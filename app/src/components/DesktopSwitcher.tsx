"use client";

import { ChevronDownIcon, ChevronUpIcon, MonitorIcon } from "lucide-react";
import { cn } from "cn";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { addUnread, callsText, NO_UNREAD, total, UnreadBadges, unreadText } from "./UnreadBadges";
import { accName, accountUnread, call, errorText, idleChecked, loadSeen, onDesktop, post, type Account, type Unread } from "@/lib/client";

const label = (a: Account) => a.tenant || accName(a);
// the page has no event stream: the counts come from the account list read again every so often
export const COUNTS_EVERY_MS = 30_000;
const waits = (u: Unread) => total(u) + u.calls > 0;
const waitText = (u: Unread) => [unreadText(u), u.calls > 0 && callsText(u.calls)].filter(Boolean).join(", ");

// The one remote desktop on the whole page, and a small tab with an arrow at its top: a click pulls down the accounts
// whose window is on the desktop, a pick brings that account to the front of the desktop on screen (POST
// /api/desktop/N) and the desktop stays connected. The address names the account in front. A second tab of the
// desktop would cut off the first: Selkies keeps one viewer in control. The arrow counts what waits in every account,
// each account its own, like the account menu of the app.
export function DesktopSwitcher({ accounts, initial }: { accounts: Account[]; initial: number }) {
  // the account asked for, even a light one with no browser now: /api/desktop/N starts its browser, the desktop never
  // opens on another account instead
  const asked = accounts.find((a) => a.slot === initial && !a.relay && !a.stopped && !idleChecked(a));
  const others = onDesktop(accounts);
  const list = asked && !others.includes(asked) ? [asked, ...others] : others;
  const first = asked ?? list[0];
  const [front, setFront] = useState(first?.slot ?? 0);
  // opened once, on the first account: another address would load the desktop again
  const [src] = useState(first ? `/api/desktop/${first.slot}` : "");
  const [down, setDown] = useState(false);
  const [problem, setProblem] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const tab = useRef<HTMLDivElement>(null);

  // what waits in every account, as the account menu of the app counts it on this device: the seen lists are the app's,
  // and a list the app marks in another tab counts here at once
  const [live, setLive] = useState(accounts);
  const [marked, setMarked] = useState(0);
  useEffect(() => {
    const t = setInterval(() => void call<{ accounts: Account[] }>("/api/accounts", undefined, 0).then((d) => setLive(d.accounts), () => undefined), COUNTS_EVERY_MS);
    const mark = () => setMarked((n) => n + 1);
    window.addEventListener("storage", mark);
    return () => {
      clearInterval(t);
      window.removeEventListener("storage", mark);
    };
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- marked: the seen lists changed in another tab
  const seen = useMemo(() => loadSeen(live), [live, marked]);
  const unreadOf = (slot: number) => {
    const a = live.find((x) => x.slot === slot);
    return a ? accountUnread(a, seen[slot] ?? null) : NO_UNREAD;
  };
  const all = live.reduce((u, a) => addUnread(u, unreadOf(a.slot)), NO_UNREAD);
  // accounts with no window on the desktop, whose counts would have no button
  const elsewhere = live.filter((a) => !list.some((x) => x.slot === a.slot) && waits(unreadOf(a.slot)));

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
      if (!(await post<{ shown?: boolean }>(`/api/desktop/${a.slot}`, undefined, 0)).shown) why = "the desktop did not answer";
    } catch (e) {
      why = errorText(e, "the server did not answer");
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
                        "flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-sm font-medium outline-none transition-all duration-150 focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97]",
                        a.slot === front ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-primary/10 hover:text-primary",
                      )}
                    >
                      {label(a)}
                      <UnreadBadges u={unreadOf(a.slot)} className={cn(a.slot === front && "ring-1 ring-primary-foreground")} />
                    </button>
                  </Fragment>
                ))}
              </div>
              {elsewhere.length > 0 && (
                <p data-elsewhere className="flex max-w-[40rem] flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 pt-1.5 text-xs text-muted-foreground">
                  <span>Not on the desktop:</span>
                  {elsewhere.map((a) => (
                    <span key={a.slot} className="flex items-center gap-1">
                      {label(a)}
                      <UnreadBadges u={unreadOf(a.slot)} />
                    </span>
                  ))}
                </p>
              )}
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
          aria-label={waits(all) ? `Accounts, ${waitText(all)}` : "Accounts"}
          aria-expanded={down}
          aria-controls="desktop-accounts"
          onClick={() => setDown((d) => !d)}
          className="flex h-6 min-w-12 items-center justify-center gap-1 rounded-b-xl border border-t-0 bg-background/80 px-2 text-muted-foreground shadow-md shadow-black/10 backdrop-blur-xl transition-colors duration-150 hover:text-primary"
        >
          {down ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
          {!down && <UnreadBadges u={all} className="h-4 min-w-4 px-1 text-[10px]" />}
        </button>
      </div>
    </div>
  );
}
