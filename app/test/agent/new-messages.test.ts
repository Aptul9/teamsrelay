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

  // Teams shows the time of the last message for about a day (6:18 PM the next morning), then its date
  it("does not notify a message again when its time turns into its date", () => {
    const d = primed(row("Anna Rossi", "are you there?", "6:18 PM"), row("Luca Bianchi", "deploy is green", "18:05"));
    expect(d.scan([row("Anna Rossi", "are you there?", "9/26"), row("Luca Bianchi", "deploy is green", "9/26")])).toEqual([]);
  });

  // prod 2026-09-30: someone typing the next message makes the row show no preview for a while; the message already
  // notified and read came back afterwards and went out again (2026-09-29: "Codrut: Noted" 5.5 h after it came)
  it("does not notify a message again when the row shows it again after showing something else", () => {
    const d = primed(row("MOSSO Diego", "ciao", "2:20 PM"));
    expect(d.scan([row("MOSSO Diego", "cosa intendi?", "2:22 PM", true)])).toEqual([{ chat: "MOSSO Diego", body: "cosa intendi?" }]);
    expect(d.scan([row("MOSSO Diego", "cosa intendi?", "2:22 PM")])).toEqual([]);
    expect(d.scan([row("MOSSO Diego", "", "")])).toEqual([]);
    expect(d.scan([row("MOSSO Diego", "cosa intendi?", "2:22 PM")])).toEqual([]);
  });

  it("does not notify an older message the row goes back to (the newer one deleted)", () => {
    const d = primed(row("Anna Rossi", "ciao", "10:30"));
    expect(d.scan([row("Anna Rossi", "are you there?", "10:31")])).toHaveLength(1);
    expect(d.scan([row("Anna Rossi", "ciao", "10:30")])).toEqual([]);
  });

  it("notifies the next message after the row showed something else", () => {
    const d = primed(row("Anna Rossi", "ciao", "10:30"));
    expect(d.scan([row("Anna Rossi", "", "")])).toEqual([]);
    expect(d.scan([row("Anna Rossi", "are you there?", "10:31")])).toEqual([{ chat: "Anna Rossi", body: "are you there?" }]);
  });

  it("notifies the same text sent again, at a new time", () => {
    const d = primed(row("Anna Rossi", "ok", "9/26"), row("Luca Bianchi", "ok", "10:02 AM"));
    expect(d.scan([row("Anna Rossi", "ok", "10:05 AM"), row("Luca Bianchi", "ok", "10:07 AM")])).toEqual([
      { chat: "Anna Rossi", body: "ok" },
      { chat: "Luca Bianchi", body: "ok" },
    ]);
  });
});
