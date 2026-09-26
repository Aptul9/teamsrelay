import { describe, expect, it } from "vitest";
import { NewMessageDetector, type ListedChat } from "@/agent/logic/new-messages";

const row = (name: string, preview: string, time: string, unread = false, muted = false): ListedChat => ({ name, preview, time, unread, muted });

function primed(...chats: ListedChat[]) {
  const d = new NewMessageDetector();
  expect(d.scan(chats)).toEqual([]);
  return d;
}

describe("new message detection", () => {
  it("only learns the list on the first read", () => {
    const d = new NewMessageDetector();
    expect(d.scan([row("Anna Rossi", "ciao", "10:30", true)])).toEqual([]);
  });

  it("notifies an incoming preview that changed", () => {
    const d = primed(row("Anna Rossi", "ciao", "10:30"));
    expect(d.scan([row("Anna Rossi", "are you there?", "10:31")])).toEqual([{ chat: "Anna Rossi", body: "are you there?" }]);
    expect(d.scan([row("Anna Rossi", "are you there?", "10:31")])).toEqual([]);
  });

  it("ignores your own messages in the preview", () => {
    const d = primed(row("Anna Rossi", "ciao", "10:30"), row("Luca Bianchi", "ok", "9:00"));
    expect(d.scan([row("Anna Rossi", "You: on my way", "10:32"), row("Luca Bianchi", "Tu: va bene", "10:33")])).toEqual([]);
  });

  it("names the chat when it turns unread without an incoming preview", () => {
    const d = primed(row("Project Alpha", "You: deployed", "9:58"));
    expect(d.scan([row("Project Alpha", "You: deployed", "9:58", true)])).toEqual([{ chat: "Project Alpha", body: "New message from Project Alpha" }]);
  });

  it("never notifies the self chat or a muted chat", () => {
    const d = primed(row("Anna Rossi (You)", "notes", "9:00"), row("Release notes", "build 1.4.1", "9:00", false, true));
    expect(d.scan([row("Anna Rossi (You)", "more notes", "9:05", true), row("Release notes", "build 1.4.2", "9:06", true, true)])).toEqual([]);
  });

  it("notifies a chat that appears unread, not one that appears read", () => {
    const d = primed(row("Anna Rossi", "ciao", "10:30"));
    expect(d.scan([row("Marco Neri", "hello", "10:40", true), row("Sara Gialli", "hi", "10:41", false)])).toEqual([{ chat: "Marco Neri", body: "hello" }]);
  });

  it("does not notify the same message twice when the chat goes read and unread again", () => {
    const d = primed(row("Anna Rossi", "ciao", "10:30"));
    expect(d.scan([row("Anna Rossi", "ciao", "10:30", true)])).toHaveLength(1);
    expect(d.scan([row("Anna Rossi", "ciao", "10:30", false)])).toEqual([]);
    expect(d.scan([row("Anna Rossi", "ciao", "10:30", true)])).toEqual([]);
  });
});
