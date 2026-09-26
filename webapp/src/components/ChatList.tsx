"use client";

import { ArrowDownWideNarrowIcon, ArrowUpNarrowWideIcon, AtSignIcon, MessagesSquareIcon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Avatar } from "./Avatar";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isSelf, post, type Chat } from "@/lib/client";

type Filter = "all" | "unread" | "mentions";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ChatList({
  acc,
  chats,
  selected,
  onOpen,
}: {
  acc: number;
  chats: Chat[] | null;
  selected: string | null;
  onOpen: (name: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [newestFirst, setNewestFirst] = useState(true);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [pullText, setPullText] = useState("");
  const pull = useRef({ y: 0, active: false });
  const listRef = useRef<HTMLDivElement>(null);

  // the agent reads the chat list of Teams again
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await post("/api/resync", undefined, acc);
      await sleep(900);
    } catch {
      toast.error("Refresh failed");
    }
    setRefreshing(false);
  }

  // pull to refresh, on touch screens
  const onTouchStart = (e: React.TouchEvent) => {
    if ((listRef.current?.scrollTop ?? 0) <= 0) pull.current = { y: e.touches[0].clientY, active: true };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!pull.current.active) return;
    const dy = e.touches[0].clientY - pull.current.y;
    setPullText(dy > 70 ? "Release to refresh" : dy > 10 ? "Pull to refresh" : "");
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!pull.current.active) return;
    pull.current.active = false;
    setPullText("");
    if (e.changedTouches[0].clientY - pull.current.y > 70) void refresh();
  };

  let body: React.ReactNode;
  if (chats === null) {
    body = (
      <div className="space-y-1 p-2" aria-busy="true" aria-label="Loading conversations">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-2.5 py-2.5">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
        ))}
      </div>
    );
  } else {
    const self = chats.find((c) => isSelf(c.name));
    let rest = chats.filter((c) => !isSelf(c.name));
    if (filter === "unread") rest = rest.filter((c) => c.unread);
    if (filter === "mentions") rest = rest.filter((c) => c.mention || /@/.test(c.preview || ""));
    if (!newestFirst) rest = [...rest].reverse();
    let list = self && filter === "all" ? [self, ...rest] : rest;
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((c) => c.name.toLowerCase().includes(q) || (c.preview || "").toLowerCase().includes(q));
    body = list.length ? (
      <ul className="space-y-0.5 p-2" aria-label="Conversations">
        {list.map((c) => {
          const active = c.name === selected;
          const mention = !!c.mention;
          return (
            <li key={c.name}>
              <button
                type="button"
                onClick={() => onOpen(c.name)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none",
                  active && "bg-sidebar-accent hover:bg-sidebar-accent",
                )}
              >
                <Avatar name={c.name} av={c.av} acc={acc} muted={!!c.muted} className="size-11 md:size-10" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className={cn("truncate text-[0.9375rem] md:text-sm", c.unread ? "font-semibold" : "font-medium")}>{c.name}</span>
                    <span className={cn("ml-auto shrink-0 text-xs tabular-nums", c.unread ? "font-medium text-primary" : "text-muted-foreground")}>{c.tm}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className={cn("truncate text-sm", c.unread ? "text-foreground" : "text-muted-foreground")}>{c.preview || " "}</span>
                    {mention && <AtSignIcon aria-label="You were mentioned" className="size-3.5 shrink-0 text-primary" />}
                    {c.unread ? <span className="ml-auto size-2.5 shrink-0 rounded-full bg-primary" aria-label="Unread" /> : null}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    ) : (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessagesSquareIcon />
          </EmptyMedia>
          <EmptyTitle>{q || filter !== "all" ? "Nothing matches" : "No conversations yet"}</EmptyTitle>
          <EmptyDescription>
            {q || filter !== "all" ? "Try another filter or search." : "The chat list of Teams appears here once the account is signed in."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 px-3 pt-1 pb-2">
        <InputGroup className="h-10 md:h-9">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search chats" />
          {query && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                <XIcon />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <div className="flex items-center gap-1">
          <ToggleGroup type="single" value={filter} onValueChange={(v) => v && setFilter(v as Filter)} variant="outline" size="sm" aria-label="Filter chats">
            <ToggleGroupItem value="all" className="px-3">
              All
            </ToggleGroupItem>
            <ToggleGroupItem value="unread" className="px-3">
              Unread
            </ToggleGroupItem>
            <ToggleGroupItem value="mentions" className="px-3">
              Mentions
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="ml-auto flex items-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={() => setNewestFirst(!newestFirst)} aria-label={newestFirst ? "Newest first" : "Oldest first"}>
                  {newestFirst ? <ArrowDownWideNarrowIcon /> : <ArrowUpNarrowWideIcon />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{newestFirst ? "Newest first" : "Oldest first"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={() => void refresh()} disabled={refreshing || !acc} aria-label="Refresh from Teams">
                  <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh from Teams</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
      <div
        ref={listRef}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {(pullText || refreshing) && (
          <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground md:hidden">
            {refreshing ? <RefreshCwIcon className="size-3.5 animate-spin" /> : null}
            {refreshing ? "Refreshing…" : pullText}
          </div>
        )}
        {body}
      </div>
    </div>
  );
}
