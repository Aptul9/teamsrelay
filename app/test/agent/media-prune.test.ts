import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import type { Agent } from "@/agent/context";
import { pruneMedia } from "@/agent/jobs/media";
import { avatarFile } from "@/agent/logic/files";
import type { ChatEntry } from "@/agent/logic/chats";
import { Media } from "@/agent/media";
import type { ActivityEntry } from "@/agent/store/slot-store";
import { SlotStore } from "@/agent/store/slot-store";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

const chat = (name: string, av: string): ChatEntry => ({ name, preview: "", time: "", unread: false, mention: false, muted: false, av });
const item = (id: string, av: string): ActivityEntry => ({ id, kind: "reaction", actor: "Anna Rossi", title: "", emoji: "", preview: "", tm: "", chat: "Anna Rossi", channel: false, unread: false, av });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

// A media folder holding these files
function folder(...names: string[]) {
  const dir = tempDir();
  for (const n of names) fs.writeFileSync(path.join(dir, n), PNG);
  return dir;
}

// Address of the profile picture of a person, as Teams draws it in the chat list
const src = (id: string) => `https://teams.cloud.microsoft/api/mt/emea/beta/users/me/profilepicturev2/8:orgid:${id}?displayname=${id}&size=HR64x64`;

describe("files the rows name", () => {
  it("are the pictures of the chats, of the feed and of the account, and the images and pictures of the messages kept", () => {
    const store = SlotStore.open(path.join(tempDir(), "messages.db"));
    store.saveChats([chat("Anna Rossi", "aaaaaaaaaaaaaaa1.png"), chat("Luca Bianchi", "")]);
    store.saveActivity([item("101", "bbbbbbbbbbbbbbb2.png"), item("102", "")]);
    store.saveChatMessages("Anna Rossi", [
      {
        mid: "m1",
        author: "Anna Rossi",
        text: "",
        mine: false,
        reacts: "",
        extra: { av: "ccccccccccccccc3.png", images: [{ f: "ddddddddddddddd4.webp", w: 1, h: 1 }, { url: "https://media.giphy.com/media/x/giphy.gif" }] },
      },
      { mid: "m2", author: "", text: "ok", mine: true, reacts: "", extra: null },
    ]);
    // a chat that left the list keeps the messages saved the last time it was open, and their images with them
    store.saveChatMessages("Old chat", [{ mid: "m3", author: "Old", text: "", mine: false, reacts: "", extra: { images: [{ f: "eeeeeeeeeeeeeee5.jpg" }] } }]);
    store.setState(STATE.me, JSON.stringify({ name: "Test User", email: "test.user@contoso.example", tenant: "Contoso", av: "fffffffffffffff6.png" }));
    expect([...store.mediaFiles()].sort()).toEqual([
      "aaaaaaaaaaaaaaa1.png",
      "bbbbbbbbbbbbbbb2.png",
      "ccccccccccccccc3.png",
      "ddddddddddddddd4.webp",
      "eeeeeeeeeeeeeee5.jpg",
      "fffffffffffffff6.png",
    ]);
  });

  it("are none in a new database", () => {
    expect(SlotStore.open(path.join(tempDir(), "messages.db")).mediaFiles()).toEqual(new Set());
  });

  it("are read past rows no app shows: broken JSON, images that are not a list, an account that is not JSON", () => {
    const file = path.join(tempDir(), "messages.db");
    const store = SlotStore.open(file);
    store.saveChats([chat("Anna Rossi", "aaaaaaaaaaaaaaa1.png")]);
    const db = new Database(file);
    const insert = db.prepare("INSERT INTO chat_messages(chat, idx, mid, author, text, mine, reacts, extra) VALUES(?,?,?,?,?,?,?,?)");
    insert.run("A", 0, "m1", "", "", 0, "", "{broken");
    insert.run("A", 1, "m2", "", "", 0, "", JSON.stringify({ images: 5, av: 7 }));
    insert.run("A", 2, "m3", "", "", 0, "", JSON.stringify({ images: [null, { f: "ccccccccccccccc3.png" }] }));
    db.close();
    store.setState(STATE.me, "not json");
    expect([...store.mediaFiles()].sort()).toEqual(["aaaaaaaaaaaaaaa1.png", "ccccccccccccccc3.png"]);
  });
});

describe("pictures no row names", () => {
  it("leave the media folder; the files a row names and the files of other names stay", () => {
    const dir = folder("aaaaaaaaaaaaaaa1.png", "0000000000000000.png", "1111111111111111.webp", "notes.txt", "aaaaaaaaaaaaaaa1.png.tmp");
    expect(new Media(dir, tempDir()).prune(new Set(["aaaaaaaaaaaaaaa1.png"]))).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual(["aaaaaaaaaaaaaaa1.png", "aaaaaaaaaaaaaaa1.png.tmp", "notes.txt"]);
  });

  it("are none before the first picture: no folder yet", () => {
    expect(new Media(path.join(tempDir(), "media"), tempDir()).prune(new Set())).toBe(0);
  });

  it("go after a start that lists other people: the pictures of the chats listed now stay, those of the chats gone do not", async () => {
    const dir = tempDir();
    const mediaDir = path.join(dir, "media");
    const store = SlotStore.open(path.join(dir, "relay.db"));
    const media = new Media(mediaDir, path.join(dir, "files"));
    // every picture the page is asked for is drawn in it
    const page = { evaluate: async () => PNG.toString("base64") } as unknown as Page;
    const a = { store, media } as unknown as Agent;
    const list = async (...people: string[]) =>
      store.saveChats(await media.avatars(page, people.map((p) => ({ ...chat(p, ""), avsrc: src(p) })), 40), true);

    // first start: the list below the first screen shows B and C; second start: D and E instead (thousands of chats)
    await list("A", "B", "C");
    pruneMedia(a);
    await list("A", "D", "E");
    expect(fs.readdirSync(mediaDir)).toHaveLength(5);
    pruneMedia(a);
    expect(fs.readdirSync(mediaDir).sort()).toEqual([avatarFile(src("A")), avatarFile(src("D")), avatarFile(src("E"))].sort());
    expect(store.chats().map((c) => fs.existsSync(path.join(mediaDir, c.av)))).toEqual([true, true, true]);
  });
});
