import { parseState, Viewing } from "@/shared/slot-db/state";

// Seconds without a mark of the app before Teams goes back to the self chat. The app marks the chat it shows every
// 10 s and says at once when it stops showing it (a viewing without chat): this is for an app gone without a word.
export const PARK_AFTER = 30;

// The chat the app shows now, "" when none: marked less than PARK_AFTER seconds ago, not left since
export function shownInApp(viewing: Viewing, nowSeconds: number): string {
  return viewing.chat && nowSeconds - viewing.ts < PARK_AFTER ? viewing.chat : "";
}

// The Teams page counts as seen by the user, so it marks as read what arrives in the open chat. Teams shows
// the chat in use in the app while the app shows it (viewing, marked by the app and by every command),
// otherwise the self chat. Without a self chat the open chat stays.
export function wantedChat(active: string, viewing: string, nowSeconds: number, selfChat: string): string {
  if (active && shownInApp(parseState(Viewing, viewing, { chat: "", ts: 0 }), nowSeconds)) return active;
  return selfChat || active;
}
