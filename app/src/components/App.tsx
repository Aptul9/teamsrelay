"use client";

import {
  BellIcon,
  BellRingIcon,
  ClockIcon,
  ExternalLinkIcon,
  LaptopIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  MonitorIcon,
  PhoneIcon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { AccountMenu, accName, needsLogin } from "./AccountMenu";
import { Activity } from "./Activity";
import { CallBanner, RingHint } from "./CallAlert";
import { Calls } from "./Calls";
import { ChatList } from "./ChatList";
import { Conversation } from "./Conversation";
import { relayHost, RelayTokenDialog } from "./RelayToken";
import { StatusPanel } from "./StatusPanel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { appStart, keepAppStart, useAppStart } from "@/lib/android-app";
import { authClient } from "@/lib/auth-client";
import {
  accountUnread,
  addingTitle,
  ApiError,
  appBadgeCount,
  bellOn,
  call,
  callsSnapshot,
  checkLine,
  clock,
  hours,
  idleChecked,
  isMissedCall,
  isSelf,
  loadSeen,
  noteShown,
  pageTitle,
  post,
  readStorage,
  relayOffline,
  runCmd,
  signedInOnce,
  toLogin,
  unreadInOthers,
  unseenActivity,
  unseenCalls,
  writeStorage,
  type Account,
  type ActivityItem,
  type CallLogEntry,
  type Chat,
  type Health,
  type Message,
  type RingingCall,
  type Unread,
} from "@/lib/client";
import { enablePush, pushState } from "@/lib/push";
import { Ringer } from "@/lib/ring";

type ListTab = "chats" | "activity" | "calls";
type User = { name: string; email: string; role: string };

// On a PC (mouse, no touch) the remote desktop opens in a browser tab; elsewhere it has a view of its own
const noSubscribe = () => () => {};
const isPcNow = () => window.matchMedia("(hover:hover) and (pointer:fine)").matches && !("ontouchstart" in window);

// The event stream names the open chat only while the app is on screen: a background tab or a phone in the
// pocket no longer counts as reading it, and the agent takes Teams back to the self chat
const onVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const visibleNow = () => document.visibilityState === "visible";

// red: the count of missed calls, the only red one
function CountBadge({ n, red }: { n: number; red?: boolean }) {
  if (!n) return null;
  return (
    <span
      className={cn(
        "ml-1 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-[0.6875rem] font-semibold tabular-nums",
        red ? "bg-destructive text-white" : "bg-primary text-primary-foreground",
      )}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

// The number of what waits on the icon of the installed app (Badging API, Chrome and Edge)
type BadgeNavigator = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

// Sign in to Microsoft: in the remote browser, or, for an account checked every N hours, with a check that waits for it
function SignInButton({
  a,
  onDesktop,
  onCheck,
  ...props
}: { a: Account; onDesktop: (n: number) => void; onCheck: (a: Account) => void } & Omit<React.ComponentProps<typeof Button>, "onClick">) {
  const checked = idleChecked(a);
  return (
    <Button {...props} disabled={checked && a.nextCheck === 0} onClick={() => (checked ? onCheck(a) : onDesktop(a.slot))}>
      {checked ? <PowerIcon /> : <ExternalLinkIcon />}
      {checked ? (a.nextCheck === 0 ? "Check asked" : "Start to sign in") : "Sign in to Microsoft"}
    </Button>
  );
}

export function App({ user, desktopUrl }: { user: User; desktopUrl: string }) {
  const [acc, setAcc] = useState(0);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [limits, setLimits] = useState({ max: 4, free: 0 });
  const [listTab, setListTab] = useState<ListTab>("chats");
  const [pane, setPane] = useState<"main" | "desktop">("main");
  const [openChat, setOpenChat] = useState<string | null>(null);
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [messages, setMessages] = useState<{ chat: string; rows: Message[] } | null>(null);
  const [activity, setActivity] = useState<{ ts: number; items: ActivityItem[] } | null>(null);
  const [callLog, setCallLog] = useState<CallLogEntry[] | null>(null);
  // the calls ringing now in every account of the user, whichever is on screen, and the calls in progress (active)
  const [calls, setCalls] = useState<RingingCall[]>([]);
  const [seenAct, setSeenAct] = useState<Record<number, string[]>>({});
  // the notifications of the account seen here when the Calls list opened: its missed calls not seen then keep their
  // dot while it stays open, and the ones of the new account when the account changes under it
  const [callsSeen, setCallsSeen] = useState<{ acc: number; seen: string[] | null } | null>(null);
  // streams opened again after the browser gave one up
  const [reconnects, setReconnects] = useState(0);
  const [health, setHealth] = useState<Health | null>(null);
  const [pushOff, setPushOff] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deskOpened, setDeskOpened] = useState(false);
  const [adding, setAdding] = useState(false);
  // the token of an account on another computer just added, shown once, with the address of the server its relay joins
  const [relayToken, setRelayToken] = useState<{ token: string; server: string } | null>(null);
  const [toggling, setToggling] = useState(0);
  const [removing, setRemoving] = useState<Account | null>(null);
  const isPc = useSyncExternalStore(noSubscribe, isPcNow, () => false);
  // the Android app opened this server: the account menu offers Change server
  const appPage = useAppStart();
  const onScreen = useSyncExternalStore(onVisibility, visibleNow, () => true);

  const deskUrl = useCallback((n: number) => desktopUrl.replace("{n}", String(n)), [desktopUrl]);

  // the ring of the calls: learns at once whether the page may play sound, else the first click allows it
  const [ringer] = useState(() => (typeof window === "undefined" ? null : new Ringer()));
  useEffect(() => {
    if (!ringer) return;
    ringer.attach(document);
    return () => ringer.close();
  }, [ringer]);

  // switching account drops everything that belonged to the previous one
  const accRef = useRef(0);
  const accountsRef = useRef<Account[]>([]);
  const switchTo = useCallback((n: number) => {
    if (accRef.current === n) return;
    accRef.current = n;
    setAcc(n);
    setOpenChat(null);
    setChats(null);
    setMessages(null);
    setActivity(null);
    setCallLog(null);
    setHealth(null);
    setDeskOpened(false);
    setPane("main");
  }, []);

  // activity ids already seen, per account and device: the first feed of an account counts as seen, later ones only
  // while their list is on screen (the Notifications list marks all but the missed calls, the Calls list those)
  const listRef = useRef<ListTab>("chats");
  useEffect(() => {
    listRef.current = listTab;
  }, [listTab]);
  const noteActivity = useCallback((n: number, d: { ts: number; items: ActivityItem[] }, list: ListTab) => {
    setActivity(d);
    const a = accountsRef.current.find((x) => x.slot === n);
    if (!a || !d.ts) return; // account list not in yet (it comes first on the stream), or Teams feed not read yet
    const { stored, seen } = noteShown(a, d.items, list);
    // the Calls list open while the account changes: its dots compare with what the new account had seen
    if (list === "calls") setCallsSeen((s) => callsSnapshot(s, n, stored));
    setSeenAct((all) => ({ ...all, [n]: seen }));
  }, []);

  const selectAccount = useCallback(
    (n: number) => {
      switchTo(n);
      if (n) writeStorage("acc", String(n));
    },
    [switchTo],
  );

  const applyAccounts = useCallback(
    (d: { accounts: Account[]; max: number; free: number }) => {
      accountsRef.current = d.accounts;
      setAccounts(d.accounts);
      setLimits({ max: d.max, free: d.free });
      // the account menu counts the notifications of every account, not only of the selected one
      setSeenAct(loadSeen(d.accounts));
      if (d.accounts.some((a) => a.slot === accRef.current)) return;
      const saved = Number(readStorage("acc")) || 0;
      const pick = d.accounts.find((a) => a.slot === saved) ?? d.accounts[0];
      switchTo(pick ? pick.slot : 0);
    },
    [switchTo],
  );

  const loadAccounts = useCallback(async () => {
    try {
      applyAccounts(await call<{ accounts: Account[]; max: number; free: number }>("/api/accounts", undefined, 0));
    } catch {
      // the event stream retries
    }
  }, [applyAccounts]);

  // first load: an account asked for in the URL (tap on a notification) wins over the remembered one, and the start page
  // of the Android app (app=) is kept before the address is cleaned. The account list itself arrives with the first
  // event of the stream.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const want = Number(q.get("a")) || 0;
    if (want) writeStorage("acc", String(want));
    keepAppStart(appStart(window.location.search));
    if (want || q.has("app")) window.history.replaceState(null, "", "/");
  }, []);

  // server-sent events: account list, health, chats, activity and the open chat, pushed on change
  useEffect(() => {
    const qs = new URLSearchParams();
    if (acc) qs.set("a", String(acc));
    if (acc && openChat && onScreen) qs.set("chat", openChat);
    const es = new EventSource(`/api/events?${qs}`);
    const on = <T,>(name: string, fn: (d: T) => void) => es.addEventListener(name, (e) => fn(JSON.parse((e as MessageEvent).data)));
    // a stream opened for another account (first load, or a switch in progress) still delivers a few events:
    // they must not land on the account now selected
    const own = <T,>(fn: (d: T) => void) => (d: T) => {
      if (accRef.current === acc) fn(d);
    };
    on("accounts", applyAccounts);
    on<RingingCall[]>("calls", setCalls);
    on<Health>("health", own(setHealth));
    on<Chat[]>("chats", own(setChats));
    on<{ ts: number; items: ActivityItem[] }>("activity", own((d) => noteActivity(acc, d, listRef.current)));
    on<CallLogEntry[]>("calllog", own(setCallLog));
    on<{ chat: string; rows: Message[] }>("messages", own(setMessages));
    let retry: ReturnType<typeof setTimeout> | undefined;
    es.onerror = () => {
      // without the stream no call is known to ring: the ring stops until it is back
      setCalls([]);
      // a stream refused with 401 means the session is over
      void fetch("/api/accounts", { credentials: "same-origin" }).then((r) => {
        if (r.status === 401) toLogin();
      });
      // the browser gives up on a stream answered with an error (502 while the web app restarts): open it again
      if (es.readyState === EventSource.CLOSED) retry = setTimeout(() => setReconnects((n) => n + 1), 5000);
    };
    return () => {
      clearTimeout(retry);
      es.close();
    };
  }, [acc, openChat, onScreen, applyAccounts, noteActivity, reconnects]);

  // notification tapped while the app is open: switch to the account it comes from. A message that alerts: the service
  // worker asks whether this page rings the bell, and shows the notification quiet when it does (sw.js)
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "bell") {
        void (ringer && bellOn() ? ringer.bell() : Promise.resolve(false)).then((played) => e.ports[0]?.postMessage({ played }));
        return;
      }
      const n = Number(e.data?.acc);
      if (n) selectAccount(n);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [selectAccount, ringer]);

  useEffect(() => {
    void pushState().then((s) => setPushOff(s === "off"));
  }, []);

  async function turnOnPush() {
    try {
      await enablePush();
      setPushOff(false);
      toast.success("Notifications enabled on this device");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Notifications not enabled");
    }
  }

  async function refreshActivity() {
    // an account checked every N hours: its feed is the one of the last check
    if (!acc || refreshing || (current && current.checkEvery > 0)) return;
    setRefreshing(true);
    // while Teams starts the agent keeps the refresh until its side bar can be clicked, up to the 2 minutes a command
    // may wait
    const r = await runCmd("/api/activity/refresh", undefined, acc, 175);
    setRefreshing(false);
    if (r.status !== "done") toast.error("Teams activity not updated");
  }

  // the missed calls come from the Teams Activity feed too: both lists read it again when they open
  function showList(t: ListTab) {
    setPane("main");
    setListTab(t);
    if (t !== "chats") {
      if (t === "calls") setCallsSeen({ acc, seen: seenAct[acc] ?? null });
      if (activity) noteActivity(acc, activity, t);
      void refreshActivity();
    }
  }

  // Microsoft login (and MFA) in the remote browser of the account: new tab on a PC, a view of its own elsewhere
  function openDesktop(n: number) {
    const a = accounts?.find((x) => x.slot === n);
    if (a?.relay) {
      toast.info("This account runs on another computer", { description: `Its Teams window is on ${relayHost(a)}: sign in there.` });
      return;
    }
    if (a?.stopped) {
      toast.info("This account is stopped", { description: "Start it (Start on its page, or a status in Settings) to open its remote Teams." });
      return;
    }
    if (a && idleChecked(a)) {
      toast.info("This account runs only during its checks", { description: "Check now starts its browser for a few minutes." });
      return;
    }
    if (isPc) {
      window.open(deskUrl(n), "_blank", "noopener");
      return;
    }
    selectAccount(n);
    setPane("desktop");
    setDeskOpened(true);
  }

  // Answer from the app: the remote desktop, which carries the sound, opens at once (a window opened after the request
  // would count as a popup), and the agent clicks Accept with audio in Teams within a second
  function answerCall(c: RingingCall) {
    openDesktop(c.acc);
    post("/api/call/answer", { since: c.since }, c.acc).catch((e: unknown) =>
      toast.error("Call not answered", { description: e instanceof ApiError ? e.message : "The server could not be reached" }),
    );
  }

  async function hangUpCall(c: RingingCall) {
    const r = await runCmd("/api/call/hangup", {}, c.acc, 15);
    if (r.status !== "done") toast.error("Call not ended", { description: "End it in Teams, in the remote desktop of the account." });
  }

  async function addAccount() {
    setAdding(true);
    try {
      const r = await post<{ slot: number }>("/api/accounts", undefined, 0);
      await loadAccounts();
      selectAccount(r.slot);
      toast.success("Browser starting", { description: "Sign in to Microsoft as soon as the account shows the button, within two minutes." });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Account not added");
    } finally {
      setAdding(false);
    }
  }

  // An account whose browser runs on another computer: its relay joins with the token shown once
  async function addRelayAccount() {
    setAdding(true);
    try {
      const r = await post<{ slot: number; token: string; server: string }>("/api/accounts", { relay: true }, 0);
      await loadAccounts();
      selectAccount(r.slot);
      setRelayToken({ token: r.token, server: r.server });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Account not added");
    } finally {
      setAdding(false);
    }
  }

  // Stop keeps the Microsoft session: the account only stops reading Teams and sending notifications
  async function setRunning(a: Account, running: boolean) {
    setToggling(a.slot);
    try {
      await call(`/api/accounts/${a.slot}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ running }) }, 0);
      await loadAccounts();
      if (running) toast.success(`${accName(a)} started`, { description: "Teams is back within a couple of minutes." });
      else toast.success(`${accName(a)} stopped`, { description: "Still signed in. No new messages or notifications until you start it again." });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : running ? "Account not started" : "Account not stopped");
    } finally {
      setToggling(0);
    }
  }

  // The check of an account checked every N hours, now: within seconds, after the check running now if any. One that
  // found a sign-in to do waits ten minutes for it, in the remote Teams.
  async function checkNow(a: Account) {
    try {
      await post(`/api/accounts/${a.slot}/check`, undefined, 0);
      await loadAccounts();
      toast.success(`Checking ${accName(a)}`, {
        description: needsLogin(a) ? "The browser starts: sign in to Microsoft in the remote Teams within ten minutes." : "The browser starts, reads Teams and stops again within a few minutes.",
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Check not started");
    }
  }

  async function removeAccount(a: Account) {
    const id = toast.loading(`Removing ${accName(a)}…`);
    try {
      await call(`/api/accounts/${a.slot}`, { method: "DELETE" }, 0);
      await loadAccounts();
      toast.success("Account removed", { id });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Account not removed", { id });
    }
  }

  // the chat of the list an activity item belongs to: same name, or the only one that shares its beginning
  function resolveActivity(a: ActivityItem): string | null {
    if (!a.chat || a.kind === "meeting") return null;
    const list = chats ?? [];
    const exact = list.find((c) => c.name === a.chat);
    if (exact) return exact.name;
    const prefix = list.filter((c) => c.name.startsWith(a.chat) || a.chat.startsWith(c.name));
    return prefix.length === 1 ? prefix[0].name : null;
  }

  // a call of the list opens the chat of the same name
  const chatOf = (name: string) => (chats ?? []).find((c) => c.name === name)?.name ?? null;

  const current = accounts?.find((a) => a.slot === acc);
  const unreadChats = (chats ?? []).filter((c) => c.unread && !c.muted && !isSelf(c.name)).length;
  const unreadActivity = unseenActivity(activity?.items ?? [], seenAct[acc] ?? null);
  const unreadCalls = unseenCalls(activity?.items ?? [], seenAct[acc] ?? null);
  // what waits in each account, for the account menu: the selected one counts what its tabs show
  const unreadOf = (a: Account): Unread =>
    a.slot === acc && !a.stopped ? { chats: unreadChats, notifications: unreadActivity, calls: unreadCalls } : accountUnread(a, seenAct[a.slot] ?? null);
  const others = unreadInOthers(accounts ?? [], acc, unreadOf);
  const otherCalls = (accounts ?? []).reduce((n, a) => (a.slot === acc ? n : n + unreadOf(a).calls), 0);

  // what waits in every account on the icon of the installed app; set again when the app comes back on screen, where
  // the service worker may have put a dot meanwhile
  const badge = accounts ? appBadgeCount(accounts, unreadOf) : null;
  useEffect(() => {
    const nav = navigator as BadgeNavigator;
    if (badge === null || !nav.setAppBadge) return;
    void (badge ? nav.setAppBadge(badge) : nav.clearAppBadge?.())?.catch(() => undefined);
  }, [badge, onScreen]);
  // and in the title of the page, for the tab and the taskbar
  useEffect(() => {
    if (badge !== null) document.title = pageTitle(badge);
  }, [badge]);
  const canAdd = !!accounts && accounts.length < limits.max && limits.free > 0;
  const addLabel = canAdd ? "Add a Teams account" : accounts && accounts.length >= limits.max ? `At most ${limits.max} accounts` : "No free slot on this server";
  const noAccounts = !!accounts && !accounts.length;
  // the account on screen, while it was never signed in to Microsoft: an account still being added
  const beingAdded = current && !current.relay && !signedInOnce(current) ? current : null;
  // on a phone the list and the chat (or the remote desktop) take the whole screen in turn
  const phoneShowsMain = pane === "desktop" || !!openChat;

  const tabs: { id: ListTab | "desktop"; label: string; icon: React.ComponentType<{ className?: string }>; count: number; red?: boolean }[] = [
    { id: "chats", label: "Chats", icon: MessageSquareIcon, count: unreadChats },
    { id: "activity", label: "Notifications", icon: BellIcon, count: unreadActivity },
    { id: "calls", label: "Calls", icon: PhoneIcon, count: unreadCalls, red: true },
    // the Teams window of an account on another computer is there
    ...(!isPc && !current?.relay ? [{ id: "desktop" as const, label: "Desktop", icon: MonitorIcon, count: 0 }] : []),
  ];
  const activeTab = pane === "desktop" ? "desktop" : listTab;
  const selectTab = (t: string) => (t === "desktop" ? acc && openDesktop(acc) : showList(t as ListTab));

  const phoneNav = (
    <nav className="grid shrink-0 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => {
            setOpenChat(null);
            selectTab(t.id);
          }}
          aria-current={activeTab === t.id ? "page" : undefined}
          className={cn(
            "relative flex h-14 flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium text-muted-foreground transition-colors outline-none focus-visible:bg-accent",
            activeTab === t.id && "text-primary",
          )}
        >
          <span className="relative">
            <t.icon className="size-5" />
            {t.count > 0 && (
              <span
                className={cn(
                  "absolute -top-1.5 -right-2.5 min-w-4 rounded-full px-1 text-center text-[0.625rem] leading-4 font-semibold tabular-nums",
                  t.red ? "bg-destructive text-white" : "bg-primary text-primary-foreground",
                )}
              >
                {t.count > 99 ? "99+" : t.count}
              </span>
            )}
          </span>
          {t.label}
        </button>
      ))}
    </nav>
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <CallBanner
        calls={calls}
        accounts={accounts}
        ringer={ringer}
        onSelect={selectAccount}
        onAnswer={answerCall}
        onHangUp={(c) => void hangUpCall(c)}
        onDesktop={openDesktop}
      />
      <aside className={cn("flex w-full shrink-0 flex-col border-r bg-sidebar md:w-[22rem] xl:w-[25rem]", phoneShowsMain && "max-md:hidden")}>
        <div className="flex items-center gap-1 px-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-2 md:pt-2">
          <AccountMenu
            user={user}
            accounts={accounts}
            current={current}
            unreadOf={unreadOf}
            others={others}
            canAdd={canAdd}
            addLabel={addLabel}
            adding={adding}
            onSelect={selectAccount}
            onAdd={() => void addAccount()}
            onAddRelay={() => void addRelayAccount()}
            onOpenDesktop={openDesktop}
            onRemove={setRemoving}
            onSignOut={() => void authClient.signOut().then(toLogin)}
            appPage={appPage}
          />
          <StatusPanel
            acc={acc}
            accountName={current ? accName(current) : ""}
            health={health}
            pushOff={pushOff}
            onEnablePush={() => void turnOnPush()}
            onOpenDesktop={() => acc && openDesktop(acc)}
          />
        </div>

        {!noAccounts && (
          <Tabs value={activeTab} onValueChange={selectTab} className="px-3 pb-2 max-md:hidden">
            <TabsList className="h-9 w-full">
              {tabs.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="gap-1.5">
                  <t.icon />
                  {t.label}
                  <CountBadge n={t.count} red={t.red} />
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}

        {current?.stopped && (
          <div className="px-3 pb-2">
            <Alert>
              <PowerOffIcon />
              <AlertTitle>This account is stopped</AlertTitle>
              <AlertDescription>
                <p>Still signed in to Microsoft. The chats are the last ones read: no new messages or notifications until you start it.</p>
                <Button size="sm" className="mt-2 h-9 md:h-8" disabled={toggling === current.slot} onClick={() => void setRunning(current, true)}>
                  {toggling === current.slot ? <Spinner /> : <PowerIcon />}
                  Start
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}
        {current && idleChecked(current) && !needsLogin(current) && (
          <div className="px-3 pb-2">
            <Alert>
              <ClockIcon />
              <AlertTitle>Checked every {hours(current.checkEvery)}</AlertTitle>
              <AlertDescription>
                <p>{checkLine(current)}. The chats and counts are those of the last check: the browser runs only during a check.</p>
                <Button size="sm" className="mt-2 h-9 md:h-8" disabled={current.nextCheck === 0} onClick={() => void checkNow(current)}>
                  <RefreshCwIcon />
                  {current.nextCheck === 0 ? "Check asked" : "Check now"}
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}
        {current?.checking && current.teams !== "login" && (
          <div className="px-3 pb-2">
            <Alert>
              <Spinner />
              <AlertTitle>Checking now</AlertTitle>
              <AlertDescription>The browser reads the chats and the notifications of Teams, then stops again.</AlertDescription>
            </Alert>
          </div>
        )}
        {current?.relay && (needsLogin(current) || relayOffline(current)) && (
          <div className="px-3 pb-2">
            {needsLogin(current) ? (
              <Alert className="border-warning/40 bg-warning/10">
                <TriangleAlertIcon className="text-warning" />
                <AlertTitle>Microsoft sign-in needed</AlertTitle>
                <AlertDescription>Sign in with password and MFA in the TeamsRelay window on {relayHost(current)}.</AlertDescription>
              </Alert>
            ) : (
              <Alert>
                <LaptopIcon />
                <AlertTitle>{current.relaySeen ? `Relay on ${relayHost(current)} not connected` : "Waiting for the relay of the other computer"}</AlertTitle>
                <AlertDescription>
                  {current.relaySeen
                    ? `Last sync at ${clock(current.relaySeen)}: the chats are those it sent then. Start the relay again on that computer.`
                    : "Start the relay on the other computer with the two lines of relay.env shown when the account was added."}
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}
        {current && !current.relay && (needsLogin(current) || (current.teams === "starting" && !current.checking)) && (
          <div className="px-3 pb-2">
            {current.teams === "starting" && !current.checking ? (
              <Alert>
                <Spinner />
                <AlertTitle>Starting the browser</AlertTitle>
                <AlertDescription>It takes up to two minutes, then sign in to Microsoft.</AlertDescription>
              </Alert>
            ) : (
              <Alert className="border-warning/40 bg-warning/10">
                <TriangleAlertIcon className="text-warning" />
                <AlertTitle>{signedInOnce(current) ? "Microsoft sign-in needed" : addingTitle(accounts ?? [])}</AlertTitle>
                <AlertDescription>
                  {idleChecked(current) ? (
                    <p>
                      Found by the check{current.checked ? ` of ${clock(current.checked)}` : ""}. Start a check: its browser waits ten minutes for the
                      sign-in, with password and MFA in the remote Teams.
                    </p>
                  ) : signedInOnce(current) ? (
                    <p>Sign in with password and MFA in the remote browser of this account.</p>
                  ) : (
                    <p>Sign in to Microsoft with password and MFA in the remote browser of this account: its chats show up within a minute.</p>
                  )}
                  <SignInButton a={current} size="sm" className="mt-2 h-9 md:h-8" onDesktop={openDesktop} onCheck={(a) => void checkNow(a)} />
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}
        {pushOff && !noAccounts && (
          <div className="px-3 pb-2">
            <div className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-sm">
              <BellRingIcon className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 text-muted-foreground">Notifications are off on this device</span>
              <Button size="sm" variant="secondary" className="h-9 md:h-7" onClick={() => void turnOnPush()}>
                Enable
              </Button>
            </div>
          </div>
        )}
        <RingHint ringer={ringer} show={!!accounts?.some((a) => !a.stopped)} />

        {noAccounts ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessagesSquareIcon />
              </EmptyMedia>
              <EmptyTitle>No Teams account yet</EmptyTitle>
              <EmptyDescription>Add an account, then sign in to Microsoft in its remote browser. Chats show up within a minute.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button className="h-10 md:h-9" disabled={!canAdd || adding} onClick={() => void addAccount()}>
                {adding ? <Spinner /> : <PlusIcon />}
                {adding ? "Starting the browser…" : addLabel}
              </Button>
              {canAdd && (
                <Button variant="outline" className="h-10 md:h-9" disabled={adding} onClick={() => void addRelayAccount()}>
                  <LaptopIcon />
                  Add from another computer
                </Button>
              )}
            </EmptyContent>
          </Empty>
        ) : listTab === "activity" ? (
          <Activity
            acc={acc}
            feed={acc ? activity : { ts: 0, items: [] }}
            refreshing={refreshing}
            onRefresh={() => void refreshActivity()}
            resolve={resolveActivity}
            onOpenChat={(c) => {
              setPane("main");
              setOpenChat(c);
            }}
          />
        ) : listTab === "calls" ? (
          <Calls
            acc={acc}
            ringing={calls.find((c) => c.acc === acc && !c.active)}
            missed={acc ? (activity?.items ?? []).filter(isMissedCall) : []}
            log={acc ? (callLog ?? []) : []}
            seen={callsSeen?.acc === acc ? callsSeen.seen : (seenAct[acc] ?? null)}
            chatOf={chatOf}
            onOpenChat={(c) => {
              setPane("main");
              setOpenChat(c);
            }}
          />
        ) : (
          <ChatList acc={acc} chats={acc ? chats : []} selected={openChat} onOpen={(c) => {
            setPane("main");
            setOpenChat(c);
          }} />
        )}
        {phoneNav}
      </aside>

      <main className={cn("min-w-0 flex-1 flex-col", phoneShowsMain ? "flex" : "hidden md:flex")}>
        {deskOpened && acc > 0 && (
          <div className={cn("min-h-0 flex-1 flex-col bg-background", pane === "desktop" ? "flex" : "hidden")}>
            <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3 max-md:h-[calc(3rem+env(safe-area-inset-top))] max-md:pt-[env(safe-area-inset-top)]">
              <MonitorIcon className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">Remote Teams · {current ? accName(current) : ""}</span>
              <Button asChild variant="ghost" size="sm" className="h-9 md:h-8">
                <a href={deskUrl(acc)} target="_blank" rel="noopener">
                  <ExternalLinkIcon />
                  Full screen
                </a>
              </Button>
            </div>
            {/* the microphone for a call answered here, also where DESKTOP_URL is another origin */}
            <iframe src={deskUrl(acc)} title="Remote Teams desktop" allow="microphone; autoplay" className="min-h-0 w-full flex-1 border-0" />
          </div>
        )}
        {pane === "main" &&
          (openChat && acc > 0 ? (
            <Conversation
              key={`${acc}:${openChat}`}
              acc={acc}
              chat={openChat}
              entry={(chats ?? []).find((c) => c.name === openChat)}
              rows={messages?.chat === openChat ? messages.rows : null}
              stopped={!!current && (current.stopped || current.checkEvery > 0)}
              stoppedText={current?.checkEvery && !current.stopped ? "Runs only during its checks: set it to always on in Settings to send" : undefined}
              others={others}
              otherCalls={otherCalls}
              onBack={() => setOpenChat(null)}
              onOpenDesktop={() => openDesktop(acc)}
            />
          ) : (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessagesSquareIcon />
                </EmptyMedia>
                <EmptyTitle>{noAccounts ? "Welcome to TeamsRelay" : beingAdded ? addingTitle(accounts ?? []) : "Select a conversation"}</EmptyTitle>
                <EmptyDescription>
                  {noAccounts
                    ? "Add your first Teams account from the panel on the left."
                    : beingAdded
                      ? "Sign in to Microsoft in the remote browser of this account, with password and MFA: its chats show up here within a minute."
                      : `The chats of ${current ? accName(current) : "this account"} are on the left. Messages you send here go out from Teams.`}
                </EmptyDescription>
              </EmptyHeader>
              {beingAdded && needsLogin(beingAdded) && (
                <EmptyContent>
                  <SignInButton a={beingAdded} className="h-10 md:h-9" onDesktop={openDesktop} onCheck={(a) => void checkNow(a)} />
                </EmptyContent>
              )}
            </Empty>
          ))}
        {pane === "desktop" && phoneNav}
      </main>

      <RelayTokenDialog token={relayToken?.token ?? null} server={relayToken?.server ?? ""} onClose={() => setRelayToken(null)} />
      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing ? accName(removing) : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.relay
                ? `The data of this account on this server is deleted and its relay token stops working. The relay on ${relayHost(removing)} keeps its own Teams session until it is stopped there.`
                : "The Teams session and the data of this account on TeamsRelay are deleted. The Microsoft account itself is not touched, and it can be added again later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removing && void removeAccount(removing)}>
              Remove account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
