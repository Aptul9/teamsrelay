// The page side of the sound of a call answered from the app on an account of a relay (src/local/call-bridge.ts). Run
// as source text in every frame of the relay browser, before Teams, and before the microphone hook of the agent
// (installMicHook), which then sees the track this returns. Idle until Teams asks for the microphone: the relay says
// then, through the binding, whether the call is the app's. If it is, Teams gets a microphone fed by the app (Opus
// packets pulled from the relay, decoded here) and the sound Teams receives goes to the relay as Opus; the microphone of
// the computer is never opened. Otherwise Teams gets the microphone of the computer, untouched.
//
// Teams web (2026-09-30): one RTCPeerConnection per call in the main frame, the sound of the others on one audio track
// of it; getUserMedia({audio}) in the main frame when a call is answered or placed.

type BridgeMsg = { op: "mic" } | { op: "down"; p: string } | { op: "format"; channels: number } | { op: "pull" } | { op: "end" };
type MicAnswer = { bridge?: boolean } | null;
type PullAnswer = { p?: string[]; end?: boolean } | null;

// WebCodecs and the insertable streams of Chrome, which the DOM types of TypeScript do not all carry
type Frame = { numberOfChannels: number; sampleRate: number; close(): void };
type Chunk = { byteLength: number; copyTo(dest: Uint8Array): void };
type Coder = { configure(c: object): void; close(): void; state: string };
type Encoder = Coder & { encode(d: Frame): void };
type Decoder = Coder & { decode(c: unknown): void };
type Generator = MediaStreamTrack & { writable: WritableStream<Frame> };
type Processor = { readable: ReadableStream<Frame> };
type Ctors = {
  MediaStreamTrackGenerator: new (o: { kind: "audio" }) => Generator;
  MediaStreamTrackProcessor: new (o: { track: MediaStreamTrack }) => Processor;
  AudioEncoder: new (o: { output: (c: Chunk) => void; error: (e: unknown) => void }) => Encoder;
  AudioDecoder: new (o: { output: (d: Frame) => void; error: (e: unknown) => void }) => Decoder;
  EncodedAudioChunk: new (o: { type: "key"; timestamp: number; data: Uint8Array }) => unknown;
};

export function installCallBridge(binding: string): "already" | "installed" | "unavailable" {
  const w = window as unknown as Record<string, unknown>;
  if (w.__teamsCallBridge) return "already";
  const c = globalThis as unknown as Partial<Ctors>;
  const devices = navigator.mediaDevices;
  if (
    !devices ||
    typeof devices.getUserMedia !== "function" ||
    typeof window.RTCPeerConnection !== "function" ||
    !c.MediaStreamTrackGenerator ||
    !c.MediaStreamTrackProcessor ||
    !c.AudioEncoder ||
    !c.AudioDecoder ||
    !c.EncodedAudioChunk
  ) {
    return "unavailable";
  }
  const k = c as Ctors;
  const call = (m: BridgeMsg) => (w[binding] as (m: BridgeMsg) => Promise<unknown>)(m);
  const original = devices.getUserMedia.bind(devices);

  const toBase64 = (b: Uint8Array) => {
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  };
  const fromBase64 = (s: string) => {
    const t = atob(s);
    const b = new Uint8Array(t.length);
    for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
    return b;
  };

  // the sound of the others: the newest live audio track the peer connections of this frame received
  const received: MediaStreamTrack[] = [];
  let session: { tap(track: MediaStreamTrack): void } | null = null;
  const Original = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(Original, {
    construct(target, args: unknown[], newTarget) {
      const pc = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
      pc.addEventListener("track", (e) => {
        if (e.track.kind !== "audio") return;
        received.push(e.track);
        session?.tap(e.track);
      });
      return pc;
    },
  });

  // One call answered from the app: the microphones handed to Teams, the decoder of the app's packets, the encoder of
  // the sound received. Over once Teams stopped every microphone it got.
  function start() {
    const mics: Generator[] = [];
    const writers: WritableStreamDefaultWriter<Frame>[] = [];
    let over = false;
    let tapped: MediaStreamTrack | null = null;
    let reader: ReadableStreamDefaultReader<Frame> | null = null;
    let encoder: Encoder | null = null;
    let ts = 0;

    const decoder = new k.AudioDecoder({
      output: (d) => {
        let left = writers.length;
        if (!left) return d.close();
        // every microphone Teams holds gets the same sound; the last one takes the frame itself
        for (const wr of writers) {
          const frame = --left ? (d as unknown as { clone(): Frame }).clone() : d;
          wr.write(frame).catch(() => undefined);
        }
      },
      error: () => undefined,
    });
    decoder.configure({ codec: "opus", sampleRate: 48_000, numberOfChannels: 1 });

    const end = () => {
      if (over) return;
      over = true;
      session = null;
      clearInterval(watch);
      void reader?.cancel().catch(() => undefined);
      for (const x of [decoder, encoder]) if (x && x.state !== "closed") x.close();
      void call({ op: "end" }).catch(() => undefined);
    };
    // Teams stops its microphone when the call ends; a track it cloned or dropped ends as well
    const watch = setInterval(() => {
      if (mics.every((m) => m.readyState === "ended")) end();
    }, 500);

    const pull = async () => {
      while (!over) {
        let a: PullAnswer;
        try {
          a = (await call({ op: "pull" })) as PullAnswer;
        } catch {
          return end();
        }
        if (!a || a.end) return end();
        for (const p of a.p ?? []) {
          if (decoder.state !== "configured") continue;
          decoder.decode(new k.EncodedAudioChunk({ type: "key", timestamp: ts, data: fromBase64(p) }));
          ts += 20_000;
        }
      }
    };

    const tap = (track: MediaStreamTrack) => {
      if (over || track === tapped || track.readyState !== "live") return;
      tapped = track;
      void reader?.cancel().catch(() => undefined);
      const r = new k.MediaStreamTrackProcessor({ track }).readable.getReader();
      reader = r;
      void (async () => {
        for (;;) {
          let next: ReadableStreamReadResult<Frame>;
          try {
            next = await r.read();
          } catch {
            return;
          }
          if (next.done || over || reader !== r) return next.value?.close();
          const d = next.value;
          if (!encoder) {
            encoder = new k.AudioEncoder({
              output: (chunk) => {
                const b = new Uint8Array(chunk.byteLength);
                chunk.copyTo(b);
                void call({ op: "down", p: toBase64(b) }).catch(() => undefined);
              },
              error: () => undefined,
            });
            encoder.configure({ codec: "opus", sampleRate: d.sampleRate, numberOfChannels: d.numberOfChannels, bitrate: 32_000 });
            void call({ op: "format", channels: d.numberOfChannels }).catch(() => undefined);
          }
          if (encoder.state === "configured") encoder.encode(d);
          d.close();
        }
      })();
    };

    const mic = () => {
      const g = new k.MediaStreamTrackGenerator({ kind: "audio" });
      mics.push(g);
      writers.push(g.writable.getWriter());
      return g;
    };

    session = { tap };
    const live = received.filter((t) => t.readyState === "live");
    if (live.length) tap(live[live.length - 1]);
    void pull();
    return { mic };
  }

  let current: { mic(): Generator } | null = null;
  devices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    if (!constraints?.audio) return original(constraints);
    // a second microphone of the same call (a device change in Teams) gets the same sound
    if (!current || !session) {
      current = null;
      let a: MicAnswer = null;
      try {
        a = (await call({ op: "mic" })) as MicAnswer;
      } catch {
        // no relay behind the binding: the computer's microphone
      }
      if (!a?.bridge) return original(constraints);
      current = start();
    }
    const tracks: MediaStreamTrack[] = [current.mic()];
    if (constraints.video) tracks.push(...(await original({ video: constraints.video })).getVideoTracks());
    return new MediaStream(tracks);
  };
  w.__teamsCallBridge = true;
  return "installed";
}
