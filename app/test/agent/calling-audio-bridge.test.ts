import { describe, expect, it } from 'vitest';
import { CallingAudioBridge } from '../../scripts/calling-audio-bridge.mjs';
class Codec {
  static Application = { VOIP: 2048 };
  deleted = false;
  setBitrate() {}
  encode(pcm: Buffer) { return Buffer.from(pcm); }
  decode(packet: Buffer) { return Buffer.from(packet); }
  delete() { this.deleted = true; }
}
const setup = () => { const sent: (string | Buffer)[] = []; return { sent, bridge: new CallingAudioBridge({ codec: Codec, send: (v: string | Buffer) => sent.push(v) }) }; };
describe('native calling audio hub adapter', () => {
  it('requests mono audio and stops once', () => {
    const { bridge, sent } = setup(); bridge.start(); bridge.close(); bridge.close();
    expect(sent).toEqual(['CHANNELS 1', 'CAPTURE_DEMAND microphone 1', 'CAPTURE_DEMAND microphone 0']);
    expect(bridge.encoder.deleted && bridge.decoder.deleted).toBe(true);
  });
  it('upsamples Teams 16kHz to 48kHz and emits 20ms byte PCM packets', () => {
    const { bridge, sent } = setup();
    const frame = { samples: new Int16Array(160).fill(1234), sampleRate: 16000, channelCount: 1, numberOfFrames: 160 };
    bridge.speaker(frame); expect(sent).toHaveLength(0); bridge.speaker(frame);
    expect(sent).toHaveLength(1); const b = sent[0] as Buffer;
    expect(b.length).toBe(1920); expect(b.readInt16LE(100)).toBe(1234);
  });
  it('downmixes stereo before encoding', () => {
    const { bridge, sent } = setup(); const samples = new Int16Array(1920);
    for (let i = 0; i < 960; i++) { samples[i * 2] = 4000; samples[i * 2 + 1] = -2000; }
    bridge.speaker({ samples, sampleRate: 48000, channelCount: 2, numberOfFrames: 960 });
    expect((sent[0] as Buffer).readInt16LE(0)).toBe(1000);
  });
  it('waits for 60ms then feeds 10ms microphone frames', () => {
    const { bridge } = setup(); const pcm = Buffer.alloc(1920); for (let i = 0; i < 960; i++) pcm.writeInt16LE(2345, i * 2);
    const packet = Buffer.concat([Buffer.from([2]), pcm]);
    bridge.receive(packet); expect(bridge.microphone().every((x: number) => x === 0)).toBe(true);
    bridge.receive(packet); bridge.receive(packet);
    expect(bridge.microphone().every((x: number) => x === 2345)).toBe(true);
    for (let i = 0; i < 6; i++) bridge.microphone();
    expect(bridge.stats.underruns).toBe(1);
  });
  it('bounds queued microphone samples and rejects malformed input', () => {
    const { bridge } = setup();
    for (let i = 0; i < 20; i++) bridge.receive(Buffer.alloc(1921, 2));
    expect(bridge.up.length).toBeLessThanOrEqual(9600); expect(bridge.stats.droppedSamples).toBeGreaterThan(0);
    bridge.receive(Buffer.from([1, 2])); bridge.receive(Buffer.alloc(4000));
    bridge.speaker({ samples: [], sampleRate: 123, channelCount: 1, numberOfFrames: 1 });
    expect(bridge.stats.invalid).toBe(3);
    bridge.close(); bridge.receive(Buffer.alloc(1921, 2)); expect(bridge.up).toHaveLength(0);
  });
});
