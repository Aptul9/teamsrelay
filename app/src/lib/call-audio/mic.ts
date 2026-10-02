import { openMicrophone } from "./devices";
import { MIC_ENCODER, MIC_RATE, micFrame } from "./frames";
import { addWorklet } from "./player";
import { rms } from "@/lib/ring";

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
// sent as 0x02 frames. The device chosen on this device, the default one when it is gone (fellBack). Muted, the track
// itself is off (the browser gives silence) and nothing is encoded or sent.
export class MicSender {
  fellBack = false;
  private silenced = false;
  private device = "";
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private encoder: AudioEncoder | null = null;
  private timestamp = 0;
  private peak = 0;
  // a start or a switch overtaken by a stop leaves nothing open
  private run = 0;

  constructor(
    private readonly send: (frame: Uint8Array) => void,
    private readonly onChange: () => void = () => undefined,
  ) {}

  set muted(on: boolean) {
    this.silenced = on;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !on));
    if (on) this.peak = 0;
  }

  active() {
    return !!this.stream;
  }

  // how loud the microphone is now, 0 to 1: 0 while muted
  level() {
    return this.silenced ? 0 : this.peak;
  }

  async start(device = this.device) {
    this.device = device;
    if (this.stream) return;
    const run = ++this.run;
    const stream = await this.open(device);
    if (run !== this.run) return stream.getTracks().forEach((t) => t.stop());
    this.hold(stream);
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
    node.connect(silent).connect(ctx.destination);
    this.node = node;
    this.plug();
    void ctx.resume().catch(() => undefined);
    // another device chosen while this one opened
    if (this.device !== device) await this.use(this.device);
  }

  // Another microphone, now if one is open: the new one is on before the old one is let go, muted when muted
  async use(device: string) {
    this.device = device;
    if (!this.stream || !this.ctx) return;
    const run = this.run;
    const stream = await this.open(device);
    if (run !== this.run || !this.stream) return stream.getTracks().forEach((t) => t.stop());
    const old = this.stream;
    this.hold(stream);
    this.plug();
    old.getTracks().forEach((t) => t.stop());
  }

  // an AudioContext made without a tap may wait for one
  resume() {
    void this.ctx?.resume().catch(() => undefined);
  }

  stop() {
    this.run++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source?.disconnect();
    this.source = null;
    this.node?.disconnect();
    this.node = null;
    if (this.encoder && this.encoder.state !== "closed") this.encoder.close();
    this.encoder = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.peak = 0;
  }

  private async open(device: string): Promise<MediaStream> {
    const { stream, fellBack } = await openMicrophone(device);
    this.fellBack = fellBack;
    return stream;
  }

  // the stream in use, muted when muted; a device that goes away mid-call is opened again, the default one if gone
  private hold(stream: MediaStream) {
    this.stream = stream;
    for (const t of stream.getAudioTracks()) {
      t.enabled = !this.silenced;
      t.onended = () => {
        if (this.stream === stream) void this.use(this.device).then(this.onChange, () => undefined);
      };
    }
    this.onChange();
  }

  private plug() {
    if (!this.ctx || !this.node || !this.stream) return;
    this.source?.disconnect();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);
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
    const frames = chunk.length;
    this.peak = Math.max(rms(chunk), this.peak * 0.9);
    const encoder = this.encoder;
    if (!this.silenced && encoder?.state === "configured") {
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
