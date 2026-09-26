// The 21 tests of agent/test_agent.py (Python agent), one describe per Python test class.
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { openAppDb, migrateAppSchema } from "@/lib/appdb";
import { sameChat, type ChatEntry } from "@/agent/logic/chats";
import { pickTeamsPage, isTeamsUrl } from "@/agent/logic/hosts";
import { accountLabel } from "@/agent/logic/notify";
import { PARK_AFTER, wantedChat } from "@/agent/logic/parking";
import { AppStore } from "@/agent/store/app-store";
import { SlotStore } from "@/agent/store/slot-store";
import { Identity, parseState, STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

const chat = (name: string): ChatEntry => ({ name, preview: "", time: "", unread: false, mention: false, muted: false, av: "" });

let store: SlotStore;
const setChats = (...names: string[]) => {
  if (names.length) store.saveChats(names.map(chat), true);
};

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
});

describe("SameChat", () => {
  const same = (title: string, name: string) => sameChat(title, name, (n) => store.isKnownChat(n));

  it("matches equal names", () => {
    setChats("Luca Bianchi");
    expect(same("Luca Bianchi", "Luca Bianchi")).toBe(true);
  });

  it("never matches an empty title", () => {
    expect(same("", "Luca Bianchi")).toBe(false);
  });

  it("refuses another chat of the list that extends the name", () => {
    setChats("Luca Bianchini", "Luca Bianchi");
    expect(same("Luca Bianchini", "Luca Bianchi")).toBe(false);
    expect(same("Luca Bianchi", "Luca Bianchini")).toBe(false);
  });

  it("matches a title longer than the stored name", () => {
    const longName = "Project " + "x".repeat(70);
    setChats(longName.slice(0, 60));
    expect(same(longName, longName.slice(0, 60))).toBe(true);
  });

  it("matches a title with a suffix that is not in the list", () => {
    setChats("Mario Rossi");
    expect(same("Mario Rossi (External)", "Mario Rossi")).toBe(true);
  });

  it("refuses an unrelated title", () => {
    setChats("Mario Rossi", "Anna Verdi");
    expect(same("Anna Verdi", "Mario Rossi")).toBe(false);
  });
});

// Outside Edge, Defender for Cloud Apps proxies the session and appends its suffix to every host
describe("TeamsTab", () => {
  const page = (url: string) => ({ url: () => url });

  it("recognizes the Teams hosts", () => {
    for (const url of ["https://teams.microsoft.com/v2/", "https://teams.cloud.microsoft/", "https://teams.live.com/v2/"]) {
      expect(isTeamsUrl(url), url).toBe(true);
    }
  });

  it("recognizes Teams behind the Cloud Apps proxy", () => {
    for (const url of [
      "https://teams.cloud.microsoft.mcas.ms/",
      "https://teams.microsoft.com.mcas-gov.us/v2/",
      "https://teams.cloud.microsoft.mcas-gov.ms/v2/?McasCtx=4&McasTsid=28",
    ]) {
      expect(isTeamsUrl(url), url).toBe(true);
    }
  });

  it("refuses the other pages", () => {
    for (const url of [
      "https://teams.microsoft.com/v2/serviceworker.js",
      "https://teams.microsoft.com.example.net/",
      "https://outlook.office.com.mcas.ms/mail/",
      "chrome://newtab/",
    ]) {
      expect(isTeamsUrl(url), url).toBe(false);
    }
  });

  it("prefers the Teams tab to the sign-in tab", () => {
    const pages = [page("https://login.microsoftonline.com/common/oauth2/authorize"), page("https://teams.cloud.microsoft.mcas.ms/")];
    expect(pickTeamsPage(pages)?.url()).toBe("https://teams.cloud.microsoft.mcas.ms/");
  });

  it("returns the sign-in tab while signing in", () => {
    const pages = [page("chrome://newtab/"), page("https://login.microsoftonline.com/common/oauth2/authorize")];
    expect(pickTeamsPage(pages)?.url()).toBe("https://login.microsoftonline.com/common/oauth2/authorize");
  });
});

// The Teams page counts as seen by the user: while the app shows no chat, Teams stays on the self chat
describe("Parking", () => {
  const SELF = "Mario Rossi (You)";
  const now = () => Math.floor(Date.now() / 1000);
  const viewing = (chat: string, age: number) => JSON.stringify({ chat, ts: now() - age });

  it("keeps the chat on screen in the app", () => {
    expect(wantedChat("Anna Verdi", viewing("Anna Verdi", 10), now(), SELF)).toBe("Anna Verdi");
  });

  it("goes back to the self chat when nobody looked for a while", () => {
    expect(wantedChat("Anna Verdi", viewing("Anna Verdi", PARK_AFTER + 5), now(), SELF)).toBe(SELF);
  });

  it("goes to the self chat when the app never showed a chat", () => {
    expect(wantedChat("Anna Verdi", "", now(), SELF)).toBe(SELF);
    expect(wantedChat("Anna Verdi", "{", now(), SELF)).toBe(SELF);
  });

  it("goes to the self chat before any chat was opened", () => {
    expect(wantedChat("", "", now(), SELF)).toBe(SELF);
  });

  it("keeps the open chat without a self chat", () => {
    expect(wantedChat("Anna Verdi", "", now(), "")).toBe("Anna Verdi");
  });

  it("finds the self chat in the list", () => {
    setChats("Anna Verdi", SELF, "Luca Bianchi");
    expect(store.selfChat()).toBe(SELF);
    setChats("Anna Verdi");
    expect(store.selfChat()).toBe("");
  });
});

// Slot 1 belongs to u1, slot 2 to u2: the agent of slot 1 notifies u1's devices only
describe("OwnerPush", () => {
  let appDbFile: string;
  let app: AppStore;

  beforeEach(() => {
    appDbFile = path.join(tempDir(), "app.db");
    const db = openAppDb(appDbFile);
    migrateAppSchema(db);
    db.prepare("INSERT INTO teams_accounts(slot, owner_id, added) VALUES(?, ?, 0)").run(1, "u1");
    db.prepare("INSERT INTO teams_accounts(slot, owner_id, added) VALUES(?, ?, 0)").run(2, "u2");
    const sub = db.prepare("INSERT INTO push_subscriptions VALUES(?, ?, '{}', 0)");
    sub.run("https://push/u1-phone", "u1");
    sub.run("https://push/u1-pc", "u1");
    sub.run("https://push/u2-phone", "u2");
    db.close();
    app = new AppStore(appDbFile, 1);
  });

  const label = () => accountLabel(app.ownerHasManyAccounts(), parseState(Identity, store.getState(STATE.me), Identity.parse({})), 1);

  it("targets the devices of the owner", () => {
    expect(app.targets().map((t) => t.endpoint).sort()).toEqual(["https://push/u1-pc", "https://push/u1-phone"]);
    expect(app.targets()).toHaveLength(2);
  });

  it("adds no label with a single account", () => {
    expect(label()).toBe("");
  });

  it("labels the notification when the owner has more accounts", () => {
    const db = new Database(appDbFile);
    db.prepare("INSERT INTO teams_accounts(slot, owner_id, added) VALUES(3, 'u1', 0)").run();
    db.close();
    store.setState(STATE.me, '{"tenant": "Contoso"}');
    expect(label()).toBe("Contoso");
  });

  it("creates no table in app.db", () => {
    app.targets();
    app.ownerHasManyAccounts();
    const db = new Database(appDbFile, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all();
    db.close();
    expect(tables).not.toContain("push_subs");
    expect([...tables].sort()).toEqual(["push_subscriptions", "teams_accounts"]);
  });
});
