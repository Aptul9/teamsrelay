// Page scripts around the actions on a message, on a conversation with two action bars in a portal, like
// Teams draws them when the mouse moves between messages.
import { describe, expect, it } from "vitest";
import { ACTIONS, SEL } from "@/agent/teams/selectors";
import {
  barButtonPoint,
  composerText,
  deletedState,
  isOwnMessage,
  lastMessageQuotes,
  messageBodyText,
  messageCount,
  openOverlays,
  ownReactions,
  quoteBoxReady,
  reactionPill,
  readReceiptNames,
  undoButtonPoint,
} from "@/agent/teams/scripts/message-actions";
import { withChrome } from "./chrome";

const bar = (top: number) => `
<div data-tid="message-actions-container" style="position:absolute; top:${top}px; left:600px; height:32px; width:200px">
  <button data-tid="message-actions-like" style="position:absolute; left:0; width:32px; height:32px">like</button>
  <button data-tid="message-actions-more" style="position:absolute; left:40px; width:32px; height:32px">more</button>
</div>`;

const PAGE = `
<div style="position:absolute; top:0; left:0; width:560px">
  <div data-tid="chat-pane-item" style="height:100px">
    <div data-tid="chat-pane-message" data-mid="1" style="height:60px"><div id="content-1">first</div></div>
    <button data-tid="diverse-reaction-pill-button" aria-pressed="true" aria-labelledby="pill-like-1"><img alt="👍">1</button>
    <button data-tid="diverse-reaction-pill-button" aria-pressed="false" aria-labelledby="pill-heart-1"><img alt="❤️">2</button>
  </div>
  <div data-tid="chat-pane-item" style="height:100px">
    <div class="fui-ChatMyMessage"><div data-tid="chat-pane-message" data-mid="2" style="height:60px"><div id="content-2">mine&nbsp;text</div></div></div>
  </div>
  <div data-tid="chat-pane-item" style="height:100px">
    <div data-tid="chat-pane-message" data-mid="3"><div id="content-3"></div></div>
    <div data-tid="message-tombstone">Deleted <button data-tid="message-undo-delete-btn">Undo</button></div>
  </div>
</div>
${bar(10)}${bar(110)}
<div style="position:absolute; top:700px">
  <div data-tid="close-quoted-reply"></div>
  <div data-tid="ckeditor" contenteditable="true">typed reply</div>
</div>`;

const chrome = withChrome();

describe("message action page scripts", () => {
  it("clicks the bar closest to the message", async () => {
    await chrome.page.setContent(PAGE);
    expect(await chrome.page.evaluate(barButtonPoint, { s: SEL, mid: "1", tid: "message-actions-like" })).toEqual({ x: 616, y: 26 });
    expect(await chrome.page.evaluate(barButtonPoint, { s: SEL, mid: "2", tid: ACTIONS.more })).toEqual({ x: 656, y: 126 });
    expect(await chrome.page.evaluate(barButtonPoint, { s: SEL, mid: "2", tid: ACTIONS.edit })).toBeNull();
    expect(await chrome.page.evaluate(barButtonPoint, { s: SEL, mid: "9", tid: ACTIONS.more })).toBeNull();
  });

  it("gives no point where something covers the button, like an incoming call toast: the click would land on it", async () => {
    const toast = '<div data-testid="calling-notification" style="position:fixed; inset:0; z-index:10"><button aria-label="Accept with audio">Accept</button></div>';
    await chrome.page.setContent(PAGE + toast);
    expect(await chrome.page.evaluate(barButtonPoint, { s: SEL, mid: "1", tid: "message-actions-like" })).toBeNull();
    expect(await chrome.page.evaluate(reactionPill, { s: SEL, mid: "1", emoji: "❤️" })).toMatchObject({ found: true, covered: true });
    expect(await chrome.page.evaluate(undoButtonPoint, { s: SEL, mid: "3" })).toBeNull();
    await chrome.page.setContent(PAGE);
    expect(await chrome.page.evaluate(reactionPill, { s: SEL, mid: "1", emoji: "❤️" })).toMatchObject({ found: true, covered: false });
  });

  it("finds a bar only within 120 px of the message", async () => {
    await chrome.page.setContent(PAGE.replace(bar(10), "").replace(bar(110), bar(400)));
    expect(await chrome.page.evaluate(barButtonPoint, { s: SEL, mid: "1", tid: "message-actions-like" })).toBeNull();
  });

  it("reads the reaction pills and your reactions", async () => {
    await chrome.page.setContent(PAGE);
    expect(await chrome.page.evaluate(ownReactions, { s: SEL, mid: "1" })).toEqual(["like"]);
    expect(await chrome.page.evaluate(reactionPill, { s: SEL, mid: "1", emoji: "❤️" })).toMatchObject({ found: true, pressed: false });
    expect(await chrome.page.evaluate(reactionPill, { s: SEL, mid: "1", emoji: "😂" })).toEqual({ found: false });
    expect(await chrome.page.evaluate(reactionPill, { s: SEL, mid: "9", emoji: "😂" })).toBeNull();
  });

  it("tells your messages, deleted ones and missing ones apart", async () => {
    await chrome.page.setContent(PAGE);
    expect(await chrome.page.evaluate(isOwnMessage, { s: SEL, mid: "2" })).toBe(true);
    expect(await chrome.page.evaluate(isOwnMessage, { s: SEL, mid: "1" })).toBe(false);
    expect(await chrome.page.evaluate(deletedState, { s: SEL, mid: "3" })).toBe("deleted");
    expect(await chrome.page.evaluate(deletedState, { s: SEL, mid: "2" })).toBe("present");
    expect(await chrome.page.evaluate(deletedState, { s: SEL, mid: "9" })).toBe("missing");
    expect(await chrome.page.evaluate(undoButtonPoint, { s: SEL, mid: "3" })).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    expect(await chrome.page.evaluate(undoButtonPoint, { s: SEL, mid: "2" })).toBeNull();
    expect(await chrome.page.evaluate(messageBodyText, "2")).toBe("mine text");
    expect(await chrome.page.evaluate(messageBodyText, "9")).toBeNull();
    expect(await chrome.page.evaluate(messageCount, SEL)).toBe(3);
  });

  it("reads the compose box and the quote above it", async () => {
    await chrome.page.setContent(PAGE);
    expect(await chrome.page.evaluate(quoteBoxReady, SEL)).toBe(true);
    expect(await chrome.page.evaluate(composerText, SEL)).toBe("typed reply");
    expect(await chrome.page.evaluate(lastMessageQuotes, { s: SEL, before: 2, text: "first" })).toBe(false);
  });

  it("confirms a reply by the quote in the new last message", async () => {
    await chrome.page.setContent(`${PAGE}
      <div data-tid="chat-pane-item"><div data-tid="quoted-reply-card">first</div><div data-tid="chat-pane-message" data-mid="4">On it</div></div>`);
    expect(await chrome.page.evaluate(lastMessageQuotes, { s: SEL, before: 3, text: "On it" })).toBe(true);
    expect(await chrome.page.evaluate(lastMessageQuotes, { s: SEL, before: 4, text: "On it" })).toBe(false);
  });

  it("counts open menus and reads the names of the read-by submenu", async () => {
    await chrome.page.setContent(`
      <div role="menu"><div role="menuitem" data-tid="message-actions-read-receipt">Read by 2 of 3</div></div>
      <div role="menu"><div role="menuitem">Anna Rossi</div><div role="menuitem">Luca Bianchi</div></div>
      <div role="dialog" style="display:none"></div>`);
    expect(await chrome.page.evaluate(openOverlays, SEL)).toBe(2);
    expect(await chrome.page.evaluate(readReceiptNames, { s: SEL, entry: ACTIONS.readReceipt })).toEqual(["Anna Rossi", "Luca Bianchi"]);
  });
});
