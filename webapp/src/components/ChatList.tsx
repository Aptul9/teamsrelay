"use client";

import { useRef, useState } from "react";
import { Avatar } from "./Avatar";
import { isSelf, post, type Chat } from "@/lib/client";

type Filter = "all" | "unread" | "mentions";

export function ChatList({ acc, chats, onOpen }: { acc: number; chats: Chat[] | null; onOpen: (name: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [newestFirst, setNewestFirst] = useState(true);
  const [ptr, setPtr] = useState<{ text: string; cls: string } | null>(null);
  const pull = useRef({ y: 0, active: false });
  const listRef = useRef<HTMLDivElement>(null);

  // pull to refresh: the agent reads the chat list of Teams again
  const onTouchStart = (e: React.TouchEvent) => {
    if ((listRef.current?.scrollTop ?? 0) <= 0) pull.current = { y: e.touches[0].clientY, active: true };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!pull.current.active) return;
    const dy = e.touches[0].clientY - pull.current.y;
    if (dy > 0) setPtr({ text: dy > 70 ? "Release to refresh" : "Pull to refresh", cls: "" });
  };
  const onTouchEnd = async (e: React.TouchEvent) => {
    if (!pull.current.active) return;
    pull.current.active = false;
    if (e.changedTouches[0].clientY - pull.current.y <= 70) return setPtr(null);
    setPtr({ text: "Refreshing…", cls: "" });
    try {
      await post("/api/resync", undefined, acc);
      await new Promise((r) => setTimeout(r, 900));
      setPtr({ text: "Updated", cls: "ok" });
    } catch {
      setPtr({ text: "Refresh failed", cls: "err" });
    }
    setTimeout(() => setPtr(null), 1400);
  };

  const chips: [Filter, string][] = [
    ["all", "All"],
    ["unread", "Unread"],
    ["mentions", "@ Mentions"],
  ];

  let body: React.ReactNode;
  if (chats === null) {
    body = (
      <div className="spin">
        <div className="ring" />
        Loading conversations…
      </div>
    );
  } else {
    const self = chats.find((c) => isSelf(c.name));
    let rest = chats.filter((c) => !isSelf(c.name));
    if (filter === "unread") rest = rest.filter((c) => c.unread);
    if (filter === "mentions") rest = rest.filter((c) => c.mention || /@/.test(c.preview || ""));
    if (!newestFirst) rest = [...rest].reverse();
    const list = self ? [self, ...rest] : rest;
    body = list.length ? (
      list.map((c, i) => (
        <div key={c.name}>
          <div className="row" onClick={() => onOpen(c.name)}>
            <Avatar name={c.name} av={c.av} acc={acc} muted={!!c.muted} />
            <div className="rc">
              <div className="rtop">
                <div className={`rname${c.unread ? " unread" : ""}`}>{c.name}</div>
                <div className="rtime">{c.tm}</div>
              </div>
              <div className="rbot">
                <div className={`rprev${c.unread ? " unread" : ""}`}>{c.preview}</div>
                {c.unread ? <div className="dot" /> : null}
              </div>
            </div>
          </div>
          {i < list.length - 1 && <div className="sep" />}
        </div>
      ))
    ) : (
      <div className="empty">No conversations{filter !== "all" ? " for this filter" : ""}.</div>
    );
  }

  return (
    <>
      <div style={{ padding: "0 8px" }}>
        <div className="filters">
          {chips.map(([f, label]) => (
            <button key={f} className={`chip${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
          <button className="chip" onClick={() => setNewestFirst(!newestFirst)}>
            {newestFirst ? "Newest first" : "Oldest first"}
          </button>
        </div>
      </div>
      <div className="list" ref={listRef} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        <div className={`ptr${ptr ? ` show ${ptr.cls}` : ""}`}>{ptr?.text}</div>
        {body}
      </div>
    </>
  );
}
