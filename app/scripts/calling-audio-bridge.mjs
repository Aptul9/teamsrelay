// PCM/Opus boundary for the existing call-audio hub. Inject codec and transport.
export class CallingAudioBridge {
  constructor({ codec, send }) {
    this.encoder = new codec(48000, 1, codec.Application.VOIP);
    this.encoder.setBitrate(32000);
    this.decoder = new codec(48000, 1);
    this.send = send;
    this.down = []; this.up = []; this.primed = false; this.closed = false;
    this.stats = { down: 0, up: 0, invalid: 0, droppedSamples: 0, underruns: 0 };
  }
  start() { this.send('CHANNELS 1'); this.send('CAPTURE_DEMAND microphone 1'); }
  receive(frame) {
    if (this.closed) return;
    const b = Buffer.from(frame);
    if (b.length < 2 || b.length > 3829 || b[0] !== 2) { this.stats.invalid++; return; }
    try {
      const pcm = this.decoder.decode(b.subarray(1));
      for (let i = 0; i + 1 < pcm.length; i += 2) this.up.push(pcm.readInt16LE(i));
      if (this.up.length > 9600) {
        this.stats.droppedSamples += this.up.length - 9600;
        this.up.splice(0, this.up.length - 9600);
      }
      this.stats.up++;
    } catch { this.stats.invalid++; }
  }
  microphone() {
    const out = new Int16Array(480);
    if (this.closed) return out;
    if (!this.primed && this.up.length >= 2880) this.primed = true;
    if (this.primed && this.up.length >= 480) out.set(this.up.splice(0, 480));
    else if (this.primed) { this.stats.underruns++; this.primed = false; }
    return out;
  }
  speaker(frame) {
    if (this.closed) return;
    const { samples, sampleRate, channelCount, numberOfFrames } = frame;
    if (![16000, 32000, 48000].includes(sampleRate) || ![1, 2].includes(channelCount) || !Number.isInteger(numberOfFrames) || numberOfFrames < 1 || numberOfFrames > 4800 || samples.length < numberOfFrames * channelCount) { this.stats.invalid++; return; }
    const mono = (i) => {
      let sum = 0;
      for (let c = 0; c < channelCount; c++) sum += samples[Math.min(numberOfFrames - 1, i) * channelCount + c];
      return sum / channelCount;
    };
    for (let i = 0; i < Math.round(numberOfFrames * 48000 / sampleRate); i++) {
      const p = i * sampleRate / 48000, lo = Math.floor(p), f = p - lo;
      this.down.push(Math.round(mono(lo) * (1 - f) + mono(lo + 1) * f));
    }
    while (this.down.length >= 960) {
      const pcm = Buffer.allocUnsafe(1920);
      this.down.splice(0, 960).forEach((v, i) => pcm.writeInt16LE(v, i * 2));
      this.send(this.encoder.encode(pcm, 960)); this.stats.down++;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.send('CAPTURE_DEMAND microphone 0'); }
    finally { this.encoder.delete(); this.decoder.delete(); this.up.length = this.down.length = 0; }
  }
}
