"use client";

import DOMPurify from "dompurify";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar } from "./Avatar";
import { followCmd, mediaUrl, post, runCmd, type Chat, type Message } from "@/lib/client";

const EMO: Record<string, string> = { like: "👍", heart: "❤️", laugh: "😆", surprised: "😮", cry: "😢", angry: "😠" };

// The agent already rebuilds message bodies from a short list of tags; sanitized again before rendering.
function safeHtml(html: string): string {
  if (typeof window === "undefined") return "";
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["b", "i", "u", "s", "code", "pre", "ul", "ol", "li", "blockquote", "p", "div", "span", "a", "br"],
    ALLOWED_ATTR: ["href", "target", "rel", "style", "class"],
  });
}

function statusLabel(s?: string): string {
  if (/everyone/i.test(s || "")) return "Seen by everyone";
  if (/seen|read/i.test(s || "")) return "Seen";
  return "Sent";
}

// In group chats the agent collects "Read by" in the background: shown under your message
function readLabel(m: Message): string {
  const mm = /^Read by (\d+) of (\d+)$/i.exec(m.readby?.label || "");
  if (!mm) return statusLabel(m.status);
  if (+mm[1] === 0) return "Sent · not read yet";
  const who = (m.readby?.names || []).join(", ");
  return (mm[1] === mm[2] ? "Read by everyone" : `Read by ${mm[1]} of ${mm[2]}`) + (who ? `: ${who}` : "");
}

type Pending = { text: string; ts: number; quote?: { author: string; text: string } };
type Bar = { mid: string; x: number; y: number };

export function Conversation({
  acc,
  chat,
  entry,
  rows,
  onBack,
  toast,
}: {
  acc: number;
  chat: string;
  entry?: Chat;
  rows: Message[] | null;
  onBack: () => void;
  toast: (t: string) => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [localReacts, setLocalReacts] = useState<Record<string, string[]>>({});
  const [pillPending, setPillPending] = useState<Record<string, Record<string, boolean>>>({});
  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});
  const [editMid, setEditMid] = useState<string | null>(null);
  const [reply, setReply] = useState<{ mid: string; author: string; text: string } | null>(null);
  const [bar, setBar] = useState<Bar | null>(null);
  const [downloads, setDownloads] = useState<Record<string, "busy" | "failed">>({});
  const [now, setNow] = useState(() => Date.now());
  const [openedAt] = useState(() => Date.now());
  const boxRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);

  const messages = rows ?? [];
  const realMine = messages.filter((m) => m.mine).map((m) => (m.text || "").trim());
  const shownPending = pending.filter((p) => !realMine.includes(p.text.trim()));

  // Opens the chat in the remote Teams: the agent keeps the messages of the open chat up to date
  useEffect(() => {
    void post("/api/open", { name: chat }, acc).catch(() => undefined);
  }, [chat, acc]);

  // the spinner gives the agent a few seconds to open the chat before "No messages" is shown
  useEffect(() => {
    const t = setTimeout(() => setNow(Date.now()), 5100);
    return () => clearTimeout(t);
  }, []);

  // a pending message that never shows up on Teams turns into "Not sent"
  useEffect(() => {
    if (!shownPending.length) return;
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, [shownPending.length]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && atBottom.current) box.scrollTop = box.scrollHeight;
  }, [rows, pending]);

  // reaction bar next to the tapped message, kept inside the screen
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!bar || !el) return;
    const bw = el.offsetWidth || 258;
    const bh = el.offsetHeight || 50;
    let top = bar.y - bh - 12;
    if (top < 64) top = bar.y + 18;
    el.style.left = `${Math.max(8, Math.min(bar.x - bw / 2, window.innerWidth - bw - 8))}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
  }, [bar]);

  useEffect(() => {
    if (!bar) return;
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!barRef.current?.contains(t) && !t.closest(".b")) setBar(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [bar]);

  const onScroll = () => {
    const b = boxRef.current;
    if (b) atBottom.current = b.scrollHeight - b.scrollTop - b.clientHeight < 70;
  };

  const barMessage = bar ? messages.find((m) => String(m.mid) === bar.mid) : undefined;

  function openBar(e: React.MouseEvent, mid: string) {
    if (!mid) return;
    e.stopPropagation();
    setBar({ mid, x: e.clientX || window.innerWidth / 2, y: e.clientY || 200 });
  }

  async function doReact(key: string) {
    if (!bar) return;
    const mid = bar.mid;
    const m = messages.find((x) => String(x.mid) === mid);
    const mineAlready = m?.reactions?.some((r) => r.e === EMO[key] && r.mine);
    if (!mineAlready) setLocalReacts((s) => ({ ...s, [mid]: [...new Set([...(s[mid] || []), key])] }));
    setBar(null);
    const r = await runCmd("/api/react", { name: chat, mid, emoji: key }, acc);
    setLocalReacts((s) => ({ ...s, [mid]: (s[mid] || []).filter((k) => k !== key) }));
    if (r.status !== "done") toast("Reaction not applied on Teams");
  }

  // tap on a reaction under a message, like in Teams: removed if yours, added otherwise
  async function tapPill(e: React.MouseEvent, mid: string, emoji: string) {
    e.stopPropagation();
    const m = messages.find((x) => String(x.mid) === mid);
    const wasMine = !!m?.reactions?.find((x) => x.e === emoji)?.mine;
    const key = Object.keys(EMO).find((k) => EMO[k] === emoji);
    if (wasMine) setPillPending((s) => ({ ...s, [mid]: { ...(s[mid] || {}), [emoji]: true } }));
    else if (key) setLocalReacts((s) => ({ ...s, [mid]: [...new Set([...(s[mid] || []), key])] }));
    const r = await runCmd("/api/react", { name: chat, mid, pill: emoji }, acc);
    setPillPending((s) => {
      const rest = { ...(s[mid] || {}) };
      delete rest[emoji];
      return { ...s, [mid]: rest };
    });
    if (key) setLocalReacts((s) => ({ ...s, [mid]: (s[mid] || []).filter((k) => k !== key) }));
    if (r.status !== "done") toast(wasMine ? "Reaction not removed on Teams" : "Reaction not applied on Teams");
  }

  function startEdit() {
    if (!barMessage) return;
    setBar(null);
    setReply(null);
    setEditMid(String(barMessage.mid));
    setText(barMessage.text || "");
    taRef.current?.focus();
  }

  function startReply() {
    if (!barMessage) return;
    setBar(null);
    setEditMid(null);
    setReply({ mid: String(barMessage.mid), author: barMessage.mine ? "You" : barMessage.author || "", text: (barMessage.text || "").slice(0, 160) });
    taRef.current?.focus();
  }

  function cancelEdit() {
    setEditMid(null);
    setText("");
  }

  // deleted right away, like in Teams, with "Undo" on the deleted message
  async function doDelete() {
    if (!bar) return;
    const mid = bar.mid;
    setBar(null);
    setPendingEdits((s) => ({ ...s, [mid]: "Deleting…" }));
    const r = await runCmd("/api/delete", { name: chat, mid }, acc);
    setPendingEdits((s) => {
      const rest = { ...s };
      delete rest[mid];
      return rest;
    });
    if (r.status !== "done") toast("Message not deleted on Teams");
  }

  async function undoDelete(e: React.MouseEvent, mid: string) {
    e.stopPropagation();
    (e.target as HTMLButtonElement).textContent = "Restoring…";
    const r = await runCmd("/api/undodelete", { name: chat, mid }, acc);
    if (r.status !== "done") toast("The message can no longer be restored");
  }

  // attachments live on SharePoint: the agent downloads them with the Teams session, then the browser saves them
  async function getFile(e: React.MouseEvent, url: string, name: string) {
    e.preventDefault();
    e.stopPropagation();
    if (downloads[url] === "busy") return;
    setDownloads((s) => ({ ...s, [url]: "busy" }));
    let r: { status: string; result: { f?: string } | null } = { status: "failed", result: null };
    try {
      const c = await post<{ id: number }>("/api/download", { url, name }, acc);
      r = await followCmd(c.id, acc);
    } catch {
      // reported below
    }
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

  async function send() {
    const t = text.trim();
    if (!t) return;
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
    atBottom.current = true;
    if (reply) {
      const r0 = reply;
      setReply(null);
      setPending((p) => [...p, { text: t, ts: Date.now(), quote: { author: r0.author, text: r0.text } }]);
      const r = await runCmd("/api/reply", { name: chat, mid: r0.mid, text: t }, acc);
      if (r.status !== "done") toast("Reply not sent on Teams");
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
      if (r.status !== "done") toast("Edit not applied on Teams");
      return;
    }
    setPending((p) => [...p, { text: t, ts: Date.now() }]);
    try {
      await post("/api/send", { name: chat, text: t }, acc);
    } catch {
      toast("Message not queued");
    }
  }

  const loading = rows === null || (!messages.length && !shownPending.length && now - openedAt < 5000);
  // Teams shows author and picture only on the first of consecutive messages of the same person
  const firsts: boolean[] = [];
  let prevAuthor: string | null = null;
  for (const m of messages) {
    firsts.push(!m.mine && m.author !== prevAuthor);
    prevAuthor = m.mine ? null : m.author;
  }
  const bubbles = messages.map((m, idx) => {
    const images = m.images || [];
    const files = m.files || [];
    if (!m.deleted && !(m.text || "").trim() && !images.length && !files.length) return null;
    const mid = String(m.mid || "");
    const pe = pendingEdits[mid];
    const teamsReacts = (m.reactions || [])
      .filter((r) => !pillPending[mid]?.[r.e])
      .map((r) => ({ t: r.e + (r.n > 1 ? ` ${r.n}` : ""), e: r.e, mine: r.mine, pend: false }));
    const localOnly = (localReacts[mid] || [])
      .map((k) => EMO[k])
      .filter((x) => x && !(m.reactions || []).some((r) => r.e === x))
      .map((x) => ({ t: x, e: "", mine: true, pend: true }));
    const reacts = [...teamsReacts, ...localOnly];
    const status = pe ? "Editing…" : readLabel(m) + (m.edited ? " · Edited" : "");
    const firstOfSeries = firsts[idx];

    const bubble = (
      <div key={mid || m.text} className={`b ${m.mine ? "me" : "them"}`} onClick={(e) => openBar(e, mid)}>
        {!m.mine && m.author && firstOfSeries && (
          <div className="au">
            {m.author}
            {m.mentionsMe && <span className="atme">@</span>}
          </div>
        )}
        {m.deleted ? (
          <div className="del">
            Message deleted
            {!!m.mine && (
              <button className="undo" onClick={(e) => undoDelete(e, mid)}>
                Undo
              </button>
            )}
          </div>
        ) : (
          <>
            {m.quote && (
              <div className="q">
                <div className="qa">{m.quote.author}</div>
                {m.quote.text}
              </div>
            )}
            {images.map((im, i) => {
              const u = im.f ? mediaUrl(im.f, acc) : im.url || "";
              return (
                <a key={i} className="im" href={u} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- images saved by the agent, sizes from Teams */}
                  <img src={u} alt="" width={im.w || undefined} height={im.h || undefined} />
                </a>
              );
            })}
            {!pe && m.html ? <div className="tx" dangerouslySetInnerHTML={{ __html: safeHtml(m.html) }} /> : pe || m.text}
            {files.map((f) => (
              <a key={f.url} className="fl" href={f.url} onClick={(e) => getFile(e, f.url, f.name)}>
                {f.name}
                <span className="fl-s">
                  {downloads[f.url] === "busy" ? "Downloading…" : downloads[f.url] === "failed" ? "Download failed, tap to retry" : "Tap to download"}
                </span>
              </a>
            ))}
          </>
        )}
        {!m.mine && m.edited && <div className="st">Edited</div>}
        {!!m.mine && !m.deleted && <div className="st">{status}</div>}
        {!m.deleted && reacts.length > 0 && (
          <div>
            {reacts.map((r, i) => (
              <span
                key={i}
                className={`react${r.mine ? " mine" : ""}${r.pend ? " pend" : ""}${r.e ? " tap" : ""}`}
                onClick={r.e ? (e) => tapPill(e, mid, r.e) : undefined}
              >
                {r.t}
              </span>
            ))}
          </div>
        )}
      </div>
    );
    if (m.mine) return bubble;
    return (
      <div key={`r${mid || m.text}`} className="mrow">
        <Avatar name={m.author || "?"} av={m.av} acc={acc} hidden={!firstOfSeries} />
        {bubble}
      </div>
    );
  });

  return (
    <div className="conv">
      <div className="cbar">
        <button className="back" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <Avatar name={chat} av={entry?.av} acc={acc} muted={!!entry?.muted} />
        <div className="t">{chat}</div>
      </div>
      <div className="msgs" ref={boxRef} onScroll={onScroll}>
        {loading ? (
          <div className="spin">
            <div className="ring" />
            Loading…
          </div>
        ) : !messages.length && !shownPending.length ? (
          <div className="empty">No messages in this chat.</div>
        ) : (
          <>
            {bubbles}
            {shownPending.map((p) => {
              const failed = now - p.ts > 14000;
              return (
                <div key={p.ts} className="b me pending">
                  {p.quote && (
                    <div className="q">
                      <div className="qa">{p.quote.author}</div>
                      {p.quote.text}
                    </div>
                  )}
                  {p.text}
                  <div className={`st${failed ? " err" : ""}`}>{failed ? "Not sent, try again" : "Sending…"}</div>
                </div>
              );
            })}
          </>
        )}
      </div>
      {editMid && (
        <div className="editbar">
          <span>Edit message</span>
          <button onClick={cancelEdit} aria-label="Cancel edit">
            ✕
          </button>
        </div>
      )}
      {reply && (
        <div className="replybar">
          <div className="rq">
            <div className="qa">{reply.author}</div>
            <div className="rt">{reply.text || "Attachment"}</div>
          </div>
          <button onClick={() => setReply(null)} aria-label="Cancel reply">
            ✕
          </button>
        </div>
      )}
      <div className="compose">
        <textarea
          ref={taRef}
          rows={1}
          placeholder="Type a message…"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button onClick={() => void send()} aria-label="Send">
          ➤
        </button>
      </div>
      {bar && (
        <div ref={barRef} className="reactbar" style={{ visibility: "hidden", left: 0, top: 0 }}>
          {Object.entries(EMO).map(([k, e]) => (
            <button key={k} onClick={() => void doReact(k)}>
              {e}
            </button>
          ))}
          <button className="rb-text" onClick={startReply}>
            Reply
          </button>
          {!!barMessage?.mine && !barMessage.deleted && (barMessage.text || "").trim() && (
            <button className="rb-text" onClick={startEdit}>
              Edit
            </button>
          )}
          {!!barMessage?.mine && !barMessage.deleted && (
            <button className="rb-text rb-del" onClick={() => void doDelete()}>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
