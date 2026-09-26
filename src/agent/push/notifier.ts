import webpush from "web-push";
import { PUSH_TTL, RecentPushes } from "../logic/notify";
import { errorText, log } from "../log";
import type { SlotStore } from "../store/slot-store";
import type { VapidKeys } from "./vapid";

type Send = (subscription: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;
export type Ntfy = { url: string; topic: string } | null;

// Notifications of the relay: Web Push to every device subscribed from the app, ntfy when a topic is set, and the
// history of the messages notified (messages table). Outbound only: the push service delivers to the phone.
export class Notifier {
  private readonly recent: RecentPushes;

  constructor(
    private readonly o: {
      store: SlotStore;
      vapid: VapidKeys | null;
      subject: string;
      ntfy: Ntfy;
      send?: Send;
      clock?: () => number;
    },
  ) {
    this.recent = new RecentPushes(o.clock);
  }

  // A new Teams message: the same text within 150 s is notified once. The notification opens the app on the chat.
  async message(chat: string, body: string) {
    if (!this.recent.allow(body)) return;
    this.o.store.addNotification(chat, body);
    await this.ntfy(chat, body);
    await this.push(chat, body, chat);
  }

  // About the relay itself (Teams signed out, check outcome): push and ntfy, no history
  async alert(title: string, body: string, urgency: webpush.Urgency = "high"): Promise<number> {
    await this.ntfy(title, body);
    return this.push(title, body, "", urgency);
  }

  // Push to every device; subscriptions the push service reports as gone are removed. Urgency high: a phone on low
  // battery asks its push service for high only (RFC 8030 section 5.3), and web-push sends normal unless told.
  async push(title: string, body: string, chat = "", urgency: webpush.Urgency = "high"): Promise<number> {
    const { vapid, store } = this.o;
    if (!vapid) return 0;
    const targets = store.pushSubscriptions();
    if (!targets.length) return 0;
    const payload = JSON.stringify({ title: title || "Teams", body: body || "", chat });
    const send: Send = this.o.send ?? webpush.sendNotification;
    let sent = 0;
    for (const t of targets) {
      try {
        await send(JSON.parse(t.sub) as webpush.PushSubscription, payload, {
          vapidDetails: { subject: this.o.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          TTL: PUSH_TTL,
          urgency,
          timeout: 15_000,
        });
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          store.deletePushSubscription(t.endpoint);
          log.info("push", "device gone, removed", { status });
        } else log.warn("push", errorText(e), { status });
      }
    }
    return sent;
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
