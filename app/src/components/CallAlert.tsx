"use client";

import { PhoneIncomingIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { Account, RingingCall } from "@/lib/client";
import type { Ringer } from "@/lib/ring";

const callKey = (c: RingingCall) => `${c.acc}:${c.since}`;

// The account a call rings in, as its notifications name it: organization, otherwise email
export const accountLabel = (a: Account | undefined, acc: number) => (a && (a.tenant || a.email || a.name)) || `Account ${acc}`;

const noSubscribe = () => () => {};

// Whether the page may play the ring; before hydration it counts as allowed, so the server shows no hint
function useRingAllowed(ringer: Ringer | null) {
  return useSyncExternalStore(ringer?.subscribe ?? noSubscribe, () => ringer?.allowed() ?? true, () => true);
}

// The calls ringing now in every account of the user, on top of the app, with the ring while one of them is not muted.
// A tap on a call opens its account; Mute silences that call only, and the next one rings again.
export function CallBanner({
  calls,
  accounts,
  ringer,
  onSelect,
}: {
  calls: RingingCall[];
  accounts: Account[] | null;
  ringer: Ringer | null;
  onSelect: (acc: number) => void;
}) {
  const [muted, setMuted] = useState<string[]>([]);
  const allowed = useRingAllowed(ringer);
  const loud = calls.some((c) => !muted.includes(callKey(c)));

  useEffect(() => {
    if (!ringer) return;
    if (loud) ringer.start();
    else ringer.stop();
  }, [loud, ringer]);
  useEffect(() => () => ringer?.stop(), [ringer]);

  if (!calls.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-2 px-3 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
      {calls.map((c) => {
        const key = callKey(c);
        const off = muted.includes(key);
        return (
          <div key={key} role="alert" className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-card-foreground shadow-lg">
            <PhoneIncomingIcon className="size-5 shrink-0 text-primary motion-safe:animate-pulse" />
            <button type="button" onClick={() => onSelect(c.acc)} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
              <span className="block truncate text-sm font-semibold">{c.caller ? `${c.caller} is calling` : "Incoming call"}</span>
              <span className="block truncate text-xs text-muted-foreground">
                ({accountLabel(accounts?.find((a) => a.slot === c.acc), c.acc)})
                {!allowed && !off ? " · Click to allow the ring" : ""}
              </span>
            </button>
            <Button size="sm" variant="secondary" className="h-9 shrink-0 md:h-8" onClick={() => setMuted((m) => (off ? m.filter((k) => k !== key) : [...m, key]))}>
              {off ? <Volume2Icon /> : <VolumeXIcon />}
              {off ? "Unmute" : "Mute"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// Shown while the page may not play the ring yet: a click or a key press anywhere in the page allows it
export function RingHint({ ringer, show }: { ringer: Ringer | null; show: boolean }) {
  const allowed = useRingAllowed(ringer);
  if (!ringer || allowed || !show) return null;
  return (
    <div className="px-3 pb-2">
      <button type="button" onClick={() => ringer.allow()} className="flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <Volume2Icon className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 text-muted-foreground">Click to allow the call ring</span>
      </button>
    </div>
  );
}
