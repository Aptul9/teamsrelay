// @ in the compose box, on fixtures captured from Teams web (slot 2 of the local stack, 2026-09-26) with
// scripts/capture-fixture.ts: the structure is Teams', every name is invented.
import { describe, expect, it } from "vitest";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { composerMentionNames, mentionMessageSent, mentionOptionPoint } from "@/agent/teams/scripts/mentions";
import { fixture, withChrome } from "./chrome";

const chrome = withChrome();

describe("list of people of the @, captured from a group chat", () => {
  it("points at the entry of exactly that person", async () => {
    await chrome.page.setContent(fixture("mention-popup.html"));
    const point = await chrome.page.evaluate(mentionOptionPoint, { s: SEL, name: "DUS Saf" });
    expect(point).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    const tid = await chrome.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="option"]')?.getAttribute("data-tid"), point!);
    expect(tid).toBe("autocomplete-picker-item-DUS Saf");
  });

  it("finds no entry for someone else, a part of a name or an entry that is not a person", async () => {
    await chrome.page.setContent(fixture("mention-popup.html"));
    expect(await chrome.page.evaluate(mentionOptionPoint, { s: SEL, name: "DUS" })).toBeNull();
    expect(await chrome.page.evaluate(mentionOptionPoint, { s: SEL, name: "Somebody Else" })).toBeNull();
    await chrome.page.evaluate(() => document.querySelector('[data-tid="autocomplete-picker-item-DUS Saf"]')!.setAttribute("itemtype", "shareContact"));
    expect(await chrome.page.evaluate(mentionOptionPoint, { s: SEL, name: "DUS Saf" })).toBeNull();
  });
});

describe("person picked in the compose box, captured", () => {
  it("reads the name of the mention, words joined as Teams shows them", async () => {
    await chrome.page.setContent(fixture("mention-picked.html"));
    expect(await chrome.page.evaluate(composerMentionNames, SEL)).toEqual(["LOM Miv"]);
    await chrome.page.setContent('<div data-tid="ckeditor" contenteditable="true"><p>no one</p></div>');
    expect(await chrome.page.evaluate(composerMentionNames, SEL)).toEqual([]);
  });
});

describe("message with people tagged, sent", () => {
  const TEXT_MID = "1790000000006";

  // the conversation captured from Teams, its last message of yours tagging `name`, with the status `status`
  async function sent(name: string, status: string) {
    await chrome.page.setContent(fixture("conversation-image.html"));
    return chrome.page.evaluate(
      ({ mid, name, status }) => {
        const m = document.querySelector(`[data-mid="${mid}"]`)!;
        m.querySelector('[id^="content-"] p')!.insertAdjacentHTML(
          "afterbegin",
          `<span data-mention-type="person" aria-label="${name}"><span itemtype="http://schema.skype.com/Mention">${name}</span></span> `,
        );
        m.closest(".fui-ChatMyMessage")!.querySelector('[class*="statusIcon"]')!.setAttribute("aria-label", status);
        return [...document.querySelectorAll('[data-tid="chat-pane-message"]')].map((e) => e.getAttribute("data-mid") || "").filter((x) => x !== mid);
      },
      { mid: TEXT_MID, name, status },
    );
  }

  it("is seen once Teams has it, with every person tagged", async () => {
    const before = await sent("DUS Saf", "Sent");
    expect(await chrome.page.evaluate(mentionMessageSent, { s: SEL, t: TEXTS, before, names: ["DUS Saf"] })).toBe(true);
  });

  it("is not seen before Teams draws its status icon, or when Teams failed to send it", async () => {
    const before = await sent("DUS Saf", "Sent");
    await chrome.page.evaluate((mid) => document.querySelector(`[data-mid="${mid}"]`)!.closest(".fui-ChatMyMessage")!.querySelector('[class*="statusIcon"]')!.remove(), TEXT_MID);
    expect(await chrome.page.evaluate(mentionMessageSent, { s: SEL, t: TEXTS, before, names: ["DUS Saf"] })).toBe(false);
    await sent("DUS Saf", "Failed to send");
    expect(await chrome.page.evaluate(mentionMessageSent, { s: SEL, t: TEXTS, before, names: ["DUS Saf"] })).toBe(false);
  });

  it("is not seen while sending, without the person, or among the messages already there", async () => {
    let before = await sent("DUS Saf", "Sending...");
    expect(await chrome.page.evaluate(mentionMessageSent, { s: SEL, t: TEXTS, before, names: ["DUS Saf"] })).toBe(false);
    before = await sent("DUS Saf", "Sent");
    expect(await chrome.page.evaluate(mentionMessageSent, { s: SEL, t: TEXTS, before, names: ["DUS Saf", "VEL Tor"] })).toBe(false);
    expect(await chrome.page.evaluate(mentionMessageSent, { s: SEL, t: TEXTS, before: [...before, TEXT_MID], names: ["DUS Saf"] })).toBe(false);
  });
});
