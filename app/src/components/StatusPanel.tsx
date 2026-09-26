"use client";

import { BellRingIcon, MonitorIcon, RefreshCwIcon, StethoscopeIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { ago, post, type Health } from "@/lib/client";

type Tone = "ok" | "warn" | "bad" | "off";
const DOT: Record<Tone, string> = { ok: "bg-success", warn: "bg-warning", bad: "bg-destructive", off: "bg-muted-foreground/40" };

const teamsState = (t?: string): [string, Tone] =>
  t === "ok"
    ? ["Connected", "ok"]
    : t === "login"
      ? ["Session expired", "bad"]
      : t === "unknown"
        ? ["Unreachable", "bad"]
        : t === "err" || t === "no" || t === "stale"
          ? ["Error", "bad"]
          : t === "starting"
            ? ["Starting", "warn"]
            : ["Loading", "warn"];

// Your status in Teams, as the Teams header shows it. The relay keeps it Available; Busy, Do not disturb,
// meetings and calls come from you or your calendar and are fine as they are.
const presenceState = (p?: string): [string, Tone] => {
  if (!p) return ["Unknown", "warn"];
  const label = p.charAt(0).toUpperCase() + p.slice(1);
  return [label, /^(away|be right back|offline|unknown)/.test(p) ? "warn" : "ok"];
};

// Health of the selected Teams account, with the actions that fix the usual problems
export function StatusPanel({
  acc,
  accountName,
  health,
  pushOff,
  onEnablePush,
  onOpenDesktop,
}: {
  acc: number;
  accountName: string;
  health: Health | null;
  pushOff: boolean;
  onEnablePush: () => void;
  onOpenDesktop: () => void;
}) {
  const [busy, setBusy] = useState<"" | "resync" | "recheck">("");
  const overall = health?.overall || "yellow";
  // grey: the owner stopped the account, which is not a problem
  const stopped = overall === "grey";
  const tone: Tone = stopped ? "off" : overall === "green" ? "ok" : overall === "red" ? "bad" : "warn";
  const label = !acc ? "No account" : stopped ? "Stopped" : overall === "green" ? "Connected" : overall === "red" ? "Problem" : "Connecting";

  const rows: [string, string, Tone][] = health
    ? [
        ["Teams", ...teamsState(health.teams)],
        ["Your Teams status", ...presenceState(health.presence)],
        ["New message detection", health.watcher === "ok" ? "Running" : "Stopped", health.watcher === "ok" ? "ok" : "warn"],
        ["Browser engine", health.agent === "ok" ? "Running" : "Not responding", health.agent === "ok" ? "ok" : "bad"],
        ["Last message", ago(health.last_msg_ts), health.last_msg_ts ? "ok" : "warn"],
        ["Push notifications", `${health.push_subs ?? 0} device${health.push_subs === 1 ? "" : "s"}`, (health.push_subs ?? 0) > 0 ? "ok" : "warn"],
      ]
    : [];
  const shown: [string, string, Tone][] = stopped ? [["Teams", "Stopped, still signed in", "off"]] : rows;

  async function run(kind: "resync" | "recheck") {
    setBusy(kind);
    try {
      await post(`/api/${kind}`, undefined, acc);
      toast.success(kind === "resync" ? "Chats read again from Teams" : "Check started: the result arrives as a notification");
    } catch {
      toast.error(kind === "resync" ? "Resync failed" : "Check failed");
    }
    setBusy("");
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="h-9 shrink-0 gap-2 rounded-full px-3 data-[state=open]:bg-sidebar-accent" aria-label={`System status: ${label}`}>
          <span className={cn("size-2.5 rounded-full", acc ? DOT[tone] : "bg-muted-foreground/40", tone === "warn" && acc && "animate-pulse motion-reduce:animate-none")} />
          <span className="text-sm font-medium max-sm:sr-only">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>System status</PopoverTitle>
          <PopoverDescription className="truncate">{acc ? accountName : "Add a Teams account to see its status."}</PopoverDescription>
        </PopoverHeader>
        {acc > 0 && (
          <>
            <dl className="mt-3 space-y-2.5">
              {shown.length ? (
                shown.map(([k, v, t]) => (
                  <div key={k} className="flex items-center gap-2.5 text-sm">
                    <span className={cn("size-2 shrink-0 rounded-full", DOT[t])} aria-hidden />
                    <dt className="flex-1 text-muted-foreground">{k}</dt>
                    <dd className="font-medium">{v}</dd>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">Waiting for the first status…</p>
              )}
            </dl>
            <Separator className="my-3" />
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="h-10 md:h-9" onClick={() => void run("resync")} disabled={!!busy || stopped} title="Read the chat list and the open chat of Teams again">
                <RefreshCwIcon className={cn(busy === "resync" && "animate-spin")} />
                Resync
              </Button>
              <Button variant="outline" className="h-10 md:h-9" onClick={() => void run("recheck")} disabled={!!busy || stopped} title="Check the whole chain and send the result as a notification">
                <StethoscopeIcon />
                Recheck
              </Button>
              <Button variant="outline" className="col-span-2 h-10 md:h-9" onClick={onOpenDesktop} disabled={stopped}>
                <MonitorIcon />
                Open the remote Teams (sign-in, MFA)
              </Button>
              {pushOff && (
                <Button className="col-span-2 h-10 md:h-9" onClick={onEnablePush}>
                  <BellRingIcon />
                  Enable notifications on this device
                </Button>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
