"use client";

import {
  AtSignIcon,
  BellIcon,
  CalendarDaysIcon,
  ClipboardCheckIcon,
  HashIcon,
  MessageSquareIcon,
  PhoneMissedIcon,
  RefreshCwIcon,
  ReplyIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { Avatar } from "./Avatar";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { clock, type ActivityItem } from "@/lib/client";

type Filter = "all" | "unread" | "mention" | "reaction";

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  mention: AtSignIcon,
  reply: ReplyIcon,
  message: MessageSquareIcon,
  meeting: CalendarDaysIcon,
  call: PhoneMissedIcon,
  task: ClipboardCheckIcon,
  team: UsersIcon,
};

// The Teams Activity feed: reactions to your messages, mentions, replies, invitations, missed calls.
// `resolve` tells which chat of the list an item opens; meetings and channels open only in the remote Teams.
export function Activity({
  acc,
  feed,
  refreshing,
  onRefresh,
  resolve,
  onOpenChat,
}: {
  acc: number;
  feed: { ts: number; items: ActivityItem[] } | null;
  refreshing: boolean;
  onRefresh: () => void;
  resolve: (a: ActivityItem) => string | null;
  onOpenChat: (chat: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const items = feed?.items ?? [];
  const shown = items.filter((a) => filter === "all" || (filter === "unread" ? a.unread : a.kind === filter));

  let body: React.ReactNode;
  if (feed === null) {
    body = (
      <div className="space-y-1 p-2" aria-busy="true" aria-label="Loading activity">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex gap-3 px-2.5 py-2.5">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (!shown.length) {
    body = (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BellIcon />
          </EmptyMedia>
          <EmptyTitle>{items.length ? "Nothing for this filter" : "No activity"}</EmptyTitle>
          <EmptyDescription>Reactions, mentions and replies from Teams show up here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <ul className="space-y-0.5 p-2" aria-label="Activity">
        {shown.map((a) => {
          const target = resolve(a);
          const Icon = a.channel ? HashIcon : KIND_ICON[a.kind] || MessageSquareIcon;
          const content = (
            <>
              <Avatar name={a.actor || a.chat || "Teams"} av={a.av} acc={acc} className="size-11 md:size-10">
                <span className="absolute -right-1 -bottom-1 z-10 grid size-5 place-items-center rounded-full bg-background text-[0.8rem] leading-none shadow-sm ring-1 ring-border">
                  {a.kind === "reaction" && a.emoji ? a.emoji : <Icon className="size-3 text-primary" />}
                </span>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm leading-snug", a.unread ? "font-semibold" : "font-medium")}>{a.title || a.chat || "Message"}</p>
                {a.preview && <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{a.preview}</p>}
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {a.chat}
                  {a.chat && a.tm ? " · " : ""}
                  {a.tm}
                  {!target && (a.kind === "meeting" || a.channel) ? " · open it in Teams" : ""}
                </p>
              </div>
              {a.unread ? <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-primary" aria-label="Unread" /> : null}
            </>
          );
          return (
            <li key={a.id}>
              {target ? (
                <button
                  type="button"
                  onClick={() => onOpenChat(target)}
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
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-3 pt-1 pb-2">
        <ToggleGroup type="single" value={filter} onValueChange={(v) => v && setFilter(v as Filter)} variant="outline" size="sm" aria-label="Filter activity">
          <ToggleGroupItem value="all" className="px-3">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="unread" className="px-3">
            Unread
          </ToggleGroupItem>
          <ToggleGroupItem value="mention" className="px-3">
            Mentions
          </ToggleGroupItem>
          <ToggleGroupItem value="reaction" className="px-3">
            Reactions
          </ToggleGroupItem>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onRefresh} disabled={refreshing || !acc} aria-label="Refresh from Teams">
              <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{refreshing ? "Updating from Teams…" : feed?.ts ? `Updated at ${clock(feed.ts)}` : "Refresh from Teams"}</TooltipContent>
        </Tooltip>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">{body}</div>
    </div>
  );
}
