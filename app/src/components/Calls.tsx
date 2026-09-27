"use client";

import { PhoneIcon, PhoneIncomingIcon, PhoneMissedIcon } from "lucide-react";
import { cn } from "cn";
import { Avatar } from "./Avatar";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import type { ActivityItem, CallLogEntry, RingingCall } from "@/lib/client";
import { hasTeamsId } from "@/shared/slot-db/rows";

// When a call rang: the time today, the day and the time before
function when(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

type Row = { key: string; name: string; line: string; icon: typeof PhoneIcon; tone: string; dot?: boolean };

// The calls of the account: the one ringing now, the missed calls of the Teams Activity feed (those that rang while
// no browser ran too, found by a check) and the calls the agent saw ring, with how long. A call whose caller has a chat
// in the list opens it. A red dot marks a missed call this device has not shown yet, as the Calls tab counts it: Teams
// shows every missed call as read, new or not.
export function Calls({
  acc,
  ringing,
  missed,
  log,
  seen,
  chatOf,
  onOpenChat,
}: {
  acc: number;
  ringing: RingingCall | undefined;
  missed: ActivityItem[];
  log: CallLogEntry[];
  seen: string[] | null;
  chatOf: (name: string) => string | null;
  onOpenChat: (chat: string) => void;
}) {
  const now: Row[] = ringing
    ? [{ key: "now", name: ringing.caller || "Incoming call", line: "Ringing now", icon: PhoneIncomingIcon, tone: "text-primary motion-safe:animate-pulse" }]
    : [];
  const shown = new Set(seen ?? []);
  const missedRows: Row[] = missed.map((a) => ({
    key: a.id,
    name: a.actor || a.chat || "Unknown caller",
    line: `Missed call${a.tm ? ` · ${a.tm}` : ""}`,
    icon: PhoneMissedIcon,
    tone: "text-destructive",
    dot: !!seen && !shown.has(a.id) && hasTeamsId(a.id),
  }));
  const logRows: Row[] = log.map((c) => ({
    key: `${c.since}`,
    name: c.caller || "Unknown caller",
    line: `${when(c.since)} · rang ${c.seconds} s`,
    icon: PhoneIncomingIcon,
    tone: "text-muted-foreground",
  }));

  if (!now.length && !missedRows.length && !logRows.length) {
    return (
      <Empty className="flex-1 py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PhoneIcon />
          </EmptyMedia>
          <EmptyTitle>No calls</EmptyTitle>
          <EmptyDescription>Calls ring here while the account runs. Missed calls come from the Teams activity feed.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const section = (title: string, rows: Row[]) =>
    rows.length > 0 && (
      <section aria-label={title}>
        <h3 className="px-2.5 pt-3 pb-1 text-xs font-medium text-muted-foreground">{title}</h3>
        <ul className="space-y-0.5">
          {rows.map((r) => {
            const chat = chatOf(r.name);
            const content = (
              <>
                <Avatar name={r.name} av="" acc={acc} className="size-11 md:size-10">
                  <span className="absolute -right-1 -bottom-1 z-10 grid size-5 place-items-center rounded-full bg-background shadow-sm ring-1 ring-border">
                    <r.icon className={cn("size-3", r.tone)} />
                  </span>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className={cn("truncate text-sm leading-snug", r.dot ? "font-semibold" : "font-medium")}>{r.name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{r.line}</p>
                </div>
                {r.dot && <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-destructive" aria-label="New" />}
              </>
            );
            return (
              <li key={r.key}>
                {chat ? (
                  <button
                    type="button"
                    onClick={() => onOpenChat(chat)}
                    className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none"
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex items-start gap-3 rounded-xl px-2.5 py-2.5">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    );

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2" aria-label="Calls">
      {section("Ringing", now)}
      {section("Missed calls", missedRows)}
      {section("Calls that rang here", logRows)}
    </div>
  );
}
