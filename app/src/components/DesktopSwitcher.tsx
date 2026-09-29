"use client";

import { ChevronDownIcon, ChevronUpIcon, MonitorIcon } from "lucide-react";
import { cn } from "cn";
import { Fragment, useEffect, useRef, useState } from "react";
import { accName } from "@/components/AccountMenu";
import { onDesktop, type Account } from "@/lib/client";

const label = (a: Account) => a.tenant || accName(a);

// The one remote desktop on the whole page, and a small tab with an arrow at its top: a click pulls down the accounts
// whose window is on the desktop, a pick brings that account to the front of the desktop on screen (POST
// /api/desktop/N) and the desktop stays connected. The address names the account in front. A second tab of the
// desktop would cut off the first: Selkies keeps one viewer in control.
export function DesktopSwitcher({ accounts, initial }: { accounts: Account[]; initial: number }) {
  const list = onDesktop(accounts);
  const first = list.find((a) => a.slot === initial) ?? list[0];
  const [front, setFront] = useState(first?.slot ?? 0);
  // opened once, on the first account: another address would load the desktop again
  const [src] = useState(first ? `/api/desktop/${first.slot}` : "");
  const [down, setDown] = useState(false);
  const [problem, setProblem] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const tab = useRef<HTMLDivElement>(null);

  // a reload opens the account in front again
  useEffect(() => {
    if (front) window.history.replaceState(null, "", `?account=${front}`);
  }, [front]);

  // up again at a click anywhere else (a click on the desktop takes the focus from this page) and at Escape
  useEffect(() => {
    if (!down) return;
    const away = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && tab.current?.contains(e.target as Node)) return;
      setDown(false);
    };
    for (const type of ["pointerdown", "keydown", "blur"]) window.addEventListener(type, away);
    return () => {
      for (const type of ["pointerdown", "keydown", "blur"]) window.removeEventListener(type, away);
    };
  }, [down]);

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
    // the tab stays down with the reason
    if (why) return setProblem(`${label(a)} not brought to the front: ${why}`);
    setFront(a.slot);
    setDown(false);
    // the keyboard back to the desktop
    frame.current?.focus();
  }

  if (!first) return <p className="p-4 text-sm text-muted-foreground">No account has its window on the remote desktop.</p>;
  return (
    <div className="relative h-dvh overflow-hidden bg-background">
      <iframe ref={frame} src={src} title="Remote Teams desktop" allow="microphone; autoplay" className="absolute inset-0 size-full border-0" />
      <div ref={tab} className="absolute left-1/2 top-0 z-10 flex -translate-x-1/2 flex-col items-center">
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
            down ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div id="desktop-accounts" inert={!down} aria-hidden={!down} className="min-h-0 overflow-hidden">
            <div className="flex flex-col items-center rounded-b-2xl border border-t-0 bg-background/80 p-1.5 shadow-xl shadow-black/10 backdrop-blur-xl">
              <div className="flex items-center">
                <MonitorIcon className="mx-2 size-4 shrink-0 text-muted-foreground" />
                {list.map((a) => (
                  <Fragment key={a.slot}>
                    <span data-separator aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
                    <button
                      type="button"
                      aria-pressed={a.slot === front}
                      onClick={() => void bring(a)}
                      className={cn(
                        "h-8 shrink-0 rounded-xl px-3.5 text-sm font-medium outline-none transition-all duration-150 focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97]",
                        a.slot === front ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-primary/10 hover:text-primary",
                      )}
                    >
                      {label(a)}
                    </button>
                  </Fragment>
                ))}
              </div>
              {problem && (
                <p role="alert" className="max-w-80 px-2 pt-1 text-xs text-destructive">
                  {problem}
                </p>
              )}
            </div>
          </div>
        </div>
        <button
          type="button"
          aria-label="Accounts"
          aria-expanded={down}
          aria-controls="desktop-accounts"
          onClick={() => setDown((d) => !d)}
          className="flex h-5 w-12 items-center justify-center rounded-b-xl border border-t-0 bg-background/80 text-muted-foreground shadow-md shadow-black/10 backdrop-blur-xl transition-colors duration-150 hover:text-primary"
        >
          {down ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
        </button>
      </div>
    </div>
  );
}
