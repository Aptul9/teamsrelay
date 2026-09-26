import webpush from "web-push";
import { Identity, parseState, STATE } from "@/shared/slot-db/state";
import { accountLabel, chatTag, PUSH_TTL, pushRetryDelay, pushTitle, RecentPushes } from "../logic/notify";
import { errorText, log } from "../log";
import type { AppStore, PushTarget } from "../store/app-store";
import type { SlotStore } from "../store/slot-store";
import type { VapidKeys } from "./vapid";

type Send = (subscription: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;
type Later = (ms: number, fn: () => void) => void;
export type Ntfy = { url: string; topic: string } | null;

// Retries run on timers, so a push service that answers slowly or not at all never holds up the read loop
const later: Later = (ms, fn) => void setTimeout(fn, ms).unref();

// Notifications of the slot: Web Push to the devices of the slot owner, ntfy when enabled, and the history
// of the messages notified (messages table).
export class Notifier {
  private readonly recent: RecentPushes;

  constructor(
    private readonly o: {
      slot: number;
      store: SlotStore;
      app: AppStore;
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
  // of the same chat, which keeps the last lines (sw.js).
  async message(title: string, body: string) {
    if (!this.recent.allow(body)) return;
    this.o.store.addNotification(title, body);
    await this.ntfy(title, body);
    await this.deliver(title, body, "high", chatTag(this.o.slot, title));
  }

  // About the account itself: session expired, check outcome. Urgency high unless the caller says it can wait: a
  // phone on low battery asks its push service for high only (RFC 8030 section 5.3), and web-push sends normal.
  async push(title: string, body: string, urgency: webpush.Urgency = "high"): Promise<number> {
    return this.deliver(title, body, urgency, "");
  }

  // Push to every device of the owner. Returns the devices the push service took on the first try; the ones it
  // reported as gone are removed, the ones it could not take now are tried again later.
  private async deliver(title: string, body: string, urgency: webpush.Urgency, tag: string): Promise<number> {
    const { vapid, app, store, slot } = this.o;
    if (!vapid) return 0;
    const targets = app.pushTargets();
    if (!targets.length) return 0;
    const me = parseState(Identity, store.getState(STATE.me), Identity.parse({}));
    // acc: the notification opens the app on this account; tag: the chat it belongs to
    const payload = JSON.stringify({ title: pushTitle(title, accountLabel(app.ownerHasManyAccounts(), me, slot)), body: body || "", acc: slot, ...(tag && { tag }) });
    const options: webpush.RequestOptions = {
      vapidDetails: { subject: this.o.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: PUSH_TTL,
      urgency,
      timeout: 15_000,
    };
    let sent = 0;
    for (const t of targets) if (await this.sendTo(t, payload, options, 0)) sent++;
    return sent;
  }

  private async sendTo(t: PushTarget, payload: string, options: webpush.RequestOptions, attempt: number): Promise<boolean> {
    const send: Send = this.o.send ?? webpush.sendNotification;
    try {
      await send(JSON.parse(t.sub) as webpush.PushSubscription, payload, options);
      if (attempt) log.info("push", "sent on retry", { attempt });
      return true;
    } catch (e) {
      const { statusCode: status, headers } = e as { statusCode?: number; headers?: Record<string, string | string[] | undefined> };
      if (status === 404 || status === 410) {
        this.o.app.deleteSubscription(t.endpoint);
        return false;
      }
      const retryAfter = headers?.["retry-after"];
      const wait = pushRetryDelay(status, Array.isArray(retryAfter) ? retryAfter[0] : retryAfter, attempt, (this.o.clock ?? Date.now)());
      log.warn("push", errorText(e), { status, attempt, retry: wait ?? "none" });
      if (wait !== null) (this.o.later ?? later)(wait * 1000, () => void this.sendTo(t, payload, options, attempt + 1));
      return false;
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
