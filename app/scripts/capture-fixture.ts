// Captures a part of the live Teams page as a test fixture (test/agent/fixtures). The structure stays; every
// word that is not Teams interface text becomes an invented one, ids and URLs are replaced, images become
// blank pictures of the same size. It all happens inside the page: real text never leaves the browser.
// Development tool, not part of the image. From app/, with the local stack up:
//   npx esbuild scripts/capture-fixture.ts --bundle --platform=node --format=cjs --external:playwright-core --outfile=<dir>/capture.cjs
//   docker run --rm --network container:teams-chromium-2 -v "$PWD:/w" -v "<dir>:/t" -w /w node:24-slim node /t/capture.cjs <part>
// <part>: chat-list, conversation, toolbar-mine, toolbar-other, activity. The HTML goes to stdout.
import { chromium, type Page } from "playwright-core";
import { pickTeamsPage } from "../src/agent/logic/hosts";
import { SEL, TEXTS, type Selectors } from "../src/agent/teams/selectors";

type Part = "chat-list" | "conversation" | "toolbar-mine" | "toolbar-other" | "activity";

// Interface words kept as they are: the page scripts read them, and they say nothing about the user
const KEEP = `Chats Chat Favorites Quick views Recent Drafts Copilot Meet now Activity Unread Mentions Teams channels Calendar Calls Files
You You: Available Away Busy Offline Do not disturb Be right back Presence unknown Out of office Edited Seen Sent Sending by everyone Read of
Undo This message has been deleted reacted to your message messages mentioned you replied added assigned a task Missed call from In chat with
posted in updated Yesterday Today Mon Tue Wed Thu Fri Sat Sun Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec AM PM Like Heart Laugh Surprised
Sad Angry reaction reactions More options Reply quote Edit Delete Pin Forward Copy link Translate Mark as unread Save Hide Mute Remove history
Call External unfamiliar Team owner General and the an is are was it for on at team Everyone Mentioned New conversation Type Send Emoji GIF
Format Open Close Back Scheduled Delivered Failed`
  .split(/\s+/)
  // plus every word the page scripts match on (feed actions, statuses, expired session...)
  .concat(Object.values(TEXTS).flatMap((v) => (v instanceof RegExp ? v.source : v).match(/[A-Za-z]{2,}/g) ?? []));

function capture({ part, s, keep, limit, hovered }: { part: Part; s: Selectors; keep: string[]; limit: number; hovered: string }): string {
  const KEEP = new Set(keep);
  const TIME = /^(\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}(\/\d{2,4})?|AM|PM)$/;
  const SYL = ["kar", "lom", "miv", "ren", "dus", "saf", "vel", "tor", "nix", "bep", "ulm", "raz", "zen", "fiq", "mox", "taj", "geb", "lin", "pav", "sor"];
  const words = new Map<string, string>();
  const numbers = new Map<string, string>();
  const tokens = new Map<string, string>();
  let urls = 0;
  let mails = 0;
  const fakeWord = (w: string) => {
    let f = words.get(w);
    if (!f) {
      let n = words.size + 1;
      f = "";
      while (n > 0) {
        f += SYL[n % SYL.length];
        n = Math.floor(n / SYL.length);
      }
      if (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) f = f.toUpperCase();
      else if (/^[A-Z]/.test(w)) f = f[0].toUpperCase() + f.slice(1);
      words.set(w, f);
    }
    return f;
  };
  const fakeNumber = (d: string) => {
    let f = numbers.get(d);
    if (!f) {
      f = String(numbers.size + 1).padStart(d.length, "7").slice(-d.length);
      numbers.set(d, f);
    }
    return f;
  };
  const text = (v: string): string =>
    v
      .split(/(\s+)/)
      .map((tok) => {
        if (!tok || /^\s+$/.test(tok)) return tok;
        if (/^https?:\/\//i.test(tok)) return `https://contoso.sharepoint.com/sites/fixture/f${++urls}.pdf`;
        if (tok.includes("@")) return `user${++mails}@contoso.example`;
        const m = tok.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u) || ["", "", tok, ""];
        const [, pre, core, post] = m;
        if (!core || KEEP.has(core) || TIME.test(core) || !/[\p{L}\p{N}]/u.test(core)) return tok;
        if (/^\d+$/.test(core)) return pre + (core.length <= 2 ? core : fakeNumber(core)) + post;
        if (/^\d{1,2}:\d{2}$/.test(core)) return tok;
        return pre + core.replace(/[\p{L}\p{N}]+/gu, (w) => (KEEP.has(w) ? w : /^\d{1,2}$/.test(w) ? w : fakeWord(w))) + post;
      })
      .join("");
  // ids, message ids, thread ids and image object ids: the same value always gets the same replacement, links
  // between attributes stay
  const ident = (v: string) =>
    v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(19|8|28):[^\s"]+|[0-9a-f]{16,}|\d{5,}/gi, (t) => {
      let f = tokens.get(t);
      if (!f) {
        f = /^\d+$/.test(t) ? String(1790000000000 + tokens.size + 1).slice(-t.length) : `x${tokens.size + 1}`;
        tokens.set(t, f);
      }
      return f;
    });
  const picture = (w: number, h: number) =>
    `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#6b70dd"/></svg>`)}`;
  const KEEP_ATTRS = ["role", "aria-level", "aria-expanded", "aria-pressed", "aria-label", "aria-labelledby", "id", "data-tid", "data-testid", "data-item-type", "data-mid", "data-mention-type", "itemtype", "alt", "href", "src", s.lazyImageSource, "class", "contenteditable"];
  const BODY_STYLE = ["color", "background-color", "font-weight", "font-style", "text-decoration"];

  // copy of `el` with its geometry relative to `box` when absolute (the action bar needs real coordinates)
  const copy = (el: Element, absolute: boolean, box: DOMRect | null): Node | null => {
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "link", "noscript", "iframe", "canvas", "video", "template"].includes(tag)) return null;
    const out = document.createElement(tag === "svg" ? "span" : tag);
    for (const name of KEEP_ATTRS) {
      const v = el.getAttribute(name);
      if (v === null) continue;
      if (name === "aria-label") out.setAttribute(name, text(v));
      else if (name === "alt") out.setAttribute(name, /\p{L}/u.test(v) ? text(v) : v);
      else if (name === "href") {
        if (/^https?:/i.test(v)) out.setAttribute(name, `https://example.com/l${++urls}`);
      } else if (name === "src") {
        const img = el as HTMLImageElement;
        out.setAttribute(name, picture(img.naturalWidth || 0, img.naturalHeight || 0));
      } else if (name === s.lazyImageSource) {
        out.setAttribute(name, `https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/fixture-${++urls}/views/imgo_webp`);
      } else if (name === "class") {
        const cls = v.split(/\s+/).filter((c) => /^(fui-|feeditem_)/.test(c) || /MyMessage|statusIcon|Avatar|mention/i.test(c));
        if (cls.length) out.setAttribute(name, cls.join(" "));
      } else out.setAttribute(name, ident(v));
    }
    const cs = getComputedStyle(el);
    const style: string[] = [`display:${cs.display}`];
    if (el.closest(s.body)) for (const p of BODY_STYLE) {
      const v = (el as HTMLElement).style?.getPropertyValue(p);
      if (v) style.push(`${p}:${v}`);
    }
    if (el.matches(s.feedTitle)) style.push(`font-weight:${cs.fontWeight}`);
    const r = el.getBoundingClientRect();
    if (absolute && box) style.push(`position:absolute`, `left:${r.left - box.left}px`, `top:${r.top - box.top}px`, `width:${r.width}px`, `height:${r.height}px`, "margin:0");
    out.setAttribute("style", style.join(";"));
    if (tag !== "svg") {
      for (const c of el.childNodes) {
        if (c.nodeType === 3) out.appendChild(document.createTextNode(text(c.nodeValue || "")));
        else if (c.nodeType === 1) {
          const k = copy(c as Element, absolute, absolute ? r : null);
          if (k) out.appendChild(k);
        }
      }
    }
    return out;
  };

  const wrap = document.createElement("div");
  const add = (el: Element | null, absolute = false) => {
    if (!el) throw new Error(`nothing to capture for ${part}`);
    const node = copy(el, absolute, absolute ? new DOMRect(0, 0, 0, 0) : null);
    if (node) wrap.appendChild(node);
    return node as HTMLElement;
  };
  // smallest element holding every match of `selector`
  const holder = (selector: string) => {
    const all = [...document.querySelectorAll(selector)];
    let root = all[0]?.parentElement ?? null;
    while (root && !all.every((i) => root?.contains(i))) root = root.parentElement;
    return root;
  };
  if (part === "chat-list") add(document.querySelector(s.chatRow)?.closest('[role="tree"]') ?? null);
  if (part === "activity") add(holder(s.feedItem));
  if (part === "conversation") {
    add(document.querySelector(s.chatTitle));
    const pane = add(holder(s.item));
    const copies = [...pane.querySelectorAll(s.item)];
    for (const extra of copies.slice(0, Math.max(0, copies.length - limit))) extra.remove();
  }
  if (part === "toolbar-mine" || part === "toolbar-other") {
    const m = document.querySelector(`${s.message}[data-mid="${CSS.escape(hovered)}"]`);
    const item = add(m?.closest(s.item) ?? null, true);
    item.setAttribute("data-fixture", "hovered");
    for (const bar of document.querySelectorAll<HTMLElement>(s.actionBar)) if (bar.offsetParent !== null) add(bar, true);
  }
  return wrap.innerHTML;
}

async function hover(page: Page, own: boolean): Promise<string> {
  const mids = await page.evaluate(
    ({ s, own }) =>
      [...document.querySelectorAll(s.message)].filter((m) => !!m.closest(s.mine) === own).map((m) => m.getAttribute("data-mid") || ""),
    { s: SEL, own },
  );
  const mid = mids.filter(Boolean).at(-1);
  if (!mid) throw new Error(own ? "no message of yours in the open chat" : "no message of others in the open chat");
  const m = page.locator(`${SEL.message}[data-mid="${mid}"]`);
  await m.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const box = await m.boundingBox();
  if (!box) throw new Error("message not visible");
  await page.mouse.move(2, 2);
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 20), { steps: 3 });
  await page.locator(`${SEL.actionBar}:visible`).first().waitFor({ timeout: 3000 });
  return mid;
}

async function main() {
  const part = process.argv[2] as Part;
  if (!["chat-list", "conversation", "toolbar-mine", "toolbar-other", "activity"].includes(part)) throw new Error("part: chat-list | conversation | toolbar-mine | toolbar-other | activity");
  const browser = await chromium.connectOverCDP(process.env.CDP || "http://127.0.0.1:9222");
  try {
    const page = pickTeamsPage(browser.contexts()[0]?.pages() ?? []);
    if (!page) throw new Error("no Teams tab");
    let hovered = "";
    if (part === "toolbar-mine" || part === "toolbar-other") hovered = await hover(page, part === "toolbar-mine");
    if (part === "activity") {
      await page.locator(`${SEL.activityView}:visible`).first().click({ timeout: 4000 });
      await page.locator(SEL.feedItem).first().waitFor({ timeout: 8000 });
      await page.waitForTimeout(800);
    }
    const html = await page.evaluate(capture, { part, s: SEL, keep: KEEP, limit: 15, hovered });
    if (part === "activity") await page.locator(`${SEL.chatView}:visible`).first().click({ timeout: 4000 });
    if (hovered) await page.mouse.move(2, 2);
    process.stdout.write(`<!-- Teams web, captured ${new Date().toISOString().slice(0, 10)} by scripts/capture-fixture.ts (${part}): structure only, texts invented -->\n${html}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
