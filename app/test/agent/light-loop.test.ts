import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LightApi, type CsaChat, type Notification } from "@/agent/light/api";
import { lightHandlers, runLightCommands } from "@/agent/light/commands";
import type { Light } from "@/agent/light/context";
import { readFeed, readList, runLight, syncNativeCalls } from "@/agent/light/loop";
import { LightToken, SignedOut } from "@/agent/light/token";
import { McasSession } from "@/agent/light/mcas-session";
import { NewMessageDetector } from "@/agent/logic/new-messages";
import { Media } from "@/agent/media";
import { SlotStore } from "@/agent/store/slot-store";
import { captureLightToken, TEAMS_WEB_CLIENT, teamsRefreshToken } from "@/agent/jobs/light-token";
import type { Agent } from "@/agent/context";
import { readMsalEntries } from "@/agent/teams/scripts/tokens";
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
    authors: vi.fn(async (conversation: string) => (void conversation, new Map<string, { displayName: string; givenName: string }>())),
    auth: vi.fn(async () => ({ token: "t", region: "emea", oid: ME, name: "Me Myself" })),
    keepActive: vi.fn(async () => undefined),
  };
  const l: Light = {
    config: { lightPoll: 60, uploadsDir: path.join(dir, "uploads") } as Light["config"],
    store,
    notifier: notifier as unknown as Light["notifier"],
    media: new Media(path.join(dir, "media"), path.join(dir, "files"), (url, init) => fetch(url, init)),
    detector: new NewMessageDetector(),
    api: api as unknown as LightApi,
    token: new LightToken(path.join(dir, "light-token.json")),
    me: { oid: ME, name: "Me Myself" },
    list: { ids: new Map(), names: new Map(), members: new Map() },
    people: new Map(),
    authorsRead: new Map(),
    mentioned: new Set(),
    due: { list: 0, activity: 0 },
    scanAt: 0,
    error: "",
    signedOut: false,
    health: null,
    startedAt: Date.now(),
    feedRead: false,
  };
  return { l, store, notifier, api, dir };
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
  it("keeps its own presence active from the browserless loop", async () => {
    const { l, api } = setup(() => []);
    const stop = new AbortController();
    api.chats.mockImplementation(async () => { stop.abort(); return []; });
    await runLight(l, stop.signal);
    expect(api.keepActive).toHaveBeenCalledOnce();
  });

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

  it("names a chat neither look-up knows from its messages, read once per last message", async () => {
    let chats: CsaChat[] = [{ ...oneToOne("19:ext@unq.gbl.spaces", "ext", "mine", 5), isLastMessageFromMe: true }];
    const { l, store, api } = setup(() => chats);
    api.people.mockResolvedValue(new Map());
    await readList(l);
    await readList(l);
    expect(api.authors).toHaveBeenCalledTimes(1);
    expect(store.chats().map((c) => c.name)).toEqual([]);
    api.authors.mockResolvedValue(new Map([[mri("ext"), { displayName: "Esterno Persona", givenName: "Esterno" }]]));
    chats = [{ ...oneToOne("19:ext@unq.gbl.spaces", "ext", "mine again", 1), isLastMessageFromMe: true }];
    await readList(l);
    expect(api.authors).toHaveBeenCalledTimes(2);
    expect(api.authors).toHaveBeenLastCalledWith("19:ext@unq.gbl.spaces");
    expect(store.chats().map((c) => c.name)).toEqual(["Esterno Persona"]);
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

  it("saves the image of a message with the chatsvc token, once", async () => {
    const { l, store, dir } = setup(() => [oneToOne("19:anna@unq.gbl.spaces", "anna", "hello", 1)]);
    await readList(l);
    const ams = "https://eu-api.asm.skype.com/v1/objects/0-weu-d2-abc/views/imgo";
    const jpeg = Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.alloc(2000, 1)]);
    const messages = [{ id: "1793690000000", messagetype: "RichText/Html", content: `<p><img src="${ams}" width="833" height="250" itemtype="http://schema.skype.com/AMSImage"></p>`, imdisplayname: "Person anna", from: `https://x/contacts/${mri("anna")}` }];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === ams) {
        const auth = new Headers(init?.headers).get("Authorization");
        return auth === "Bearer t" ? new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } }) : new Response(null, { status: 401 });
      }
      return chatsvc(messages)(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    for (let i = 0; i < 2; i++) {
      const id = store.enqueue("open", "Person anna");
      await runLightCommands(l, lightHandlers({ list: async () => true, activity: async () => true }));
      expect(store.commandStatus(id)).toBe("done");
    }
    const [im] = store.messages("Person anna")[0].images ?? [];
    expect(im).toMatchObject({ w: 833, h: 250 });
    expect(im.f).toMatch(/^[0-9a-f]{16}\.jpg$/);
    expect(im.url).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "media", im.f!))).toEqual(jpeg);
    expect(fetch.mock.calls.filter(([u]) => u === ams)).toHaveLength(1);
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

// An entry as MSAL browser encrypts its cache (key of the cookie msal.cache.encryption, prod AGAP2 2026-11-03)
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
async function encrypted(baseKey: Uint8Array<ArrayBuffer>, id: string, context: string, value: object): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey("raw", baseKey, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", salt: nonce, hash: "SHA-256", info: new TextEncoder().encode(context) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, key, new TextEncoder().encode(JSON.stringify(value))));
  return JSON.stringify({ id, nonce: b64url(nonce), data: b64url(data), lastUpdatedAt: "1" });
}

describe("names of people for a light account", () => {
  it("asks the federated look-up only for the people the organization's one did not name", async () => {
    const bodies: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname.split("/").pop() ?? "";
        bodies[path] = JSON.parse(String(init?.body));
        const value = path === "fetchShortProfile" ? [{ mri: mri("in"), displayName: "Interno Anna", givenName: "Anna" }] : [{ objectId: "out", displayName: "Esterno Luca", givenName: "Luca" }];
        return { ok: true, status: 200, json: async () => ({ value }) };
      }),
    );
    const api = new LightApi({ accessToken: async () => "t" } as unknown as LightToken, () => "emea");
    const people = await api.people([mri("in"), mri("out"), "4:+390000"]);
    expect(bodies).toEqual({ fetchShortProfile: [mri("in"), mri("out")], fetchFederated: [mri("out")] });
    expect([...people]).toEqual([
      [mri("in"), { displayName: "Interno Anna", givenName: "Anna" }],
      [mri("out"), { displayName: "Esterno Luca", givenName: "Luca" }],
    ]);
  });

  it("reads the names the messages of a chat carry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          messages: [
            { from: `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/${mri("me")}`, imdisplayname: "Me Myself" },
            { from: `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/${mri("ext")}`, imdisplayname: "Rossi, Mario" },
            { from: "", imdisplayname: "System" },
          ],
        }),
      })),
    );
    const api = new LightApi({ accessToken: async () => "t" } as unknown as LightToken, () => "emea");
    const authors = await api.authors("19:x@unq.gbl.spaces");
    expect(authors.get(mri("ext"))).toEqual({ displayName: "Rossi, Mario", givenName: "Rossi" });
    expect(authors.size).toBe(2);
  });
});

describe("sign-in capture of a light account", () => {
  const entries = new Map<string, string>();
  const OTHER = "11111111-2222-3333-4444-555555555555";
  const rtKey = (client: string) => `msal.2|oid.tenant|login.windows.net|refreshtoken|${client}||`;
  beforeEach(() => {
    entries.clear();
    vi.stubGlobal("document", { cookie: "" });
    vi.stubGlobal("localStorage", {
      get length() {
        return entries.size;
      },
      key: (i: number) => [...entries.keys()][i] ?? null,
      getItem: (k: string) => entries.get(k) ?? null,
    });
  });

  it("reads the refresh token of Teams web from the page", async () => {
    entries.set(rtKey(OTHER), JSON.stringify({ secret: "rt-other", clientId: OTHER, homeAccountId: "u.t" }));
    entries.set(rtKey(TEAMS_WEB_CLIENT), JSON.stringify({ secret: "rt-teams", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant", expiresOn: "1793750000" }));
    entries.set("msal.2|z|accesstoken", JSON.stringify({ secret: "at" }));
    const read = await readMsalEntries(["refreshtoken"]);
    expect(read).toHaveLength(2);
    expect(teamsRefreshToken(read)).toEqual({ secret: "rt-teams", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant", expiresOn: 1793750000 });
  });

  it("decrypts the cache of a Teams web that encrypts it, skipping entries of another key", async () => {
    const baseKey = crypto.getRandomValues(new Uint8Array(32));
    vi.stubGlobal("document", { cookie: `other=1; msal.cache.encryption=${encodeURIComponent(JSON.stringify({ id: "k1", key: b64url(baseKey) }))}` });
    const rt = { secret: "rt-encrypted", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant", expiresOn: "1793800000" };
    entries.set(rtKey(TEAMS_WEB_CLIENT), await encrypted(baseKey, "k1", TEAMS_WEB_CLIENT, rt));
    entries.set(rtKey(OTHER), await encrypted(baseKey, "k0", OTHER, { ...rt, secret: "rt-old-key", clientId: OTHER }));
    const at = `msal.2|oid.tenant|login.windows.net|accesstoken|${TEAMS_WEB_CLIENT}|tenant|https://ic3.teams.office.com/teams.accessasuser.all https://ic3.teams.office.com/.default|`;
    entries.set(at, await encrypted(baseKey, "k1", TEAMS_WEB_CLIENT, { secret: "at-encrypted", clientId: TEAMS_WEB_CLIENT }));
    expect(await readMsalEntries(["refreshtoken"])).toEqual([{ secret: "rt-encrypted", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant", expiresOn: 1793800000 }]);
    expect((await readMsalEntries(["accesstoken", "ic3.teams.office.com"])).map((e) => e.secret)).toEqual(["at-encrypted"]);
    // a key not the one of the entries: nothing, and no error
    vi.stubGlobal("document", { cookie: `msal.cache.encryption=${encodeURIComponent(JSON.stringify({ id: "k1", key: b64url(new Uint8Array(32)) }))}` });
    expect(await readMsalEntries(["refreshtoken"])).toEqual([]);
  });

  it("stores it for the light agent with its tenant and region, its expiry for the web app, once", async () => {
    entries.set(rtKey(TEAMS_WEB_CLIENT), JSON.stringify({ secret: "rt-teams", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant", expiresOn: "1793750000" }));
    const dir = tempDir();
    const store = SlotStore.open(path.join(dir, "messages.db"));
    const file = path.join(dir, "light-token.json");
    const page = {
      evaluate: async (fn: (arg: string[]) => unknown, arg: string[]) => fn(arg),
      context: () => ({ cookies: async () => [{ name: "authtoken", domain: "teams.microsoft.com", path: "/api/mt/part/amer-02/beta/users/x" }] }),
    };
    const a = { config: { lightTokenFile: file }, store, tp: { page } } as unknown as Agent;
    expect(await captureLightToken(a)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ refreshToken: "rt-teams", clientId: TEAMS_WEB_CLIENT, tenantId: "tenant", region: "amer", expiresOn: 1793750000 });
    expect(parseState(LightSignIn, store.getState(STATE.lightToken))).toMatchObject({ expiresOn: 1793750000, refused: false });
    expect(await captureLightToken(a)).toBe(false);
  });

  it("captures Microsoft session cookies even when the refresh token was already saved", async () => {
    const rt = { secret: "same-rt", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant", expiresOn: "1793750000" };
    entries.set(rtKey(TEAMS_WEB_CLIENT), JSON.stringify(rt));
    const dir = tempDir();
    const file = path.join(dir, "light-token.json");
    LightToken.save(file, { refreshToken: rt.secret, clientId: rt.clientId, tenantId: "tenant", region: "emea", expiresOn: 1793750000 });
    const store = SlotStore.open(path.join(dir, "messages.db"));
    store.setState(STATE.me, JSON.stringify({ email: "me@example.com" }));
    const microsoft = { name: "ESTSAUTHPERSISTENT", value: "session", domain: ".login.microsoftonline.com", path: "/", expires: 1900000000 };
    const page = { evaluate: async (fn: (arg: string[]) => unknown, arg: string[]) => fn(arg), context: () => ({ cookies: async () => [microsoft, { ...microsoft, domain: ".unrelated.test", value: "unrelated" }] }) };
    const a = { config: { lightTokenFile: file }, store, tp: { page } } as unknown as Agent;
    expect(await captureLightToken(a)).toBe(true);
    const session = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
    expect(session).toMatchObject({ loginHint: "me@example.com", cookies: [microsoft] });
    expect(session.userAgent).toBeTruthy();
    expect(parseState(LightSignIn, store.getState(STATE.lightToken)).session).toBe(true);
    expect(await captureLightToken(a)).toBe(false);
  });

  it("bootstraps session capture from a saved token before Teams finishes loading", async () => {
    const dir = tempDir();
    const file = path.join(dir, "light-token.json");
    LightToken.save(file, { refreshToken: "expired-rt", clientId: TEAMS_WEB_CLIENT, tenantId: "tenant", region: "emea", expiresOn: 1 });
    const store = SlotStore.open(path.join(dir, "messages.db"));
    const page = {
      evaluate: async (fn: () => unknown) => fn === readMsalEntries ? [] : "browser-ua",
      context: () => ({ cookies: async () => [{ name: "ESTSAUTHPERSISTENT", value: "session", domain: ".login.microsoftonline.com", path: "/", expires: 1900000000 }] }),
    };
    const a = { config: { lightTokenFile: file }, store, tp: { page } } as unknown as Agent;
    expect(await captureLightToken(a)).toBe(true);
    expect(parseState(LightSignIn, store.getState(STATE.lightToken))).toMatchObject({ expiresOn: 1, session: true, refused: false });
  });

  it("marks an MCAS capture for browser renewal and does not recycle an ending token before fresh sign-in", async () => {
    const now = Math.floor(Date.now() / 1000);
    const dir = tempDir();
    const file = path.join(dir, "light-token.json");
    const store = SlotStore.open(path.join(dir, "messages.db"));
    const page = {
      url: () => "https://teams.cloud.microsoft.mcas.ms/",
      evaluate: async (fn: (arg: string[]) => unknown, arg: string[]) => fn(arg),
      context: () => ({ cookies: async () => [{ name: "ESTSAUTHPERSISTENT", value: "session", domain: ".login.microsoftonline.com", path: "/", expires: now + 90000 }] }),
    };
    const a = { config: { lightTokenFile: file }, store, tp: { page } } as unknown as Agent;
    entries.set(rtKey(TEAMS_WEB_CLIENT), JSON.stringify({ secret: "rt-teams", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant" }));
    expect(await captureLightToken(a)).toBe(true);
    expect(parseState(LightSignIn, store.getState(STATE.lightToken))).toMatchObject({ browser: true, session: true });
    store.setState(STATE.lightToken, JSON.stringify({ at: now - 80000, expiresOn: now - 1, refused: false, session: true, browser: true }));
    entries.set(rtKey(TEAMS_WEB_CLIENT), JSON.stringify({ secret: "rt-rotated", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant" }));
    expect(await captureLightToken(a)).toBe(false);
    expect(LightToken.load(file)?.refreshToken).toBe("rt-teams");
    store.setState(STATE.freshSignIn, String(now));
    expect(await captureLightToken(a)).toBe(true);
    expect(parseState(LightSignIn, store.getState(STATE.lightToken))).toMatchObject({ browser: true, refused: false, expiresOn: now + 72000 });
  });

  it("enables MCAS HTTP renewal only after capturing its current proxy session", async () => {
    const capture = vi.spyOn(McasSession, "capture").mockResolvedValue(true);
    try {
      const dir = tempDir(), file = path.join(dir, "light-token.json");
      const store = SlotStore.open(path.join(dir, "messages.db"));
      store.setState(STATE.me, JSON.stringify({ email: "me@example.com" }));
      entries.set(rtKey(TEAMS_WEB_CLIENT), JSON.stringify({ secret: "rt-teams", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant" }));
      const page = {
        url: () => "https://teams.cloud.microsoft.mcas.ms/",
        evaluate: async (fn: (arg: string[]) => unknown, arg: string[]) => fn(arg),
        context: () => ({ cookies: async () => [{ name: "ESTSAUTHPERSISTENT", value: "session", domain: ".login.microsoftonline.com", path: "/", expires: 1900000000 }] }),
      };
      const a = { config: { lightTokenFile: file }, store, tp: { page } } as unknown as Agent;
      expect(await captureLightToken(a)).toBe(true);
      expect(capture).toHaveBeenCalledOnce();
      expect(parseState(LightSignIn, store.getState(STATE.lightToken))).toMatchObject({ mcas: true, session: true });
      expect(parseState(LightSignIn, store.getState(STATE.lightToken)).browser).not.toBe(true);
    } finally { capture.mockRestore(); }
  });

  it.each([false, true])("does not mistake a rotated page RT for fresh authorization on an MCAS fallback (known backend %s)", async (mcas) => {
    const now = Math.floor(Date.now() / 1000);
    const dir = tempDir();
    const file = path.join(dir, "light-token.json");
    const store = SlotStore.open(path.join(dir, "messages.db"));
    LightToken.save(file, { refreshToken: "old-rt", clientId: TEAMS_WEB_CLIENT, tenantId: "tenant", region: "emea", expiresOn: now + 3600 });
    store.setState(STATE.lightToken, JSON.stringify({ at: now - 10000, expiresOn: now + 3600, refused: true, session: true, mcas }));
    entries.set(rtKey(TEAMS_WEB_CLIENT), JSON.stringify({ secret: "rt-rotated", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant" }));
    const page = {
      url: () => mcas ? "https://teams.microsoft.com/" : "https://teams.cloud.microsoft.mcas.ms/",
      evaluate: async (fn: (arg: string[]) => unknown, arg: string[]) => fn(arg),
      context: () => ({ cookies: async () => [{ name: "ESTSAUTHPERSISTENT", value: "session", domain: ".login.microsoftonline.com", path: "/", expires: now + 90000 }] }),
    };
    const a = { config: { lightTokenFile: file }, store, tp: { page } } as unknown as Agent;
    expect(await captureLightToken(a)).toBe(false);
    expect(parseState(LightSignIn, store.getState(STATE.lightToken)).refused).toBe(true);
    expect(LightToken.load(file)?.refreshToken).toBe("old-rt");
  });

  it.each(["browser", "mcas"])("preserves %s cookie-only capture until a page RT is observed", async (backend) => {
    const now = Math.floor(Date.now() / 1000);
    const dir = tempDir();
    const file = path.join(dir, "light-token.json");
    const store = SlotStore.open(path.join(dir, "messages.db"));
    LightToken.save(file, { refreshToken: "old-rt", clientId: TEAMS_WEB_CLIENT, tenantId: "tenant", region: "emea", expiresOn: now + 3600 });
    store.setState(STATE.lightToken, JSON.stringify({ at: now - 100, expiresOn: now + 3600, refused: false, session: true, [backend]: true }));
    const page = {
      url: () => "https://login.microsoftonline.com/",
      evaluate: async (fn: (arg: string[]) => unknown, arg: string[]) => fn(arg),
      context: () => ({ cookies: async () => [{ name: "ESTSAUTHPERSISTENT", value: "session", domain: ".login.microsoftonline.com", path: "/", expires: now + 90000 }] }),
    };
    const a = { config: { lightTokenFile: file }, store, tp: { page } } as unknown as Agent;
    expect(await captureLightToken(a)).toBe(true);
    expect(parseState(LightSignIn, store.getState(STATE.lightToken)).at).toBe(now - 100);
    expect(JSON.parse(store.getState(STATE.lightToken))[backend]).toBe(true);
    entries.set(rtKey(TEAMS_WEB_CLIENT), JSON.stringify({ secret: "old-rt", clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant" }));
    expect(await captureLightToken(a)).toBe(true);
    expect(parseState(LightSignIn, store.getState(STATE.lightToken)).at).toBe(now);
  });
});

describe("native call command wiring", () => {
  it("uses the resolved one-to-one peer and preserves answer identity", async () => {
    const { l, store } = setup(() => []);
    const command = vi.fn(async () => true);
    l.calls = { command } as unknown as NonNullable<Light['calls']>;
    l.list.ids.set('Other', 'thread'); l.list.members.set('thread', [mri('other')]);
    const handlers = lightHandlers({list: async()=>true, activity:async()=>true});
    const base = { id: 1, ts: Math.floor(Date.now()/1000), arg1:'Other', arg2:'', type:'call' };
    expect(await handlers.call!(l, base)).toBe('done');
    expect(command).toHaveBeenCalledWith('call', {thread:'thread',peer:mri('other'),name:'Other'});
    expect(await handlers.answer!(l,{...base,type:'answer',arg2:'{"since":123}'})).toBe('done');
    expect(command).toHaveBeenCalledWith('answer',{since:123});
    store.close();
  });
});


describe("independent native call command lane", () => {
 it("answers while a non-call command waits without marking it interrupted", async () => {
  const {l,store}=setup(()=>[]);
  let release!:()=>void; const waiting=new Promise<void>(r=>{release=r;});
  const slow=store.enqueue('open','Slow'); const answer=store.enqueue('answer','Peer','{"since":1}');
  const handlers={open:async()=>{await waiting;return 'done' as const;},answer:async()=> 'done' as const};
  const running=runLightCommands(l,handlers,'other');
  await runLightCommands(l,handlers,'calls');
  expect(store.commandStatus(answer)).toBe('done');
  release();await running;expect(store.commandStatus(slow)).toBe('done');store.close();
 });
});


describe("per-account native calls", () => {
  it("starts the calling worker when calls are on and stops it when switched off", async () => {
    const { l, store } = setup(() => []);
    const worker = { start: vi.fn(async () => undefined), stop: vi.fn(), schedule: vi.fn() };
    const make = vi.fn(() => worker as unknown as NonNullable<Light["calls"]>);
    await syncNativeCalls(l, true, make);
    expect(make).toHaveBeenCalledTimes(1);
    expect(worker.start).toHaveBeenCalledTimes(1);
    await syncNativeCalls(l, true, make);
    expect(make).toHaveBeenCalledTimes(1);
    await syncNativeCalls(l, false, make);
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(l.calls).toBeUndefined();
    store.close();
  });
});
