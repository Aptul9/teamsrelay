// Page script of the open conversation. Runs inside the Teams page: self-contained, type imports only.
import type { Reaction } from "@/shared/slot-db/rows";
import type { Selectors, Texts } from "../selectors";

// loaded: drawn in the page, src is what it shows; otherwise src is the address Teams will load it from and the
// size is not known yet (0)
export type PageImage = { src: string; w: number; h: number; loaded: boolean };
export type PageMessage = {
  mid: string;
  author: string;
  text: string;
  mine: boolean;
  reacts: string;
  quote: { author: string; text: string } | null;
  images: PageImage[];
  files: { name: string; url: string }[];
  reactions: Reaction[];
  status: string;
  edited: boolean;
  html: string;
  mentionsMe: boolean;
  avsrc: string;
  deleted: boolean;
};

// The last 40 messages of the open chat. The body comes as text and as reduced HTML: known tags only, colours
// checked, http(s) links, text always escaped (the web app sanitizes it again before rendering).
export function readMessages({ s, t }: { s: Selectors; t: Texts }): PageMessage[] {
  const isEmoji = (i: Element) => s.emojiType.test(i.getAttribute("itemtype") || "") || !!i.closest(s.emoticon);
  const block = (n: Element) => /^(block|flex|grid|list-item|table)$/.test(getComputedStyle(n).display);
  // Teams emoji are <img alt="😂">: innerText would lose them
  const walk = (n: Node): string => {
    if (n.nodeType === 3) return n.nodeValue || "";
    if (n.nodeType !== 1) return "";
    const el = n as HTMLElement;
    if (el.matches(s.bodySkip)) return "";
    if (el.tagName === "BR") return "\n";
    if (el.tagName === "IMG") return isEmoji(el) ? (el as HTMLImageElement).alt || "" : "";
    let text = "";
    for (const c of el.childNodes) text += walk(c);
    return el.tagName === "P" || block(el) ? text + "\n" : text;
  };
  const esc = (v: string) => (v || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c);
  const COLOR = /^(rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)|#[0-9a-f]{3,8})$/i;
  const TAGS: Record<string, string> = { B: "b", STRONG: "b", I: "i", EM: "i", U: "u", S: "s", STRIKE: "s", DEL: "s", CODE: "code", PRE: "pre", UL: "ul", OL: "ol", LI: "li", BLOCKQUOTE: "blockquote", P: "p", H1: "h", H2: "h", H3: "h", H4: "h" };
  const toHtml = (n: Node): string => {
    if (n.nodeType === 3) return esc(n.nodeValue || "");
    if (n.nodeType !== 1) return "";
    const el = n as HTMLElement;
    if (el.matches(s.bodySkip)) return "";
    const tag = el.tagName;
    if (tag === "BR") return "<br>";
    if (tag === "IMG") return isEmoji(el) ? esc((el as HTMLImageElement).alt || "") : "";
    if (s.mentionType.test(el.getAttribute("itemtype") || "")) {
      const me = (((el.closest(s.mentionBox) || el).getAttribute("aria-label") || "").toLowerCase()).includes(t.mentionedYou.toLowerCase());
      return `<span class="mn${me ? " me" : ""}">${esc(el.textContent || "")}</span>`;
    }
    let out = "";
    for (const c of el.childNodes) out += toHtml(c);
    // the box around a mention stays inline
    if (el.hasAttribute("data-mention-type")) return out;
    if (tag === "A") {
      const href = el.getAttribute("href") || "";
      return /^https?:\/\//i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener">${out}</a>` : out;
    }
    const st = el.style;
    if (st.color && COLOR.test(st.color.trim())) out = `<span style="color:${st.color.trim()}">${out}</span>`;
    if (st.backgroundColor && COLOR.test(st.backgroundColor.trim())) out = `<span style="background:${st.backgroundColor.trim()}">${out}</span>`;
    if (/^(bold|[6-9]00)$/.test(st.fontWeight || "")) out = `<b>${out}</b>`;
    if (st.fontStyle === "italic") out = `<i>${out}</i>`;
    if (/line-through/.test(st.textDecoration || "")) out = `<s>${out}</s>`;
    else if (/underline/.test(st.textDecoration || "")) out = `<u>${out}</u>`;
    const known = TAGS[tag];
    if (known === "h") return `<div class="h">${out}</div>`;
    if (known) return `<${known}>${out}</${known}>`;
    return block(el) ? `<div>${out}</div>` : out;
  };

  const out: PageMessage[] = [];
  let lastAuthor = "";
  for (const e of [...document.querySelectorAll<HTMLElement>(s.message)].slice(-40)) {
    const className = typeof e.className === "string" ? e.className : "";
    const mine = !!e.querySelector(s.mine) || className.indexOf("MyMessage") > -1 || !!e.closest(s.mine);
    const item = (e.closest(s.item) || e) as HTMLElement;
    const authorEl = item.querySelector<HTMLElement>(s.author) || e.querySelector<HTMLElement>(s.author);
    let author = authorEl ? (authorEl.innerText || "").trim() : "";
    if (!author) {
      const m = (e.getAttribute("aria-label") || "").match(t.authorLabel);
      if (m) author = m[1].trim();
    }
    // Teams shows the name only on the first of consecutive messages of the same author
    if (mine) lastAuthor = "";
    else if (author) lastAuthor = author;
    else author = lastAuthor;
    const body = e.querySelector<HTMLElement>(s.body) || e.querySelector<HTMLElement>(s.bodyAlt);
    const text = body ? walk(body).replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
    let quote: PageMessage["quote"] = null;
    const card = e.querySelector<HTMLElement>(s.quote);
    if (card) {
      const preview = card.querySelector<HTMLElement>(s.quotePreview);
      const lines = (card.innerText || "").split("\n").map((x) => x.trim()).filter(Boolean);
      quote = { author: (lines[0] || "").slice(0, 60), text: ((preview && preview.innerText) || lines.slice(2).join(" ")).trim().slice(0, 300) };
    }
    const images = [...e.querySelectorAll<HTMLImageElement>("img")]
      .filter(
        (i) =>
          !isEmoji(i) &&
          !i.closest(s.bodySkip) &&
          !i.closest(s.anyAvatar) &&
          (s.imageType.test(i.getAttribute("itemtype") || "") || s.lazyImage.test(i.getAttribute("data-tid") || "") || i.naturalWidth > 64),
      )
      // Teams draws a 1x1 placeholder until it has loaded the image: meanwhile its address is in an attribute
      .map((i): PageImage =>
        i.complete && i.naturalWidth > 1
          ? { src: i.currentSrc || i.src || "", w: i.naturalWidth, h: i.naturalHeight, loaded: true }
          : { src: i.getAttribute(s.lazyImageSource) || "", w: 0, h: 0, loaded: false },
      )
      .filter((i) => i.src);
    const files: PageMessage["files"] = [];
    for (const grid of e.querySelectorAll(s.files)) {
      for (const x of grid.querySelectorAll(s.fileEntry)) {
        const [name, ...rest] = (x.getAttribute("aria-label") || "").split("\n");
        const url = rest.join("").trim();
        if (name && !files.some((f) => f.url === url)) files.push({ name: name.trim().slice(0, 160), url });
      }
    }
    // reactions under the message: one pill per emoji, the count in its text ("2 Like reactions.")
    const reactions = [...item.querySelectorAll<HTMLElement>(s.pill)]
      .map((x) => ({
        e: [...x.querySelectorAll("img")].map((i) => i.alt).join(""),
        n: parseInt((x.innerText || "").trim(), 10) || 1,
        mine: x.getAttribute("aria-pressed") === "true",
      }))
      .filter((r) => r.e);
    const reacts = reactions.map((r) => r.e + (r.n > 1 ? r.n : "")).join(" ");
    // status of your messages: Teams puts the "Seen" icon on the last one the other side read
    let status = "";
    if (mine) {
      const my = e.closest(s.mine) || item.querySelector(s.mine);
      const icon = my && my.querySelector(s.statusIcon);
      status = icon ? (icon.getAttribute("aria-label") || "").trim() : "";
    }
    const deleted = !!item.querySelector(s.tombstone);
    // Teams writes "Edited" in a span of the message header
    const edited = [...item.querySelectorAll("span")].some((x) => !x.closest(s.body) && t.edited.test((x.textContent || "").trim()));
    const avatar = item.querySelector<HTMLImageElement>(s.messageAvatar);
    const avsrc = avatar && avatar.naturalWidth ? avatar.currentSrc || avatar.src : "";
    let html = body ? toHtml(body) : "";
    // empty boxes (the one of a GIF, read apart) and empty paragraphs at the start or at the end
    for (let k = 0; k < 4; k++) html = html.replace(/<div>\s*<\/div>/g, "");
    html = html
      .replace(/^(\s|<div>|<p>[\s ]*<\/p>)+/, (m) => m.replace(/<p>[\s ]*<\/p>/g, ""))
      .replace(/(<p>[\s ]*<\/p>|\s)+(?=(<\/div>)*$)/, "")
      .slice(0, 20000);
    const mentionsMe = !!(body && body.querySelector(`${s.mentionBox}[aria-label="${t.mentionedYou}"]`));
    out.push({ mid: e.getAttribute("data-mid") || "", author: author.slice(0, 60), text: text.slice(0, 2000), mine, reacts, quote, images, files, reactions, status, edited, html, mentionsMe, avsrc, deleted });
  }
  return out;
}
