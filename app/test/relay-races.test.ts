// A request of the relay of an account on another computer still on its way when the account is removed, or gets a new
// token (src/lib/relay.ts): it writes nothing, neither into the account that takes the slot next nor into a folder
// brought back. Real routes; the body of the request is held open while the account changes.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import * as commandsRoute from "@/app/api/relay/commands/route";
import * as mediaRoute from "@/app/api/relay/media/[file]/route";
import * as pushRoute from "@/app/api/relay/push/route";
import * as syncRoute from "@/app/api/relay/sync/route";
import { appDb, migrateAppSchema } from "@/lib/appdb";
import type { ControlClient } from "@/lib/control";
import { addRelayAccount, removeAccount, renewRelayToken } from "@/lib/slots";
import { held, tempDir } from "./helpers";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let dataDir: string;
const ctl: ControlClient = { start: async () => undefined, stop: async () => undefined, wipe: async () => undefined, show: async () => true };
const opts = () => ({ db: appDb(), dataDir, perUser: 4 });

beforeAll(() => {
  dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
});

const request = (p: string, token: string, method: string, body?: ReadableStream<Uint8Array>) =>
  new Request(`http://localhost:8090${p}`, { method, headers: { Authorization: `Bearer ${token}` }, body, duplex: "half" } as RequestInit);

const slotDb = <T>(n: number, fn: (db: Database.Database) => T): T => {
  const db = new Database(path.join(dataDir, String(n), "messages.db"), { fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

const chat = (name: string) => ({ name, preview: "", pos: 0, ts: 0, tm: "", unread: 0, mention: 0, muted: 0, av: "" });

describe("a request on its way while the account is removed", () => {
  it("a sync writes nothing into the account that took the slot since", async () => {
    const gone = await addRelayAccount("ra", opts());
    const sync = held(`{"host":"pc-a","now":${Date.now()},"chats":[`, `${JSON.stringify(chat("From the removed account"))}]}`);
    const answer = syncRoute.POST(request("/api/relay/sync", gone.token, "POST", sync.body), undefined);
    await sync.reading;
    await removeAccount(gone.slot, ctl, opts());
    const next = await addRelayAccount("rb", opts());
    expect(next.slot).toBe(gone.slot);
    sync.release();

    expect((await answer).status).toBe(401);
    expect(slotDb(next.slot, (db) => db.prepare("SELECT name FROM chats").pluck().all())).toEqual([]);
  });

  it("a sync does not bring back the folder of the account", async () => {
    const gone = await addRelayAccount("rc", opts());
    const sync = held(`{"host":"pc-c","now":${Date.now()},"chats":[`, `${JSON.stringify(chat("Anna Rossi"))}]}`);
    const answer = syncRoute.POST(request("/api/relay/sync", gone.token, "POST", sync.body), undefined);
    await sync.reading;
    await removeAccount(gone.slot, ctl, opts());
    sync.release();

    expect((await answer).status).toBe(401);
    expect(fs.existsSync(path.join(dataDir, String(gone.slot)))).toBe(false);
  });

  it("a notification goes to nobody, and leaves nothing in the account that took the slot since", async () => {
    const gone = await addRelayAccount("rd", opts());
    const push = held('{"op":"message","title":"Anna Rossi",', '"body":"from the removed account","chat":""}');
    const answer = pushRoute.POST(request("/api/relay/push", gone.token, "POST", push.body), undefined);
    await push.reading;
    await removeAccount(gone.slot, ctl, opts());
    const next = await addRelayAccount("re", opts());
    expect(next.slot).toBe(gone.slot);
    push.release();

    expect((await answer).status).toBe(401);
    expect(slotDb(next.slot, (db) => db.prepare("SELECT COUNT(*) FROM messages").pluck().get())).toBe(0);
  });
});

describe("a request on its way while the account gets a new token", () => {
  it("a file is not kept", async () => {
    const { slot, token } = await addRelayAccount("rf", opts());
    const upload = held(PNG.subarray(0, 8), PNG.subarray(8));
    const answer = mediaRoute.PUT(request("/api/relay/media/0123456789abcdef.png", token, "PUT", upload.body), {
      params: Promise.resolve({ file: "0123456789abcdef.png" }),
    });
    await upload.reading;
    await renewRelayToken(slot, appDb());
    upload.release();

    expect((await answer).status).toBe(401);
    const media = path.join(dataDir, String(slot), "media");
    expect(fs.existsSync(media) ? fs.readdirSync(media) : []).toEqual([]);
  });

  it("the wait for commands ends at once", async () => {
    const { slot, token } = await addRelayAccount("rg", opts());
    const answer = commandsRoute.GET(request("/api/relay/commands?after=0&vts=0", token, "GET"), undefined);
    await new Promise((r) => setTimeout(r, 300));
    await renewRelayToken(slot, appDb());
    const t = Date.now();

    expect((await answer).status).toBe(401);
    expect(Date.now() - t).toBeLessThan(3000);
  });
});
