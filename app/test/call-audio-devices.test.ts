// The microphone and the speaker of calls chosen on this device: the list offered (the devices as the browser names
// them, without the Default and Communications entries of Windows, which repeat a real device), and the choice kept in
// the storage of the browser.
import { afterEach, describe, expect, it } from "vitest";
import { deviceOptions, saveDevices, savedDevices } from "@/lib/call-audio/devices";

const info = (kind: MediaDeviceKind, deviceId: string, label = "") => ({ kind, deviceId, label, groupId: "g" }) as MediaDeviceInfo;

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("deviceOptions", () => {
  it("lists the devices of a kind by name, without Default and Communications", () => {
    const list = [
      info("audioinput", "default", "Default - Headset (Jabra)"),
      info("audioinput", "communications", "Communications - Headset (Jabra)"),
      info("audioinput", "a1", "Headset (Jabra)"),
      info("audioinput", "a2", "CABLE Output (VB-Audio Virtual Cable)"),
      info("audiooutput", "o1", "Speakers (Realtek)"),
      info("videoinput", "v1", "Camera"),
    ];
    expect(deviceOptions(list, "audioinput")).toEqual([
      { id: "a1", label: "Headset (Jabra)" },
      { id: "a2", label: "CABLE Output (VB-Audio Virtual Cable)" },
    ]);
    expect(deviceOptions(list, "audiooutput")).toEqual([{ id: "o1", label: "Speakers (Realtek)" }]);
  });

  it("numbers the devices the browser does not name yet (no microphone permission)", () => {
    expect(deviceOptions([info("audioinput", "a1"), info("audioinput", "a2")], "audioinput")).toEqual([
      { id: "a1", label: "Microphone 1" },
      { id: "a2", label: "Microphone 2" },
    ]);
    expect(deviceOptions([info("audiooutput", "o1")], "audiooutput")).toEqual([{ id: "o1", label: "Speaker 1" }]);
  });
});

describe("savedDevices", () => {
  it("keeps the choice of this device, the system's default when none", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(savedDevices()).toEqual({ mic: "", speaker: "" });
    saveDevices({ mic: "a2", speaker: "o1" });
    expect(savedDevices()).toEqual({ mic: "a2", speaker: "o1" });
    store.set("callDevices", "not json");
    expect(savedDevices()).toEqual({ mic: "", speaker: "" });
  });

  it("works without storage (private mode): the default devices", () => {
    expect(savedDevices()).toEqual({ mic: "", speaker: "" });
    expect(() => saveDevices({ mic: "a1", speaker: "" })).not.toThrow();
  });
});
