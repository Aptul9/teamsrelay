import { type CallDevices, playOn, playingOn } from "./devices";
import { OPUS_RATE } from "./frames";
import { MicSender } from "./mic";
import { OpusPlayer } from "./player";
import { AudioLink, type LinkState, type SocketLike } from "./socket";

// What the banner shows of the sound of a call: the link to the remote desktop, the microphone (denied: refused on
// this device or disabled on the server), Mute, whether a tap is needed before the page may play, and whether the
// microphone or the speaker chosen is gone and the default one is in use
export type CallAudioState = {
  link: LinkState;
  reason?: string;
  mic: "off" | "on" | "denied";
  muted: boolean;
  needsTap: boolean;
  micFallback: boolean;
  speakerFallback: boolean;
};

// The websocket of the remote desktop (Selkies, under /desktop/ on the site of the app)
export function callAudioUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/desktop/api/websockets`;
}

// The browser plays and records a call in the app: WebCodecs for the Opus, worklets, a microphone
export function callAudioSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof AudioDecoder === "function" &&
    typeof AudioWorkletNode === "function" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

// The sound of a call answered from the app, both ways, over the websocket of the remote desktop and without its video,
// on the microphone and the speaker chosen on this device
export class CallAudio {
  private readonly ctx: AudioContext;
  private readonly player: OpusPlayer;
  private readonly mic: MicSender;
  private readonly link: AudioLink;
  private state: CallAudioState = { link: "connecting", mic: "off", muted: false, needsTap: false, micFallback: false, speakerFallback: false };
  private stopped = false;
  private devices: CallDevices;

  constructor(
    private readonly o: {
      url: string;
      onState: (s: CallAudioState) => void;
      devices?: CallDevices;
      open?: (url: string) => SocketLike;
      // where the sound goes: the speakers, or something in between (an analyser in the tests)
      output?: (ctx: AudioContext) => AudioNode;
    },
  ) {
    this.devices = { ...(o.devices ?? { mic: "", speaker: "" }) };
    this.ctx = new AudioContext({ sampleRate: OPUS_RATE, latencyHint: "interactive" });
    this.player = new OpusPlayer(this.ctx, o.output?.(this.ctx) ?? this.ctx.destination);
    this.mic = new MicSender(
      (frame) => this.link.sendMic(frame),
      () => this.update({ micFallback: this.mic.fellBack }),
    );
    this.link = new AudioLink({
      url: o.url,
      open: o.open ?? ((url) => new WebSocket(url) as unknown as SocketLike),
      events: {
        audio: (packet) => this.player.play(packet),
        channels: (n) => this.player.channels(n),
        mic: (wanted) => void this.demand(wanted),
        micDisabled: () => this.update({ mic: "denied" }),
        state: (link, reason) => this.update({ link, reason }),
      },
    });
    this.ctx.onstatechange = () => this.update({ needsTap: this.ctx.state === "suspended" });
  }

  start() {
    void this.player.ready().catch(() => this.update({ link: "unavailable", reason: "This browser cannot play the call" }));
    void this.useSpeaker(this.devices.speaker);
    this.link.start();
    void this.ctx.resume().catch(() => undefined);
    // a page not allowed to play yet stays suspended until a tap
    setTimeout(() => !this.stopped && this.update({ needsTap: this.ctx.state === "suspended" }), 500);
  }

  // from a tap: the page may play from now on
  resume() {
    void this.ctx.resume().catch(() => undefined);
    this.mic.resume();
  }

  mute(on: boolean) {
    this.mic.muted = on;
    this.update({ muted: on });
  }

  // how loud the microphone is now, 0 to 1 (0 while muted)
  micLevel() {
    return this.mic.level();
  }

  // the speaker the call plays on, "" for the default one
  speaker() {
    return playingOn(this.ctx);
  }

  async useMic(id: string) {
    this.devices.mic = id;
    await this.mic.use(id).catch(() => undefined);
    this.update({ micFallback: this.mic.fellBack });
  }

  async useSpeaker(id: string) {
    this.devices.speaker = id;
    const found = await playOn(this.ctx, id);
    this.update({ speakerFallback: !found && !!id });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.link.stop();
    this.mic.stop();
    this.player.close();
    void this.ctx.close().catch(() => undefined);
  }

  private async demand(wanted: boolean) {
    if (!wanted) {
      this.mic.stop();
      if (this.state.mic === "on") this.update({ mic: "off" });
      return;
    }
    try {
      await this.mic.start(this.devices.mic);
      if (this.mic.active()) this.update({ mic: "on", micFallback: this.mic.fellBack });
    } catch {
      this.update({ mic: "denied" });
    }
  }

  private update(change: Partial<CallAudioState>) {
    const next = { ...this.state, ...change };
    if ((Object.keys(next) as (keyof CallAudioState)[]).every((k) => next[k] === this.state[k])) return;
    this.state = next;
    this.o.onState({ ...next });
  }
}
