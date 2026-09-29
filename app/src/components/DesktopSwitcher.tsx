"use client";

import { MonitorIcon } from "lucide-react";
import { useRef, useState } from "react";
import { accName } from "@/components/AccountMenu";
import { Button } from "@/components/ui/button";
import { onDesktop, type Account } from "@/lib/client";

const label = (a: Account) => a.tenant || accName(a);

// The one remote desktop in a tab of its own, a button per account above it: a click brings the window of that account
// to the front of the desktop on screen (POST /api/desktop/N) and the desktop stays connected. A second tab of the
// desktop would cut off the first: Selkies keeps one viewer in control.
export function DesktopSwitcher({ accounts, initial }: { accounts: Account[]; initial: number }) {
  const list = onDesktop(accounts);
  const first = list.find((a) => a.slot === initial) ?? list[0];
  const [front, setFront] = useState(first?.slot ?? 0);
  // opened once, on the first account: another address would load the desktop again
  const [src] = useState(first ? `/api/desktop/${first.slot}` : "");
  const [problem, setProblem] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);

  async function bring(a: Account) {
    setProblem("");
    let why = "";
    try {
      const r = await fetch(`/api/desktop/${a.slot}`, { method: "POST" });
      const b = (await r.json().catch(() => ({}))) as { shown?: boolean; detail?: string };
      if (!r.ok) why = b.detail || `error ${r.status}`;
      else if (!b.shown) why = "the desktop did not answer";
    } catch {
      why = "the server did not answer";
    }
    if (why) setProblem(`${label(a)} not brought to the front: ${why}`);
    else setFront(a.slot);
    // the keyboard back to the desktop
    frame.current?.focus();
  }

  if (!first) return <p className="p-4 text-sm text-muted-foreground">No account has its window on the remote desktop.</p>;
  return (
    <div className="flex h-dvh flex-col bg-background">
      <nav aria-label="Accounts" className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b px-2">
        <MonitorIcon className="mr-1 size-4 shrink-0 text-muted-foreground" />
        {list.map((a) => (
          <Button key={a.slot} size="sm" variant={a.slot === front ? "secondary" : "ghost"} aria-pressed={a.slot === front} className="h-8 shrink-0" onClick={() => void bring(a)}>
            {label(a)}
          </Button>
        ))}
        {problem && (
          <span role="alert" className="ml-2 truncate text-xs text-destructive">
            {problem}
          </span>
        )}
      </nav>
      <iframe ref={frame} src={src} title="Remote Teams desktop" allow="microphone; autoplay" className="min-h-0 w-full flex-1 border-0" />
    </div>
  );
}
