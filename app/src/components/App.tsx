"use client";

import { BellIcon, BellRingIcon, ExternalLinkIcon, MessageSquareIcon, MessagesSquareIcon, MonitorIcon, PlusIcon, PowerIcon, PowerOffIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { AccountMenu, accName, needsLogin } from "./AccountMenu";
import { Activity } from "./Activity";
import { ChatList } from "./ChatList";
import { Conversation } from "./Conversation";
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
import { authClient } from "@/lib/auth-client";
import {
  accountUnread,
  ApiError,
  call,
  isSelf,
  loadSeen,
  markActivitySeen,
  parseSeen,
  post,
  readStorage,
  runCmd,
  seenKey,
  toLogin,
  unreadInOthers,
  unseenActivity,
  writeStorage,
  type Account,
  type ActivityItem,
  type Chat,
  type Health,
  type Message,
  type Unread,
} from "@/lib/client";
import { enablePush, pushState } from "@/lib/push";

type ListTab = "chats" | "activity";
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

function CountBadge({ n }: { n: number }) {
  if (!n) return null;
  return <span className="ml-1 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-primary px-1 text-[0.6875rem] font-semibold text-primary-foreground tabular-nums">{n > 99 ? "99+" : n}</span>;
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
  const [seenAct, setSeenAct] = useState<Record<number, string[]>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const [pushOff, setPushOff] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deskOpened, setDeskOpened] = useState(false);
  const [adding, setAdding] = useState(false);
  const [toggling, setToggling] = useState(0);
  const [removing, setRemoving] = useState<Account | null>(null);
  const isPc = useSyncExternalStore(noSubscribe, isPcNow, () => false);
  const onScreen = useSyncExternalStore(onVisibility, visibleNow, () => true);

  const deskUrl = useCallback((n: number) => desktopUrl.replace("{n}", String(n)), [desktopUrl]);

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
    setHealth(null);
    setDeskOpened(false);
    setPane("main");
  }, []);

  // activity ids already seen in the Notifications list, per account and device: the first feed of an account
  // counts as seen, later ones only while the list is on screen
  const listRef = useRef<ListTab>("chats");
  useEffect(() => {
    listRef.current = listTab;
  }, [listTab]);
  const noteActivity = useCallback((n: number, d: { ts: number; items: ActivityItem[] }, looking: boolean) => {
    setActivity(d);
    const a = accountsRef.current.find((x) => x.slot === n);
    if (!a || !d.ts) return; // account list not in yet (it comes first on the stream), or Teams feed not read yet
    const key = seenKey(a);
    const stored = parseSeen(readStorage(key));
    const seen = stored && !looking ? stored : markActivitySeen(stored, d.items);
    if (seen !== stored) writeStorage(key, JSON.stringify(seen));
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

  // first load: an account asked for in the URL (tap on a notification) wins over the remembered one.
  // The account list itself arrives with the first event of the stream.
  useEffect(() => {
    const want = Number(new URLSearchParams(window.location.search).get("a")) || 0;
    if (want) {
      writeStorage("acc", String(want));
      window.history.replaceState(null, "", "/");
    }
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
    on<Health>("health", own(setHealth));
    on<Chat[]>("chats", own(setChats));
    on<{ ts: number; items: ActivityItem[] }>("activity", own((d) => noteActivity(acc, d, listRef.current === "activity")));
    on<{ chat: string; rows: Message[] }>("messages", own(setMessages));
    es.onerror = () => {
      // a stream refused with 401 means the session is over
      void fetch("/api/accounts", { credentials: "same-origin" }).then((r) => {
        if (r.status === 401) toLogin();
      });
    };
    return () => es.close();
  }, [acc, openChat, onScreen, applyAccounts, noteActivity]);

  // notification tapped while the app is open: switch to the account it comes from
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const n = Number(e.data?.acc);
      if (n) selectAccount(n);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [selectAccount]);

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
    if (!acc || refreshing) return;
    setRefreshing(true);
    const r = await runCmd("/api/activity/refresh", undefined, acc);
    setRefreshing(false);
    if (r.status !== "done") toast.error("Teams activity not updated");
  }

  function showList(t: ListTab) {
    setPane("main");
    setListTab(t);
    if (t === "activity") {
      if (activity) noteActivity(acc, activity, true);
      void refreshActivity();
    }
  }

  // Microsoft login (and MFA) in the remote browser of the account: new tab on a PC, a view of its own elsewhere
  function openDesktop(n: number) {
    if (accounts?.find((a) => a.slot === n)?.stopped) {
      toast.info("This account is stopped", { description: "Start it from the account menu to open its remote Teams." });
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

  const current = accounts?.find((a) => a.slot === acc);
  const unreadChats = (chats ?? []).filter((c) => c.unread && !c.muted && !isSelf(c.name)).length;
  const unreadActivity = unseenActivity(activity?.items ?? [], seenAct[acc] ?? null);
  // what waits in each account, for the account menu: the selected one counts what its tabs show
  const unreadOf = (a: Account): Unread =>
    a.slot === acc && !a.stopped ? { chats: unreadChats, notifications: unreadActivity } : accountUnread(a, seenAct[a.slot] ?? null);
  const others = unreadInOthers(accounts ?? [], acc, unreadOf);
  const canAdd = !!accounts && accounts.length < limits.max && limits.free > 0;
  const addLabel = canAdd ? "Add a Teams account" : accounts && accounts.length >= limits.max ? `At most ${limits.max} accounts` : "No free slot on this server";
  const noAccounts = !!accounts && !accounts.length;
  // on a phone the list and the chat (or the remote desktop) take the whole screen in turn
  const phoneShowsMain = pane === "desktop" || !!openChat;

  const tabs: { id: ListTab | "desktop"; label: string; icon: React.ComponentType<{ className?: string }>; count: number }[] = [
    { id: "chats", label: "Chats", icon: MessageSquareIcon, count: unreadChats },
    { id: "activity", label: "Notifications", icon: BellIcon, count: unreadActivity },
    ...(!isPc ? [{ id: "desktop" as const, label: "Desktop", icon: MonitorIcon, count: 0 }] : []),
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
              <span className="absolute -top-1.5 -right-2.5 min-w-4 rounded-full bg-primary px-1 text-center text-[0.625rem] leading-4 font-semibold text-primary-foreground tabular-nums">
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
            toggling={toggling}
            onSelect={selectAccount}
            onSetRunning={(a, running) => void setRunning(a, running)}
            onAdd={() => void addAccount()}
            onOpenDesktop={openDesktop}
            onRemove={setRemoving}
            onSignOut={() => void authClient.signOut().then(toLogin)}
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
                  <CountBadge n={t.count} />
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
        {current && (needsLogin(current) || current.teams === "starting") && (
          <div className="px-3 pb-2">
            {current.teams === "starting" ? (
              <Alert>
                <Spinner />
                <AlertTitle>Starting the browser</AlertTitle>
                <AlertDescription>It takes up to two minutes, then sign in to Microsoft.</AlertDescription>
              </Alert>
            ) : (
              <Alert className="border-warning/40 bg-warning/10">
                <TriangleAlertIcon className="text-warning" />
                <AlertTitle>Microsoft sign-in needed</AlertTitle>
                <AlertDescription>
                  <p>Sign in with password and MFA in the remote browser of this account.</p>
                  <Button size="sm" className="mt-2 h-9 md:h-8" onClick={() => openDesktop(current.slot)}>
                    <ExternalLinkIcon />
                    Sign in to Microsoft
                  </Button>
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
            <iframe src={deskUrl(acc)} title="Remote Teams desktop" className="min-h-0 w-full flex-1 border-0" />
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
              stopped={!!current?.stopped}
              others={others}
              onBack={() => setOpenChat(null)}
              onOpenDesktop={() => openDesktop(acc)}
            />
          ) : (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessagesSquareIcon />
                </EmptyMedia>
                <EmptyTitle>{noAccounts ? "Welcome to TeamsRelay" : "Select a conversation"}</EmptyTitle>
                <EmptyDescription>
                  {noAccounts
                    ? "Add your first Teams account from the panel on the left."
                    : `The chats of ${current ? accName(current) : "this account"} are on the left. Messages you send here go out from Teams.`}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ))}
        {pane === "desktop" && phoneNav}
      </main>

      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing ? accName(removing) : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              The Teams session and the data of this account on TeamsRelay are deleted. The Microsoft account itself is not touched, and it can be added again later.
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
