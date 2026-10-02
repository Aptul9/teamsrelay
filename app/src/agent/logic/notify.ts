import type { Identity } from "@/shared/slot-db/state";

// How long the push service keeps a notification for a phone that is offline or asleep, in seconds. A phone back
// after a night gets one notification per chat: the service worker groups them by tag.
export const PUSH_TTL = 86_400;

// How long the push service keeps a push of a call still ringing, in seconds: later it could not be answered
export const CALL_TTL = 60;

// The same text within this many seconds is pushed once (Teams list and Teams notification of one message)
export const PUSH_DEDUP_SECONDS = 150;

// Seconds before the next try of a push the push service could not take: 5xx, no answer, 429 without Retry-After
const PUSH_RETRY_DELAYS = [5, 30, 120];

// A longer Retry-After of a 429 is cut to this, in seconds
const PUSH_RETRY_AFTER_MAX = 900;

// Wait before trying a push again after this failed attempt (0 = the first send), or null: other 4xx are refusals
// the same request would get again, and the attempts are over after the last delay
export function pushRetryDelay(status: number | undefined, retryAfter: string | undefined, attempt: number, now: number): number | null {
  if (attempt >= PUSH_RETRY_DELAYS.length) return null;
  if (status === 429) return retryAfterSeconds(retryAfter, now) ?? PUSH_RETRY_DELAYS[attempt];
  if (status === undefined || status >= 500) return PUSH_RETRY_DELAYS[attempt];
  return null;
}

// Retry-After is seconds or an HTTP date (RFC 9110). Date.parse alone would also read "1.5" or "-5" as dates.
function retryAfterSeconds(value: string | undefined, now: number): number | null {
  const v = value?.trim();
  if (!v) return null;
  const s = /^\d+$/.test(v) ? Number(v) : /[a-z]{3}/i.test(v) ? (Date.parse(v) - now) / 1000 : NaN;
  if (!Number.isFinite(s)) return null;
  return Math.min(Math.max(Math.ceil(s), 1), PUSH_RETRY_AFTER_MAX);
}

// The notifications of one chat share this tag on the device
export const chatTag = (slot: number, chat: string) => `chat-${slot}-${chat}`;

// A call has one notification per account on the device: ringing, then ended
export const callTag = (slot: number) => `call-${slot}`;

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
