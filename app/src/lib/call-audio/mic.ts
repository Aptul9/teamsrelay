import { MIC_FRAME, MIC_RATE, micFrame } from "./frames";
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
// in an AudioContext of 24 kHz (the browser resamples), sent as 0x02 frames of 20 ms. Muted, nothing is sent.
export class MicSender {
  muted = false;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private pending = new Float32Array(MIC_FRAME);
  private filled = 0;
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
    const ctx = new AudioContext({ sampleRate: MIC_RATE, latencyHint: "interactive" });
    this.ctx = ctx;
    await addWorklet(ctx, MIC);
    if (run !== this.run) return;
    const node = new AudioWorkletNode(ctx, "call-audio-mic", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.samples(e.data);
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
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.filled = 0;
  }

  private samples(chunk: Float32Array) {
    for (let at = 0; at < chunk.length; ) {
      const take = Math.min(MIC_FRAME - this.filled, chunk.length - at);
      this.pending.set(chunk.subarray(at, at + take), this.filled);
      this.filled += take;
      at += take;
      if (this.filled === MIC_FRAME) {
        if (!this.muted) this.send(micFrame(this.pending));
        this.filled = 0;
      }
    }
  }
}
