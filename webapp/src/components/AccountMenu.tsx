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
import type { Account } from "@/lib/client";

export const accName = (a: Account) => a.name || a.email || `Account ${a.slot}`;
export const needsLogin = (a: Account) => a.teams === "login" || (a.teams !== "starting" && a.teams !== "ok" && !a.name);

export function accSub(a: Account): { text: string; warn: boolean } {
  if (a.teams === "starting") return { text: "Starting the browser…", warn: false };
  if (a.teams === "login") return { text: "Microsoft sign-in needed", warn: true };
  if (!a.name) return { text: "Waiting for sign-in", warn: true };
  if (a.teams === "unknown") return { text: "Browser unreachable", warn: true };
  return { text: [a.email, a.tenant].filter(Boolean).join(" · "), warn: false };
}

// Switch between the Teams accounts of the user, add or remove one, reach settings and sign out
export function AccountMenu({
  user,
  accounts,
  current,
  canAdd,
  addLabel,
  adding,
  onSelect,
  onAdd,
  onOpenDesktop,
  onRemove,
  onSignOut,
}: {
  user: { name: string; email: string; role: string };
  accounts: Account[] | null;
  current: Account | undefined;
  canAdd: boolean;
  addLabel: string;
  adding: boolean;
  onSelect: (slot: number) => void;
  onAdd: () => void;
  onOpenDesktop: (slot: number) => void;
  onRemove: (a: Account) => void;
  onSignOut: () => void;
}) {
  const otherUnread = (accounts ?? []).some((a) => a.slot !== current?.slot && a.unread > 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Accounts and settings"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-sidebar-accent"
        >
          {current ? <Avatar name={accName(current)} av={current.av} acc={current.slot} className="size-9" /> : <LogoTile />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{current ? current.tenant || accName(current) : "TeamsRelay"}</div>
            <div className="truncate text-xs text-muted-foreground">{current ? accSub(current).text : user.email}</div>
          </div>
          {otherUnread && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread messages in another account" />}
          <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-1rem)]">
        <DropdownMenuLabel>Teams accounts</DropdownMenuLabel>
        <DropdownMenuGroup>
          {(accounts ?? []).map((a) => {
            const sub = accSub(a);
            return (
              <DropdownMenuItem key={a.slot} onSelect={() => onSelect(a.slot)} className="gap-3 py-2">
                <Avatar name={accName(a)} av={a.av} acc={a.slot} className="size-8" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{accName(a)}</div>
                  <div className={cn("truncate text-xs", sub.warn ? "text-destructive" : "text-muted-foreground")}>{sub.text}</div>
                </div>
                {a.unread > 0 && <Badge className="h-5 min-w-5 rounded-full px-1.5 tabular-nums">{a.unread}</Badge>}
                {a.slot === current?.slot && <CheckIcon className="text-primary" />}
              </DropdownMenuItem>
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
              <DropdownMenuItem onSelect={() => onOpenDesktop(current.slot)}>
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
