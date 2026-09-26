// People of a chat, on fixtures captured from Teams web (slot 2 of the local stack, 2026-09-26) with
// scripts/capture-fixture.ts: the structure is Teams', every name is invented.
import { describe, expect, it } from "vitest";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { rosterNames, topicNames } from "@/agent/teams/scripts/members";
import { fixture, withChrome } from "./chrome";

const chrome = withChrome();

describe("members captured from Teams", () => {
  it("reads every name of the member list of a group chat, never its buttons", async () => {
    await chrome.page.setContent(fixture("roster.html"));
    expect(await chrome.page.evaluate(rosterNames, SEL)).toEqual([
      "REN Dus",
      "SAF Vel",
      "TOR Nix",
      "BEP Ulm",
      "RAZ Zen",
      "FIQ Mox",
      "TAJ Geb",
      "LIN Pav",
      "SOR Karlom",
      "LOMLOM Mivlom",
    ]);
  });

  it("reads the person of a 1:1 chat, and you in the self chat, from the header", async () => {
    await chrome.page.setContent(fixture("conversation.html"));
    expect(await chrome.page.evaluate(topicNames, { s: SEL, t: TEXTS })).toEqual(["MIV Ren"]);
    await chrome.page.setContent(fixture("conversation-image.html"));
    expect(await chrome.page.evaluate(topicNames, { s: SEL, t: TEXTS })).toEqual(["MIV Ren"]);
  });

  it("finds nobody where the header names nobody", async () => {
    await chrome.page.setContent('<h2 data-tid="chat-title"><div><span dir="auto">Cloud team</span></div></h2><ul data-tid="chat-topic-menu"></ul>');
    expect(await chrome.page.evaluate(topicNames, { s: SEL, t: TEXTS })).toEqual([]);
  });
});
