import webpush from "web-push";
import { Identity, parseState, STATE } from "@/shared/slot-db/state";
import { CALL_TTL, callTag, chatTag, PUSH_TTL, pushRetryDelay, pushTitle, RecentPushes } from "../logic/notify";
import { errorText, log } from "../log";
import type { SlotStore } from "../store/slot-store";
import type { FcmSender } from "./fcm";
import { sealFor } from "./seal";
import type { VapidKeys } from "./vapid";

type Send = (subscription: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;
type Later = (ms: number, fn: () => void) => void;
export type Ntfy = { url: string; topic: string } | null;
export type PushTarget = { endpoint: string; sub: string };
type Delivery = { urgency: webpush.Urgency; ttl: number; retry: boolean };

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

// A phone of the Android app (mobile/), registered through /api/push/fcm: FCM, not Web Push
export const isPhone = (t: Pick<PushTarget, "endpoint">) => t.endpoint.startsWith("fcm:");

// The outcome of one send, handed to took when the push service took it
function noteTook(ok: boolean, t: PushTarget, took?: (t: PushTarget) => void): boolean {
  if (ok) took?.(t);
  return ok;
}

// An FCM message carries 4096 bytes of data: long texts are cut, as for ntfy, and once more when the sealed message
// is still too big (text of many bytes per character)
function sealFitting(key: string, content: Record<string, unknown>): Record<string, string> {
  const cut = (n: number) => ({ ...content, title: String(content.title ?? "").slice(0, 100), body: String(content.body ?? "").slice(0, n) });
  const data = sealFor(key, cut(1000));
  return JSON.stringify(data).length < 3800 ? data : sealFor(key, cut(200));
}

// Notifications of the account: Web Push to its browsers, FCM to the phones of the Android app (when the service
// account key of the Firebase project is there), ntfy when enabled, and the history of the messages notified
// (messages table).
export class Notifier {
  private readonly recent: RecentPushes;
  private readonly now: () => number;
  private readonly schedule: Later;

  constructor(
    private readonly o: {
      store: SlotStore;
      devices: PushDevices;
      vapid: VapidKeys | null;
      subject: string;
      ntfy: Ntfy;
      fcm?: FcmSender | null;
      send?: Send;
      later?: Later;
      clock?: () => number;
      // a ringing call can be answered from the app (an account of the browsers container): its pushes offer it
      answerable?: boolean;
    },
  ) {
    this.recent = new RecentPushes(o.clock);
    this.now = o.clock ?? Date.now;
    this.schedule = o.later ?? later;
  }

  // The account the notifications come from, for an app that shows more than one
  private account() {
    return this.o.devices.account?.(parseState(Identity, this.o.store.getState(STATE.me)));
  }

  // A new Teams message: the same text within 150 s is notified once. On the device it replaces the notification
  // of the same chat, unless that one shows a newer message (ts, the time it was sent: sw.js); the notification opens
  // the app on `chat`, when known.
  async message(title: string, body: string, chat = "") {
    if (!this.recent.allow(body)) return;
    this.o.store.addNotification(title, body);
    await this.ntfy(title, body);
    await this.push(title, body, chat, "high", title, this.now());
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
  // chat) share one notification on the device, which keeps the newest (ts, ms).
  async push(title: string, body: string, chat = "", urgency: webpush.Urgency = "high", group = "", ts = 0): Promise<number> {
    // tag: the chat it belongs to, per account (the local relay has one, 0)
    return this.deliver((acc) => ({ title, body: body || "", chat, ...(group && { tag: chatTag(acc, group) }), ...(ts && { ts }) }), { urgency, ttl: PUSH_TTL, retry: true });
  }

  // An incoming Teams call, on a notification of its own per account: "ringing" when it starts, "again" every few
  // seconds while it rings, "ended" once it stops. While it rings every push alerts again on the device (sw.js), and
  // the push service keeps it only while the call could still be answered, with no retry: the next one follows in
  // seconds. Once it stops, the same notification turns quiet and stays a day. Safari devices get the start and the
  // end only: on an iPhone every push shows apart, the tag ignored (WebKit bug 258922); so do the phones of the
  // Android app, which loop the ringtone themselves until the end (a phone the first push did not reach gets the next
  // one), and ntfy, whose app keeps alerting for a message of priority 5 when its setting says so. Not in the history
  // of notified messages.
  // answered: the call ended because it was answered from the app
  async call(caller: string, state: "ringing" | "again" | "ended", since: number, seconds = 0, answered = false): Promise<number> {
    const ringing = state !== "ended";
    const title = ringing ? (caller ? `${caller} is calling` : "Incoming call") : caller ? `Call from ${caller}` : "Call ended";
    const body = ringing ? "Teams call, ringing now" : answered ? "Answered in TeamsRelay" : seconds ? `Ended after ${seconds} s` : "Ended";
    const chat = caller && this.o.store.isKnownChat(caller) ? caller : "";
    // a phone that did not take the first push of the call gets the next one, until one reaches it
    if (state === "ringing") this.phonesRinging = { since, took: new Set() };
    const took = this.phonesRinging?.since === since ? this.phonesRinging.took : null;
    // ntfy beside the devices, one message after the other so that the end of the call comes after its start: a slow
    // ntfy.sh holds no push of the call
    if (state !== "again") this.ntfyCalls = this.ntfyCalls.then(() => this.ntfyCall(title, body, since, ringing));
    const answer = ringing && this.o.answerable ? { answer: true } : {};
    return this.deliver((acc) => ({ title, body, chat, tag: callTag(acc), call: ringing ? "ringing" : "ended", ts: since, ...answer }), {
      urgency: "high",
      ttl: ringing ? CALL_TTL : PUSH_TTL,
      retry: !ringing,
      skip: state === "again" ? (t) => APPLE_PUSH.test(t.endpoint) || (isPhone(t) && (!took || took.has(t.endpoint))) : undefined,
      took: ringing && took ? (t) => void (isPhone(t) && took.add(t.endpoint)) : undefined,
    });
  }

  private ntfyCalls: Promise<void> = Promise.resolve();

  // The phones of the Android app the ringing call (since, when it started) reached: they ring on their own until it
  // ends, another push would start the ringtone again
  private phonesRinging: { since: number; took: Set<string> } | null = null;

  // A missed call the check of an account checked every N hours found in its Teams Activity feed: its browser did not
  // run while the call rang. A notification of its own, which alerts, and ntfy when enabled; time is the one Teams shows.
  async missedCall(caller: string, time: string): Promise<number> {
    const title = caller ? `Missed call from ${caller}` : "Missed call";
    const body = `Teams call${time ? ` at ${time}` : ""}, found by the check`;
    await this.ntfy(title, body);
    return this.push(title, body, caller && this.o.store.isKnownChat(caller) ? caller : "");
  }

  // Sends to every device, all at once, what `content` makes for the account (its slot, 0 for the local relay), the
  // title naming the account when the owner has more: Web Push to the browsers, a sealed FCM message to the phones.
  // Returns the devices the push service took on the first try; the ones it reported as gone are removed, the ones it
  // could not take now are tried again later when `retry`.
  private async deliver(
    content: (acc: number) => { title: string } & Record<string, unknown>,
    o: Delivery & { skip?: (t: PushTarget) => boolean; took?: (t: PushTarget) => void },
  ): Promise<number> {
    const { vapid, devices, fcm } = this.o;
    const targets = devices.targets().filter((t) => !o.skip?.(t));
    if (!targets.length) return 0;
    const account = this.account();
    const c = content(account?.acc ?? 0);
    const message = { ...c, title: pushTitle(c.title, account?.label ?? ""), ...(account ? { acc: account.acc } : {}) };
    const sends: Promise<boolean>[] = [];
    const browsers = targets.filter((t) => !isPhone(t));
    if (vapid && browsers.length) {
      const payload = JSON.stringify(message);
      const options: webpush.RequestOptions = {
        vapidDetails: { subject: this.o.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: o.ttl,
        urgency: o.urgency,
        timeout: 15_000,
      };
      sends.push(...browsers.map((t) => this.sendTo(t, payload, options, 0, o.retry).then((ok) => noteTook(ok, t, o.took))));
    }
    const phones = targets.filter(isPhone);
    if (phones.length && fcm) sends.push(...phones.map((t) => this.sendToPhone(t, message, o, 0).then((ok) => noteTook(ok, t, o.took))));
    else if (phones.length && !this.fcmMissing) {
      this.fcmMissing = true;
      log.warn("push", "phones of the Android app registered, but no Firebase service account key: FCM off");
    }
    // one push service that does not answer (15 s) holds no other device
    return (await Promise.all(sends)).filter(Boolean).length;
  }

  private fcmMissing = false;

  // A sealed FCM message to a phone of the Android app: high priority (wakes a phone in Doze) for an urgent push,
  // normal otherwise. A token FCM no longer knows is removed; 429, 5xx and no answer are tried again as for Web Push.
  private async sendToPhone(t: PushTarget, message: Record<string, unknown>, o: Delivery, attempt: number): Promise<boolean> {
    let phone: { token: string; key: string };
    try {
      phone = (JSON.parse(t.sub) as { fcm: { token: string; key: string } }).fcm;
    } catch {
      return false;
    }
    let status: number | undefined;
    let retryAfter: string | undefined;
    try {
      const r = await this.o.fcm!.send(phone.token, sealFitting(phone.key, message), { ttl: o.ttl, high: o.urgency === "high" });
      if (r.ok) {
        if (attempt) log.info("push", "sent on retry", { attempt, fcm: true });
        return true;
      }
      if (r.gone) {
        this.o.devices.remove(t.endpoint);
        // 403: a token of another Firebase project, which every phone has when the service account key is not of the
        // project the app was built with
        if (r.status === 403) log.warn("push", "phone of another Firebase project (SENDER_ID_MISMATCH), removed: key and app build must share one project");
        else log.info("push", "phone gone, removed", { status: r.status });
        return false;
      }
      ({ status, retryAfter } = r);
    } catch (e) {
      // no answer, or the access token refused: the status stays unknown
      log.warn("push", `FCM: ${errorText(e)}`, { attempt });
    }
    const wait = o.retry ? pushRetryDelay(status, retryAfter, attempt, this.now()) : null;
    if (status !== undefined) log.warn("push", `FCM answered ${status}`, { attempt, retry: wait ?? "none" });
    if (wait !== null) this.retryLater(wait, t.endpoint, attempt + 1, (x) => this.sendToPhone(x, message, o, attempt + 1));
    return false;
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
      const wait = retry && reached ? pushRetryDelay(status, Array.isArray(retryAfter) ? retryAfter[0] : retryAfter, attempt, this.now()) : null;
      log.warn("push", errorText(e), { status, attempt, retry: wait ?? "none" });
      if (wait !== null) this.retryLater(wait, t.endpoint, attempt + 1, (x) => this.sendTo(x, payload, options, attempt + 1));
      return false;
    }
  }

  // A retry in `wait` seconds goes to the device only while it is still one of the devices: a subscription can pass
  // to another user of the same browser, or be removed, while the retry waits. It runs on a timer, where an error of
  // the device store would be uncaught (the local relay stops on one): logged instead.
  private retryLater(wait: number, endpoint: string, attempt: number, send: (t: PushTarget) => Promise<boolean>) {
    const fields = { attempt, ...(isPhone({ endpoint }) && { fcm: true }) };
    this.schedule(wait * 1000, () => {
      const failed = (e: unknown) => log.warn("push", `retry: ${errorText(e)}`, fields);
      try {
        const t = this.o.devices.targets().find((x) => x.endpoint === endpoint);
        if (!t) return log.info("push", `${isPhone({ endpoint }) ? "phone" : "device"} gone before the retry`, { attempt });
        send(t).catch(failed);
      } catch (e) {
        failed(e);
      }
    });
  }

  // A call on ntfy: priority 5 while it rings, then the same notification (sequence id) at priority 2, quiet
  private async ntfyCall(title: string, body: string, since: number, ringing: boolean) {
    if (!this.o.ntfy) return;
    const account = this.account();
    await this.postNtfy({
      title: pushTitle(title, account?.label ?? "").slice(0, 100),
      message: body,
      priority: ringing ? 5 : 2,
      tags: ["telephone_receiver"],
      sequence_id: `call-${account?.acc ?? 0}-${since}`,
    });
  }

  private ntfy(title: string, body: string) {
    return this.postNtfy({ title: (title || "Teams").slice(0, 100), message: (body || "(new message)").slice(0, 1000), priority: 4, tags: ["speech_balloon"] });
  }

  private async postNtfy(message: Record<string, unknown>) {
    const ntfy = this.o.ntfy;
    if (!ntfy) return;
    try {
      await fetch(ntfy.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: ntfy.topic, ...message }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      log.warn("ntfy", errorText(e));
    }
  }
}
