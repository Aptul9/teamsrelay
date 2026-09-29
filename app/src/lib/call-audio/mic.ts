import { MIC_ENCODER, MIC_RATE, micFrame } from "./frames";
import { addWorklet } from "./player";

// The worklet that hands the microphone to the page, one render quantum (128 samples) at a time
const MIC = `
class CallAudioMic extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("call-audio-mic", CallAudioMic);
`;

// The microphone of the phone for the call: echo cancellation, noise suppression and gain control as in a call app,
// in an AudioContext of 24 kHz (the browser resamples), encoded to Opus (low delay where the browser offers it) and
// sent as 0x02 frames. Muted, nothing is encoded or sent.
export class MicSender {
  muted = false;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private encoder: AudioEncoder | null = null;
  private timestamp = 0;
  // a start overtaken by a stop leaves nothing open
  private run = 0;

  constructor(private readonly send: (frame: Uint8Array) => void) {}

  active() {
    return !!this.stream;
  }

  async start() {
    if (this.stream) return;
    const run = ++this.run;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    if (run !== this.run) return stream.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.encoder = await this.encoderFor(run);
    const ctx = new AudioContext({ sampleRate: MIC_RATE, latencyHint: "interactive" });
    this.ctx = ctx;
    await addWorklet(ctx, MIC);
    if (run !== this.run) return;
    const node = new AudioWorkletNode(ctx, "call-audio-mic", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
    node.port.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer>>) => this.samples(e.data);
    // a node the graph does not pull is never run: into the speakers, silent
    const silent = ctx.createGain();
    silent.gain.value = 0;
    ctx.createMediaStreamSource(stream).connect(node);
    node.connect(silent).connect(ctx.destination);
    this.node = node;
    void ctx.resume().catch(() => undefined);
  }

  // an AudioContext made without a tap may wait for one
  resume() {
    void this.ctx?.resume().catch(() => undefined);
  }

  stop() {
    this.run++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.node?.disconnect();
    this.node = null;
    if (this.encoder && this.encoder.state !== "closed") this.encoder.close();
    this.encoder = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  private async encoderFor(run: number): Promise<AudioEncoder> {
    const encoder = new AudioEncoder({
      output: (chunk) => {
        if (run !== this.run) return;
        const packet = new Uint8Array(chunk.byteLength);
        chunk.copyTo(packet);
        this.send(micFrame(packet));
      },
      error: () => undefined,
    });
    const lowDelay = { ...MIC_ENCODER, opus: { application: "lowdelay" } } as AudioEncoderConfig;
    const supported = await AudioEncoder.isConfigSupported(lowDelay).then(
      (s) => !!s.supported,
      () => false,
    );
    encoder.configure(supported ? lowDelay : MIC_ENCODER);
    return encoder;
  }

  private samples(chunk: Float32Array<ArrayBuffer>) {
    const encoder = this.encoder;
    const frames = chunk.length;
    if (!this.muted && encoder?.state === "configured") {
      const data = new AudioData({ format: "f32", sampleRate: MIC_RATE, numberOfFrames: frames, numberOfChannels: 1, timestamp: this.timestamp, data: chunk });
      try {
        encoder.encode(data);
      } finally {
        data.close();
      }
    }
    this.timestamp += Math.round((frames * 1_000_000) / MIC_RATE);
  }
}
