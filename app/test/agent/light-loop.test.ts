import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CsaChat, LightApi, Notification } from "@/agent/light/api";
import { lightHandlers, runLightCommands } from "@/agent/light/commands";
import type { Light } from "@/agent/light/context";
import { readFeed, readList } from "@/agent/light/loop";
import { LightToken, SignedOut } from "@/agent/light/token";
import { NewMessageDetector } from "@/agent/logic/new-messages";
import { SlotStore } from "@/agent/store/slot-store";
import { captureLightToken, TEAMS_WEB_CLIENT } from "@/agent/jobs/light-token";
import type { Agent } from "@/agent/context";
import { readRefreshToken } from "@/agent/teams/scripts/tokens";
import { cmdResultKey, LightSignIn, parseState, STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

const ME = "me-oid";
const mri = (oid: string) => `8:orgid:${oid}`;
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function oneToOne(id: string, oid: string, text: string, minutesAgo: number, read = true): CsaChat {
  return { id, isOneOnOne: true, isRead: read, members: [{ mri: mri(ME) }, { mri: mri(oid) }], lastMessage: { id: String(minutesAgo), content: `<p>${text}</p>`, originalArrivalTime: iso(minutesAgo) } };
}

function setup(chats: () => CsaChat[], notifications: () => Notification[] = () => []) {
  const dir = tempDir();
  const store = SlotStore.open(path.join(dir, "messages.db"));
  store.setState(STATE.me, JSON.stringify({ name: "Me Myself", email: "", tenant: "", av: "", logo: "" }));
  const notifier = {
    message: vi.fn(async (title: string, body: string, chat?: string) => void [title, body, chat]),
    alert: vi.fn(async (title: string, body: string) => (void [title, body], 1)),
    call: vi.fn(),
    missedCall: vi.fn(),
    deviceCount: () => 1,
  };
  const api = {
    chats: vi.fn(async () => chats()),
    people: vi.fn(async (mris: string[]) => new Map(mris.map((m) => [m, { displayName: `Person ${m.split(":").pop()}`, givenName: m.split(":").pop() ?? "" }]))),
    presence: vi.fn(async (mris: string[]) => new Map(mris.map((m) => [m, { availability: "Away", activity: "Away" }]))),
    notifications: vi.fn(async () => notifications()),
    notesLast: vi.fn(async () => null),
    auth: vi.fn(async () => ({ token: "t", region: "emea", oid: ME, name: "Me Myself" })),
  };
  const l: Light = {
    config: { lightPoll: 60, uploadsDir: path.join(dir, "uploads") } as Light["config"],
    store,
    notifier: notifier as unknown as Light["notifier"],
    detector: new NewMessageDetector(),
    api: api as unknown as LightApi,
    token: new LightToken(path.join(dir, "light-token.json")),
    me: { oid: ME, name: "Me Myself" },
    list: { ids: new Map(), names: new Map(), members: new Map() },
    people: new Map(),
    mentioned: new Set(),
    due: { list: 0, activity: 0 },
    scanAt: 0,
    error: "",
    signedOut: false,
    health: null,
    startedAt: Date.now(),
    feedRead: false,
  };
  return { l, store, notifier, api };
}

const chatsvc = (messages: unknown[]) =>
  vi.fn(async (url: string, init?: RequestInit) => {
    void init;
    if (/\/messages\?/.test(url)) return { ok: true, status: 200, json: async () => ({ messages }) };
    return { ok: true, status: 201, json: async () => ({ OriginalArrivalTime: 1793700000000 }), text: async () => "" };
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("light agent", () => {
  it("saves the list with names, presence and the chat with yourself, and pushes only messages after the first read", async () => {
    let chats = [oneToOne("19:anna@unq.gbl.spaces", "anna", "hello", 30)];
    const { l, store, notifier, api } = setup(() => chats);
    api.notesLast.mockResolvedValue({ id: "5", content: "<p>todo</p>", time: iso(60) } as never);
    expect(await readList(l)).toBe(true);
    expect(store.chats().map((c) => [c.name, c.presence])).toEqual([
      ["Person anna", "away"],
      ["Me Myself (You)", ""],
    ]);
    expect(Number(store.getState(STATE.presence) === "away")).toBe(1);
    expect(notifier.message).not.toHaveBeenCalled();
    chats = [oneToOne("19:anna@unq.gbl.spaces", "anna", "are you there?", 0, false)];
    vi.stubGlobal("fetch", chatsvc([]));
    await readList(l);
    expect(notifier.message).toHaveBeenCalledWith("Person anna", "are you there?", "Person anna");
    expect(api.people).toHaveBeenCalledTimes(1);
  });

  it("opens a chat through chatsvc and marks it read", async () => {
    const { l, store } = setup(() => [oneToOne("19:anna@unq.gbl.spaces", "anna", "hello", 1)]);
    await readList(l);
    const fetch = chatsvc([{ id: "1793690000000", messagetype: "RichText/Html", content: "<p>hello</p>", imdisplayname: "Person anna", from: `https://x/contacts/${mri("anna")}` }]);
    vi.stubGlobal("fetch", fetch);
    const id = store.enqueue("open", "Person anna");
    await runLightCommands(l, lightHandlers({ list: async () => true, activity: async () => true }));
    expect(store.commandStatus(id)).toBe("done");
    expect(store.messages("Person anna").map((m) => m.text)).toEqual(["hello"]);
    expect(store.getState(STATE.activeChat)).toBe("Person anna");
    await vi.waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).includes("consumptionhorizon"))).toBe(true));
  });

  it("fails an open of a chat the list does not have, with its reason", async () => {
    const { l, store } = setup(() => []);
    const id = store.enqueue("open", "Nobody");
    await runLightCommands(l, lightHandlers({ list: async () => true, activity: async () => true }));
    expect(store.commandStatus(id)).toBe("failed");
    expect(JSON.parse(store.getState(cmdResultKey(id)))).toEqual({ reason: "not-listed" });
  });

  it("sends through chatsvc to the conversation of the chat", async () => {
    const { l, store } = setup(() => [oneToOne("19:anna@unq.gbl.spaces", "anna", "hello", 1)]);
    await readList(l);
    const fetch = chatsvc([]);
    vi.stubGlobal("fetch", fetch);
    const id = store.enqueue("send", "Person anna", "see you");
    await runLightCommands(l, lightHandlers({ list: async () => true, activity: async () => true }));
    expect(store.commandStatus(id)).toBe("done");
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(String(post?.[0])).toContain(encodeURIComponent("19:anna@unq.gbl.spaces"));
    expect(JSON.parse(String(post?.[1]?.body)).content).toBe("<p>see you</p>");
  });

  it("sends people tagged with their mri", async () => {
    const group: CsaChat = { id: "19:g@thread.v2", title: "Team", members: [mri(ME), mri("anna"), mri("marco")].map((m) => ({ mri: m })), lastMessage: { id: "1", content: "x", originalArrivalTime: iso(1) } };
    const { l, store } = setup(() => [group]);
    await readList(l);
    const fetch = chatsvc([]);
    vi.stubGlobal("fetch", fetch);
    const id = store.enqueue("sendmentions", "Team", JSON.stringify({ parts: [{ text: "hi " }, { mention: "Person anna" }, { text: " ok?" }] }));
    await runLightCommands(l, lightHandlers({ list: async () => true, activity: async () => true }));
    expect(store.commandStatus(id)).toBe("done");
    const body = JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body));
    expect(body.content).toBe('<p>hi <span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">Person anna</span> ok?</p>');
    expect(JSON.parse(body.properties.mentions)).toEqual([{ itemid: 0, mri: mri("anna"), mentionType: "person", displayName: "Person anna" }]);
  });

  it("refuses what needs the Teams page", async () => {
    const { l, store } = setup(() => []);
    const id = store.enqueue("download", "x", "{}");
    await runLightCommands(l, lightHandlers({ list: async () => true, activity: async () => true }));
    expect(store.commandStatus(id)).toBe("failed");
  });

  it("pushes a missed call once, after the first feed read, with the ids of Teams", async () => {
    let items: Notification[] = [{ activity: { activityId: 1, activityType: "call", activitySubtype: "missedCall", activityTimestamp: iso(90), sourceUserImDisplayName: "Old Caller" }, read: true }];
    const { l, store, notifier } = setup(() => [], () => items);
    await readFeed(l);
    expect(notifier.alert).not.toHaveBeenCalled();
    items = [{ activity: { activityId: 2, activityType: "call", activitySubtype: "missedCall", activityTimestamp: iso(0), sourceUserImDisplayName: "New Caller" }, read: false }, ...items];
    await readFeed(l);
    await readFeed(l);
    expect(notifier.alert).toHaveBeenCalledTimes(1);
    expect(notifier.alert.mock.calls[0]?.[0]).toBe("Missed call from New Caller");
    expect(store.missedCalls().map((c) => c.id)).toEqual(["2", "1"]);
  });

  it("at its start pushes the calls that came while the account changed mode, not those of weeks ago the page never showed", async () => {
    const call = (id: number, minutesAgo: number) => ({ activity: { activityId: id, activityType: "call", activitySubtype: "missedCall", activityTimestamp: iso(minutesAgo), sourceUserImDisplayName: `Caller ${id}` }, read: true });
    const { l, store, notifier } = setup(() => [], () => [call(3, 2), call(2, 30 * 24 * 60), call(1, 60)]);
    store.setState(STATE.callsTold, JSON.stringify(["1"]));
    await readFeed(l);
    expect(notifier.alert.mock.calls.map((c) => c[0])).toEqual(["Missed call from Caller 3"]);
  });

  it("tells the web app when Microsoft refused the sign-in", async () => {
    const { l, store, api } = setup(() => []);
    store.setState(STATE.lightToken, JSON.stringify({ at: 1, expiresOn: 2, refused: false }));
    api.chats.mockRejectedValue(new SignedOut("refresh token refused"));
    expect(await readList(l)).toBe(false);
    expect(l.signedOut).toBe(true);
    expect(parseState(LightSignIn, store.getState(STATE.lightToken)).refused).toBe(true);
  });
});

describe("sign-in capture of a light account", () => {
  const entries = new Map<string, string>();
  beforeEach(() => {
    entries.clear();
    vi.stubGlobal("localStorage", {
      get length() {
        return entries.size;
      },
      key: (i: number) => [...entries.keys()][i] ?? null,
      getItem: (k: string) => entries.get(k) ?? null,
    });
  });

  it("reads the refresh token of Teams web from the page", () => {
    entries.set("msal.2|x|login.windows.net|refreshtoken|other|", JSON.stringify({ secret: "rt-other", clientId: "other", homeAccountId: "u.t" }));
    entries.set("msal.2|y|login.windows.net|refreshtoken|teams|", JSON.stringify({ secret: "rt-teams", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant", expiresOn: "1793750000" }));
    entries.set("msal.2|z|accesstoken", JSON.stringify({ secret: "at" }));
    expect(readRefreshToken(TEAMS_WEB_CLIENT)).toEqual({ secret: "rt-teams", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant", expiresOn: 1793750000 });
  });

  it("stores it for the light agent with its tenant and region, its expiry for the web app, once", async () => {
    entries.set("msal.2|y|login.windows.net|refreshtoken|teams|", JSON.stringify({ secret: "rt-teams", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant", expiresOn: "1793750000" }));
    const dir = tempDir();
    const store = SlotStore.open(path.join(dir, "messages.db"));
    const file = path.join(dir, "light-token.json");
    const page = {
      evaluate: async (fn: (arg: string) => unknown, arg: string) => fn(arg),
      context: () => ({ cookies: async () => [{ name: "authtoken", domain: "teams.microsoft.com", path: "/api/mt/part/amer-02/beta/users/x" }] }),
    };
    const a = { config: { lightTokenFile: file }, store, tp: { page } } as unknown as Agent;
    expect(await captureLightToken(a)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ refreshToken: "rt-teams", clientId: TEAMS_WEB_CLIENT, tenantId: "tenant", region: "amer", expiresOn: 1793750000 });
    expect(parseState(LightSignIn, store.getState(STATE.lightToken))).toMatchObject({ expiresOn: 1793750000, refused: false });
    expect(await captureLightToken(a)).toBe(false);
  });
});
