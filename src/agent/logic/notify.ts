import type { Identity } from "@/shared/slot-db/state";

// How long the push service keeps a notification for a phone that is offline or asleep, in seconds
export const PUSH_TTL = 3600;

// The same text within this many seconds is pushed once (Teams list and Teams notification of one message)
export const PUSH_DEDUP_SECONDS = 150;

export class RecentPushes {
  private readonly seen = new Map<string, number>();

  constructor(private readonly clock: () => number = Date.now) {}

  allow(body: string): boolean {
    const key = body.trim().toLowerCase().slice(0, 60);
    const now = this.clock() / 1000;
    for (const [k, at] of this.seen) if (now - at > PUSH_DEDUP_SECONDS) this.seen.delete(k);
    if (!key) return true;
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }
}

// When the owner has more Teams accounts, the notification says which one: organization, otherwise email
export function accountLabel(ownerHasMany: boolean, me: Identity, slot: number): string {
  if (!ownerHasMany) return "";
  return me.tenant || me.email || `account ${slot}`;
}

export function pushTitle(title: string, label: string): string {
  return (title || "TeamsRelay") + (label ? ` · ${label}` : "");
}
