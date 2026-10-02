import type { MentionPart } from "@/shared/slot-db/commands";
import { errorText, log } from "../log";
import { confirmSent, sleep, until, type AfterPress, type SendResult, type TeamsPage } from "./page";
import { composerLeft, messageIds, ownMessageSent } from "./scripts/compose";
import { rosterNames, topicNames } from "./scripts/members";
import { composerMentionNames, mentionOptionPoint } from "./scripts/mentions";
import { SEL, TEXTS } from "./selectors";

// People of a chat and messages that tag them with @. Each action checks on the page that Teams applied it.

// People of a chat as Teams names them: in a group chat the list its participant count opens, read and closed
// with Escape (the list also holds buttons that remove people and leave the chat: nothing in it is clicked);
// in the other chats the header. null when the chat did not open or the list did not show.
export async function readMembers(tp: TeamsPage, chat: string): Promise<string[] | null> {
  if (!(await tp.toChat(chat, true))) return null;
  const page = tp.page;
  const count = page.locator(`${SEL.participantCount}:visible`);
  if (!(await count.count())) return page.evaluate(topicNames, { s: SEL, t: TEXTS });
  try {
    await count.first().click({ timeout: 3000 });
    await page.locator(SEL.rosterName).first().waitFor({ timeout: 5000 });
    return await page.evaluate(rosterNames, SEL);
  } catch (e) {
    log.warn("members", errorText(e), { chat });
    return null;
  } finally {
    await tp.clearOverlays();
  }
}

// @ and the name word by word until Teams lists exactly that person, then a real click on the entry. True once
// the compose box holds one more person tagged.
async function tagPerson(tp: TeamsPage, name: string): Promise<boolean> {
  const page = tp.page;
  const tagged = (await page.evaluate(composerMentionNames, SEL)).length;
  const words = name.split(/\s+/);
  for (let i = 0; i <= words.length; i++) {
    await page.keyboard.type(i === 0 ? "@" : `${i > 1 ? " " : ""}${words[i - 1]}`, { delay: 40 });
    for (let k = 0; k < 8; k++) {
      await sleep(300);
      const point = await page.evaluate(mentionOptionPoint, { s: SEL, name });
      if (!point) continue;
      await page.mouse.click(point.x, point.y);
      return until(async () => (await page.evaluate(composerMentionNames, SEL)).length > tagged, 10, 200);
    }
  }
  log.warn("mention", "not in the list of Teams", { name });
  return false;
}

// Types the message in the empty compose box of the open chat, text as it is and people picked in the Teams list,
// and checks every person is tagged. Nothing is sent.
async function composeWithMentions(tp: TeamsPage, parts: readonly MentionPart[]): Promise<boolean> {
  const page = tp.page;
  await page.locator(SEL.editor).last().focus({ timeout: 2000 });
  for (const part of parts) {
    if ("text" in part) await page.keyboard.insertText(part.text);
    else if (!(await tagPerson(tp, part.mention))) return false;
  }
  const tagged = await page.evaluate(composerMentionNames, SEL);
  return parts.every((p) => !("mention" in p) || tagged.includes(p.mention));
}

// The message with people tagged, as a person writes it: refused when Teams shows another chat or the compose box
// holds a draft; whatever goes wrong before the send leaves the box empty. Sent once Teams shows the message sent,
// with everyone tagged; unconfirmed when Enter went and Teams does not show it. `sent` runs as soon as the message went.
export async function sendWithMentions(tp: TeamsPage, chat: string, parts: readonly MentionPart[], sent?: AfterPress): Promise<SendResult> {
  if (!(await tp.toChat(chat, true))) return "failed";
  const page = tp.page;
  // a draft already there is someone's: left as it is, nothing sent
  if (await page.evaluate(composerLeft, SEL)) {
    log.warn("mention", "compose box not empty", { chat });
    return "failed";
  }
  const names = parts.flatMap((p) => ("mention" in p ? [p.mention] : []));
  const before = await page.evaluate(messageIds, SEL);
  let pressed = false;
  try {
    if (!(await composeWithMentions(tp, parts))) throw new Error("message not composed");
    await sleep(300);
    pressed = true;
    await page.keyboard.press("Enter");
  } catch (e) {
    log.warn("mention", errorText(e), { chat });
    if (pressed) return "unconfirmed";
    await tp.emptyComposeBox();
    return "failed";
  }
  return confirmSent({ area: "mention", shown: () => page.evaluate(ownMessageSent, { s: SEL, t: TEXTS, before, names }), tries: 40, sent, fields: { chat } });
}
