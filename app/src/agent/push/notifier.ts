import webpush from "web-push";
import { Identity, parseState, STATE } from "@/shared/slot-db/state";
import { CALL_TTL, callTag, chatTag, PUSH_TTL, pushRetryDelay, pushTitle, RecentPushes } from "../logic/notify";
import { errorText, log } from "../log";
import type { SlotStore } from "../store/slot-store";
import type { VapidKeys } from "./vapid";

type Send = (subscription: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;
type Later = (ms: number, fn: () => void) => void;
export type Ntfy = { url: string; topic: string } | null;
export type PushTarget = { endpoint: string; sub: string };

// The devices a push goes to: those of the slot owner in app.db (AppStore), those subscribed from the app of the
// local relay (src/local/devices.ts)
export type PushDevices = {
  targets(): PushTarget[];
  // a subscription the push service reports as gone
  remove(endpoint: string): void;
  // the account the notification comes from, for an app that shows more than one: its slot (acc, the app opens
  // it), and its name after the title when the owner has more than one
  account?(me: Identity): { acc: number; label: string };
};

// What the jobs notify through: the Notifier below, or the web app of the server a local relay joined
// (ServerNotifier, src/local/server-link.ts), which sends with this Notifier on its side
export type Notify = Pick<Notifier, "message" | "alert" | "call" | "missedCall" | "deviceCount">;

// Retries run on timers, so a push service that answers slowly or not at all never holds up the read loop
const later: Later = (ms, fn) => void setTimeout(fn, ms).unref();

// Push service of Safari (web apps on the Home Screen of an iPhone or iPad, Safari on a Mac)
const APPLE_PUSH = /^https:\/\/web\.push\.apple\.com\//;

// Notifications of the account: Web Push to its devices, ntfy when enabled, and the history of the messages
// notified (messages table).
export class Notifier {
  private readonly recent: RecentPushes;

  constructor(
    private readonly o: {
      store: SlotStore;
      devices: PushDevices;
      vapid: VapidKeys | null;
      subject: string;
      ntfy: Ntfy;
      send?: Send;
      later?: Later;
      clock?: () => number;
    },
  ) {
    this.recent = new RecentPushes(o.clock);
  }

  // A new Teams message: the same text within 150 s is notified once. On the device it replaces the notification
  // of the same chat, which keeps the last lines (sw.js); the notification opens the app on `chat`, when known.
  async message(title: string, body: string, chat = "") {
    if (!this.recent.allow(body)) return;
    this.o.store.addNotification(title, body);
    await this.ntfy(title, body);
    await this.push(title, body, chat, "high", title);
  }

  // About the relay itself (Teams signed out, outcome of a check): push and ntfy, no history
  async alert(title: string, body: string, urgency: webpush.Urgency = "high"): Promise<number> {
    await this.ntfy(title, body);
    return this.push(title, body, "", urgency);
  }

  deviceCount(): number {
    return this.o.devices.targets().length;
  }

  // Push to every device. Urgency high unless the caller says it can wait: a phone on low battery asks its push
  // service for high only (RFC 8030 section 5.3), and web-push sends normal unless told. Pushes of one `group` (a
  // chat) share one notification on the device.
  async push(title: string, body: string, chat = "", urgency: webpush.Urgency = "high", group = ""): Promise<number> {
    // tag: the chat it belongs to, per account (the local relay has one, 0)
    return this.deliver((acc) => ({ title, body: body || "", chat, ...(group && { tag: chatTag(acc, group) }) }), { urgency, ttl: PUSH_TTL, retry: true });
  }

  // An incoming Teams call, on a notification of its own per account: "ringing" when it starts, "again" every few
  // seconds while it rings, "ended" once it stops. While it rings every push alerts again on the device (sw.js), and
  // the push service keeps it only while the call could still be answered, with no retry: the next one follows in
  // seconds. Once it stops, the same notification turns quiet and stays a day. Safari devices get the start and the
  // end only: on an iPhone every push shows apart, the tag ignored (WebKit bug 258922). Not in the history of
  // notified messages, not on ntfy.
  async call(caller: string, state: "ringing" | "again" | "ended", since: number, seconds = 0): Promise<number> {
    const ringing = state !== "ended";
    const title = ringing ? (caller ? `${caller} is calling` : "Incoming call") : caller ? `Call from ${caller}` : "Call ended";
    const body = ringing ? "Teams call, ringing now" : seconds ? `Ended after ${seconds} s` : "Ended";
    const chat = caller && this.o.store.isKnownChat(caller) ? caller : "";
    return this.deliver((acc) => ({ title, body, chat, tag: callTag(acc), call: ringing ? "ringing" : "ended", ts: since }), {
      urgency: "high",
      ttl: ringing ? CALL_TTL : PUSH_TTL,
      retry: !ringing,
      skip: state === "again" ? (t) => APPLE_PUSH.test(t.endpoint) : undefined,
    });
  }

  // A missed call the check of an account checked every N hours found in its Teams Activity feed: its browser did not
  // run while the call rang. A notification of its own, which alerts, and ntfy when enabled; time is the one Teams shows.
  async missedCall(caller: string, time: string): Promise<number> {
    const title = caller ? `Missed call from ${caller}` : "Missed call";
    const body = `Teams call${time ? ` at ${time}` : ""}, found by the check`;
    await this.ntfy(title, body);
    return this.push(title, body, caller && this.o.store.isKnownChat(caller) ? caller : "");
  }

  // Sends to every device, all at once, what `content` makes for the account (its slot, 0 for the local relay), the
  // title naming the account when the owner has more. Returns the devices the push service took on the first try;
  // the ones it reported as gone are removed, the ones it could not take now are tried again later when `retry`.
  private async deliver(
    content: (acc: number) => { title: string } & Record<string, unknown>,
    o: { urgency: webpush.Urgency; ttl: number; retry: boolean; skip?: (t: PushTarget) => boolean },
  ): Promise<number> {
    const { vapid, devices, store } = this.o;
    if (!vapid) return 0;
    const targets = devices.targets().filter((t) => !o.skip?.(t));
    if (!targets.length) return 0;
    const account = devices.account?.(parseState(Identity, store.getState(STATE.me), Identity.parse({})));
    const c = content(account?.acc ?? 0);
    const payload = JSON.stringify({ ...c, title: pushTitle(c.title, account?.label ?? ""), ...(account ? { acc: account.acc } : {}) });
    const options: webpush.RequestOptions = {
      vapidDetails: { subject: this.o.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: o.ttl,
      urgency: o.urgency,
      timeout: 15_000,
    };
    // one push service that does not answer (15 s) holds no other device
    return (await Promise.all(targets.map((t) => this.sendTo(t, payload, options, 0, o.retry)))).filter(Boolean).length;
  }

  private async sendTo(t: PushTarget, payload: string, options: webpush.RequestOptions, attempt: number, retry = true): Promise<boolean> {
    const send: Send = this.o.send ?? webpush.sendNotification;
    try {
      await send(JSON.parse(t.sub) as webpush.PushSubscription, payload, options);
      if (attempt) log.info("push", "sent on retry", { attempt });
      return true;
    } catch (e) {
      const { statusCode: status, headers, code } = e as { statusCode?: number; headers?: Record<string, string | string[] | undefined>; code?: unknown };
      if (status === 404 || status === 410) {
        this.o.devices.remove(t.endpoint);
        log.info("push", "device gone, removed", { status });
        return false;
      }
      // without a status, only a push service that did not answer (network error, timeout) is tried again: a
      // subscription web-push refuses before sending fails the same way every time
      const reached = status !== undefined || typeof code === "string" || errorText(e) === "Socket timeout";
      const retryAfter = headers?.["retry-after"];
      const wait = retry && reached ? pushRetryDelay(status, Array.isArray(retryAfter) ? retryAfter[0] : retryAfter, attempt, (this.o.clock ?? Date.now)()) : null;
      log.warn("push", errorText(e), { status, attempt, retry: wait ?? "none" });
      if (wait !== null) (this.o.later ?? later)(wait * 1000, () => this.retry(t.endpoint, payload, options, attempt + 1));
      return false;
    }
  }

  // A retry goes to the device only while it is still one of the devices: a subscription can pass to another user
  // of the same browser, or be removed, while the retry waits. It runs on a timer, where an error of the device
  // store would be uncaught (the local relay stops on one): logged instead.
  private retry(endpoint: string, payload: string, options: webpush.RequestOptions, attempt: number) {
    const failed = (e: unknown) => log.warn("push", `retry: ${errorText(e)}`, { attempt });
    try {
      const t = this.o.devices.targets().find((x) => x.endpoint === endpoint);
      if (!t) return log.info("push", "device gone before the retry", { attempt });
      this.sendTo(t, payload, options, attempt).catch(failed);
    } catch (e) {
      failed(e);
    }
  }

  private async ntfy(title: string, body: string) {
    const ntfy = this.o.ntfy;
    if (!ntfy) return;
    try {
      await fetch(ntfy.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: ntfy.topic, title: (title || "Teams").slice(0, 100), message: (body || "(new message)").slice(0, 1000), priority: 4, tags: ["speech_balloon"] }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      log.warn("ntfy", errorText(e));
    }
  }
}
