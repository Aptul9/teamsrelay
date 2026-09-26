import { parseState, Viewing } from "@/shared/slot-db/state";

// Seconds without the app showing a chat before Teams goes back to the self chat
export const PARK_AFTER = 90;

// The Teams page counts as seen by the user, so it marks as read what arrives in the open chat. Teams shows
// the chat in use in the app while the app shows it (viewing, refreshed by the web app and by every command),
// otherwise the self chat. Without a self chat the open chat stays.
export function wantedChat(active: string, viewing: string, nowSeconds: number, selfChat: string): string {
  const { ts } = parseState(Viewing, viewing, { chat: "", ts: 0 });
  if (active && nowSeconds - ts < PARK_AFTER) return active;
  return selfChat || active;
}
