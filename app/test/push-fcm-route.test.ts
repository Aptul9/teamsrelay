// The Android app registers its phone with the session cookie of its web page and forgets it once signed out
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, POST } from "@/app/api/push/fcm/route";
import { appDb, migrateAppSchema } from "@/lib/appdb";
import { HttpError } from "@/lib/http";
import { requireSession } from "@/lib/session";
import { tempDir } from "./helpers";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
const as = (id: string, session = `s-${id}`) => ({ user: { id, email: `${id}@contoso.example`, name: id.toUpperCase(), role: "user" }, session }) as never;

const TOKEN = "dGVzdC1waG9uZQ:APA91bH-test_token_of_the_phone_1234567890";

beforeAll(() => {
  process.env.APP_DB = path.join(tempDir(), "app.db");
  migrateAppSchema(appDb());
});

beforeEach(() => {
  appDb().prepare("DELETE FROM push_subscriptions").run();
  vi.mocked(requireSession).mockResolvedValue(as("u1"));
});

const call = (handler: typeof POST, method: string, body: unknown) =>
  handler(new Request("http://localhost:8090/api/push/fcm", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), undefined);
const rows = () => appDb().prepare("SELECT endpoint, user_id, sub FROM push_subscriptions").all() as { endpoint: string; user_id: string; sub: string }[];

describe("POST /api/push/fcm", () => {
  it("registers the phone for the signed-in user and its session, answers its key, the same key when the phone registers again", async () => {
    const r = await call(POST, "POST", { token: TOKEN, name: "Google Pixel 9" });
    expect(r.status).toBe(200);
    const { key } = (await r.json()) as { key: string };
    expect(Buffer.from(key, "base64url")).toHaveLength(32);
    expect(rows()).toEqual([{ endpoint: `fcm:${TOKEN}`, user_id: "u1", sub: JSON.stringify({ fcm: { token: TOKEN, key, name: "Google Pixel 9", session: "s-u1" } }) }]);
    const again = (await (await call(POST, "POST", { token: TOKEN, name: "Google Pixel 9" })).json()) as { key: string };
    expect(again.key).toBe(key);
    expect(rows()).toHaveLength(1);
  });

  it("gives a phone signed in by another user a key of its own: the first user's messages stop reaching it", async () => {
    const first = (await (await call(POST, "POST", { token: TOKEN })).json()) as { key: string };
    vi.mocked(requireSession).mockResolvedValue(as("u2"));
    const second = (await (await call(POST, "POST", { token: TOKEN })).json()) as { key: string };
    expect(second.key).not.toBe(first.key);
    expect(rows().map((r) => r.user_id)).toEqual(["u2"]);
  });

  it("refuses a request without a session, and anything that is not an FCM token", async () => {
    expect((await call(POST, "POST", { token: "short" })).status).toBe(400);
    expect((await call(POST, "POST", { token: "has spaces in it, not a token at all" })).status).toBe(400);
    vi.mocked(requireSession).mockRejectedValue(new HttpError(401, "Not signed in"));
    expect((await call(POST, "POST", { token: TOKEN })).status).toBe(401);
    expect(rows()).toEqual([]);
  });
});

describe("DELETE /api/push/fcm", () => {
  it("forgets the phone by its token, without a session (the app calls it once signed out)", async () => {
    await call(POST, "POST", { token: TOKEN });
    vi.mocked(requireSession).mockRejectedValue(new HttpError(401, "Not signed in"));
    const r = await call(DELETE, "DELETE", { token: TOKEN });
    expect(r.status).toBe(200);
    expect(rows()).toEqual([]);
  });
});
