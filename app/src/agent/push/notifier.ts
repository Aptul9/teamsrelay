import webpush from "web-push";
import { Identity, parseState, STATE } from "@/shared/slot-db/state";
import { PUSH_TTL, pushTitle, RecentPushes } from "../logic/notify";
import { errorText, log } from "../log";
import type { SlotStore } from "../store/slot-store";
import type { VapidKeys } from "./vapid";

type Send = (subscription: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;
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

  deviceCount(): number {
    return this.o.devices.targets().length;
  }

  // Push to every device; subscriptions the push service reports as gone are removed
  async push(title: string, body: string): Promise<number> {
    const { vapid, devices, store } = this.o;
    if (!vapid) return 0;
    const targets = devices.targets();
    if (!targets.length) return 0;
    const account = devices.account?.(parseState(Identity, store.getState(STATE.me), Identity.parse({})));
    const payload = JSON.stringify({ title: pushTitle(title, account?.label ?? ""), body: body || "", ...(account ? { acc: account.acc } : {}) });
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
        if (status === 404 || status === 410) devices.remove(t.endpoint);
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
