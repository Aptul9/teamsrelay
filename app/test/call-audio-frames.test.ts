// The audio part of the Selkies 2.0 wire format, as its server and page speak it (websockets_mode.py and
// selkies-core.js of the browsers image): Opus down in 0x01 frames, with or without redundant blocks (RED), the
// microphone up as Opus in 0x02 frames, the demand for the microphone as text.
import { describe, expect, it } from "vitest";
import { audioChannels, captureDemand, micFrame, opusPacket } from "@/lib/call-audio/frames";

const bytes = (...b: number[]) => new Uint8Array(b);

// a 0x01 frame with one redundant block: flag word, timestamp, one block header, the primary's header byte, the
// redundant block, then the primary packet
function redFrame(redundant: number[], primary: number[]) {
  const field = (960 << 10) | redundant.length;
  return bytes(0x01, 1, 0, 0, 0x12, 0x34, 0xe3, (field >> 16) & 0xff, (field >> 8) & 0xff, field & 0xff, 0x63, ...redundant, ...primary);
}

describe("opusPacket", () => {
  it("gives the Opus packet of a frame without redundancy", () => {
    expect(opusPacket(bytes(0x01, 0, 7, 8, 9))).toEqual(bytes(7, 8, 9));
  });

  it("gives the primary packet of a frame with a redundant block, the last one", () => {
    expect(opusPacket(redFrame([5, 5], [7, 8, 9]))).toEqual(bytes(7, 8, 9));
  });

  it("gives nothing for a frame shorter than its headers, or whose blocks overrun it", () => {
    expect(opusPacket(bytes(0x01, 2, 0, 0, 0, 0, 0xe3, 0, 0))).toBeNull();
    expect(opusPacket(redFrame([5, 5, 5, 5, 5], []).subarray(0, 12))).toBeNull();
  });

  it("gives nothing for a frame that is not audio", () => {
    expect(opusPacket(bytes(0x03, 0, 7, 8))).toBeNull();
    expect(opusPacket(bytes(0x01))).toBeNull();
  });
});

describe("micFrame", () => {
  // Selkies' own page encodes the microphone to Opus and pcmflux decodes it: raw PCM there plays as noise
  it("is 0x02 then the Opus packet of the microphone", () => {
    expect(micFrame(bytes(0x78, 0x01, 0x02))).toEqual(bytes(0x02, 0x78, 0x01, 0x02));
  });
});

describe("captureDemand", () => {
  it("reads the demand for a device, on and off", () => {
    expect(captureDemand("CAPTURE_DEMAND microphone 1")).toEqual({ subject: "microphone", wanted: true });
    expect(captureDemand("CAPTURE_DEMAND microphone 0")).toEqual({ subject: "microphone", wanted: false });
    expect(captureDemand("CAPTURE_DEMAND webcam 1")).toEqual({ subject: "webcam", wanted: true });
  });

  it("ignores other text", () => {
    expect(captureDemand("AUDIO_STARTED")).toBeNull();
    expect(captureDemand("CAPTURE_DEMAND microphone")).toBeNull();
  });
});

describe("audioChannels", () => {
  it("takes the channels of the audio from the server settings, stereo when absent or out of range", () => {
    expect(audioChannels({ type: "server_settings", settings: { audio_channels: { value: 1 } } })).toBe(1);
    expect(audioChannels({ type: "server_settings", settings: { audio_channels: { value: 2 } } })).toBe(2);
    expect(audioChannels({ type: "server_settings", settings: {} })).toBe(2);
    expect(audioChannels({ type: "server_settings", settings: { audio_channels: { value: 6 } } })).toBe(2);
    expect(audioChannels(null)).toBe(2);
  });
});
