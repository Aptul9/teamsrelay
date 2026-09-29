import { OPUS_RATE } from "./frames";

// The worklet that plays the decoded call: a short queue (about 60 ms before it starts, again after running dry),
// never more than 300 ms (the oldest dropped), silence while empty. A mono stream plays on both channels.
const PLAYER = `
class CallAudioPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.offset = 0;
    this.queued = 0;
    this.playing = false;
    this.start = Math.round(sampleRate * 0.06);
    this.max = Math.round(sampleRate * 0.3);
    this.port.onmessage = (e) => {
      this.chunks.push(e.data);
      this.queued += e.data[0].length;
      while (this.queued > this.max && this.chunks.length > 1) {
        const dropped = this.chunks.shift();
        this.queued -= dropped[0].length - this.offset;
        this.offset = 0;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (!this.playing && this.queued < this.start) {
      for (const channel of out) channel.fill(0);
      return true;
    }
    this.playing = true;
    let done = 0;
    while (done < n && this.chunks.length) {
      const chunk = this.chunks[0];
      const take = Math.min(n - done, chunk[0].length - this.offset);
      for (let c = 0; c < out.length; c++) out[c].set(chunk[Math.min(c, chunk.length - 1)].subarray(this.offset, this.offset + take), done);
      done += take;
      this.offset += take;
      this.queued -= take;
      if (this.offset >= chunk[0].length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    if (done < n) {
      for (const channel of out) channel.fill(0, done);
      this.playing = false;
    }
    return true;
  }
}
registerProcessor("call-audio-player", CallAudioPlayer);
`;

// A worklet module from its source, without a file of its own on the server
export async function addWorklet(ctx: BaseAudioContext, source: string) {
  const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Opus packets of the call, decoded by WebCodecs and played on the given output of an AudioContext of 48 kHz
export class OpusPlayer {
  private decoder: AudioDecoder | null = null;
  private node: AudioWorkletNode | null = null;
  private count = 2;
  private timestamp = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly output: AudioNode,
  ) {}

  async ready() {
    await addWorklet(this.ctx, PLAYER);
    this.node = new AudioWorkletNode(this.ctx, "call-audio-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.connect(this.output);
    this.configure();
  }

  channels(n: number) {
    if (n === this.count) return;
    this.count = n;
    if (this.node) this.configure();
  }

  play(packet: Uint8Array) {
    const d = this.decoder;
    // a decoder falling behind drops packets rather than piling up delay
    if (!d || d.state !== "configured" || d.decodeQueueSize > 20) return;
    try {
      d.decode(new EncodedAudioChunk({ type: "key", timestamp: this.timestamp, data: packet }));
      this.timestamp += 20_000;
    } catch {
      // a packet the decoder refuses is skipped
    }
  }

  close() {
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
    this.node?.disconnect();
    this.node = null;
  }

  private configure() {
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = new AudioDecoder({ output: (frame) => this.frame(frame), error: () => undefined });
    this.decoder.configure({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: this.count });
  }

  private frame(frame: AudioData) {
    try {
      const planes: Float32Array[] = [];
      for (let c = 0; c < frame.numberOfChannels; c++) {
        const plane = new Float32Array(frame.numberOfFrames);
        frame.copyTo(plane, { planeIndex: c, format: "f32-planar" });
        planes.push(plane);
      }
      this.node?.port.postMessage(
        planes,
        planes.map((p) => p.buffer),
      );
    } finally {
      frame.close();
    }
  }
}
