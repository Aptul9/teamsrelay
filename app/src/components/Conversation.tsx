"use client";

import DOMPurify from "dompurify";
import {
  ArrowLeftIcon,
  CheckCheckIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  ImagePlusIcon,
  MessageSquareDashedIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PhoneIcon,
  RefreshCwIcon,
  ReplyIcon,
  SendHorizontalIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Avatar } from "./Avatar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorText, followCmd, IMAGE_ACCEPT, imageProblem, mediaUrl, post, runCmd, sendImage, type Chat, type Message, type OpenReason, type OpenStatus } from "@/lib/client";
import { REACTION_EMOJI } from "@/shared/slot-db/rows";
import { useInUse } from "@/lib/in-use";
import { insertMention, matchPeople, mentionQuery, shownText } from "@/lib/mentions";
import { dayLabel, fullTime, placeMessages, sentAt, timeLabel } from "@/lib/message-times";

const EMO_LABEL: Record<string, string> = { like: "Like", heart: "Heart", laugh: "Laugh", surprised: "Surprised", cry: "Sad", angry: "Angry" };

// The agent already rebuilds message bodies from a short list of tags; sanitized again before rendering.
function safeHtml(html: string): string {
  if (typeof window === "undefined") return "";
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["b", "i", "u", "s", "code", "pre", "ul", "ol", "li", "blockquote", "p", "div", "span", "a", "br"],
    ALLOWED_ATTR: ["href", "target", "rel", "style", "class"],
  });
}

// "Seen" or "Read by N of M" under your messages, "Sent" otherwise
function readStatus(m: Message): { label: string; seen: boolean } {
  const mm = /^Read by (\d+) of (\d+)$/i.exec(m.readby?.label || "");
  if (mm) {
    if (+mm[1] === 0) return { label: "Sent · not read yet", seen: false };
    const who = (m.readby?.names || []).join(", ");
    return { label: (mm[1] === mm[2] ? "Read by everyone" : `Read by ${mm[1]} of ${mm[2]}`) + (who ? `: ${who}` : ""), seen: true };
  }
  if (/everyone/i.test(m.status || "")) return { label: "Seen by everyone", seen: true };
  if (/seen|read/i.test(m.status || "")) return { label: "Seen", seen: true };
  return { label: "Sent", seen: false };
}

// Why Teams did not open the chat, as the agent tells it (cmd_result of the open); an open failed without a reason
// waited too long for the agent, or was cut by its restart
const OPEN_FAILED: Record<OpenReason, string> = {
  "signed-out": "Teams is signed out: sign in again, then try again.",
  "not-listed": "Teams has no chat with this name in its list.",
  "not-shown": "Teams did not show it.",
  unreadable: "Teams showed it, but its messages could not be read.",
};
const NO_ANSWER = "Teams did not get to it in time.";

// Away from the app this long, the chat is opened in Teams again on return, with its progress on screen. Teams leaves
// the chat as soon as the app is out of use (lib/in-use.ts, lib/viewing.ts) and the agent opens it again at its first
// round after the app marks it on return; after a longer absence another chat may be the one open in Teams by then.
const REOPEN_AFTER = 60_000;

// text as shown, as Teams will show it; raw and mentions as typed, for a retry
type Pending = { text: string; ts: number; quote?: { author: string; text: string }; raw?: string; mentions?: string[] };

// Box of an image of w x h at most 20rem (320 px) high and as wide as the bubble, before it loads: no bars around
// it, no jump when it arrives
const imageWidth = (w?: number, h?: number) => (w && h ? `min(100%, ${Math.round(w * Math.min(1, 320 / h))}px)` : undefined);

// Touch screens have no hover: a tap on a message opens its actions in a sheet from the bottom
const NO_HOVER = "(hover: none)";
const onHoverChange = (cb: () => void) => {
  const mq = window.matchMedia(NO_HOVER);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

export function Conversation({
  acc,
  chat,
  entry,
  rows,
  open = null,
  stopped,
  stoppedText = "Account stopped: start it to send",
  others,
  otherCalls = 0,
  onBack,
  onOpenDesktop,
  onCall,
  callHost,
}: {
  acc: number;
  chat: string;
  entry?: Chat;
  rows: Message[] | null;
  // the last open of this chat, from the event stream: which one Teams has done, or why it failed
  open?: OpenStatus | null;
  // the account is switched off, or runs only during its checks: the messages are the last ones read, nothing can be
  // sent; stoppedText says why
  stopped: boolean;
  stoppedText?: string;
  // unread in the other accounts: on a phone the account menu, which shows it, is hidden while a chat is open; the missed
  // calls among them have a red dot of their own
  others: number;
  otherCalls?: number;
  onBack: () => void;
  onOpenDesktop: () => void;
  // a Teams audio call to the person of this chat, given only where the app can place one (a 1:1 chat of an account of
  // the browsers container, no call on it): the header offers Call, and asks before calling
  onCall?: () => void;
  // the computer whose Teams window carries the sound of a call from this account, when it is not this app
  callHost?: string;
}) {
  const [text, setText] = useState("");
  const [askCall, setAskCall] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [localReacts, setLocalReacts] = useState<Record<string, string[]>>({});
  const [pillPending, setPillPending] = useState<Record<string, Record<string, boolean>>>({});
  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});
  const [editMid, setEditMid] = useState<string | null>(null);
  const [reply, setReply] = useState<{ mid: string; author: string; text: string } | null>(null);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const touch = useSyncExternalStore(onHoverChange, () => window.matchMedia(NO_HOVER).matches, () => false);
  const [downloads, setDownloads] = useState<Record<string, "busy" | "failed">>({});
  const [restoring, setRestoring] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const boxRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const atBottom = useRef(true);
  // image pasted or attached for the next message, shown above the box; images on their way to Teams
  const [image, setImage] = useState<{ file: File; url: string } | null>(null);
  const [imagesPending, setImagesPending] = useState<{ url: string; text: string; ts: number }[]>([]);
  // @: people of the chat (null until the first @), those tagged in the text, the @ being typed and the entry
  // highlighted in its list
  const [members, setMembers] = useState<string[] | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [mentions, setMentions] = useState<string[]>([]);
  const [picker, setPicker] = useState<{ start: number; query: string } | null>(null);
  const [pickIndex, setPickIndex] = useState(0);
  const membersAsked = useRef(false);

  const messages = rows ?? [];
  const realMine = messages.filter((m) => m.mine).map((m) => (m.text || "").trim());
  const shownPending = pending.filter((p) => !realMine.includes(p.text.trim()));

  // Opens the chat in the remote Teams: the agent saves what Teams shows, then keeps it up to date. Until that open is
  // done the messages are the ones saved at the last visit. asks counts the tries (Try again); asked is the command the
  // web app queued for the last one, or why it could not queue it.
  const [asks, setAsks] = useState(0);
  const [asked, setAsked] = useState<{ ask: number; id?: number; error?: string } | null>(null);
  useEffect(() => {
    if (stopped) return;
    let gone = false;
    post<{ id: number }>("/api/open", { name: chat }, acc).then(
      (r) => !gone && setAsked({ ask: asks, id: r.id }),
      (e: unknown) => !gone && setAsked({ ask: asks, error: errorText(e, "No answer from the server.") }),
    );
    return () => {
      gone = true;
    };
  }, [chat, acc, stopped, asks]);
  // Back in use after REOPEN_AFTER or more away (another tab or window, another application in front, a phone in the
  // pocket), Teams may show another chat than this one by then. The chat is opened again, as when it was chosen, and
  // the messages saved meanwhile show as such until Teams has it open.
  const inUse = useInUse();
  const awayAt = useRef(0);
  useEffect(() => {
    if (stopped) return;
    if (!inUse) {
      awayAt.current ||= Date.now();
      return;
    }
    if (awayAt.current && Date.now() - awayAt.current >= REOPEN_AFTER) setAsks((n) => n + 1);
    awayAt.current = 0;
  }, [inUse, stopped]);
  const mine = asked?.ask === asks ? asked : null;
  // saved: a stopped account, nothing asked; live once the open of this visit (or a later one) is done
  const openState: "saved" | "opening" | "live" | "failed" = stopped
    ? "saved"
    : mine?.error
      ? "failed"
      : mine?.id !== undefined && open && open.id >= mine.id
        ? open.status === "pending"
          ? "opening"
          : open.status === "done"
            ? "live"
            : "failed"
        : "opening";
  const whyNot = mine?.error ?? (open?.reason ? OPEN_FAILED[open.reason] : NO_ANSWER);

  // a pending message that never shows up on Teams turns into "Not sent"
  useEffect(() => {
    if (!shownPending.length) return;
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, [shownPending.length]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && atBottom.current) box.scrollTop = box.scrollHeight;
  }, [rows, pending, imagesPending]);

  // the preview address lives as long as the image stays in the box
  useEffect(() => () => void (image && URL.revokeObjectURL(image.url)), [image]);

  const onScroll = () => {
    const b = boxRef.current;
    if (b) atBottom.current = b.scrollHeight - b.scrollTop - b.clientHeight < 70;
  };

  async function refresh() {
    setRefreshing(true);
    try {
      await post("/api/resync", undefined, acc);
    } catch {
      toast.error("Refresh failed");
    }
    setTimeout(() => setRefreshing(false), 900);
  }

  async function doReact(mid: string, key: string) {
    setSheetFor(null);
    const m = messages.find((x) => String(x.mid) === mid);
    const mineAlready = m?.reactions?.some((r) => r.e === REACTION_EMOJI[key] && r.mine);
    if (!mineAlready) setLocalReacts((s) => ({ ...s, [mid]: [...new Set([...(s[mid] || []), key])] }));
    const r = await runCmd("/api/react", { name: chat, mid, emoji: key }, acc);
    setLocalReacts((s) => ({ ...s, [mid]: (s[mid] || []).filter((k) => k !== key) }));
    if (r.status !== "done") toast.error("Reaction not applied on Teams");
  }

  // click on a reaction under a message, like in Teams: removed if yours, added otherwise
  async function tapPill(mid: string, emoji: string) {
    const m = messages.find((x) => String(x.mid) === mid);
    const wasMine = !!m?.reactions?.find((x) => x.e === emoji)?.mine;
    const key = Object.keys(REACTION_EMOJI).find((k) => REACTION_EMOJI[k] === emoji);
    if (wasMine) setPillPending((s) => ({ ...s, [mid]: { ...(s[mid] || {}), [emoji]: true } }));
    else if (key) setLocalReacts((s) => ({ ...s, [mid]: [...new Set([...(s[mid] || []), key])] }));
    const r = await runCmd("/api/react", { name: chat, mid, pill: emoji }, acc);
    setPillPending((s) => {
      const rest = { ...(s[mid] || {}) };
      delete rest[emoji];
      return { ...s, [mid]: rest };
    });
    if (key) setLocalReacts((s) => ({ ...s, [mid]: (s[mid] || []).filter((k) => k !== key) }));
    if (r.status !== "done") toast.error(wasMine ? "Reaction not removed on Teams" : "Reaction not applied on Teams");
  }

  function startEdit(m: Message) {
    setSheetFor(null);
    setReply(null);
    setEditMid(String(m.mid));
    setText(m.text || "");
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function startReply(m: Message) {
    setSheetFor(null);
    setEditMid(null);
    setReply({ mid: String(m.mid), author: m.mine ? "You" : m.author || "", text: (m.text || "").slice(0, 160) });
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function cancelCompose() {
    if (editMid) setText("");
    setEditMid(null);
    setReply(null);
  }

  // deleted right away, like in Teams, with "Undo" on the deleted message
  async function doDelete(mid: string) {
    setSheetFor(null);
    setPendingEdits((s) => ({ ...s, [mid]: "Deleting…" }));
    const r = await runCmd("/api/delete", { name: chat, mid }, acc);
    setPendingEdits((s) => {
      const rest = { ...s };
      delete rest[mid];
      return rest;
    });
    if (r.status !== "done") toast.error("Message not deleted on Teams");
  }

  async function undoDelete(mid: string) {
    setRestoring((s) => ({ ...s, [mid]: true }));
    const r = await runCmd("/api/undodelete", { name: chat, mid }, acc);
    setRestoring((s) => ({ ...s, [mid]: false }));
    if (r.status !== "done") toast.error("The message can no longer be restored");
  }

  // attachments live on SharePoint: the agent downloads them with the Teams session, then the browser saves them
  async function getFile(url: string, name: string) {
    if (downloads[url] === "busy") return;
    setDownloads((s) => ({ ...s, [url]: "busy" }));
    const r = await runCmd("/api/download", { url, name }, acc);
    if (r.status !== "done" || !r.result?.f) {
      setDownloads((s) => ({ ...s, [url]: "failed" }));
      return;
    }
    setDownloads((s) => {
      const rest = { ...s };
      delete rest[url];
      return rest;
    });
    const a = document.createElement("a");
    a.href = `/files/${encodeURIComponent(r.result.f)}?a=${acc}&name=${encodeURIComponent(name)}`;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function pickImage(f: File | undefined) {
    if (!f) return;
    const problem = imageProblem(f);
    if (problem) {
      toast.error(problem);
      return;
    }
    if (reply || editMid) {
      toast.error("Images go in a new message, not in a reply or an edit");
      return;
    }
    setImage({ file: f, url: URL.createObjectURL(f) });
    requestAnimationFrame(() => taRef.current?.focus());
  }

  // the text of the box goes with the image as its caption
  async function sendPicked(file: File, t: string) {
    const url = URL.createObjectURL(file);
    const ts = Date.now();
    setImagesPending((p) => [...p, { url, text: t, ts }]);
    const r = await sendImage(chat, file, t, acc);
    setImagesPending((p) => p.filter((x) => x.ts !== ts));
    URL.revokeObjectURL(url);
    if (r.status !== "done") toast.error(r.detail || "Image not sent on Teams");
  }

  // The people of the chat come from Teams on the first @ (the list read last, meanwhile), then stay
  async function loadMembers() {
    if (membersAsked.current) return;
    membersAsked.current = true;
    setMembersLoading(true);
    try {
      const first = await post<{ names: string[]; id?: number }>("/api/members", { name: chat }, acc);
      setMembers(first.names);
      if (first.id) {
        await followCmd(first.id, acc, 30);
        setMembers((await post<{ names: string[] }>("/api/members", { name: chat }, acc)).names);
      }
    } catch {
      setMembers((m) => m ?? []);
    }
    setMembersLoading(false);
  }

  // An @ right before the cursor opens the list of people, in a new message only
  function watchMention(el: HTMLTextAreaElement) {
    const q = !reply && !editMid && !stopped ? mentionQuery(el.value, el.selectionStart ?? el.value.length, mentions) : null;
    if (q?.query !== picker?.query || q?.start !== picker?.start) setPickIndex(0);
    setPicker(q);
    if (q) void loadMembers();
  }

  function tag(name: string) {
    const el = taRef.current;
    if (!picker || !el) return;
    const r = insertMention(text, picker.start, el.selectionStart ?? text.length, name);
    setText(r.text);
    setMentions((m) => (m.includes(name) ? m : [...m, name]));
    setPicker(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.caret, r.caret);
    });
  }

  async function sendText(t: string, quote?: Pending["quote"], tagged: string[] = []) {
    // Teams shows the people tagged by name, without the @: the message waiting for it reads the same
    setPending((p) => [...p, { text: shownText(t, tagged), ts: Date.now(), quote, raw: t, mentions: tagged }]);
    try {
      await post("/api/send", { name: chat, text: t, mentions: tagged.length ? tagged : undefined }, acc);
    } catch {
      toast.error("Message not queued");
    }
  }

  async function send() {
    const t = text.trim();
    const img = !reply && !editMid ? image : null;
    if (!t && !img) return;
    setText("");
    const tagged = mentions.filter((n) => t.includes(`@${n}`));
    setMentions([]);
    setPicker(null);
    if (taRef.current) taRef.current.style.height = "auto";
    atBottom.current = true;
    if (img) {
      setImage(null);
      await sendPicked(img.file, t);
      return;
    }
    if (reply) {
      const r0 = reply;
      setReply(null);
      setPending((p) => [...p, { text: t, ts: Date.now(), quote: { author: r0.author, text: r0.text } }]);
      const r = await runCmd("/api/reply", { name: chat, mid: r0.mid, text: t }, acc);
      if (r.status !== "done") toast.error("Reply not sent on Teams");
      return;
    }
    if (editMid) {
      const mid = editMid;
      setEditMid(null);
      setPendingEdits((s) => ({ ...s, [mid]: t }));
      const r = await runCmd("/api/edit", { name: chat, mid, text: t }, acc);
      setPendingEdits((s) => {
        const rest = { ...s };
        delete rest[mid];
        return rest;
      });
      if (r.status !== "done") toast.error("Edit not applied on Teams");
      return;
    }
    await sendText(t, undefined, tagged);
  }

  function retry(p: Pending) {
    setPending((list) => list.filter((x) => x.ts !== p.ts));
    void sendText(p.raw ?? p.text, undefined, p.mentions ?? []);
  }

  const people = picker && members ? matchPeople(members, picker.query) : [];
  const nothing = !messages.length && !shownPending.length && !imagesPending.length;
  const loading = (rows === null && openState !== "failed") || (openState === "opening" && nothing);
  // Teams shows author, picture and time only on the first of consecutive messages of the same person, and again after
  // a pause or on another day, under the divider of that day
  const placed = placeMessages(messages);
  // and the delivery status only under the last of your consecutive messages
  const lastMine = messages.map((m, i) => !!m.mine && !messages[i + 1]?.mine);
  const sheetMsg = sheetFor ? messages.find((m) => String(m.mid) === sheetFor) : undefined;

  const bubbles = messages.flatMap((m, idx) => {
    const at = sentAt(m.mid);
    const day = placed[idx].day && at !== null && (
      <div key={`day:${at}`} role="separator" className="mt-5 mb-1 flex justify-center">
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">{dayLabel(at, now)}</span>
      </div>
    );
    const images = m.images || [];
    const files = m.files || [];
    if (!m.deleted && !(m.text || "").trim() && !images.length && !files.length) return day ? [day] : [];
    const mid = String(m.mid || "");
    const mine = !!m.mine;
    const pe = pendingEdits[mid];
    const first = placed[idx].first;
    const teamsReacts = (m.reactions || [])
      .filter((r) => !pillPending[mid]?.[r.e])
      .map((r) => ({ e: r.e, n: r.n, mine: r.mine, pend: false }));
    const localOnly = (localReacts[mid] || [])
      .map((k) => REACTION_EMOJI[k])
      .filter((x) => x && !(m.reactions || []).some((r) => r.e === x))
      .map((x) => ({ e: x, n: 1, mine: true, pend: true }));
    const reacts = [...teamsReacts, ...localOnly];
    const status = readStatus(m);
    const actionsOpen = menuFor === mid || sheetFor === mid;
    const canAct = !!mid && !m.deleted && !pe;

    return [
      day,
      <div
        key={mid || `${idx}:${m.text}`}
        data-mid={mid}
        className={cn("group/msg relative flex gap-2 outline-none", mine ? "justify-end" : "justify-start", first ? "mt-4" : "mt-0.5")}
      >
        {!mine && (first ? <Avatar name={m.author || "?"} av={m.av} acc={acc} presence={entry?.presence} className="mt-5 size-8" /> : <div className="w-8 shrink-0" />)}
        <div className={cn("flex max-w-[min(36rem,82%)] min-w-0 flex-col", mine ? "items-end" : "items-start")}>
          {first && ((!mine && m.author) || at !== null) && (
            <div className={cn("mb-1 flex items-center gap-1.5 text-xs text-muted-foreground", mine ? "mr-1" : "ml-1")}>
              {!mine && m.author && <span className="font-medium">{m.author}</span>}
              {at !== null && (
                <time dateTime={new Date(at).toISOString()} className="tabular-nums">
                  {timeLabel(at)}
                </time>
              )}
              {!mine && m.mentionsMe && <span className="rounded-full bg-destructive/10 px-1.5 text-[0.6875rem] font-semibold text-destructive">@you</span>}
            </div>
          )}
          <div className="relative">
            <div
              title={at !== null ? fullTime(at) : undefined}
              onClick={(e) => {
                if (!touch || !canAct || (e.target as HTMLElement).closest("a,button")) return;
                setSheetFor(mid);
              }}
              className={cn(
                "rounded-2xl px-3.5 py-2 text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap shadow-xs md:text-sm",
                mine ? "bubble-mine bg-bubble-mine text-bubble-mine-foreground" : "border bg-bubble-theirs text-bubble-theirs-foreground",
                mine ? (first ? "rounded-tr-md" : "rounded-r-md") : first ? "rounded-tl-md" : "rounded-l-md",
                m.deleted && "border border-dashed bg-transparent text-muted-foreground shadow-none",
                canAct && "cursor-default select-text",
                actionsOpen && "ring-2 ring-ring/40",
              )}
            >
              {m.deleted ? (
                <div className="flex items-center gap-3 italic">
                  Message deleted
                  {mine && (
                    <Button
                      variant="link"
                      size="xs"
                      className="h-auto p-0 not-italic"
                      disabled={!!restoring[mid]}
                      onClick={() => void undoDelete(mid)}
                    >
                      {restoring[mid] ? <Spinner className="size-3" /> : <Undo2Icon />}
                      {restoring[mid] ? "Restoring…" : "Undo"}
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  {m.quote && (
                    <div className="mb-1.5 border-l-[3px] border-current/40 pl-2 text-[0.8125rem] leading-snug whitespace-normal opacity-80">
                      <div className="text-xs font-semibold">{m.quote.author}</div>
                      <div className="line-clamp-3">{m.quote.text}</div>
                    </div>
                  )}
                  {images.map((im, i) => {
                    const u = im.f ? mediaUrl(im.f, acc) : im.url || "";
                    return (
                      <a key={i} href={u} target="_blank" rel="noopener" className="my-1 block cursor-zoom-in overflow-hidden rounded-lg transition-opacity hover:opacity-90">
                        {/* eslint-disable-next-line @next/next/no-img-element -- images saved by the agent, sizes from Teams */}
                        <img
                          src={u}
                          alt="Image"
                          width={im.w || undefined}
                          height={im.h || undefined}
                          style={{ width: imageWidth(im.w, im.h) }}
                          className="block h-auto max-h-80 max-w-full object-contain"
                        />
                      </a>
                    );
                  })}
                  {pe ? <span className="opacity-70">{pe}</span> : m.html ? <div className="msg-html" dangerouslySetInnerHTML={{ __html: safeHtml(m.html) }} /> : m.text}
                  {files.map((f) => {
                    const st = downloads[f.url];
                    return (
                      <button
                        key={f.url}
                        type="button"
                        onClick={() => void getFile(f.url, f.name)}
                        disabled={st === "busy"}
                        className={cn(
                          "my-1 flex w-full min-w-56 items-center gap-3 rounded-xl border px-3 py-2 text-left whitespace-normal transition-colors",
                          mine ? "border-white/25 bg-white/10 hover:bg-white/20" : "bg-background/60 hover:bg-accent",
                        )}
                      >
                        <FileTextIcon className="size-5 shrink-0 opacity-80" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{f.name}</span>
                          <span className={cn("block text-xs opacity-75", st === "failed" && "text-destructive opacity-100")}>
                            {st === "busy" ? "Downloading…" : st === "failed" ? "Cannot be downloaded here: open it in Teams" : "Download"}
                          </span>
                        </span>
                        {st === "busy" ? <Spinner className="shrink-0" /> : <DownloadIcon className="size-4 shrink-0 opacity-80" />}
                      </button>
                    );
                  })}
                </>
              )}
            </div>

            {canAct && !touch && (
              <div
                data-open={actionsOpen}
                className={cn(
                  "absolute -top-5 z-10 flex items-center gap-0.5 rounded-full border bg-popover p-0.5 text-popover-foreground shadow-md transition-opacity",
                  "invisible opacity-0 group-hover/msg:visible group-hover/msg:opacity-100 group-focus-within/msg:visible group-focus-within/msg:opacity-100 data-[open=true]:visible data-[open=true]:opacity-100",
                  mine ? "right-2" : "left-2",
                )}
              >
                {Object.entries(REACTION_EMOJI).map(([k, e]) => (
                  <Tooltip key={k}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => void doReact(mid, k)}
                        aria-label={EMO_LABEL[k]}
                        className="grid size-8 place-items-center rounded-full text-lg transition-transform hover:scale-110 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:transition-none"
                      >
                        {e}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{EMO_LABEL[k]}</TooltipContent>
                  </Tooltip>
                ))}
                <span className="mx-0.5 h-5 w-px bg-border" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" className="rounded-full" onClick={() => startReply(m)} aria-label="Reply with quote">
                      <ReplyIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Reply</TooltipContent>
                </Tooltip>
                <DropdownMenu onOpenChange={(o) => setMenuFor(o ? mid : null)}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="More actions">
                      <MoreHorizontalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align={mine ? "end" : "start"} className="w-44">
                    <DropdownMenuItem onSelect={() => startReply(m)}>
                      <ReplyIcon />
                      Reply
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!(m.text || "").trim()}
                      onSelect={() => void navigator.clipboard?.writeText(m.text || "").then(() => toast.success("Copied"))}
                    >
                      <CopyIcon />
                      Copy text
                    </DropdownMenuItem>
                    {mine && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem disabled={!(m.text || "").trim()} onSelect={() => startEdit(m)}>
                          <PencilIcon />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => void doDelete(mid)}>
                          <Trash2Icon />
                          Delete
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>

          {!m.deleted && reacts.length > 0 && (
            <div className={cn("mt-1 flex flex-wrap gap-1", mine ? "justify-end" : "justify-start")}>
              {reacts.map((r, i) => (
                <button
                  key={`${r.e}${i}`}
                  type="button"
                  disabled={r.pend}
                  onClick={() => void tapPill(mid, r.e)}
                  aria-pressed={r.mine}
                  aria-label={`${r.e} ${r.n}${r.mine ? ", yours" : ""}`}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-full border bg-background px-2 text-xs tabular-nums transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
                    r.mine && "border-primary/50 bg-primary/10 hover:bg-primary/15",
                  )}
                >
                  <span className="text-sm leading-none">{r.e}</span>
                  {r.n > 1 && <span>{r.n}</span>}
                </button>
              ))}
            </div>
          )}

          {mine && !m.deleted && (pe || lastMine[idx]) ? (
            <div className="mt-1 mr-1 flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
              {pe ? (
                <>
                  <Spinner className="size-3" />
                  {pe === "Deleting…" ? "Deleting…" : "Editing…"}
                </>
              ) : (
                <>
                  {status.seen ? <CheckCheckIcon className="size-3.5 text-primary" /> : <CheckIcon className="size-3.5" />}
                  {status.label}
                  {m.edited ? " · Edited" : ""}
                </>
              )}
            </div>
          ) : (
            m.edited && !m.deleted && <div className={cn("mt-1 text-[0.6875rem] text-muted-foreground", mine ? "mr-1" : "ml-1")}>Edited</div>
          )}
        </div>
      </div>,
    ];
  });

  return (
    // a file dropped on the chat: an image goes above the box, anything else gets the reason it cannot go (without
    // this the browser would open the file in place of the app)
    <div
      className="flex h-full min-h-0 flex-1 flex-col bg-background"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        const f = e.dataTransfer.files[0];
        if (!f) return;
        e.preventDefault();
        if (stopped) toast.error(stoppedText);
        else pickImage(f);
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-2 backdrop-blur md:px-4 max-md:h-[calc(3.5rem+env(safe-area-inset-top))] max-md:pt-[env(safe-area-inset-top)]">
        <Button
          variant="ghost"
          size="icon"
          className="relative size-10 md:hidden"
          onClick={onBack}
          aria-label={others ? `Back to the list, ${others} unread in other accounts${otherCalls ? `, ${otherCalls} missed ${otherCalls === 1 ? "call" : "calls"}` : ""}` : "Back to the list"}
        >
          <ArrowLeftIcon className="size-5" />
          {others - otherCalls > 0 && (
            <span aria-hidden className="absolute top-0.5 left-5 min-w-4 rounded-full bg-primary px-1 text-center text-[0.625rem] leading-4 font-semibold text-primary-foreground tabular-nums">
              {others - otherCalls > 99 ? "99+" : others - otherCalls}
            </span>
          )}
          {otherCalls > 0 && <span aria-hidden className="absolute bottom-1 left-6 size-2.5 rounded-full bg-destructive ring-2 ring-background" />}
        </Button>
        <Avatar name={chat} av={entry?.av} acc={acc} muted={!!entry?.muted} presence={entry?.presence} className="size-9" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[0.9375rem] font-semibold">{chat}</h2>
          {entry?.muted ? <p className="text-xs text-muted-foreground">Muted in Teams</p> : null}
        </div>
        {onCall && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-10 md:size-9" onClick={() => setAskCall(true)} aria-label={`Call ${chat}`}>
                <PhoneIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Call {chat}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-10 md:size-9" onClick={() => void refresh()} disabled={stopped} aria-label="Refresh from Teams">
              <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh from Teams</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-10 md:size-9" onClick={onOpenDesktop} aria-label="Open in the remote Teams">
              <ExternalLinkIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open in the remote Teams</TooltipContent>
        </Tooltip>
      </header>

      {(openState === "failed" || (openState === "opening" && !loading)) && (
        <div
          role={openState === "failed" ? "alert" : "status"}
          className={cn(
            "flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs md:px-6",
            openState === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted/60 text-muted-foreground",
          )}
        >
          {openState === "opening" ? (
            <>
              <Spinner className="size-3.5 shrink-0" />
              <span>Opening in Teams… showing the messages saved at your last visit.</span>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1">
                <span className="font-medium">Teams did not open this chat.</span> {whyNot}
                {messages.length ? " Showing the messages saved at your last visit." : ""}
              </span>
              <Button variant="link" size="xs" className="h-auto shrink-0 p-0 text-xs" onClick={() => setAsks((n) => n + 1)}>
                Try again
              </Button>
            </>
          )}
        </div>
      )}

      <div ref={boxRef} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* the messages saved at the last visit, dimmed until Teams has opened the chat for this one */}
        <div className={cn("mx-auto w-full max-w-4xl px-3 pt-2 pb-6 transition-opacity md:px-6", openState === "opening" && !loading && "opacity-60")}>
          {loading ? (
            <div className="flex h-60 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <Spinner className="size-6" />
              Opening the chat in Teams…
            </div>
          ) : nothing ? (
            <Empty className="h-60">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageSquareDashedIcon />
                </EmptyMedia>
                {openState === "failed" ? (
                  <>
                    <EmptyTitle>No messages saved for this chat</EmptyTitle>
                    <EmptyDescription>They show once Teams opens it.</EmptyDescription>
                  </>
                ) : (
                  <>
                    <EmptyTitle>No messages in this chat</EmptyTitle>
                    <EmptyDescription>Write the first one below.</EmptyDescription>
                  </>
                )}
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              {bubbles}
              {shownPending.map((p) => {
                const failed = now - p.ts > 14000;
                return (
                  <div key={p.ts} className="mt-1 flex flex-col items-end">
                    <div className="max-w-[min(36rem,82%)] rounded-2xl rounded-r-md bg-bubble-mine px-3.5 py-2 text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap text-bubble-mine-foreground opacity-70 md:text-sm">
                      {p.quote && (
                        <div className="mb-1.5 border-l-[3px] border-current/40 pl-2 text-[0.8125rem] leading-snug whitespace-normal opacity-80">
                          <div className="text-xs font-semibold">{p.quote.author}</div>
                          <div className="line-clamp-3">{p.quote.text}</div>
                        </div>
                      )}
                      {p.text}
                    </div>
                    <div className={cn("mt-1 mr-1 flex items-center gap-1.5 text-[0.6875rem]", failed ? "text-destructive" : "text-muted-foreground")}>
                      {failed ? (
                        <>
                          Not sent
                          {!p.quote && (
                            <Button variant="link" size="xs" className="h-auto p-0 text-[0.6875rem]" onClick={() => retry(p)}>
                              Try again
                            </Button>
                          )}
                        </>
                      ) : (
                        <>
                          <Spinner className="size-3" />
                          Sending…
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {imagesPending.map((p) => (
                <div key={p.ts} className="mt-1 flex flex-col items-end">
                  <div className="max-w-[min(36rem,82%)] rounded-2xl rounded-r-md bg-bubble-mine px-3.5 py-2 text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap text-bubble-mine-foreground opacity-70 md:text-sm">
                    {/* eslint-disable-next-line @next/next/no-img-element -- local copy of the image being sent */}
                    <img src={p.url} alt="Image being sent" className="my-1 block max-h-80 max-w-full rounded-lg object-contain" />
                    {p.text}
                  </div>
                  <div className="mt-1 mr-1 flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                    <Spinner className="size-3" />
                    Sending…
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t bg-background px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] md:px-6 md:pb-3">
        <div className="relative mx-auto w-full max-w-4xl">
          {picker && (
            <div role="listbox" aria-label="People to tag" className="absolute bottom-full left-0 z-20 mb-2 w-80 max-w-full overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-md">
              {people.length ? (
                people.map((n, i) => (
                  <button
                    key={n}
                    type="button"
                    role="option"
                    aria-label={n}
                    aria-selected={i === pickIndex}
                    // mouse down, not click: the box keeps the focus and the cursor
                    onMouseDown={(e) => {
                      e.preventDefault();
                      tag(n);
                    }}
                    onMouseEnter={() => setPickIndex(i)}
                    className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", i === pickIndex && "bg-accent text-accent-foreground")}
                  >
                    <Avatar name={n} av="" acc={acc} className="size-6" />
                    <span className="truncate">{n}</span>
                  </button>
                ))
              ) : (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">
                  {membersLoading ? "Loading the people of this chat…" : members?.length ? "No one with this name here" : "No one to tag in this chat"}
                </div>
              )}
            </div>
          )}
          {(reply || editMid) && (
            <div className="mb-2 flex items-start gap-2 rounded-xl border-l-[3px] border-primary bg-muted/60 py-1.5 pr-1 pl-3">
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                  {reply ? <ReplyIcon className="size-3.5" /> : <PencilIcon className="size-3.5" />}
                  {reply ? `Replying to ${reply.author}` : "Editing your message"}
                </div>
                {reply && <div className="truncate text-muted-foreground">{reply.text || "Attachment"}</div>}
              </div>
              <Button variant="ghost" size="icon-sm" onClick={cancelCompose} aria-label={reply ? "Cancel reply" : "Cancel edit"}>
                <XIcon />
              </Button>
            </div>
          )}
          {image && (
            <div className="relative mb-2 w-fit">
              {/* eslint-disable-next-line @next/next/no-img-element -- local preview of the image to send */}
              <img src={image.url} alt="Image to send" className="block max-h-32 max-w-56 rounded-lg border object-contain" />
              <Button variant="secondary" size="icon-xs" className="absolute -top-2 -right-2 rounded-full border shadow-xs" onClick={() => setImage(null)} aria-label="Remove image">
                <XIcon />
              </Button>
            </div>
          )}
          <div className="flex items-end gap-1 rounded-2xl border bg-card py-1.5 pr-1.5 pl-1.5 shadow-xs transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 shrink-0 rounded-xl text-muted-foreground"
                  onClick={() => fileRef.current?.click()}
                  disabled={stopped || !!reply || !!editMid}
                  aria-label="Attach an image"
                >
                  <ImagePlusIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Attach an image, or paste one in the box</TooltipContent>
            </Tooltip>
            <input
              ref={fileRef}
              type="file"
              accept={IMAGE_ACCEPT}
              hidden
              onChange={(e) => {
                pickImage(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <textarea
              ref={taRef}
              rows={1}
              placeholder={stopped ? stoppedText : `Message ${chat}`}
              disabled={stopped}
              aria-label="Message"
              enterKeyHint="send"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                watchMention(e.target);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`;
              }}
              onSelect={(e) => watchMention(e.currentTarget)}
              onBlur={() => setPicker(null)}
              onKeyDown={(e) => {
                // the list of people takes the arrows, Enter and Tab while it shows someone
                if (picker && people.length && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key) && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (e.key === "ArrowDown") setPickIndex((i) => (i + 1) % people.length);
                  else if (e.key === "ArrowUp") setPickIndex((i) => (i - 1 + people.length) % people.length);
                  else tag(people[Math.min(pickIndex, people.length - 1)]);
                  return;
                }
                if (picker && e.key === "Escape") {
                  e.preventDefault();
                  setPicker(null);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
                if (e.key === "Escape" && (reply || editMid)) cancelCompose();
              }}
              onPaste={(e) => {
                // a pasted file: an image goes above the box, anything else gets the reason it cannot go
                const f = e.clipboardData.files[0];
                if (!f) return;
                e.preventDefault();
                pickImage(f);
              }}
              className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-base leading-6 outline-none placeholder:text-muted-foreground md:text-sm"
            />
            <Button
              size="icon"
              className="size-9 shrink-0 rounded-xl"
              onClick={() => void send()}
              disabled={stopped || (!text.trim() && !(image && !reply && !editMid))}
              aria-label={editMid ? "Save edit" : "Send"}
            >
              {editMid ? <CheckIcon /> : <SendHorizontalIcon />}
            </Button>
          </div>
          <p className="mt-1.5 hidden text-[0.6875rem] text-muted-foreground md:block">
            <Kbd>Enter</Kbd> to send, <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> for a new line, <Kbd>@</Kbd> to tag someone
          </p>
        </div>
      </div>

      <Sheet open={!!sheetMsg} onOpenChange={(o) => !o && setSheetFor(null)}>
        <SheetContent side="bottom" showCloseButton={false} className="gap-3 rounded-t-3xl px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
          <div aria-hidden className="mx-auto h-1.5 w-10 rounded-full bg-muted-foreground/30" />
          <SheetHeader className="gap-0.5 p-0 px-2">
            <SheetTitle className="text-sm">{sheetMsg?.mine ? "Your message" : sheetMsg?.author || "Message"}</SheetTitle>
            <SheetDescription className="line-clamp-2">{sheetMsg?.text || "Attachment"}</SheetDescription>
          </SheetHeader>
          {sheetMsg && (
            <>
              <div className="flex justify-between gap-1 px-1">
                {Object.entries(REACTION_EMOJI).map(([k, e]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => void doReact(String(sheetMsg.mid), k)}
                    aria-label={EMO_LABEL[k]}
                    className="grid size-12 place-items-center rounded-full bg-muted text-2xl transition-transform active:scale-90 motion-reduce:transition-none"
                  >
                    {e}
                  </button>
                ))}
              </div>
              <div className="flex flex-col">
                <Button variant="ghost" className="h-12 justify-start gap-3 px-3 text-base" onClick={() => startReply(sheetMsg)}>
                  <ReplyIcon className="size-5" />
                  Reply
                </Button>
                <Button
                  variant="ghost"
                  className="h-12 justify-start gap-3 px-3 text-base"
                  disabled={!(sheetMsg.text || "").trim()}
                  onClick={() => {
                    setSheetFor(null);
                    void navigator.clipboard?.writeText(sheetMsg.text || "").then(() => toast.success("Copied"));
                  }}
                >
                  <CopyIcon className="size-5" />
                  Copy text
                </Button>
                {!!sheetMsg.mine && (
                  <>
                    <Button variant="ghost" className="h-12 justify-start gap-3 px-3 text-base" disabled={!(sheetMsg.text || "").trim()} onClick={() => startEdit(sheetMsg)}>
                      <PencilIcon className="size-5" />
                      Edit
                    </Button>
                    <Button variant="ghost" className="h-12 justify-start gap-3 px-3 text-base text-destructive hover:text-destructive" onClick={() => void doDelete(String(sheetMsg.mid))}>
                      <Trash2Icon className="size-5" />
                      Delete
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={askCall && !!onCall} onOpenChange={setAskCall}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Call {chat}?</AlertDialogTitle>
            <AlertDialogDescription>
              {callHost
                ? `A Teams audio call from this account. The sound of the call stays in the Teams window on ${callHost} only.`
                : "A Teams audio call from this account. The sound of the call comes to this app."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => onCall?.()}>
              <PhoneIcon />
              Call
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
