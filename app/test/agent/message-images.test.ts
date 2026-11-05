import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import type { Agent } from "@/agent/context";
import { readOpenMessages } from "@/agent/jobs/conversation";
import { Media } from "@/agent/media";
import type { TeamsPage } from "@/agent/teams/page";
import type { PageImage, PageMessage } from "@/agent/teams/scripts/conversation";
import { tempDir } from "../helpers";

// The 1x1 GIF Teams draws while it loads an image (saved by earlier releases as if it were the image)
const PLACEHOLDER = Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64");
// Start of a 554x554 PNG: enough for the file, the content is never decoded
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d494844520000022a0000022a0806000000", "hex"), Buffer.alloc(64, 7)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(64, 9)]);

// Page answering fetchImage with the given results in order; srcs lists the addresses it was asked for
function page(results: ({ type: string; data: Buffer } | null)[]) {
  const srcs: string[] = [];
  const p = {
    evaluate: async (_: unknown, arg: { src: string }) => {
      srcs.push(arg.src);
      const r = results.shift();
      return r ? { type: r.type, data: r.data.toString("base64") } : null;
    },
  } as unknown as Page;
  return { page: p, srcs };
}

describe("images of messages", () => {
  it("does not keep the placeholder Teams shows while an image loads, and asks again", async () => {
    const dir = tempDir();
    const media = new Media(dir, tempDir());
    const p = page([{ type: "image/gif", data: PLACEHOLDER }, { type: "image/webp", data: WEBP }]);
    expect(await media.image(p.page, "a1", "blob:https://teams.cloud.microsoft/1")).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await media.image(p.page, "a1", "blob:https://teams.cloud.microsoft/1")).toBe("a1.webp");
    expect(fs.readFileSync(path.join(dir, "a1.webp"))).toEqual(WEBP);
  });

  it("replaces a placeholder saved by an earlier release", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "b2.gif"), PLACEHOLDER);
    const media = new Media(dir, tempDir());
    const p = page([{ type: "image/webp", data: WEBP }]);
    expect(await media.image(p.page, "b2", "blob:https://teams.cloud.microsoft/2")).toBe("b2.webp");
    expect(fs.readdirSync(dir)).toEqual(["b2.webp"]);
  });

  it("serves a saved image without asking the page", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "c3.png"), PNG);
    const p = page([]);
    expect(await new Media(dir, tempDir()).image(p.page, "c3", "blob:https://teams.cloud.microsoft/3")).toBe("c3.png");
    expect(p.srcs).toEqual([]);
  });

  it("asks once per address: a failed one is not asked again, a new one is", async () => {
    const media = new Media(tempDir(), tempDir());
    const p = page([null, { type: "image/png", data: PNG }]);
    const original = "https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/o1/views/imgo_webp";
    expect(await media.image(p.page, "d4", original)).toBeNull();
    expect(await media.image(p.page, "d4", original)).toBeNull();
    expect(await media.image(p.page, "d4", "blob:https://teams.cloud.microsoft/4")).toBe("d4.png");
    expect(p.srcs).toEqual([original, "blob:https://teams.cloud.microsoft/4"]);
  });

  it("fetches an AMS image with the chatsvc token itself, not through the page", async () => {
    const dir = tempDir();
    const asked: { url: string; auth: string | null }[] = [];
    const get = (async (url: string, init?: RequestInit) => {
      asked.push({ url, auth: new Headers(init?.headers).get("Authorization") });
      return new Response(PNG, { headers: { "Content-Type": "image/png" } });
    }) as typeof fetch;
    const p = page([]);
    const ams = "https://eu-api.asm.skype.com/v1/objects/0-weu-d2-o1/views/imgo";
    expect(await new Media(dir, tempDir(), get).image(p.page, "f6", ams, "tok")).toBe("f6.png");
    expect(await new Media(tempDir(), tempDir(), get).image(null, "g7", ams, "tok")).toBe("g7.png");
    expect(asked).toEqual([
      { url: ams, auth: "Bearer tok" },
      { url: ams, auth: "Bearer tok" },
    ]);
    expect(p.srcs).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "f6.png"))).toEqual(PNG);
  });

  it("keeps the page for an image of another host, and without a token", async () => {
    const get = (async () => {
      throw new Error("no fetch expected");
    }) as typeof fetch;
    const p = page([
      { type: "image/png", data: PNG },
      { type: "image/png", data: PNG },
    ]);
    const media = new Media(tempDir(), tempDir(), get);
    expect(await media.image(p.page, "h8", "blob:https://teams.cloud.microsoft/8", "tok")).toBe("h8.png");
    expect(await media.image(p.page, "i9", "https://eu-api.asm.skype.com/v1/objects/o9/views/imgo")).toBe("i9.png");
    expect(p.srcs).toHaveLength(2);
  });

  it("refused by AMS: no file, the address not asked again", async () => {
    let calls = 0;
    const get = (async () => (calls++, new Response(null, { status: 401 }))) as typeof fetch;
    const media = new Media(tempDir(), tempDir(), get);
    const ams = "https://eu-api.asm.skype.com/v1/objects/o10/views/imgo";
    expect(await media.image(null, "j10", ams, "tok")).toBeNull();
    expect(await media.image(null, "j10", ams, "tok")).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("images saved with the conversation", () => {
  const message = (images: PageImage[]): PageMessage => ({
    mid: "m1",
    author: "Anna Rossi",
    text: "",
    mine: false,
    reacts: "",
    quote: null,
    images,
    files: [],
    reactions: [],
    status: "",
    edited: false,
    html: "",
    mentionsMe: false,
    avsrc: "",
    deleted: false,
  });

  // Agent whose page shows `rows` and whose media answers with `file` for every image
  function agent(rows: PageMessage[], file: string | null): Agent {
    const tp = {
      page: { evaluate: async () => rows },
      isOpen: async () => true,
    } as unknown as TeamsPage;
    return {
      tp,
      store: { readByCache: () => new Map() },
      media: { image: async () => file, avatar: async () => "" },
    } as unknown as Agent;
  }

  it("keeps the public address of a loaded image the page could not read", async () => {
    const gif = { src: "https://media.giphy.com/media/x/giphy.gif", w: 200, h: 150, loaded: true };
    const [m] = (await readOpenMessages(agent([message([gif])], null), "Anna Rossi")) ?? [];
    expect(m.extra?.images).toEqual([{ url: gif.src, w: 200, h: 150 }]);
  });

  it("gives no address for an image Teams has not loaded yet: it needs the session", async () => {
    const lazy = { src: "https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/o1/views/imgo_webp", w: 0, h: 0, loaded: false };
    const [m] = (await readOpenMessages(agent([message([lazy])], null), "Anna Rossi")) ?? [];
    expect(m.extra?.images).toBeUndefined();
  });

  it("saves the file of an image the page read", async () => {
    const lazy = { src: "https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/o1/views/imgo_webp", w: 0, h: 0, loaded: false };
    const [m] = (await readOpenMessages(agent([message([lazy])], "e5.webp"), "Anna Rossi")) ?? [];
    expect(m.extra?.images).toEqual([{ f: "e5.webp", w: 0, h: 0 }]);
  });
});
