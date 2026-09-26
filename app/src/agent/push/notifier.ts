import webpush from "web-push";
import { Identity, parseState, STATE } from "@/shared/slot-db/state";
import { accountLabel, PUSH_TTL, pushTitle, RecentPushes } from "../logic/notify";
import { errorText, log } from "../log";
import type { AppStore } from "../store/app-store";
import type { SlotStore } from "../store/slot-store";
import type { VapidKeys } from "./vapid";

type Send = (subscription: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;
export type Ntfy = { url: string; topic: string } | null;

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
      clock?: () => number;
    },
  ) {
    this.recent = new RecentPushes(o.clock);
  }

  // A new Teams message: the same text within 150 s is notified once
  async message(title: string, body: string) {
    if (!this.recent.allow(body)) return;
    this.o.store.addNotification(title, body);
    await this.ntfy(title, body);
    await this.push(title, body);
  }

  // Push to every device of the owner; subscriptions the push service reports as gone are removed
  async push(title: string, body: string): Promise<number> {
    const { vapid, app, store, slot } = this.o;
    if (!vapid) return 0;
    const targets = app.pushTargets();
    if (!targets.length) return 0;
    const me = parseState(Identity, store.getState(STATE.me), Identity.parse({}));
    // acc: the notification opens the app on this account
    const payload = JSON.stringify({ title: pushTitle(title, accountLabel(app.ownerHasManyAccounts(), me, slot)), body: body || "", acc: slot });
    const send: Send = this.o.send ?? webpush.sendNotification;
    let sent = 0;
    for (const t of targets) {
      try {
        await send(JSON.parse(t.sub) as webpush.PushSubscription, payload, {
          vapidDetails: { subject: this.o.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          TTL: PUSH_TTL,
        });
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) app.deleteSubscription(t.endpoint);
        else log.warn("push", errorText(e), { status });
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
