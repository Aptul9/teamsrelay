import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/sendimage/route";
import { appDb, claimSlot, migrateAppSchema, setSlotStopped } from "@/lib/appdb";
import { HttpError } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { imageExt } from "@/lib/uploads";
import { createSlotDb, tempDir } from "./helpers";

// The session is better-auth's: here it resolves to the slot of the test, or refuses like for another user's slot
vi.mock("@/lib/session", () => ({ requireSlot: vi.fn() }));

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(200, 1)]);
const JPEG = Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.alloc(200, 2)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40, 3)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(40, 4)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

let dataDir: string;
let slot: number;
let slotDb: ReturnType<typeof createSlotDb>;

beforeAll(() => {
  dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
  slot = claimSlot(appDb(), "u1", { slotCount: 4, perUser: 4 });
  slotDb = createSlotDb(path.join(dataDir, String(slot), "messages.db"));
});

beforeEach(() => {
  vi.mocked(requireSlot).mockResolvedValue({ user: { id: "u1", email: "u1@contoso.example", name: "U1" }, slot });
  setSlotStopped(appDb(), slot, false);
  fs.rmSync(uploads(), { recursive: true, force: true });
  slotDb.exec("DELETE FROM commands");
});

const uploads = () => path.join(dataDir, String(slot), "uploads");

function post(fields: { name?: string; text?: string; file?: { data: Buffer; type?: string; name?: string } }, headers: Record<string, string> = {}) {
  const form = new FormData();
  if (fields.name !== undefined) form.set("name", fields.name);
  if (fields.text !== undefined) form.set("text", fields.text);
  if (fields.file) form.set("file", new File([new Uint8Array(fields.file.data)], fields.file.name ?? "photo", { type: fields.file.type ?? "" }));
  return POST(new Request(`http://localhost:8090/api/sendimage?a=${slot}`, { method: "POST", body: form, headers }), undefined);
}

describe("image types", () => {
  it("come from the first bytes", () => {
    expect([PNG, JPEG, GIF, WEBP].map((b) => imageExt(b))).toEqual(["png", "jpg", "gif", "webp"]);
    expect(imageExt(SVG)).toBeNull();
    expect(imageExt(Buffer.from("RIFF0000AVI LIST"))).toBeNull();
    expect(imageExt(Buffer.alloc(0))).toBeNull();
  });
});

describe("POST /api/sendimage", () => {
  it("writes the image for the agent and queues it with its caption", async () => {
    // the declared name and type are not trusted: the content is a PNG
    const r = await post({ name: "Anna Rossi", text: "For you", file: { data: PNG, type: "text/plain", name: "notes.txt" } });
    expect(r.status).toBe(200);
    const { id } = await r.json();
    const row = slotDb.prepare("SELECT type, arg1, arg2, status FROM commands WHERE id=?").get(id) as { type: string; arg1: string; arg2: string; status: string };
    expect(row).toMatchObject({ type: "sendimage", arg1: "Anna Rossi", status: "pending" });
    const { file, text } = JSON.parse(row.arg2);
    expect(file).toMatch(/^[0-9a-f]{16}\.png$/);
    expect(text).toBe("For you");
    expect(fs.readFileSync(path.join(uploads(), file))).toEqual(PNG);
  });

  it("takes an image without a caption", async () => {
    const r = await post({ name: "Anna Rossi", file: { data: JPEG, type: "image/jpeg" } });
    expect(r.status).toBe(200);
    const row = slotDb.prepare("SELECT arg2 FROM commands").get() as { arg2: string };
    expect(JSON.parse(row.arg2)).toEqual({ file: expect.stringMatching(/\.jpg$/), text: "" });
  });

  it("refuses what is not a PNG, JPEG, GIF or WebP image: 415", async () => {
    const r = await post({ name: "Anna Rossi", file: { data: SVG, type: "image/svg+xml", name: "a.svg" } });
    expect([r.status, (await r.json()).detail]).toEqual([415, "Only PNG, JPEG, GIF or WebP images can be sent from here: send other files from Teams"]);
    expect(fs.existsSync(uploads()) ? fs.readdirSync(uploads()) : []).toEqual([]);
  });

  it("refuses an image over 10 MB: 413, before reading it when the length is declared", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(10e6)]);
    const r = await post({ name: "Anna Rossi", file: { data: big, type: "image/png" } });
    expect(r.status).toBe(413);
    const declared = await post({ name: "Anna Rossi", file: { data: PNG } }, { "content-length": String(11e6) });
    expect(declared.status).toBe(413);
    expect(slotDb.prepare("SELECT COUNT(*) AS n FROM commands").get()).toEqual({ n: 0 });
  });

  it("refuses a missing image, chat or form: 400", async () => {
    expect((await post({ name: "Anna Rossi" })).status).toBe(400);
    expect((await post({ file: { data: PNG } })).status).toBe(400);
    expect((await post({ name: " ", file: { data: PNG } })).status).toBe(400);
    const notForm = await POST(new Request(`http://localhost:8090/api/sendimage?a=${slot}`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }), undefined);
    expect(notForm.status).toBe(400);
  });

  it("refuses the slot of another user: 404, nothing written", async () => {
    vi.mocked(requireSlot).mockRejectedValueOnce(new HttpError(404, "Account not found"));
    const r = await post({ name: "Anna Rossi", file: { data: PNG } });
    expect(r.status).toBe(404);
    expect(fs.existsSync(uploads())).toBe(false);
  });

  it("refuses a stopped account: 409, nothing written", async () => {
    setSlotStopped(appDb(), slot, true);
    const r = await post({ name: "Anna Rossi", file: { data: PNG } });
    expect(r.status).toBe(409);
    expect(fs.existsSync(uploads()) ? fs.readdirSync(uploads()) : []).toEqual([]);
  });

  it("deletes uploads older than a day that no agent picked up", async () => {
    fs.mkdirSync(uploads(), { recursive: true });
    const old = path.join(uploads(), "00000000000000aa.png");
    const fresh = path.join(uploads(), "00000000000000bb.png");
    fs.writeFileSync(old, PNG);
    fs.writeFileSync(fresh, PNG);
    const twoDaysAgo = new Date(Date.now() - 2 * 86400e3);
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
    expect((await post({ name: "Anna Rossi", file: { data: GIF } })).status).toBe(200);
    const left = fs.readdirSync(uploads());
    expect(left).toContain("00000000000000bb.png");
    expect(left).not.toContain("00000000000000aa.png");
    expect(left).toHaveLength(2);
  });
});
