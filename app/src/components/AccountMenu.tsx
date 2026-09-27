"use client";

import { CheckIcon, ChevronsUpDownIcon, LogOutIcon, MonitorIcon, PlusIcon, SettingsIcon, Trash2Icon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";
import { Avatar, LogoTile } from "./Avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { Account, Unread } from "@/lib/client";

export const accName = (a: Account) => a.name || a.email || `Account ${a.slot}`;

const total = (u: Unread) => u.chats + u.notifications;
const capped = (n: number) => (n > 99 ? "99+" : String(n));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const unreadText = (u: Unread) =>
  [u.chats > 0 && plural(u.chats, "unread chat", "unread chats"), u.notifications > 0 && plural(u.notifications, "new notification", "new notifications")]
    .filter(Boolean)
    .join(", ");
export const needsLogin = (a: Account) => !a.stopped && (a.teams === "login" || (a.teams !== "starting" && a.teams !== "ok" && !a.name));

export function accSub(a: Account): { text: string; warn: boolean } {
  if (a.stopped) return { text: "Stopped · still signed in", warn: false };
  if (a.teams === "starting") return { text: "Starting the browser…", warn: false };
  if (a.teams === "login") return { text: "Microsoft sign-in needed", warn: true };
  if (!a.name) return { text: "Waiting for sign-in", warn: true };
  if (a.teams === "unknown") return { text: "Browser unreachable", warn: true };
  return { text: [a.email, a.tenant].filter(Boolean).join(" · "), warn: false };
}

// Switch between the Teams accounts of the user, stop or start one, add or remove one, reach settings and sign out.
// Every account shows its unread chats plus new notifications; the button shows the total of the other accounts.
export function AccountMenu({
  user,
  accounts,
  current,
  unreadOf,
  canAdd,
  addLabel,
  adding,
  toggling,
  onSelect,
  onSetRunning,
  onAdd,
  onOpenDesktop,
  onRemove,
  onSignOut,
}: {
  user: { name: string; email: string; role: string };
  accounts: Account[] | null;
  current: Account | undefined;
  unreadOf: (a: Account) => Unread;
  canAdd: boolean;
  addLabel: string;
  adding: boolean;
  toggling: number;
  onSelect: (slot: number) => void;
  onSetRunning: (a: Account, running: boolean) => void;
  onAdd: () => void;
  onOpenDesktop: (slot: number) => void;
  onRemove: (a: Account) => void;
  onSignOut: () => void;
}) {
  // like Teams: the selected account has its numbers on its Chats and Notifications tabs already
  const others = (accounts ?? []).reduce((n, a) => (a.slot === current?.slot ? n : n + total(unreadOf(a))), 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={others ? `Accounts and settings, ${others} unread in other accounts` : "Accounts and settings"}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-sidebar-accent"
        >
          {current ? <Avatar name={accName(current)} av={current.av} acc={current.slot} className="size-9" /> : <LogoTile />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{current ? current.tenant || accName(current) : "TeamsRelay"}</div>
            <div className="truncate text-xs text-muted-foreground">{current ? accSub(current).text : user.email}</div>
          </div>
          {others > 0 && (
            <Badge className="h-5 min-w-5 rounded-full px-1.5 tabular-nums" title={`${others} unread in your other accounts`}>
              {capped(others)}
            </Badge>
          )}
          <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-1rem)]">
        <DropdownMenuLabel>Teams accounts</DropdownMenuLabel>
        <DropdownMenuGroup>
          {(accounts ?? []).map((a) => {
            const sub = accSub(a);
            const busy = toggling === a.slot;
            const unread = unreadOf(a);
            return (
              <div key={a.slot} className="flex items-center gap-1">
                <DropdownMenuItem onSelect={() => onSelect(a.slot)} className="min-w-0 flex-1 gap-3 py-2">
                  <Avatar name={accName(a)} av={a.av} acc={a.slot} className={cn("size-8", a.stopped && "opacity-50 grayscale")} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{accName(a)}</div>
                    <div className={cn("truncate text-xs", sub.warn ? "text-destructive" : "text-muted-foreground")}>{sub.text}</div>
                  </div>
                  {total(unread) > 0 && (
                    <Badge className="h-5 min-w-5 rounded-full px-1.5 tabular-nums" title={unreadText(unread)}>
                      {capped(total(unread))}
                      <span className="sr-only"> ({unreadText(unread)})</span>
                    </Badge>
                  )}
                  {a.slot === current?.slot && <CheckIcon className="text-primary" />}
                </DropdownMenuItem>
                {/* on: green, off: grey. The menu stays open to show the switch move */}
                <DropdownMenuItem
                  role="menuitemcheckbox"
                  aria-checked={!a.stopped}
                  aria-label={`${a.stopped ? "Start" : "Stop"} ${accName(a)}`}
                  title={a.stopped ? "Stopped: click to start" : "Running: click to stop, the account stays signed in"}
                  disabled={busy}
                  onSelect={(e) => {
                    e.preventDefault();
                    onSetRunning(a, a.stopped);
                  }}
                  className="shrink-0 justify-center self-stretch px-2"
                >
                  {busy ? (
                    <Spinner />
                  ) : (
                    <Switch checked={!a.stopped} tabIndex={-1} aria-hidden className="pointer-events-none data-[state=checked]:bg-success" />
                  )}
                </DropdownMenuItem>
              </div>
            );
          })}
          <DropdownMenuItem disabled={!canAdd || adding} onSelect={onAdd}>
            {adding ? <Spinner /> : <PlusIcon />}
            {adding ? "Starting the browser…" : addLabel}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {current && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={current.stopped} onSelect={() => onOpenDesktop(current.slot)}>
                <MonitorIcon />
                {needsLogin(current) ? "Sign in to Microsoft" : "Open the remote Teams"}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => onRemove(current)}>
                <Trash2Icon />
                Remove this account…
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <SettingsIcon />
              Settings
            </Link>
          </DropdownMenuItem>
          {user.role === "admin" && (
            <DropdownMenuItem asChild>
              <Link href="/admin">
                <UsersIcon />
                Users
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onSignOut}>
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="truncate px-2 py-1.5 text-xs text-muted-foreground">Signed in as {user.email}</div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
