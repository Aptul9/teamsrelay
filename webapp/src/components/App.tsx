"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Activity } from "./Activity";
import { Avatar, Logo } from "./Avatar";
import { ChatList } from "./ChatList";
import { Conversation } from "./Conversation";
import { authClient } from "@/lib/auth-client";
import {
  ago,
  ApiError,
  avColor,
  call,
  isSelf,
  markActivitySeen,
  parseSeen,
  post,
  readStorage,
  runCmd,
  toLogin,
  unseenActivity,
  writeStorage,
  type Account,
  type ActivityItem,
  type Chat,
  type Health,
  type Message,
} from "@/lib/client";

type Tab = "activity" | "chats" | "desktop";
type User = { name: string; email: string; role: string };

const COLOR: Record<string, string> = { green: "var(--green)", yellow: "var(--yellow)", red: "var(--red)" };
const pillColor = (st?: string) =>
  st === "ok" ? "var(--green)" : st === "login" || st === "err" || st === "no" || st === "stale" ? "var(--red)" : "var(--yellow)";

const accName = (a: Account) => a.name || a.email || `Account ${a.slot}`;
const needsLogin = (a: Account) => a.teams === "login" || (a.teams !== "starting" && a.teams !== "ok" && !a.name);
function accSub(a: Account): [string, string] {
  if (a.teams === "starting") return ["Starting the browser…", ""];
  if (a.teams === "login") return ["Microsoft sign-in needed", "warn"];
  if (!a.name) return ["Waiting for sign-in…", ""];
  if (a.teams === "unknown") return ["Browser unreachable", "warn"];
  return [[a.email, a.tenant].filter(Boolean).join(" · "), ""];
}

// On a PC (mouse, no touch) the Desktop tab is not needed: the remote desktop opens in a browser tab
const noSubscribe = () => () => {};
const isPcNow = () => window.matchMedia("(hover:hover) and (pointer:fine)").matches && !("ontouchstart" in window);

function urlB64ToUint8(s: string) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a;
}

export function App({ user, desktopUrl }: { user: User; desktopUrl: string }) {
  const [acc, setAcc] = useState(0);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [limits, setLimits] = useState({ max: 4, free: 0 });
  const [tab, setTab] = useState<Tab>("chats");
  const [openChat, setOpenChat] = useState<string | null>(null);
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [messages, setMessages] = useState<{ chat: string; rows: Message[] } | null>(null);
  const [activity, setActivity] = useState<{ ts: number; items: ActivityItem[] } | null>(null);
  const [seenAct, setSeenAct] = useState<string[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [panel, setPanel] = useState<"none" | "status" | "accounts">("none");
  const [toastText, setToastText] = useState("");
  const [pushOff, setPushOff] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deskOpened, setDeskOpened] = useState(false);
  const isPc = useSyncExternalStore(noSubscribe, isPcNow, () => false);
  const [adding, setAdding] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const deskUrl = useCallback((n: number) => desktopUrl.replace("{n}", String(n)), [desktopUrl]);
  const toast = useCallback((t: string) => {
    setToastText(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(""), 3500);
  }, []);

  // switching account drops everything that belonged to the previous one
  const accRef = useRef(0);
  const switchTo = useCallback((n: number) => {
    if (accRef.current === n) return;
    accRef.current = n;
    setAcc(n);
    setOpenChat(null);
    setChats(null);
    setMessages(null);
    setActivity(null);
    setSeenAct(null);
    setHealth(null);
    setDeskOpened(false);
  }, []);

  // activity ids already seen in the Notifications tab, per account and device: the first feed of an account
  // counts as seen, later ones only while the tab is on screen
  const tabRef = useRef<Tab>("chats");
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  const noteActivity = useCallback((n: number, d: { ts: number; items: ActivityItem[] }, looking: boolean) => {
    setActivity(d);
    if (!n || !d.ts) return; // the agent has not read the Teams feed yet
    const key = `actseen:${n}`;
    const stored = parseSeen(readStorage(key));
    const seen = stored && !looking ? stored : markActivitySeen(stored, d.items);
    if (seen !== stored) writeStorage(key, JSON.stringify(seen));
    setSeenAct(seen);
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
      setAccounts(d.accounts);
      setLimits({ max: d.max, free: d.free });
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
    if (acc && openChat) qs.set("chat", openChat);
    const es = new EventSource(`/api/events?${qs}`);
    const on = <T,>(name: string, fn: (d: T) => void) => es.addEventListener(name, (e) => fn(JSON.parse((e as MessageEvent).data)));
    on("accounts", applyAccounts);
    on<Health>("health", setHealth);
    on<Chat[]>("chats", setChats);
    on<{ ts: number; items: ActivityItem[] }>("activity", (d) => noteActivity(acc, d, tabRef.current === "activity"));
    on<{ chat: string; rows: Message[] }>("messages", setMessages);
    es.onerror = () => {
      // a stream refused with 401 means the session is over
      void fetch("/api/accounts", { credentials: "same-origin" }).then((r) => {
        if (r.status === 401) toLogin();
      });
    };
    return () => es.close();
  }, [acc, openChat, applyAccounts, noteActivity]);

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
    (async () => {
      if (!("serviceWorker" in navigator)) return setPushOff(true);
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        setPushOff(!(await reg.pushManager.getSubscription()));
      } catch {
        setPushOff(true);
      }
    })();
  }, []);

  async function enablePush() {
    try {
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || (!standalone && /iPhone|iPad/i.test(navigator.userAgent))) {
        alert('On iPhone notifications work only in the installed app: Share, "Add to Home Screen", open TeamsRelay from there and try again.');
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      if ((await Notification.requestPermission()) !== "granted") return alert("Notification permission denied.");
      const { key } = await call<{ key: string }>("/api/vapidkey", undefined, 0);
      if (!key) return alert("Push keys are not configured on the server.");
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) }));
      await post("/api/push/subscribe", sub.toJSON(), 0);
      setPushOff(false);
      toast("Notifications enabled");
    } catch (e) {
      alert(`Notification error: ${e}`);
    }
  }

  function show(t: Tab) {
    setTab(t);
    if (t === "desktop") setDeskOpened(true);
    if (t === "activity") {
      if (activity) noteActivity(acc, activity, true);
      void refreshActivity();
    }
  }

  async function refreshActivity() {
    if (!acc || refreshing) return;
    setRefreshing(true);
    const r = await runCmd("/api/activity/refresh", undefined, acc);
    setRefreshing(false);
    if (r.status !== "done") toast("Teams activity not updated");
  }

  // Microsoft login (and MFA) in the remote browser of the account: new tab on a PC, Desktop tab on a phone
  function openDesktop(n: number) {
    setPanel("none");
    if (isPc) {
      window.open(deskUrl(n), "_blank");
      return;
    }
    selectAccount(n);
    setTab("desktop");
    setDeskOpened(true);
  }

  async function addAccount() {
    setAdding(true);
    try {
      const r = await post<{ slot: number }>("/api/accounts", undefined, 0);
      await loadAccounts();
      selectAccount(r.slot);
      setPanel("accounts");
      toast('Browser starting: tap "Sign in to Microsoft" in a moment');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Account not added");
    } finally {
      setAdding(false);
    }
  }

  async function removeAccount(a: Account) {
    if (!confirm(`Remove ${accName(a)}?\n\nThe Teams session and the data of this account on TeamsRelay are deleted. The Microsoft account itself is not touched.`)) return;
    toast(`Removing ${accName(a)}…`);
    try {
      await call(`/api/accounts/${a.slot}`, { method: "DELETE" }, 0);
      await loadAccounts();
      toast("Account removed");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Account not removed");
    }
  }

  function openFromActivity(chat: string) {
    if (!chat) return toast("This one opens only in the remote Teams");
    const list = chats ?? [];
    const prefix = list.filter((x) => x.name.startsWith(chat) || chat.startsWith(x.name));
    const c = list.find((x) => x.name === chat) ?? (prefix.length === 1 ? prefix[0] : undefined);
    if (!c) return toast("Chat not found in the list");
    setTab("chats");
    setOpenChat(c.name);
  }

  const current = accounts?.find((a) => a.slot === acc);
  const unreadChats = (chats ?? []).filter((c) => c.unread && !c.muted && !isSelf(c.name)).length;
  const unreadActivity = unseenActivity(activity?.items ?? [], seenAct);
  const otherUnread = (accounts ?? []).some((a) => a.slot !== acc && a.unread > 0);
  const overall = health?.overall || "yellow";
  const canAdd = !!accounts && accounts.length < limits.max && limits.free > 0;

  return (
    <div className="shell">
      <header>
        <div className="brand">
          {accounts?.length ? (
            <button className="accbtn" onClick={() => setPanel(panel === "accounts" ? "none" : "accounts")} aria-label="Accounts">
              {current ? (
                <Avatar name={accName(current)} av={current.av} acc={current.slot} />
              ) : (
                <div className="av" style={{ background: avColor(user.name) }} />
              )}
              {otherUnread && <span className="accdot" />}
            </button>
          ) : (
            <div className="logo">
              <Logo />
            </div>
          )}
          <h1>{current ? current.tenant || accName(current) : "TeamsRelay"}</h1>
          <button className="status" onClick={() => setPanel(panel === "status" ? "none" : "status")}>
            <span className="sdot" style={{ background: COLOR[overall] }} />
            <span>{overall === "green" ? "Active" : overall === "red" ? "Problem" : "…"}</span>
          </button>
        </div>
        <div className="switch">
          <button className={tab === "activity" ? "on" : ""} onClick={() => show("activity")}>
            Notifications
            {unreadActivity > 0 && <span className="tabbadge">{unreadActivity}</span>}
          </button>
          <button className={tab === "chats" ? "on" : ""} onClick={() => show("chats")}>
            Chats
            {unreadChats > 0 && <span className="tabbadge">{unreadChats}</span>}
          </button>
          {!isPc && (
            <button className={tab === "desktop" ? "on" : ""} onClick={() => show("desktop")}>
              Desktop
            </button>
          )}
        </div>
        {current && needsLogin(current) && (
          <button className="loginbn" onClick={() => openDesktop(current.slot)}>
            Sign in to Microsoft to use this account
          </button>
        )}
        {pushOff && (
          <button className="pushbn" onClick={() => void enablePush()}>
            Enable notifications
          </button>
        )}
      </header>

      {panel === "status" && (
        <div className="spanel">
          <h3>System status</h3>
          {health ? (
            [
              ["Teams", health.teams === "ok" ? "Connected" : health.teams === "login" ? "Session expired" : health.teams === "unknown" ? "Unreachable" : health.teams === "starting" ? "Starting" : "Loading", pillColor(health.teams)],
              ["New message detection", health.watcher === "ok" ? "Running" : "Stopped", pillColor(health.watcher === "ok" ? "ok" : "warn")],
              ["Browser engine", health.agent === "ok" ? "Running" : "Not responding", pillColor(health.agent === "ok" ? "ok" : "err")],
              ["Last message", ago(health.last_msg_ts), pillColor(health.last_msg_ts ? "ok" : "warn")],
              ["Push notifications", `${health.push_subs ?? 0} device${health.push_subs === 1 ? "" : "s"}`, pillColor((health.push_subs ?? 0) > 0 ? "ok" : "warn")],
            ].map(([k, v, c]) => (
              <div key={k} className="hrow">
                <span className="pill" style={{ background: c }} />
                <div className="k">{k}</div>
                <div className="v">{v}</div>
              </div>
            ))
          ) : (
            <div className="hint">No account selected.</div>
          )}
          {acc > 0 && (
            <>
              <div className="sbtns">
                <button onClick={() => void post("/api/resync", undefined, acc).catch(() => toast("Resync failed"))}>Resync</button>
                <button onClick={() => void post("/api/recheck", undefined, acc).then(() => toast("Check started: the result arrives as a notification"), () => toast("Check failed"))}>
                  Recheck
                </button>
              </div>
              <div className="sbtns">
                <button onClick={() => openDesktop(acc)}>Open remote Teams (login, MFA)</button>
              </div>
            </>
          )}
        </div>
      )}

      {panel === "accounts" && (
        <div className="apanel">
          <h3>Accounts</h3>
          {(accounts ?? []).map((a) => {
            const [sub, cls] = accSub(a);
            return (
              <div key={a.slot}>
                <div
                  className={`arow${a.slot === acc ? " cur" : ""}`}
                  onClick={() => {
                    setPanel("none");
                    selectAccount(a.slot);
                  }}
                >
                  <Avatar name={accName(a)} av={a.av} acc={a.slot} />
                  <div className="rc">
                    <div className="an">{accName(a)}</div>
                    <div className={`as ${cls}`}>{sub}</div>
                  </div>
                  {a.unread > 0 && <span className="aun">{a.unread}</span>}
                  {a.slot === acc && <span className="check">✓</span>}
                </div>
                <div className="aact">
                  {a.teams !== "starting" && (
                    <button className={needsLogin(a) ? "go" : ""} onClick={() => openDesktop(a.slot)}>
                      {needsLogin(a) ? "Sign in to Microsoft" : "Remote Teams"}
                    </button>
                  )}
                  <button className="rm" onClick={() => void removeAccount(a)}>
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
          <button className="addacc" disabled={!canAdd || adding} onClick={() => void addAccount()}>
            {adding ? "Starting the browser…" : canAdd ? "+ Add account" : accounts && accounts.length >= limits.max ? `At most ${limits.max} accounts` : "No free slot on this server"}
          </button>
          <div className="alinks">
            <Link href="/settings">Settings</Link>
            {user.role === "admin" && <Link href="/admin">Users</Link>}
            <button onClick={() => void authClient.signOut().then(toLogin)}>Sign out</button>
          </div>
        </div>
      )}

      <main onClick={() => panel !== "none" && setPanel("none")}>
        {accounts && !accounts.length && (
          <div className="noacc">
            <b>No Teams account</b>
            <div>Add an account, then sign in to Microsoft in its remote desktop.</div>
            <button disabled={!canAdd || adding} onClick={() => void addAccount()}>
              {adding ? "Starting the browser…" : canAdd ? "+ Add account" : "No free slot on this server"}
            </button>
          </div>
        )}
        {tab === "activity" && (
          <div className="view">
            <Activity acc={acc} feed={activity} refreshing={refreshing} onOpenChat={openFromActivity} />
          </div>
        )}
        {tab === "chats" && (
          <div className="view">
            <ChatList acc={acc} chats={acc ? chats : []} onOpen={setOpenChat} />
            {openChat && acc > 0 && (
              <Conversation
                key={`${acc}:${openChat}`}
                acc={acc}
                chat={openChat}
                entry={(chats ?? []).find((c) => c.name === openChat)}
                rows={messages?.chat === openChat ? messages.rows : null}
                onBack={() => setOpenChat(null)}
                toast={toast}
              />
            )}
          </div>
        )}
        {deskOpened && acc > 0 && (
          <div className="view desk" style={{ display: tab === "desktop" ? "flex" : "none" }}>
            <div className="bar">
              <span>Teams desktop (remote control)</span>
              <a href={deskUrl(acc)} target="_blank" rel="noopener">
                Full screen
              </a>
            </div>
            <iframe src={deskUrl(acc)} title="Teams desktop" />
          </div>
        )}
      </main>
      {toastText && <div className="toast">{toastText}</div>}
    </div>
  );
}
