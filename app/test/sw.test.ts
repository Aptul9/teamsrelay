import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Shown = { title: string; body: string; tag: string; renotify?: boolean; data: { lines?: string[] } };

// public/sw.js run with the service worker globals it uses. The fake registration keeps what a device shows: one
// notification per tag, the last one shown with it, until the user dismisses it.
function serviceWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const displayed = new Map<string, Shown>();
  const registration = {
    showNotification: async (title: string, options: Omit<Shown, "title">) => {
      const n = JSON.parse(JSON.stringify({ title, ...options })) as Shown;
      shown.push(n);
      displayed.set(n.tag, n);
    },
    getNotifications: async ({ tag }: { tag: string }) => (displayed.has(tag) ? [displayed.get(tag)] : []),
  };
  const clients = { claim: async () => undefined };
  const self = { addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn), registration, skipWaiting: () => undefined, clients };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../public/sw.js"), "utf8"), { self, clients });
  return {
    shown,
    dismiss: (tag: string) => displayed.delete(tag),
    push: async (data: unknown) => {
      const pending: Promise<unknown>[] = [];
      listeners.get("push")?.({ data: { json: () => data, text: () => JSON.stringify(data) }, waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await Promise.all(pending);
      return shown[shown.length - 1];
    },
  };
}

describe("service worker notifications", () => {
  it("shows a push without tag on its own", async () => {
    const sw = serviceWorker();
    const n = await sw.push({ title: "Teams OK", body: "Automatic check: the whole chain works.", acc: 1 });
    expect(n.title).toBe("Teams OK");
    expect(n.body).toBe("Automatic check: the whole chain works.");
    expect(n.tag).toMatch(/^teams-\d+$/);
    expect(n.renotify).toBeUndefined();
  });

  it("keeps one notification per chat with its last five lines, alerting again", async () => {
    const sw = serviceWorker();
    for (const body of ["one", "two", "three", "four", "five", "six", "seven"]) await sw.push({ title: "Anna Rossi", body, acc: 1, tag: "chat-1-Anna Rossi" });
    const n = sw.shown[sw.shown.length - 1];
    expect(n).toMatchObject({ title: "Anna Rossi", body: "three\nfour\nfive\nsix\nseven", tag: "chat-1-Anna Rossi", renotify: true });
    expect(n.data).toMatchObject({ acc: 1, tag: "chat-1-Anna Rossi", lines: ["three", "four", "five", "six", "seven"] });
  });

  it("does not mix the lines of two chats", async () => {
    const sw = serviceWorker();
    await sw.push({ title: "Anna Rossi", body: "a1", acc: 1, tag: "chat-1-Anna Rossi" });
    await sw.push({ title: "Luca Bianchi", body: "b1", acc: 1, tag: "chat-1-Luca Bianchi" });
    expect((await sw.push({ title: "Anna Rossi", body: "a2", acc: 1, tag: "chat-1-Anna Rossi" })).body).toBe("a1\na2");
  });

  it("starts over when the notification of the chat was dismissed", async () => {
    const sw = serviceWorker();
    await sw.push({ title: "Anna Rossi", body: "old", acc: 1, tag: "chat-1-Anna Rossi" });
    sw.dismiss("chat-1-Anna Rossi");
    expect((await sw.push({ title: "Anna Rossi", body: "new", acc: 1, tag: "chat-1-Anna Rossi" })).body).toBe("new");
  });
});
