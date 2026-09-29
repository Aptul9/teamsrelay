// The audio part of the websocket of Selkies 2.0, the remote desktop of the browsers container (websockets_mode.py and
// selkies-core.js of its image). Binary frames carry their kind in the first byte.
export const OP = { audio: 0x01, mic: 0x02, gzipText: 0x05 } as const;

// Opus down at 48 kHz; the microphone up as 16-bit mono PCM at 24 kHz, 20 ms per frame
export const OPUS_RATE = 48_000;
export const MIC_RATE = 24_000;
export const MIC_FRAME = 480;

// The Opus packet of a 0x01 frame. Byte 1 counts the redundant blocks (RED): with none the packet follows; with some,
// a 4-byte timestamp, 4 bytes per block (offset and length in the last 3), the header byte of the primary, the
// redundant blocks, and the primary packet last, the one played here. Null for a frame shorter than it claims.
export function opusPacket(frame: Uint8Array): Uint8Array | null {
  if (frame.length < 3 || frame[0] !== OP.audio) return null;
  const red = frame[1];
  if (!red) return frame.subarray(2);
  let pos = 6;
  if (frame.length < pos + red * 4 + 1) return null;
  let blocks = 0;
  for (let i = 0; i < red; i++, pos += 4) blocks += frame[pos + 3] | ((frame[pos + 2] & 0x03) << 8);
  pos += 1 + blocks;
  return pos < frame.length ? frame.subarray(pos) : null;
}

// A 0x02 frame of the microphone: full scale 32767, clamped, little-endian
export function micFrame(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(1 + samples.length * 2);
  out[0] = OP.mic;
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(1 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return out;
}

// "CAPTURE_DEMAND <device> <0|1>": the server wants the device of this page while a program on the desktop reads it
export function captureDemand(text: string): { subject: string; wanted: boolean } | null {
  const m = /^CAPTURE_DEMAND (\S+) ([01])$/.exec(text);
  return m ? { subject: m[1], wanted: m[2] === "1" } : null;
}

// The channels of the Opus stream, from the server settings message ({type: "server_settings", settings: {...}})
export function audioChannels(message: unknown): number {
  const value = (message as { settings?: { audio_channels?: { value?: unknown } } } | null)?.settings?.audio_channels?.value;
  return value === 1 ? 1 : 2;
}
