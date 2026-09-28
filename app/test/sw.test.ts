import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Shown = {
  title: string;
  body: string;
  tag: string;
  renotify?: boolean;
  requireInteraction?: boolean;
  silent?: boolean;
  vibrate?: number[];
  actions?: { action: string; title: string }[];
  timestamp?: number;
  data: { lines?: string[] };
};

// A window of the app, as the service worker sees it. bell: what its page answers when asked to ring the bell of a
// message (App.tsx): it plays it, it may not play sound (a tab not clicked yet), or it never answers (a page the
// browser froze). asked: the messages it got.
function appWindow(visibilityState: string, bell: "plays" | "quiet" | "no answer") {
  const asked: unknown[] = [];
  return {
    visibilityState,
    asked,
    postMessage: (message: unknown, ports: MessagePort[] = []) => {
      asked.push(message);
      if (bell !== "no answer") ports[0]?.postMessage({ played: bell === "plays" });
    },
  };
}

// public/sw.js run with the service worker globals it uses. The fake registration keeps what a device shows: one
// notification per tag, the last one shown with it, until the user dismisses it. windows: the windows of the app open
// now; badges: what the service worker put on the icon of the installed app ("dot" without a number).
// fetch: what the server answers the requests of the service worker (a rejection is a network error); opened: the
// windows it opened
function serviceWorker(o: { windows?: ({ visibilityState: string } | ReturnType<typeof appWindow>)[]; fetch?: (url: string, init: RequestInit) => Promise<unknown> } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const badges: (number | "dot")[] = [];
  const displayed = new Map<string, Shown>();
  const requests: { url: string; init: RequestInit }[] = [];
  const opened: string[] = [];
  const registration = {
    showNotification: async (title: string, options: Omit<Shown, "title">) => {
      const n = JSON.parse(JSON.stringify({ title, ...options })) as Shown;
      shown.push(n);
      displayed.set(n.tag, n);
    },
    getNotifications: async ({ tag }: { tag: string }) => (displayed.has(tag) ? [displayed.get(tag)] : []),
  };
  const clients = { claim: async () => undefined, matchAll: async () => o.windows ?? [], openWindow: async (url: string) => void opened.push(url) };
  const navigator = { setAppBadge: async (n?: number) => void badges.push(n ?? "dot") };
  const self = { addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn), registration, skipWaiting: () => undefined, clients, navigator };
  const fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return (o.fetch ?? (async () => ({ ok: false, status: 404, json: async () => ({}) })))(url, init);
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../public/sw.js"), "utf8"), { self, clients, setTimeout, clearTimeout, MessageChannel, fetch });
  return {
    shown,
    badges,
    requests,
    opened,
    // a tap on the notification, on its body or on one of its buttons (action)
    click: async (data: unknown, action = "") => {
      const pending: Promise<unknown>[] = [];
      listeners.get("notificationclick")?.({ notification: { data, close: () => undefined }, action, waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await Promise.all(pending);
    },
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

  it("keeps every line of pushes that arrive together", async () => {
    const sw = serviceWorker();
    await Promise.all(["one", "two", "three"].map((body) => sw.push({ title: "Anna Rossi", body, acc: 1, tag: "chat-1-Anna Rossi" })));
    expect(sw.shown[sw.shown.length - 1].body).toBe("one\ntwo\nthree");
  });

  it("shows a line sent again without adding it or alerting", async () => {
    const sw = serviceWorker();
    await sw.push({ title: "Anna Rossi", body: "one", acc: 1, tag: "chat-1-Anna Rossi" });
    const n = await sw.push({ title: "Anna Rossi", body: "one", acc: 1, tag: "chat-1-Anna Rossi" });
    expect(n).toMatchObject({ body: "one", renotify: false });
  });

  it("starts over when the notification of the chat was dismissed", async () => {
    const sw = serviceWorker();
    await sw.push({ title: "Anna Rossi", body: "old", acc: 1, tag: "chat-1-Anna Rossi" });
    sw.dismiss("chat-1-Anna Rossi");
    expect((await sw.push({ title: "Anna Rossi", body: "new", acc: 1, tag: "chat-1-Anna Rossi" })).body).toBe("new");
  });
});

describe("service worker call notifications", () => {
  const ringing = { title: "Anna Rossi is calling", body: "Teams call, ringing now", chat: "", acc: 2, tag: "call-2", call: "ringing", ts: 1_790_000_000_000 };

  it("rings: stays on screen with a button (Windows keeps it only with one), vibrates, alerts at every push", async () => {
    const sw = serviceWorker();
    await sw.push(ringing);
    const n = await sw.push(ringing);
    expect(sw.shown).toHaveLength(2);
    expect(n).toMatchObject({ title: "Anna Rossi is calling", body: "Teams call, ringing now", tag: "call-2", renotify: true, requireInteraction: true, silent: false, timestamp: 1_790_000_000_000 });
    expect(n.actions).toEqual([{ action: "open", title: "Open" }]);
    expect(n.vibrate?.length).toBeGreaterThan(2);
    expect(n.data).toMatchObject({ acc: 2, call: "ringing" });
  });

  it("turns quiet on the same notification when the call ends", async () => {
    const sw = serviceWorker();
    await sw.push(ringing);
    const n = await sw.push({ ...ringing, title: "Call from Anna Rossi", body: "Ended after 9 s", call: "ended" });
    expect(n).toMatchObject({ title: "Call from Anna Rossi", body: "Ended after 9 s", tag: "call-2", renotify: false, requireInteraction: false, silent: true });
    expect(n.actions).toBeUndefined();
    expect(n.vibrate).toBeUndefined();
  });

  it("keeps the notification of a newer call when a late push of an older one arrives (a retry)", async () => {
    const sw = serviceWorker();
    await sw.push({ ...ringing, ts: 9000 });
    const n = await sw.push({ ...ringing, title: "Call from Anna Rossi", body: "Ended after 9 s", call: "ended", ts: 1000 });
    expect(n).toMatchObject({ title: "Anna Rossi is calling", body: "Teams call, ringing now", tag: "call-2", requireInteraction: true, silent: true, renotify: false });
    expect(n.vibrate).toBeUndefined();
  });

  it("keeps an ended call quiet when a late ringing push of the same call arrives", async () => {
    const sw = serviceWorker();
    await sw.push({ ...ringing, title: "Call from Anna Rossi", body: "Ended after 9 s", call: "ended" });
    const n = await sw.push(ringing);
    expect(n).toMatchObject({ title: "Call from Anna Rossi", silent: true, requireInteraction: false });
  });

  it("offers Answer beside Open while a call of an account that can answer from the app rings, nothing once it ended", async () => {
    const sw = serviceWorker();
    const n = await sw.push({ ...ringing, answer: true });
    expect(n.actions).toEqual([
      { action: "answer", title: "Answer" },
      { action: "open", title: "Open" },
    ]);
    expect((await sw.push({ ...ringing, answer: true, title: "Call from Anna Rossi", body: "Ended after 9 s", call: "ended" })).actions).toBeUndefined();
  });

  it("Answer asks the server to answer that call, then opens the remote desktop it names", async () => {
    const sw = serviceWorker({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, id: 7, desktop: "/api/desktop/2" }) }) });
    await sw.click({ ...ringing, answer: true }, "answer");
    expect(sw.requests).toHaveLength(1);
    expect(sw.requests[0].url).toBe("/api/call/answer?a=2");
    expect(sw.requests[0].init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(sw.requests[0].init.body))).toEqual({ since: 1_790_000_000_000 });
    expect(sw.opened).toEqual(["/api/desktop/2"]);
  });

  it("opens the app on the account when the server refuses the answer or cannot be reached", async () => {
    const refused = serviceWorker({ fetch: async () => ({ ok: false, status: 409, json: async () => ({ detail: "Call no longer ringing" }) }) });
    await refused.click({ ...ringing, answer: true }, "answer");
    const offline = serviceWorker({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await offline.click({ ...ringing, answer: true }, "answer");
    expect([refused.opened, offline.opened]).toEqual([["/?a=2"], ["/?a=2"]]);
  });

  it("Open, or a tap on the notification, opens the app on the account and answers nothing", async () => {
    const sw = serviceWorker();
    await sw.click({ ...ringing, answer: true }, "open");
    await sw.click({ ...ringing, answer: true });
    expect(sw.requests).toEqual([]);
    expect(sw.opened).toEqual(["/?a=2", "/?a=2"]);
  });

  it("keeps a call apart from the lines of a chat of the same person", async () => {
    const sw = serviceWorker();
    await sw.push({ title: "Anna Rossi", body: "are you there?", acc: 2, tag: "chat-2-Anna Rossi" });
    const n = await sw.push(ringing);
    expect(n.body).toBe("Teams call, ringing now");
    expect((await sw.push({ title: "Anna Rossi", body: "hello?", acc: 2, tag: "chat-2-Anna Rossi" })).body).toBe("are you there?\nhello?");
  });
});

describe("service worker app icon", () => {
  it("puts a dot on the icon of the installed app for a push while no window of the app is on screen", async () => {
    const closed = serviceWorker();
    await closed.push({ title: "Anna Rossi", body: "ciao", acc: 2, tag: "chat-2-Anna Rossi" });
    expect(closed.badges).toEqual(["dot"]);
    const hidden = serviceWorker({ windows: [{ visibilityState: "hidden" }] });
    await hidden.push({ title: "Anna Rossi is calling", body: "Teams call, ringing now", acc: 2, tag: "call-2", call: "ringing", ts: 1000 });
    expect(hidden.badges).toEqual(["dot"]);
  });

  it("leaves the icon to the app on screen, which shows the count, and adds nothing for a call that ended", async () => {
    const open = serviceWorker({ windows: [{ visibilityState: "hidden" }, { visibilityState: "visible" }] });
    await open.push({ title: "Anna Rossi", body: "ciao", acc: 2, tag: "chat-2-Anna Rossi" });
    expect(open.badges).toEqual([]);
    const closed = serviceWorker();
    await closed.push({ title: "Call from Anna Rossi", body: "Ended after 9 s", acc: 2, tag: "call-2", call: "ended", ts: 1000 });
    expect(closed.badges).toEqual([]);
  });
});

describe("service worker app icon of the local relay", () => {
  it("puts no dot for a push without an account: the page of the local relay never takes it away", async () => {
    const closed = serviceWorker();
    await closed.push({ title: "Anna Rossi", body: "ciao", chat: "Anna Rossi", tag: "chat-0-Anna Rossi" });
    expect(closed.badges).toEqual([]);
  });
});

describe("service worker bell of the app", () => {
  const message = { title: "Anna Rossi", body: "ciao", acc: 2, tag: "chat-2-Anna Rossi" };

  it("lets an open window ring the bell of a message instead of the sound of the device: the notification is quiet", async () => {
    const w = appWindow("visible", "plays");
    const sw = serviceWorker({ windows: [w] });
    const n = await sw.push(message);
    expect(n).toMatchObject({ title: "Anna Rossi", body: "ciao", renotify: true, silent: true });
    // no account in it: a message with one switches the account on screen (App.tsx)
    expect(w.asked).toEqual([{ type: "bell" }]);
  });

  it("keeps the sound of the device with no window open, none that may play sound, or none that answers in time", async () => {
    for (const windows of [[], [appWindow("visible", "quiet")], [appWindow("hidden", "no answer")], [{ visibilityState: "visible" }]]) {
      const n = await serviceWorker({ windows }).push(message);
      expect(n).toMatchObject({ body: "ciao", renotify: true });
      expect(n.silent).toBeUndefined();
    }
  });

  it("asks the windows on screen first, one at a time, until one plays it: a single bell", async () => {
    const shown = appWindow("visible", "plays");
    const behind = appWindow("hidden", "plays");
    expect(await serviceWorker({ windows: [behind, shown] }).push(message)).toMatchObject({ silent: true });
    expect([shown.asked.length, behind.asked.length]).toEqual([1, 0]);
    const tab = appWindow("visible", "quiet");
    const app = appWindow("hidden", "plays");
    expect(await serviceWorker({ windows: [tab, app] }).push(message)).toMatchObject({ silent: true });
    expect([tab.asked.length, app.asked.length]).toEqual([1, 1]);
  });

  it("rings it for a push of its own too (a check, a missed call, Teams signed out)", async () => {
    const w = appWindow("hidden", "plays");
    const n = await serviceWorker({ windows: [w] }).push({ title: "Missed call from Anna Rossi", body: "Teams call at 10:05, not answered", acc: 2 });
    expect(n).toMatchObject({ title: "Missed call from Anna Rossi", silent: true });
    expect(w.asked).toHaveLength(1);
  });

  it("rings nothing for a line sent again, nor for a call, which has the ring of its own", async () => {
    const w = appWindow("visible", "plays");
    const sw = serviceWorker({ windows: [w] });
    await sw.push(message);
    const again = await sw.push(message);
    expect(again).toMatchObject({ renotify: false });
    expect(again.silent).toBeUndefined();
    await sw.push({ title: "Anna Rossi is calling", body: "Teams call, ringing now", acc: 2, tag: "call-2", call: "ringing", ts: 1000 });
    expect(w.asked).toHaveLength(1);
  });
});
