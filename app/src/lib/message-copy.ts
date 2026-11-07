import type { Message } from "@/shared/slot-db/rows";
import { mediaUrl } from "./client";
import { sentAt } from "./message-times";

type Copy = { text: string; html: string };
type Images = Map<string, string>;
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const lines = (s: string) => escape(s).replace(/\r?\n/g, "<br>");

function timestamp(mid: string): string {
  const at = sentAt(mid);
  if (at === null) return "time unavailable";
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function imageSource(image: NonNullable<Message["images"]>[number], acc: number): string {
  return image.f ? mediaUrl(image.f, acc) : image.url || "";
}

// Same text layout as Teams Supercopy; images carry portable data URLs in the HTML flavor.
export function formatMessages(chat: string, messages: Message[], acc: number, images: Images = new Map(), ownName = "You"): Copy {
  const text = [`Teams chat: ${chat}`, ""];
  const html = [`<p><b>Teams chat: ${escape(chat)}</b></p>`];
  let imageNumber = 0;
  for (const m of messages) {
    if (m.deleted) continue;
    const head = `[${timestamp(m.mid)}] ${m.author || (m.mine ? ownName || "You" : "Unknown author")}`;
    const body: string[] = [];
    const rich: string[] = [];
    if (m.quote) {
      const quote = `> in reply to ${m.quote.author}: ${m.quote.text}`;
      body.push(quote);
      rich.push(lines(quote));
    }
    if (m.text) {
      body.push(m.text);
      rich.push(lines(m.text));
    }
    for (const im of m.images || []) {
      const source = imageSource(im, acc);
      const data = images.get(source);
      const label = `[image ${++imageNumber}${data ? "" : ": not available"}]`;
      body.push(label);
      rich.push(`${label}${data ? `<br><img alt="" src="${escape(data)}">` : ""}`);
    }
    for (const f of m.files || []) {
      const label = `[file: ${f.name}]`;
      body.push(label);
      rich.push(escape(label));
    }
    if (!body.length) {
      body.push("(no text: attachment or card)");
      rich.push("(no text: attachment or card)");
    }
    text.push(head, ...body, "");
    html.push(`<p><b>${escape(head)}</b><br>${rich.join("<br>")}</p>`);
  }
  return { text: text.join("\n").trimEnd() + "\n", html: html.join("") };
}

async function embeddedImages(messages: Message[], acc: number, signal: AbortSignal): Promise<Images> {
  const sources = [...new Set(messages.flatMap((m) => (m.images || []).map((im) => imageSource(im, acc))))];
  const images: Images = new Map();
  await Promise.all(sources.map(async (source) => {
    if (!source) return;
    try {
      const url = new URL(source, location.href);
      if (!["http:", "https:", "data:"].includes(url.protocol)) return;
      const response = await fetch(url, { credentials: url.origin === location.origin ? "same-origin" : "omit", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) return;
      const blob = await response.blob();
      if (!/^image\/(png|jpeg|gif|webp)$/i.test(blob.type) || blob.size > 10e6) return;
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      images.set(source, data);
    } catch {
      // A missing or CORS-blocked image stays explicit in the copied message.
    }
  }));
  return images;
}

let pending: AbortController | null = null;

export function cancelMessageCopy() {
  pending?.abort();
  pending = null;
}

export function copyMessages(chat: string, messages: Message[], acc: number, ownName?: string): Promise<void> {
  cancelMessageCopy();
  const clipboard = navigator.clipboard;
  if (!clipboard) return Promise.reject(new Error("Clipboard unavailable"));
  if (typeof ClipboardItem === "undefined" || !clipboard.write) return clipboard.writeText(formatMessages(chat, messages, acc, undefined, ownName).text);
  const controller = new AbortController();
  pending = controller;
  const formatted = embeddedImages(messages, acc, controller.signal).then((images) => {
    controller.signal.throwIfAborted();
    return formatMessages(chat, messages, acc, images, ownName);
  });
  // Start the write inside the user gesture, before fetching images (required by Safari).
  return clipboard.write([new ClipboardItem({
    "text/plain": formatted.then((copy) => new Blob([copy.text], { type: "text/plain" })),
    "text/html": formatted.then((copy) => new Blob([copy.html], { type: "text/html" })),
  })]).catch((error: unknown) => {
    controller.signal.throwIfAborted();
    throw error;
  }).finally(() => {
    if (pending === controller) pending = null;
  });
}

export function selectedMessages(root: HTMLElement, messages: Message[], selection: Selection | null): Message[] {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return [];
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return [];
  const mids = new Set([...root.querySelectorAll<HTMLElement>("[data-copy-message]")]
    .filter((el) => range.intersectsNode(el))
    .map((el) => el.dataset.copyMessage));
  return messages.filter((m) => !m.deleted && mids.has(String(m.mid)));
}
