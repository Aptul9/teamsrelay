// Page scripts of the compose box: what is left in it before a send, and the check that the message went out. The
// conversation is the fixture captured from Teams (scripts/capture-fixture.ts in teamsrelay).
import { describe, expect, it } from "vitest";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { composerLeft, messageIds, ownMessageSent } from "@/agent/teams/scripts/compose";
import { fixture, picture, withChrome } from "./chrome";

const chrome = withChrome();

describe("what is left in the compose box", () => {
  it("counts text, images and people tagged, not the invisible marks of an empty box", async () => {
    const left = async (inner: string) => {
      await chrome.page.setContent(`<div data-tid="ckeditor" contenteditable="true">${inner}</div>`);
      return chrome.page.evaluate(composerLeft, SEL);
    };
    expect(await left('<p class="ck-placeholder"><br></p>')).toBe(0);
    expect(await left("<p>⁠⁠​ </p>")).toBe(0);
    expect(await left("<p>@Ro</p>")).toBeGreaterThan(0);
    expect(await left(`<p><img src="${picture(10)}"></p>`)).toBeGreaterThan(0);
    expect(await left(fixture("mention-picked.html").replace(/^<!--.*-->\n/, "").replace(/<\/?div[^>]*>/g, ""))).toBeGreaterThan(0);
  });
});

describe("message sent, on the conversation captured from Teams (self chat: every message is yours)", () => {
  const IMAGE_MID = "1790000000004";

  // mids in the page, and the status Teams gives the new message (Sending... then Sent)
  async function conversation(status?: string) {
    await chrome.page.setContent(fixture("conversation-image.html"));
    return chrome.page.evaluate(
      ({ mid, status }) => {
        const mids = [...document.querySelectorAll('[data-tid="chat-pane-message"]')].map((m) => m.getAttribute("data-mid") || "");
        if (status !== undefined) {
          const item = document.querySelector(`[data-mid="${mid}"]`)!.closest('[data-tid="chat-pane-item"]')!;
          // the image message is the last one, as right after the send
          for (const later of [...document.querySelectorAll('[data-tid="chat-pane-item"]')].slice(mids.indexOf(mid) + 1)) later.remove();
          const icon = document.createElement("span");
          icon.className = "fui-ChatMyMessage__statusIcon";
          icon.setAttribute("aria-label", status);
          item.querySelector(".fui-ChatMyMessage")!.appendChild(icon);
        }
        return mids;
      },
      { mid: IMAGE_MID, status },
    );
  }

  it("lists the ids of the messages", async () => {
    await conversation();
    expect(await chrome.page.evaluate(messageIds, SEL)).toEqual(["1790000000002", "1790000000003", IMAGE_MID, "1790000000006"]);
  });

  it("sees a new message of yours", async () => {
    const mids = await conversation();
    expect(await chrome.page.evaluate(ownMessageSent, { s: SEL, t: TEXTS, before: mids.filter((m) => m !== IMAGE_MID) })).toBe(true);
  });

  it("waits while Teams still shows it as sending", async () => {
    const mids = await conversation("Sending...");
    const before = mids.filter((m) => m !== IMAGE_MID);
    expect(await chrome.page.evaluate(ownMessageSent, { s: SEL, t: TEXTS, before })).toBe(false);
    await conversation("Sent");
    expect(await chrome.page.evaluate(ownMessageSent, { s: SEL, t: TEXTS, before })).toBe(true);
  });

  it("does not take a message that was already there, or a new one of someone else", async () => {
    const mids = await conversation();
    expect(await chrome.page.evaluate(ownMessageSent, { s: SEL, t: TEXTS, before: mids })).toBe(false);
    const LAST = "1790000000006";
    await chrome.page.evaluate((mid) => {
      const item = document.querySelector(`[data-mid="${mid}"]`)!.closest('[data-tid="chat-pane-item"]')!;
      for (const e of item.querySelectorAll(".fui-ChatMyMessage")) e.classList.remove("fui-ChatMyMessage");
    }, LAST);
    expect(await chrome.page.evaluate(ownMessageSent, { s: SEL, t: TEXTS, before: mids.filter((m) => m !== LAST) })).toBe(false);
  });
});
