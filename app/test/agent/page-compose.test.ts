// Page scripts of the compose box: the paste of an image, and the check that the image went out. The conversation
// is the fixture captured from Teams (scripts/capture-fixture.ts); the compose box is CKEditor there, stood in
// for here by a box that takes the paste like it does.
import { describe, expect, it } from "vitest";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { composerImages, composerLeft, imageMessageSent, messageIds, pasteImage } from "@/agent/teams/scripts/compose";
import { fixture, picture, withChrome } from "./chrome";

const chrome = withChrome();

// PNG signature plus bytes of every value: the page must hand over exactly these
const BYTES = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);
const image = { name: "photo.png", type: "image/png", data: BYTES.toString("base64") };

// Compose box that records what a paste hands it and, like CKEditor, takes it
const COMPOSE = `
<div data-tid="ckeditor" contenteditable="true" role="textbox" aria-label="Type a message"><p><br></p></div>
<script>
  document.querySelector('[data-tid="ckeditor"]').addEventListener("paste", async (e) => {
    const f = e.clipboardData.files[0];
    if (!f) return;
    e.preventDefault();
    const bytes = [...new Uint8Array(await f.arrayBuffer())];
    window.pasted = { name: f.name, type: f.type, size: f.size, bytes };
  });
</script>`;

describe("paste of an image", () => {
  it("hands the compose box a file with the name, type and bytes given", async () => {
    await chrome.page.setContent(COMPOSE);
    expect(await chrome.page.evaluate(pasteImage, { s: SEL, ...image })).toBe(true);
    await chrome.page.waitForFunction(() => (window as unknown as { pasted?: unknown }).pasted);
    const pasted = await chrome.page.evaluate(() => (window as unknown as { pasted: { name: string; type: string; size: number; bytes: number[] } }).pasted);
    expect({ ...pasted, bytes: Buffer.from(pasted.bytes) }).toEqual({ name: "photo.png", type: "image/png", size: BYTES.length, bytes: BYTES });
  });

  it("tells when the compose box did not take the paste", async () => {
    await chrome.page.setContent('<div data-tid="ckeditor" contenteditable="true"></div>');
    expect(await chrome.page.evaluate(pasteImage, { s: SEL, ...image })).toBe(false);
    await chrome.page.setContent("<p>no compose box</p>");
    expect(await chrome.page.evaluate(pasteImage, { s: SEL, ...image })).toBe(false);
  });

  it("counts the images in the compose box", async () => {
    await chrome.page.setContent(`<div data-tid="ckeditor" contenteditable="true"><p>hi</p></div><img src="${picture(20)}">`);
    expect(await chrome.page.evaluate(composerImages, SEL)).toBe(0);
    await chrome.page.setContent(`<div data-tid="ckeditor" contenteditable="true"><p><img data-tid="image-with-loader" src="${picture(20)}"></p></div>`);
    expect(await chrome.page.evaluate(composerImages, SEL)).toBe(1);
  });
});

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

describe("image sent, on the conversation captured from Teams", () => {
  const IMAGE_MID = "1790000000004";

  // mids in the page, and the status Teams gives the image message (Sending... then Sent)
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

  it("sees a new image message of yours", async () => {
    const mids = await conversation();
    expect(await chrome.page.evaluate(imageMessageSent, { s: SEL, t: TEXTS, before: mids.filter((m) => m !== IMAGE_MID) })).toBe(true);
  });

  it("waits while Teams still shows it as sending", async () => {
    const mids = await conversation("Sending...");
    const before = mids.filter((m) => m !== IMAGE_MID);
    expect(await chrome.page.evaluate(imageMessageSent, { s: SEL, t: TEXTS, before })).toBe(false);
    await conversation("Sent");
    expect(await chrome.page.evaluate(imageMessageSent, { s: SEL, t: TEXTS, before })).toBe(true);
  });

  it("does not take a message that was already there, or one without an image", async () => {
    const mids = await conversation();
    expect(await chrome.page.evaluate(imageMessageSent, { s: SEL, t: TEXTS, before: mids })).toBe(false);
    const withoutText = mids.filter((m) => m !== "1790000000006");
    expect(await chrome.page.evaluate(imageMessageSent, { s: SEL, t: TEXTS, before: withoutText })).toBe(false);
  });
});
