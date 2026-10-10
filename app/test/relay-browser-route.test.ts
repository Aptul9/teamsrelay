// Who may open the socket of the relay browser (GET /api/relay/browser), as the hub asks with the headers of the
// upgrade: the relay of an account on another computer by its token, never a web page.
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/relay/browser/route";
import { appDb, claimSlot, migrateAppSchema } from "@/lib/appdb";
import { addRelayAccount } from "@/lib/slots";
import { tempDir } from "./helpers";

let dataDir: string;
let relay: { slot: number; token: string };

beforeAll(async () => {
  dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
  claimSlot(appDb(), "u1", { perUser: 6 });
  relay = await addRelayAccount("u1", { db: appDb(), dataDir, perUser: 6 });
});

const get = (headers: Record<string, string>) => GET(new Request("http://localhost:8090/api/relay/browser", { headers }), undefined);

describe("GET /api/relay/browser", () => {
  it("names the account of the relay token", async () => {
    const r = await get({ Authorization: `Bearer ${relay.token}` });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ slot: relay.slot });
  });

  it("refuses no token, a wrong one, and a session cookie: 401", async () => {
    const refused: Record<string, string>[] = [{}, { Authorization: "Bearer wrong-token-0123456789" }, { Cookie: "better-auth.session_token=x" }];
    for (const headers of refused) {
      expect((await get(headers)).status, JSON.stringify(headers)).toBe(401);
    }
  });

  it("refuses a request from a web page: 403", async () => {
    expect((await get({ Authorization: `Bearer ${relay.token}`, Origin: "https://example.com" })).status).toBe(403);
  });
});
