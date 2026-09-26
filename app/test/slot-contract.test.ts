import { describe, expect, it } from "vitest";
import { COMMAND_TYPES, DownloadArgs, IMAGE_TYPES, ImageArgs, MessageArgs, parseArgs, ReactArgs, TextArgs, UPLOAD_NAME } from "@/shared/slot-db/commands";
import { AgentHealth, cmdResultKey, Identity, oneToOneKey, parseState, selfCheckKey, Viewing } from "@/shared/slot-db/state";

describe("command types", () => {
  it("keeps the names of earlier releases and adds sendimage", () => {
    expect(COMMAND_TYPES).toEqual(["open", "send", "reply", "react", "edit", "delete", "undodelete", "download", "activity", "resync", "recheck", "sendimage"]);
  });
});

describe("image commands", () => {
  it("read the upload and the caption", () => {
    expect(parseArgs(ImageArgs, '{"file":"0123456789abcdef.png","text":"For you"}')).toEqual({ file: "0123456789abcdef.png", text: "For you" });
    expect(parseArgs(ImageArgs, '{"file":"0123456789abcdef.jpg"}')).toEqual({ file: "0123456789abcdef.jpg", text: "" });
  });

  it("name uploads with 16 hex characters and the extension of an accepted type", () => {
    for (const ext of Object.keys(IMAGE_TYPES)) expect(UPLOAD_NAME.test(`0123456789abcdef.${ext}`), ext).toBe(true);
    for (const bad of ["../1/app.db", "0123456789abcdef.svg", "0123456789ABCDEF.png", "0123456789abcdef.png/x", ""]) expect(UPLOAD_NAME.test(bad), bad).toBe(false);
  });
});

describe("command arguments", () => {
  it("reads the JSON the web app queues", () => {
    expect(parseArgs(TextArgs, JSON.stringify({ mid: "1790", text: "On it" }))).toEqual({ mid: "1790", text: "On it" });
    expect(parseArgs(MessageArgs, '{"mid":"1790"}')).toEqual({ mid: "1790" });
    expect(parseArgs(DownloadArgs, '{"name":"Q3 report.pdf"}')).toEqual({ name: "Q3 report.pdf" });
  });

  it("tells a quick reaction from a pill", () => {
    expect(parseArgs(ReactArgs, '{"mid":"1","emoji":"like"}')).toEqual({ mid: "1", emoji: "like" });
    expect(parseArgs(ReactArgs, '{"mid":"1","pill":"👍"}')).toEqual({ mid: "1", pill: "👍" });
  });

  it("gives empty arguments for broken JSON, like the Python agent", () => {
    expect(parseArgs(TextArgs, "{")).toEqual({ mid: "", text: "" });
    expect(parseArgs(TextArgs, "")).toEqual({ mid: "", text: "" });
    expect(parseArgs(TextArgs, "[1, 2]")).toEqual({ mid: "", text: "" });
    expect(parseArgs(TextArgs, null)).toEqual({ mid: "", text: "" });
  });

  it("reads a field of the wrong type as empty and keeps the others", () => {
    expect(parseArgs(TextArgs, '{"mid":42,"text":"ok","extra":true}')).toEqual({ mid: "", text: "ok" });
  });
});

describe("state rows", () => {
  it("reads the health row written by the Python agent", () => {
    // state.v of key health on the local stack, 2026-09-26
    const py =
      '{"cdp": "ok", "ts": 1790419968, "teams": "ok", "reduced": false, "hook": "ok", "presence": "available", "push_subs": 0, "last_msg_ts": 0, "last_scan_ts": 1790419957, "watcher": "ok", "overall": "green"}';
    expect(parseState(AgentHealth, py, null)).toMatchObject({ teams: "ok", presence: "available", overall: "green", last_scan_ts: 1790419957 });
  });

  it("reads viewing as written by the web app and by the Python agent", () => {
    expect(parseState(Viewing, '{"chat":"Anna Rossi","ts":1790419968}', null)).toEqual({ chat: "Anna Rossi", ts: 1790419968 });
    expect(parseState(Viewing, '{"chat": "Anna Rossi", "ts": 1790419968}', null)).toEqual({ chat: "Anna Rossi", ts: 1790419968 });
  });

  it("falls back on a missing or broken row", () => {
    expect(parseState(Viewing, "", null)).toBeNull();
    expect(parseState(Viewing, "{", null)).toBeNull();
    expect(parseState(AgentHealth, '{"teams":"ok"}', null)).toBeNull();
  });

  it("fills the missing fields of the identity", () => {
    expect(parseState(Identity, '{"email":"anna.rossi@contoso.example"}', null)).toEqual({ name: "", email: "anna.rossi@contoso.example", tenant: "", av: "" });
  });

  it("builds the per-item keys", () => {
    expect(cmdResultKey(12)).toBe("cmd_result:12");
    expect(oneToOneKey("Anna Rossi")).toBe("chat_1to1:Anna Rossi");
    expect(selfCheckKey("20260926", "pm")).toBe("hc_20260926_pm");
  });
});
