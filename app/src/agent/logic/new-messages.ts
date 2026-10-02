import { TEXTS } from "../teams/selectors";
import { isSelfChat } from "./chats";

export type ListedChat = { name: string; preview: string; time: string; unread: boolean; muted: boolean };
export type NewMessage = { chat: string; body: string };

// The list shows the time of the last message for about a day, then its date: a time that turns into a date is
// the same message getting older
const CLOCK = /^\d{1,2}:\d{2}\s?(AM|PM)?$/i;
const DATE = /^\d{1,2}\/\d{1,2}$/;
const aged = (before: string, now: string) => CLOCK.test(before) && DATE.test(now);

// Last messages of a chat the list showed, kept to tell one it shows again from a new one
const SEEN_PER_CHAT = 8;

// New messages from the chat list, independent of the notifications of Teams. Main signal: preview or time of
// a chat change to an incoming text the chat did not show before. The row of a chat can show something else for a
// while (someone typing the next message, prod 2026-09-30) and then its last message again, or an older one when the
// last is deleted: those are no new messages. Fallback: the chat turns unread. The first list only primes the state;
// the chat with yourself and muted chats never notify.
export class NewMessageDetector {
  private primed = false;
  private readonly last = new Map<string, { preview: string; time: string }>();
  private readonly seen = new Map<string, { preview: string; time: string }[]>();
  private readonly unread = new Map<string, boolean>();
  private readonly lastNotified = new Map<string, string>();

  scan(chats: readonly ListedChat[]): NewMessage[] {
    const out: NewMessage[] = [];
    for (const ch of chats) {
      if (!ch.name) continue;
      const preview = (ch.preview || "").trim();
      const sig = `${preview}|${ch.time}`;
      if (this.primed && !isSelfChat(ch.name) && !ch.muted) {
        const inbound = !!preview && !TEXTS.outbound.test(preview);
        const changed = inbound && this.last.has(ch.name) && !this.shown(ch.name, preview, ch.time);
        const becameUnread = this.unread.get(ch.name) !== true && ch.unread;
        if (changed || becameUnread) {
          const key = `${sig}|${ch.unread ? "u" : "r"}`;
          if (this.lastNotified.get(ch.name) !== key) {
            out.push({ chat: ch.name, body: inbound ? preview : `New message from ${ch.name}` });
            this.lastNotified.set(ch.name, key);
          }
        }
      }
      this.last.set(ch.name, { preview, time: ch.time });
      if (preview) this.remember(ch.name, preview, ch.time);
      this.unread.set(ch.name, ch.unread);
    }
    this.primed = true;
    return out;
  }

  // The chat showed this message before: same text at the same time, or at the time it had before it turned into a date
  private shown(chat: string, preview: string, time: string): boolean {
    return (this.seen.get(chat) ?? []).some((s) => s.preview === preview && (s.time === time || aged(s.time, time)));
  }

  // The last messages the row of a chat showed, the newest last
  private remember(chat: string, preview: string, time: string) {
    const kept = (this.seen.get(chat) ?? []).filter((s) => s.preview !== preview || s.time !== time);
    this.seen.set(chat, [...kept, { preview, time }].slice(-SEEN_PER_CHAT));
  }
}
