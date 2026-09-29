import { readStorage, writeStorage } from "@/lib/client";
import { BELL, bellSamples } from "@/lib/ring";

// The microphone and the speaker of calls answered on this device, as Teams keeps them per computer. "" is the default
// device of the system.
export type CallDevices = { mic: string; speaker: string };

const KEY = "callDevices";

export function savedDevices(): CallDevices {
  try {
    const v = JSON.parse(readStorage(KEY) ?? "{}") as Partial<CallDevices>;
    return { mic: typeof v.mic === "string" ? v.mic : "", speaker: typeof v.speaker === "string" ? v.speaker : "" };
  } catch {
    return { mic: "", speaker: "" };
  }
}

export function saveDevices(d: CallDevices) {
  writeStorage(KEY, JSON.stringify(d));
}

// The devices of a kind the browser lists, by name. Windows adds Default and Communications entries that repeat a real
// device under another name: the default of the system is offered once, apart. Before the microphone is allowed the
// browser gives no names: numbered instead.
export function deviceOptions(list: MediaDeviceInfo[], kind: "audioinput" | "audiooutput"): { id: string; label: string }[] {
  const unnamed = kind === "audioinput" ? "Microphone" : "Speaker";
  return list
    .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d, i) => ({ id: d.deviceId, label: d.label || `${unnamed} ${i + 1}` }));
}

// The browser can send the sound of a page to a speaker of its choice (AudioContext.setSinkId: Chrome on a computer)
export function speakerChoice(): boolean {
  return typeof AudioContext !== "undefined" && typeof (AudioContext.prototype as { setSinkId?: unknown }).setSinkId === "function";
}

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };

// Sends the sound of the context to the speaker chosen; the default one when that speaker is gone. True when the chosen
// one plays.
export async function playOn(ctx: AudioContext, speaker: string): Promise<boolean> {
  const c = ctx as SinkContext;
  if (!c.setSinkId) return !speaker;
  try {
    await c.setSinkId(speaker);
    return true;
  } catch {
    await c.setSinkId("").catch(() => undefined);
    return false;
  }
}

// The speaker the context plays on now, "" for the default one
export function playingOn(ctx: AudioContext): string {
  const id = (ctx as SinkContext).sinkId;
  return typeof id === "string" ? id : "";
}

// The bell of a message on the speaker chosen, to tell the devices apart. False when that speaker is gone.
export async function testSpeaker(speaker: string): Promise<boolean> {
  const ctx = new AudioContext();
  try {
    const found = await playOn(ctx, speaker);
    const samples = bellSamples(ctx.sampleRate);
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    await ctx.resume();
    source.start();
    await new Promise((r) => setTimeout(r, BELL.length * 1000 + 200));
    return found;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}
