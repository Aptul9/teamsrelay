import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Notifier } from "@/agent/push/notifier";
import { loadVapidKeys, type VapidKeys } from "@/agent/push/vapid";
import { SlotStore } from "@/agent/store/slot-store";
import { RelayDevices } from "@/local/devices";
import { tempDir } from "../helpers";
import { fakePushService } from "./fake-push";

const GEN = path.resolve(__dirname, "../../scripts/gen-vapid.mjs");

let fake: Awaited<ReturnType<typeof fakePushService>>;
let store: SlotStore;
let devices: RelayDevices;
let vapid: VapidKeys;

beforeEach(async () => {
  fake = await fakePushService();
  const dir = path.join(tempDir(), "vapid");
  execFileSync(process.execPath, [GEN, dir], { stdio: "pipe" });
  vapid = loadVapidKeys(path.join(dir, "private_key.pem"), path.join(dir, "appkey.txt")) as VapidKeys;
  const file = path.join(tempDir(), "relay.db");
  store = SlotStore.open(file);
  devices = RelayDevices.open(file);
  const sub = fake.subscription();
  devices.save(sub.endpoint, JSON.stringify(sub), "test phone");
});

afterEach(() => fake.close());

const notifier = () => new Notifier({ store, devices, vapid, subject: "mailto:relay@example.com", ntfy: null, send: fake.send });

describe("Web Push as the push service receives it", () => {
  it("is encrypted for the device, signed with the relay's key for that service, kept an hour, urgent", async () => {
    await notifier().message("Anna Rossi", "are you there?");
    expect(fake.received).toHaveLength(1);
    const [r] = fake.received;
    expect(r.payload).toEqual({ title: "Anna Rossi", body: "are you there?", chat: "Anna Rossi" });
    expect(r.ttl).toBe("3600");
    // a phone on low battery takes only high from its push service
    expect(r.urgency).toBe("high");
    expect(r.vapid).toMatchObject({ aud: "https://push.test", sub: "mailto:relay@example.com", k: vapid.publicKey });
    const hours = ((r.vapid?.exp ?? 0) - Date.now() / 1000) / 3600;
    expect(hours).toBeGreaterThan(1);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it("carries the alerts of the relay, a passed check at normal urgency", async () => {
    expect(await notifier().alert("Teams signed out", "Sign in again in the relay window on test-pc: no messages until then.")).toBe(1);
    expect(await notifier().alert("Teams OK", "Automatic check: the whole chain works.", "normal")).toBe(1);
    expect(fake.received.map((r) => [r.payload, r.urgency])).toEqual([
      [{ title: "Teams signed out", body: "Sign in again in the relay window on test-pc: no messages until then.", chat: "" }, "high"],
      [{ title: "Teams OK", body: "Automatic check: the whole chain works.", chat: "" }, "normal"],
    ]);
  });

  it("forgets a device the push service reports as gone", async () => {
    fake.answerWith(410);
    expect(await notifier().push("x", "y")).toBe(0);
    expect(devices.count()).toBe(0);
  });

  it("keeps a device on other errors of the push service", async () => {
    fake.answerWith(500);
    expect(await notifier().push("x", "y")).toBe(0);
    expect(devices.count()).toBe(1);
  });
});
