import { TEXTS } from "../teams/selectors";

export type ListedChat = { name: string; preview: string; time: string; unread: boolean; muted: boolean };
export type NewMessage = { chat: string; body: string };

// The list shows the time of the last message for about a day, then its date: a time that turns into a date is
// the same message getting older
const CLOCK = /^\d{1,2}:\d{2}\s?(AM|PM)?$/i;
const DATE = /^\d{1,2}\/\d{1,2}$/;
const aged = (before: string, now: string) => CLOCK.test(before) && DATE.test(now);

// New messages from the chat list, independent of the notifications of Teams. Main signal: preview or time of
// a chat change with an incoming text. Fallback: the chat turns unread. The first list only primes the state;
// the chat with yourself and muted chats never notify.
export class NewMessageDetector {
  private primed = false;
  private readonly last = new Map<string, { preview: string; time: string }>();
  private readonly unread = new Map<string, boolean>();
  private readonly lastNotified = new Map<string, string>();

  scan(chats: readonly ListedChat[]): NewMessage[] {
    const out: NewMessage[] = [];
    for (const ch of chats) {
      if (!ch.name) continue;
      const preview = (ch.preview || "").trim();
      const sig = `${preview}|${ch.time}`;
      if (this.primed && !ch.name.toLowerCase().includes(TEXTS.selfChat.toLowerCase()) && !ch.muted) {
        const inbound = !!preview && !TEXTS.outbound.test(preview);
        const before = this.last.get(ch.name);
        const changed = inbound && !!before && (before.preview !== preview || (before.time !== ch.time && !aged(before.time, ch.time)));
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
      this.unread.set(ch.name, ch.unread);
    }
    this.primed = true;
    return out;
  }
}
