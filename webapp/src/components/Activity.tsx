"use client";

import { useState } from "react";
import { Avatar } from "./Avatar";
import { clock, type ActivityItem } from "@/lib/client";

type Filter = "all" | "unread" | "mention" | "reaction";
const BADGE: Record<string, string> = { mention: "@", reply: "↩", message: "•", meeting: "▦" };

// The Teams Activity feed: reactions to your messages, mentions, replies, invitations
export function Activity({
  acc,
  feed,
  refreshing,
  onOpenChat,
}: {
  acc: number;
  feed: { ts: number; items: ActivityItem[] } | null;
  refreshing: boolean;
  onOpenChat: (chat: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const items = feed?.items ?? [];
  const shown = items.filter((a) => filter === "all" || (filter === "unread" ? a.unread : a.kind === filter));
  const chips: [Filter, string][] = [
    ["all", "All"],
    ["unread", "Unread"],
    ["mention", "@ Mentions"],
    ["reaction", "Reactions"],
  ];

  return (
    <>
      <div style={{ padding: "0 8px" }}>
        <div className="filters">
          {chips.map(([f, label]) => (
            <button key={f} className={`chip${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        <div className="actsub">{refreshing ? "Updating from Teams…" : feed?.ts ? `Updated at ${clock(feed.ts)}` : ""}</div>
      </div>
      <div className="list">
        {feed === null ? (
          <div className="spin">
            <div className="ring" />
            Loading activity…
          </div>
        ) : !shown.length ? (
          <div className="empty">{items.length ? "Nothing for this filter." : "No activity."}</div>
        ) : (
          shown.map((a) => {
            const who = a.actor || a.chat || "Teams";
            // meetings and channels open only in the remote Teams
            const target = a.kind === "meeting" || a.channel ? "" : a.chat;
            return (
              <div key={a.id} className={`act${a.unread ? " unread" : ""}`} onClick={() => onOpenChat(target)}>
                <Avatar name={who} av={a.av} acc={acc}>
                  <span className="abadge">{a.kind === "reaction" ? a.emoji || "+" : BADGE[a.kind] || "•"}</span>
                </Avatar>
                <div className="rc">
                  <div className="at">{a.title || a.chat || "Message"}</div>
                  {a.preview && <div className="ap">{a.preview}</div>}
                  <div className="am">
                    {a.chat}
                    {a.tm ? ` · ${a.tm}` : ""}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
