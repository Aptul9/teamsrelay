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
    const media = new Media(dir);
    const p = page([{ type: "image/gif", data: PLACEHOLDER }, { type: "image/webp", data: WEBP }]);
    expect(await media.image(p.page, "a1", "blob:https://teams.cloud.microsoft/1")).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await media.image(p.page, "a1", "blob:https://teams.cloud.microsoft/1")).toBe("a1.webp");
    expect(fs.readFileSync(path.join(dir, "a1.webp"))).toEqual(WEBP);
  });

  it("replaces a placeholder saved by an earlier release", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "b2.gif"), PLACEHOLDER);
    const media = new Media(dir);
    const p = page([{ type: "image/webp", data: WEBP }]);
    expect(await media.image(p.page, "b2", "blob:https://teams.cloud.microsoft/2")).toBe("b2.webp");
    expect(fs.readdirSync(dir)).toEqual(["b2.webp"]);
  });

  it("serves a saved image without asking the page", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "c3.png"), PNG);
    const p = page([]);
    expect(await new Media(dir).image(p.page, "c3", "blob:https://teams.cloud.microsoft/3")).toBe("c3.png");
    expect(p.srcs).toEqual([]);
  });

  it("asks once per address: a failed one is not asked again, a new one is", async () => {
    const media = new Media(tempDir());
    const p = page([null, { type: "image/png", data: PNG }]);
    const original = "https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/o1/views/imgo_webp";
    expect(await media.image(p.page, "d4", original)).toBeNull();
    expect(await media.image(p.page, "d4", original)).toBeNull();
    expect(await media.image(p.page, "d4", "blob:https://teams.cloud.microsoft/4")).toBe("d4.png");
    expect(p.srcs).toEqual([original, "blob:https://teams.cloud.microsoft/4"]);
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
