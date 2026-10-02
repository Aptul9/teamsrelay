"use client";

import { CheckIcon, ChevronsUpDownIcon, ClockIcon, LaptopIcon, LogOutIcon, MonitorIcon, PlusIcon, ServerIcon, SettingsIcon, Trash2Icon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "cn";
import { Avatar, LogoTile } from "./Avatar";
import { relayHost } from "./RelayToken";
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
import { accName, checkLine, idleChecked, lastCheck, relayOffline, statusText, type Account, type Unread } from "@/lib/client";


// chats and notifications share the purple count; missed calls have a red one of their own
const total = (u: Unread) => u.chats + u.notifications;
const capped = (n: number) => (n > 99 ? "99+" : String(n));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const unreadText = (u: Unread) =>
  [u.chats > 0 && plural(u.chats, "unread chat", "unread chats"), u.notifications > 0 && plural(u.notifications, "new notification", "new notifications")]
    .filter(Boolean)
    .join(", ");
const callsText = (n: number) => plural(n, "missed call", "missed calls");

export function MissedBadge({ n, className }: { n: number; className?: string }) {
  if (!n) return null;
  return (
    <Badge className={cn("h-5 min-w-5 rounded-full bg-destructive px-1.5 text-white tabular-nums", className)} title={callsText(n)}>
      {capped(n)}
      <span className="sr-only"> ({callsText(n)})</span>
    </Badge>
  );
}
// between two checks an account checked every N hours knows only what its last check found; an account on another
// computer needs a sign-in only when its relay says so
export const needsLogin = (a: Account) =>
  !a.stopped &&
  (a.relay
    ? a.teams === "login"
    : idleChecked(a)
      ? a.checkResult === "login" || !a.name
      : a.teams === "login" || (a.teams !== "starting" && a.teams !== "ok" && !a.name));

// What an account on another computer is doing, when it is not simply running: its relay not there yet, or gone
function relayState(a: Account): { text: string; warn: boolean } | null {
  if (a.teams === "starting") return { text: "Waiting for its relay…", warn: false };
  if (a.teams === "unknown") return { text: `Relay on ${relayHost(a)} not connected`, warn: true };
  if (a.teams === "login") return { text: `Microsoft sign-in needed on ${relayHost(a)}`, warn: true };
  if (!a.name) return { text: `Waiting for the sign-in on ${relayHost(a)}`, warn: true };
  return null;
}

// What the account is doing, when it is not simply running: stopped, checked, starting, a sign-in to do...
export function accState(a: Account): { text: string; warn: boolean } | null {
  if (a.relay) return relayState(a);
  if (a.stopped) return { text: "Stopped · still signed in", warn: false };
  if (idleChecked(a)) {
    if (needsLogin(a)) return { text: "Microsoft sign-in needed", warn: true };
    return { text: checkLine(a), warn: a.checkResult === "failed" };
  }
  if (a.checking && a.teams !== "login") return { text: "Checking now…", warn: false };
  if (a.teams === "starting") return { text: "Starting the browser…", warn: false };
  if (a.teams === "login") return { text: "Microsoft sign-in needed", warn: true };
  if (!a.name) return { text: "Waiting for sign-in", warn: true };
  if (a.teams === "unknown") return { text: "Browser unreachable", warn: true };
  return null;
}

// Who the account is: the accounts of one person share the name
export const accIdentity = (a: Account) => [a.email, a.tenant].filter(Boolean).join(" · ");

// The line under the name on the account menu button: what the account is doing, else who it is
export function accSub(a: Account): { text: string; warn: boolean } {
  return accState(a) ?? { text: accIdentity(a), warn: false };
}

// The line under the name in the menu, whose status stands on the right: only what the status does not say
function menuState(a: Account): { text: string; warn: boolean } | null {
  if (a.stopped) return { text: "Still signed in", warn: false };
  if (idleChecked(a) && !needsLogin(a)) return a.checked ? { text: lastCheck(a), warn: a.checkResult === "failed" } : null;
  if (a.checking && a.teams !== "login") return null;
  return accState(a);
}

// Stopped, active, or when the next check updates the account, on its right in the menu; the time left counts down
// while the menu is open. "Updating in" and the time go on two lines, so the name keeps its room.
function AccountStatus({ a }: { a: Account }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  const checked = !a.stopped && a.checkEvery > 0;
  useEffect(() => {
    if (!checked) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => clearInterval(t);
  }, [checked]);
  const [head, rest] = statusText(a, now).split(/(?<=^Updating in) /);
  return (
    <span className="flex shrink-0 flex-col items-end text-right text-xs leading-tight text-muted-foreground">
      <span className="flex items-center gap-1.5">
        {checked ? <ClockIcon className="size-3" /> : <span className={cn("size-2 rounded-full", a.stopped || relayOffline(a) ? "bg-muted-foreground/40" : "bg-success")} />}
        {head}
      </span>
      {rest && <span className="whitespace-nowrap">{rest}</span>}
    </span>
  );
}

// Name, who it is and what it is doing, for the lists of accounts (menu, Settings)
export function AccountLines({ a, state = accState(a) }: { a: Account; state?: { text: string; warn: boolean } | null }) {
  const who = accIdentity(a);
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium">{accName(a)}</div>
      {who && <div className="truncate text-xs text-muted-foreground">{who}</div>}
      {state && <div className={cn("truncate text-xs", state.warn ? "text-destructive" : "text-muted-foreground")}>{state.text}</div>}
    </div>
  );
}

// Switch between the Teams accounts of the user, add or remove one, reach settings and sign out. Every account shows
// its unread chats plus new notifications and its status (set in Settings); the button shows the total of the other
// accounts.
export function AccountMenu({
  user,
  accounts,
  current,
  unreadOf,
  others,
  canAdd,
  addLabel,
  adding,
  onSelect,
  onAdd,
  onAddRelay,
  onOpenDesktop,
  onRemove,
  onSignOut,
  appPage,
}: {
  user: { name: string; email: string; role: string };
  accounts: Account[] | null;
  current: Account | undefined;
  unreadOf: (a: Account) => Unread;
  // unread in the accounts not on screen (unreadInOthers)
  others: number;
  canAdd: boolean;
  addLabel: string;
  adding: boolean;
  onSelect: (slot: number) => void;
  onAdd: () => void;
  // an account whose browser runs on another computer, joined by the relay there
  onAddRelay: () => void;
  onOpenDesktop: (slot: number) => void;
  onRemove: (a: Account) => void;
  onSignOut: () => void;
  // the start page of the Android app that opened this server (useAppStart): Change server goes back to its form
  appPage?: string | null;
}) {
  // the missed calls among what waits in the other accounts, on a red count of their own
  const otherCalls = (accounts ?? []).reduce((n, a) => (a.slot === current?.slot ? n : n + unreadOf(a).calls), 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={others ? `Accounts and settings, ${others} unread in other accounts` : "Accounts and settings"}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-sidebar-accent"
        >
          {current ? <Avatar name={accName(current)} av={current.av} acc={current.slot} presence={current.presence} className="size-9" /> : <LogoTile />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{current ? current.tenant || accName(current) : "TeamsRelay"}</div>
            <div className="truncate text-xs text-muted-foreground">{current ? accSub(current).text : user.email}</div>
          </div>
          {others - otherCalls > 0 && (
            <Badge className="h-5 min-w-5 rounded-full px-1.5 tabular-nums" title={`${others - otherCalls} unread in your other accounts`}>
              {capped(others - otherCalls)}
            </Badge>
          )}
          <MissedBadge n={otherCalls} />
          <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[22rem] max-w-[calc(100vw-1rem)]">
        <DropdownMenuLabel>Teams accounts</DropdownMenuLabel>
        <DropdownMenuGroup>
          {(accounts ?? []).map((a) => {
            const unread = unreadOf(a);
            return (
              <DropdownMenuItem key={a.slot} onSelect={() => onSelect(a.slot)} className="gap-3 py-2">
                <Avatar name={accName(a)} av={a.av} acc={a.slot} className={cn("size-8", a.stopped && "opacity-50 grayscale")} />
                <AccountLines a={a} state={menuState(a)} />
                {total(unread) > 0 && (
                  <Badge className="h-5 min-w-5 rounded-full px-1.5 tabular-nums" title={unreadText(unread)}>
                    {capped(total(unread))}
                    <span className="sr-only"> ({unreadText(unread)})</span>
                  </Badge>
                )}
                <MissedBadge n={unread.calls} />
                {a.slot === current?.slot && <CheckIcon className="text-primary" />}
                <AccountStatus a={a} />
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuItem disabled={!canAdd || adding} onSelect={onAdd}>
            {adding ? <Spinner /> : <PlusIcon />}
            {adding ? "Starting the browser…" : addLabel}
          </DropdownMenuItem>
          {canAdd && (
            <DropdownMenuItem disabled={adding} onSelect={onAddRelay}>
              <LaptopIcon />
              Add from another computer…
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        {current && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {current.relay ? (
                <DropdownMenuItem disabled>
                  <LaptopIcon />
                  Runs on {relayHost(current)}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled={current.stopped || idleChecked(current)} onSelect={() => onOpenDesktop(current.slot)}>
                  <MonitorIcon />
                  {needsLogin(current) ? "Sign in to Microsoft" : "Open the remote Teams"}
                </DropdownMenuItem>
              )}
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
          {appPage && (
            <DropdownMenuItem asChild>
              <a href={`${appPage}#change`}>
                <ServerIcon />
                Change server
              </a>
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
