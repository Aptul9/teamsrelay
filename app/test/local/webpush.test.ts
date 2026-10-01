import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notifier, type PushDevices } from "@/agent/push/notifier";
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
// retries wait here until a test runs them, as their timers would
let retries: { ms: number; run: () => void }[];

beforeEach(async () => {
  retries = [];
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

const notifier = (on: PushDevices = devices) =>
  new Notifier({ store, devices: on, vapid, subject: "mailto:relay@example.com", ntfy: null, send: fake.send, later: (ms, run) => void retries.push({ ms, run }) });

describe("Web Push as the push service receives it", () => {
  it("is encrypted for the device, signed with the relay's key for that service, kept a day, urgent", async () => {
    await notifier().message("Anna Rossi", "are you there?", "Anna Rossi");
    expect(fake.received).toHaveLength(1);
    const [r] = fake.received;
    expect(r.payload).toEqual({ title: "Anna Rossi", body: "are you there?", chat: "Anna Rossi", tag: "chat-0-Anna Rossi", ts: expect.any(Number) });
    expect(r.ttl).toBe("86400");
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

  it("sends again to the phone a push the push service could not take", async () => {
    fake.answerWith(503);
    expect(await notifier().alert("Teams signed out", "Sign in again")).toBe(0);
    expect(retries.map((r) => r.ms)).toEqual([5000]);
    fake.answerWith(201);
    retries.shift()?.run();
    await vi.waitFor(() => expect(fake.received).toHaveLength(2));
    expect(fake.received[1].payload).toEqual({ title: "Teams signed out", body: "Sign in again", chat: "" });
    expect(retries).toEqual([]);
  });

  // a retry runs on a timer: an error there would be uncaught, and the relay stops on an uncaught error
  it("stays up when the devices cannot be read at a retry", async () => {
    fake.answerWith(503);
    await notifier().alert("Teams signed out", "Sign in again");
    devices.close();
    expect(() => retries.shift()?.run()).not.toThrow();
  });

  it("stays up when a device gone at a retry cannot be removed", async () => {
    const failing: PushDevices = { targets: () => devices.targets(), remove: () => { throw new Error("disk I/O error"); } };
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      fake.answerWith(503);
      await notifier(failing).alert("Teams signed out", "Sign in again");
      fake.answerWith(410);
      retries.shift()?.run();
      await vi.waitFor(() => expect(fake.received).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
