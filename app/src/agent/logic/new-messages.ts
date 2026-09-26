import { TEXTS } from "../teams/selectors";

export type ListedChat = { name: string; preview: string; time: string; unread: boolean; muted: boolean };
export type NewMessage = { chat: string; body: string };

// New messages from the chat list, independent of the notifications of Teams. Main signal: preview or time of
// a chat change with an incoming text. Fallback: the chat turns unread. The first list only primes the state;
// the chat with yourself and muted chats never notify.
export class NewMessageDetector {
  private primed = false;
  private readonly signature = new Map<string, string>();
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
        const changed = inbound && this.signature.has(ch.name) && this.signature.get(ch.name) !== sig;
        const becameUnread = this.unread.get(ch.name) !== true && ch.unread;
        if (changed || becameUnread) {
          const key = `${sig}|${ch.unread ? "u" : "r"}`;
          if (this.lastNotified.get(ch.name) !== key) {
            out.push({ chat: ch.name, body: inbound ? preview : `New message from ${ch.name}` });
            this.lastNotified.set(ch.name, key);
          }
        }
      }
      this.signature.set(ch.name, sig);
      this.unread.set(ch.name, ch.unread);
    }
    this.primed = true;
    return out;
  }
}
