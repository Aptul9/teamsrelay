import type { ReactionName } from "@/shared/slot-db/commands";
import type { ReadBy } from "@/shared/slot-db/rows";
import { errorText, log } from "../log";
import { confirmSent, messageSelector, sleep, until, type AfterPress, type SendResult, type TeamsPage } from "./page";
import { composerImages, composerLeft, imageMessageSent, messageIds, ownMessageSent, pasteImage } from "./scripts/compose";
import {
  composerText,
  deletedState,
  isOwnMessage,
  lastMessageQuotes,
  messageBodyText,
  messageCount,
  ownReactions,
  quoteBoxReady,
  reactionPill,
  readReceiptNames,
  undoButtonPoint,
} from "./scripts/message-actions";
import { ACTIONS, BAR_REACTIONS, PICKER_REACTIONS, SEL, TEXTS } from "./selectors";

// The actions on Teams. Each one checks on the page that Teams applied it and answers true only then.

// A click or a key that threw may have sent the message or not: the page says which. The text still in the compose
// box and no new message: it never left (a panel over the Send button caught the click), the box is emptied and the
// send failed. Anything else, or a page that cannot be read: it may be out.
async function afterFailedPress(tp: TeamsPage, text: string, before: string[]): Promise<SendResult> {
  try {
    await sleep(1000);
    const left = (await tp.page.evaluate(composerText, SEL)).includes(text.slice(0, 20));
    const fresh = (await tp.page.evaluate(messageIds, SEL)).some((mid) => !before.includes(mid));
    if (left && !fresh) {
      await tp.emptyComposeBox();
      return "failed";
    }
  } catch {
    // the page cannot say
  }
  return "unconfirmed";
}

// The text typed in the compose box and sent, as a person does. Refused when Teams shows another chat or the
// compose box holds a draft, which would go out with it; whatever goes wrong before the send leaves the box empty.
// Sent once Teams shows the new message as sent (15 s at most), unconfirmed when it went and Teams does not show it.
// `sent` runs as soon as the message went.
export async function sendText(tp: TeamsPage, chat: string, raw: string, sent?: AfterPress): Promise<SendResult> {
  const text = raw.trim();
  if (!text || !(await tp.toChat(chat, true))) return "failed";
  const page = tp.page;
  // a draft already there is someone's: left as it is, nothing sent
  if (await page.evaluate(composerLeft, SEL)) {
    log.warn("send", "compose box not empty", { chat });
    return "failed";
  }
  const before = await page.evaluate(messageIds, SEL);
  let pressed = false;
  try {
    const box = (await page.$(SEL.editor)) ?? (await page.$(SEL.textbox));
    if (!box) throw new Error("no compose box");
    await box.click();
    await sleep(200);
    await page.keyboard.insertText(text);
    await sleep(300);
    if (!(await page.evaluate(composerText, SEL)).includes(text.slice(0, 20))) throw new Error("text not in the compose box");
    const send = await page.$(SEL.sendButton);
    pressed = true;
    if (send) await send.click();
    else await page.keyboard.press("Enter");
  } catch (e) {
    log.warn("send", errorText(e), { chat });
    if (pressed) return afterFailedPress(tp, text, before);
    await tp.emptyComposeBox();
    return "failed";
  }
  return confirmSent({ area: "send", shown: () => page.evaluate(ownMessageSent, { s: SEL, t: TEXTS, before }), tries: 50, sent, fields: { chat } });
}

export type ImageFile = { name: string; type: string; data: Buffer };

// The image goes in as a paste, then the caption, and Enter sends both, as a person does. Refused when Teams
// shows another chat or the compose box holds a draft, which would go out with the image. Sent once Teams shows
// the new message with the image as sent (upload included, 30 s at most), unconfirmed when it does not. `sent` runs as
// soon as the message went.
export async function sendImage(tp: TeamsPage, chat: string, image: ImageFile, caption: string, sent?: AfterPress): Promise<SendResult> {
  if (!(await tp.toChat(chat, true))) return "failed";
  const page = tp.page;
  if ((await page.evaluate(composerText, SEL)).trim() || (await page.evaluate(composerImages, SEL))) {
    log.warn("image", "compose box not empty", { chat });
    return "failed";
  }
  const before = await page.evaluate(messageIds, SEL);
  let pressed = false;
  try {
    if (!(await page.evaluate(pasteImage, { s: SEL, name: image.name, type: image.type, data: image.data.toString("base64") }))) {
      throw new Error("the compose box did not take the image");
    }
    await page.waitForFunction(composerImages, SEL, { timeout: 5000 });
    if (caption.trim()) await page.keyboard.insertText(caption);
    await sleep(300);
    pressed = true;
    await page.keyboard.press("Enter");
  } catch (e) {
    log.warn("image", errorText(e), { chat });
    if (pressed) return "unconfirmed";
    // what was pasted must not go out with the next message
    await tp.emptyComposeBox();
    return "failed";
  }
  return confirmSent({ area: "image", shown: () => page.evaluate(imageMessageSent, { s: SEL, t: TEXTS, before }), tries: 100, sent, fields: { chat } });
}

// Reply with quote: on the bar for other people's messages, in More options for yours. Refused when Teams shows
// another chat or the compose box holds a draft: Teams puts the quote above it, and it would go out with the reply.
// Sent once Teams shows the reply, unconfirmed when Enter went and Teams does not show it. `sent` runs as soon as
// the reply went.
export async function replyWithQuote(tp: TeamsPage, chat: string, mid: string, raw: string, sent?: AfterPress): Promise<SendResult> {
  const text = raw.trim();
  if (!text || !(await tp.toChat(chat, true))) return "failed";
  const page = tp.page;
  if (await page.evaluate(composerLeft, SEL)) {
    log.warn("reply", "compose box not empty", { chat });
    return "failed";
  }
  const before = await page.evaluate(messageCount, SEL);
  let pressed = false;
  try {
    const mine = await page.evaluate(isOwnMessage, { s: SEL, mid });
    if (mine || !(await tp.clickBarButton(mid, ACTIONS.quotedReply))) {
      if (!(await tp.clickBarButton(mid, ACTIONS.more))) {
        log.warn("reply", "action bar not found", { mid });
        return "failed";
      }
      await page.locator(`${SEL.menu} [data-tid="${ACTIONS.quotedReply}"]:visible`).first().click({ timeout: 4000 });
    }
    await page.waitForFunction(quoteBoxReady, SEL, { timeout: 4000 });
    // Teams already put the cursor after the quote: a click on the box would land on the quote and lose the text
    await sleep(300);
    await page.keyboard.insertText(text);
    await sleep(300);
    if (!(await page.evaluate(composerText, SEL)).includes(text.slice(0, 20))) throw new Error("text not in the compose box");
    // the send button changes name with the layout: Enter works in both
    pressed = true;
    await page.keyboard.press("Enter");
  } catch (e) {
    log.warn("reply", errorText(e), { mid });
    if (pressed) return "unconfirmed";
    // no quote left behind in the compose box
    await page.locator(`${SEL.closeQuote}:visible`).first().click({ timeout: 1500 }).catch(() => undefined);
    return "failed";
  } finally {
    await tp.mouseAway();
  }
  return confirmSent({ area: "reply", shown: () => page.evaluate(lastMessageQuotes, { s: SEL, before, text: text.slice(0, 40) }), tries: 20, sent, fields: { mid } });
}

export async function deleteMessage(tp: TeamsPage, chat: string, mid: string): Promise<boolean> {
  if (!(await tp.toChat(chat))) return false;
  try {
    if (!(await tp.clickBarButton(mid, ACTIONS.more))) return false;
    await tp.page.locator(`${SEL.menu} [data-tid="${ACTIONS.delete}"]:visible`).first().click({ timeout: 4000 });
  } catch (e) {
    log.warn("delete", errorText(e), { mid });
    await tp.clearOverlays();
    return false;
  } finally {
    await tp.mouseAway();
  }
  // Teams deletes at once and leaves "Undo" for a few seconds
  if (await until(async () => (await tp.page.evaluate(deletedState, { s: SEL, mid })) === "deleted", 32, 250)) return true;
  log.warn("delete", "no change on Teams", { mid });
  return false;
}

export async function undoDelete(tp: TeamsPage, chat: string, mid: string): Promise<boolean> {
  if (!(await tp.toChat(chat))) return false;
  const point = await tp.page.evaluate(undoButtonPoint, { s: SEL, mid });
  if (!point) return false;
  await tp.page.mouse.click(point.x, point.y);
  await tp.mouseAway();
  return until(async () => (await tp.page.evaluate(deletedState, { s: SEL, mid })) === "present", 16, 250);
}

// Adds a reaction, or removes it when it is already yours. True when your reactions on Teams changed.
export async function react(tp: TeamsPage, chat: string, mid: string, emoji: string): Promise<boolean> {
  const name = emoji as ReactionName;
  const barButton = BAR_REACTIONS[name];
  const pickerButton = PICKER_REACTIONS[name];
  if (!barButton && !pickerButton) return false;
  if (!(await tp.toChat(chat))) return false;
  const mine = () => tp.page.evaluate(ownReactions, { s: SEL, mid });
  const before = JSON.stringify(await mine());
  try {
    if (!(await tp.clickBarButton(mid, barButton ?? ACTIONS.picker))) {
      log.warn("react", "button not found", { mid, emoji });
      return false;
    }
    if (pickerButton) await tp.page.locator(`[data-tid="${pickerButton}"]:visible`).first().click({ timeout: 4000 });
  } catch (e) {
    log.warn("react", errorText(e), { mid, emoji });
    await tp.page.keyboard.press("Escape");
    return false;
  } finally {
    await tp.mouseAway();
  }
  if (await until(async () => JSON.stringify(await mine()) !== before, 12, 250)) return true;
  log.warn("react", "no change on Teams", { mid, emoji });
  return false;
}

// Click on the pill of reaction `emoji` under the message, like in Teams: removed if yours, added otherwise
export async function togglePill(tp: TeamsPage, chat: string, mid: string, emoji: string): Promise<boolean> {
  if (!emoji || !(await tp.toChat(chat))) return false;
  const m = tp.page.locator(messageSelector(mid));
  if ((await m.count()) === 0) return false;
  await m.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await sleep(400);
  const pill = () => tp.page.evaluate(reactionPill, { s: SEL, mid, emoji });
  const was = await pill();
  if (!was || !was.found) {
    log.warn("pill", "reaction not found", { mid, emoji });
    return false;
  }
  if (was.covered) {
    log.warn("pill", "reaction covered by something else on the page (a call?): not clicked", { mid, emoji });
    return false;
  }
  await tp.page.mouse.click(was.x, was.y);
  await tp.mouseAway();
  if (await until(async () => {
    const now = await pill();
    return !!now && (!now.found || now.pressed !== was.pressed);
  }, 12, 250)) return true;
  await tp.clearOverlays();
  log.warn("pill", "no change on Teams", { mid, emoji });
  return false;
}

// Edits one of your messages. True when the text on Teams is the new one.
export async function editMessage(tp: TeamsPage, chat: string, mid: string, raw: string): Promise<boolean> {
  const text = raw.trim();
  if (!text || !(await tp.toChat(chat))) return false;
  const item = tp.page.locator(`${SEL.item}:has(${messageSelector(mid)})`);
  try {
    if (!(await tp.clickBarButton(mid, ACTIONS.edit))) {
      log.warn("edit", "button not found", { mid });
      return false;
    }
    const editor = item.locator(SEL.editor).first();
    await editor.waitFor({ timeout: 4000 });
    await editor.click();
    await tp.page.keyboard.press("Control+A");
    await tp.page.keyboard.press("Delete");
    await tp.page.keyboard.insertText(text);
    await sleep(200);
    await item.locator(SEL.editDone).first().click({ timeout: 3000 });
  } catch (e) {
    log.warn("edit", errorText(e), { mid });
    // the editor left open is discarded, the message stays as it was
    try {
      await item.locator(SEL.editDiscard).first().click({ timeout: 2000 });
      await tp.page.locator(SEL.discardConfirm).click({ timeout: 2000 });
    } catch {}
    return false;
  } finally {
    await tp.mouseAway();
  }
  if (await until(async () => (await tp.page.evaluate(messageBodyText, mid))?.replace(/ /g, " ").trim() === text, 16, 250)) return true;
  log.warn("edit", "text not updated on Teams", { mid });
  return false;
}

// Who read one of your messages: "Read by X of Y" in More options and its submenu with the names. A menu
// without that entry is a 1:1 chat (label ""); null when the menu could not be read.
export async function readReceipts(tp: TeamsPage, chat: string, mid: string): Promise<ReadBy | null> {
  if (!(await tp.toChat(chat))) return null;
  const page = tp.page;
  try {
    const entry = page.locator(`[data-tid="${ACTIONS.readReceipt}"]:visible`).first();
    let found = false;
    let menuSeen = false;
    for (let i = 0; i < 2 && !found; i++) {
      if (!(await tp.clickBarButton(mid, ACTIONS.more))) {
        if (menuSeen) break;
        return null;
      }
      try {
        await page.locator(`${SEL.menu}:visible`).first().waitFor({ timeout: 3000 });
      } catch {
        await tp.clearOverlays();
        continue;
      }
      menuSeen = true;
      try {
        await entry.waitFor({ timeout: 1500 });
        found = true;
      } catch {
        await tp.clearOverlays();
        await sleep(500);
      }
    }
    if (!found) return menuSeen ? { label: "", names: [] } : null;
    const label = (await entry.innerText()).trim();
    await entry.hover();
    await sleep(1000);
    return { label, names: await page.evaluate(readReceiptNames, { s: SEL, entry: ACTIONS.readReceipt }) };
  } catch (e) {
    log.warn("readby", errorText(e), { mid });
    return null;
  } finally {
    await tp.clearOverlays().catch(() => false);
    await tp.mouseAway();
  }
}
