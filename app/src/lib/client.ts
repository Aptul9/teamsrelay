// Browser-side helpers of the PWA: API calls, command follow-up, formatting.

import { hasTeamsId, type ActivityItem } from "@/shared/slot-db/rows";

export type Account = {
  slot: number;
  name: string;
  email: string;
  tenant: string;
  av: string;
  teams: string;
  overall: string;
  stopped: boolean;
  unread: number;
  unreadActivity: string[] | null;
  missedCalls: string[] | null;
  // ids of every item of the feed, newest first: what an account met for the first time counts as seen
  activityIds: string[] | null;
  added: number;
  desktop: string;
  // checked every N hours (0: always on): seconds between two checks, end (0 before the first) and outcome of the
  // last one, when the next is due (0: asked from the app), a check running now
  checkEvery: number;
  checked: number;
  checkResult: string;
  nextCheck: number;
  checking: boolean;
  // an account on another computer, whose relay joined the server: the name of that computer ("" before its first
  // sync) and the time of its last sync
  relay: boolean;
  host: string;
  relaySeen: number;
};
export type { ActivityItem, CallLogEntry, Chat, Message, Reaction } from "@/shared/slot-db/rows";
export type { OpenReason, OpenStatus } from "@/shared/slot-db/commands";
export { CHECK_INTERVALS } from "@/shared/checks";
export type { RingingCall, SlotHealth as Health } from "@/shared/slot-db/state";
// detail: why the web app refused the command, when it did
export type CommandResult = { status: string; result: { f?: string } | null; detail?: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Full page load on purpose: drops the event stream and whatever the signed-out user had in memory
export function toLogin() {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.href = "/login";
}

// Every per-account call names its account (a=N) explicitly.
export async function call<T>(path: string, init: RequestInit | undefined, acc: number): Promise<T> {
  const url = acc ? `${path}${path.includes("?") ? "&" : "?"}a=${acc}` : path;
  const r = await fetch(url, { credentials: "same-origin", ...init });
  if (r.status === 401) {
    toLogin();
    throw new ApiError(401, "Not signed in");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, (j as { detail?: string }).detail || `HTTP ${r.status}`);
  return j as T;
}

export function post<T>(path: string, body: unknown, acc: number): Promise<T> {
  return call<T>(
    path,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    acc,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The commands of a call (answer, hang-up, mute): the agent takes them within a look of its call watch and Teams shows
// them within a second, so their outcome is read every CALL_CMD_EVERY ms, for about ten seconds
export const CALL_CMD_EVERY = 150;
export const CALL_CMD_TRIES = 70;

// Waits until the agent confirms the change on Teams (done) or gives up (failed), polling `tries` times `every` ms apart
export async function followCmd(id: number, acc: number, tries = 45, every = 700): Promise<CommandResult> {
  for (let i = 0; i < tries; i++) {
    await sleep(every);
    try {
      const r = await call<CommandResult>(`/api/cmd/${id}`, undefined, acc);
      if (r.status === "done" || r.status === "failed") return r;
    } catch {
      // keep trying until the deadline
    }
  }
  return { status: "failed", result: null };
}

export async function runCmd(path: string, body: unknown, acc: number, tries?: number, every?: number): Promise<CommandResult> {
  try {
    const { id } = await post<{ id: number }>(path, body, acc);
    return await followCmd(id, acc, tries, every);
  } catch {
    return { status: "failed", result: null };
  }
}

// Images the app sends, as /api/sendimage takes them (it checks the content again)
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

export function imageProblem(f: File): string | null {
  if (!IMAGE_ACCEPT.split(",").includes(f.type)) return "Only PNG, JPEG, GIF or WebP images can be sent from here: send other files from Teams";
  if (!f.size) return "Empty image";
  if (f.size > 10e6) return "Image larger than 10 MB";
  return null;
}

// Image with its caption to a chat: the agent pastes it in Teams, waits for the upload and confirms it (up to ~50 s)
export async function sendImage(chat: string, image: File, text: string, acc: number): Promise<CommandResult> {
  const form = new FormData();
  form.set("name", chat);
  form.set("text", text);
  form.set("file", image);
  try {
    const { id } = await call<{ id: number }>("/api/sendimage", { method: "POST", body: form }, acc);
    return await followCmd(id, acc, 70);
  } catch (e) {
    return { status: "failed", result: null, detail: e instanceof ApiError ? e.message : undefined };
  }
}

export const mediaUrl = (file: string, acc: number) => `/media/${encodeURIComponent(file)}?a=${acc}`;
export const isSelf = (name: string) => /\(you\)/i.test(name || "");

// Teams keeps an activity bold until it is clicked in Teams itself, while its Activity badge counts only
// what arrived after the feed was last opened. The tab badge does the same with the ids already seen here. Missed
// calls count on the Calls tab instead: Teams shows them as read (not bold), new or not, so every call this device has
// not shown yet counts. Feed items carry no time: an older item that only a longer read of the feed shows counts as
// new too.
export const isMissedCall = (a: Pick<ActivityItem, "kind">) => a.kind === "call";

export function unseenActivity(items: ActivityItem[], seen: string[] | null): number {
  return unseenIds(items.filter((a) => a.unread && !isMissedCall(a) && hasTeamsId(a.id)).map((a) => a.id), seen);
}

export function unseenCalls(items: ActivityItem[], seen: string[] | null): number {
  return unseenIds(items.filter((a) => isMissedCall(a) && hasTeamsId(a.id)).map((a) => a.id), seen);
}

// Same count from the ids of the unread items or of the missed calls, as /api/accounts gives them for every account
export function unseenIds(ids: string[], seen: string[] | null): number {
  if (!seen) return 0;
  const known = new Set(seen);
  return ids.filter((id) => !known.has(id)).length;
}

export type Unread = { chats: number; notifications: number; calls: number };

export const unreadTotal = (u: Unread) => u.chats + u.notifications + u.calls;

// What waits in an account the app does not show: unread chats, the notifications and the missed calls this device has
// not shown yet, the numbers its Chats, Notifications and Calls tabs would have. A stopped account reads nothing new
// from Teams and would keep its last numbers until started again: it counts nothing.
export function accountUnread(a: Account, seen: string[] | null): Unread {
  if (a.stopped) return { chats: 0, notifications: 0, calls: 0 };
  const calls = a.missedCalls ?? [];
  const isCall = new Set(calls);
  return {
    chats: a.unread,
    notifications: unseenIds((a.unreadActivity ?? []).filter((id) => !isCall.has(id)), seen),
    calls: unseenIds(calls, seen),
  };
}

// What waits in the accounts not on screen: the account menu button shows it and, on a phone, the back arrow of an
// open chat, where the menu is hidden. Like Teams, the account on screen has its numbers on its own tabs.
export function unreadInOthers(accounts: Account[], shown: number, unreadOf: (a: Account) => Unread): number {
  return accounts.reduce((n, a) => (a.slot === shown ? n : n + unreadTotal(unreadOf(a))), 0);
}

// What waits in every account, the one on screen included: the number on the icon of the installed app
export function appBadgeCount(accounts: Account[], unreadOf: (a: Account) => Unread): number {
  return accounts.reduce((n, a) => n + unreadTotal(unreadOf(a)), 0);
}

// The same number in the title of the page, for the tab and the taskbar: "(5) TeamsRelay"
export const pageTitle = (n: number) => (n > 0 ? `(${n > 99 ? "99+" : n}) TeamsRelay` : "TeamsRelay");

// An account never signed in to Microsoft has no name nor email yet: it shows as an account being added, not as a
// numbered one, until its first sign-in. One signed out since keeps who it was.
export const NEW_ACCOUNT = "New Teams account";
export const signedInOnce = (a: Pick<Account, "name" | "email">) => !!(a.name || a.email);
export const addingTitle = (accounts: Account[]) =>
  accounts.some(signedInOnce) ? "Finish adding this Teams account" : "Add your first Teams account";

export function markActivitySeen(seen: string[] | null, items: ActivityItem[]): string[] {
  const ids = items.map((a) => a.id);
  const now = new Set(ids);
  return [...ids, ...(seen ?? []).filter((id) => !now.has(id))].slice(0, 200);
}

// The seen list of the account on screen once its feed arrived: the first feed counts as seen, missed calls included;
// later the Notifications list marks what it shows but the missed calls, which only the Calls list marks
export function markShown(stored: string[] | null, items: ActivityItem[], list: "chats" | "activity" | "calls"): string[] {
  if (!stored) return markActivitySeen(null, items);
  if (list === "activity") return markActivitySeen(stored, items.filter((a) => !isMissedCall(a)));
  if (list === "calls") return markActivitySeen(stored, items.filter(isMissedCall));
  return stored;
}

// The seen list the Calls list compares with while it is open, for its dots: the one of when it opened, and the one of
// the new account when the account changes under it
export type CallsSnapshot = { acc: number; seen: string[] | null };
export const callsSnapshot = (s: CallsSnapshot | null, acc: number, seen: string[] | null): CallsSnapshot => (s?.acc === acc ? s : { acc, seen });

export function parseSeen(raw: string | null): string[] | null {
  try {
    const v: unknown = JSON.parse(raw ?? "");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

// Per slot and per time the slot was taken: an account added on a freed slot does not get the list of the removed one
export const seenKey = (a: Pick<Account, "slot" | "added">) => `actseen:${a.slot}:${a.added}`;
// Set once the seen list holds the missed calls of the account: a list an earlier release stored has none of them
const callsKey = (a: Pick<Account, "slot" | "added">) => `actcalls:${a.slot}:${a.added}`;

// Notification ids already seen on this device, per slot. An account met here for the first time takes every item of
// its feed as seen, like the first feed of the selected account: only what comes later counts. A list stored by an
// earlier release takes the items it lists now, once, first (a later mark keeps the first 200 ids). Nothing is stored
// for an account whose feed the agent has not saved yet.
export function loadSeen(accounts: Account[]): Record<number, string[]> {
  const seen: Record<number, string[]> = {};
  for (const a of accounts) {
    const stored = parseSeen(readStorage(seenKey(a)));
    if (stored && (!a.missedCalls || readStorage(callsKey(a)))) seen[a.slot] = stored;
    else if (stored || a.unreadActivity) {
      const now = [...(a.activityIds ?? []), ...(a.unreadActivity ?? []), ...(a.missedCalls ?? [])];
      seen[a.slot] = [...new Set([...now, ...(stored ?? [])])].slice(0, 200);
      writeStorage(seenKey(a), JSON.stringify(seen[a.slot]));
      writeStorage(callsKey(a), "1");
    }
  }
  return seen;
}

// The seen list of the account on screen once its feed arrived (markShown), kept on this device; stored is the list
// before
export function noteShown(a: Account, items: ActivityItem[], list: "chats" | "activity" | "calls"): { stored: string[] | null; seen: string[] } {
  const stored = parseSeen(readStorage(seenKey(a)));
  const seen = markShown(stored, items, list);
  if (seen !== stored) writeStorage(seenKey(a), JSON.stringify(seen));
  if (!stored) writeStorage(callsKey(a), "1");
  return { stored, seen };
}

export function initials(s: string): string {
  s = (s || "?").trim().replace(/\(.*?\)/g, "").trim();
  const p = s.split(/[\s,]+/).filter(Boolean);
  return ((p[0]?.[0] || "") + (p[1]?.[0] || "") || s[0] || "?").toUpperCase();
}

const COLORS = ["#6264a7", "#0a7cbb", "#498205", "#c19c00", "#ca5010", "#b4009e", "#008272", "#e3008c", "#5c2e91", "#986f0b"];
export function avColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function ago(ts?: number): string {
  if (!ts) return "never";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

// The interval of the checks of an account: "1 h", "2 h", "4 h"
export const hours = (seconds: number) => `${Math.round(seconds / 3600)} h`;

// The one status of an account, as Settings chooses it: stopped, always on (0) or checked every N seconds. A stopped
// account keeps its interval, the mode it resumes when started again.
export const accountStatus = (a: Pick<Account, "stopped" | "checkEvery">): "stopped" | number => (a.stopped ? "stopped" : a.checkEvery);

// An account checked every N hours, between two checks: no browser, no agent, the chats and numbers of its last check
export const idleChecked = (a: Pick<Account, "checkEvery" | "checking" | "stopped">) => a.checkEvery > 0 && !a.checking && !a.stopped;

// The accounts with a window on the remote desktop: not on another computer, and with a browser running
export const onDesktop = (accounts: Account[]) => accounts.filter((a) => !a.relay && !a.stopped && !idleChecked(a));

// The one desktop of the browsers container, where every account has its window
export const DEFAULT_DESKTOP_URL = "/api/desktop/{n}";
export const DESKTOP_TAB = "teamsrelay-desktop";

// Where a PC opens the desktop of account n: the one desktop in one tab of its own, with a button per account on top
// (/remote), which the next opening of any account reuses (a second tab of that desktop would cut off the first); a
// DESKTOP_URL of another desktop in a new tab
export function desktopTarget(template: string, n: number): { url: string; target: string } {
  if (template === DEFAULT_DESKTOP_URL) return { url: `/remote?account=${n}`, target: DESKTOP_TAB };
  return { url: template.replace("{n}", String(n)), target: "_blank" };
}

// An account on another computer whose relay has not synced for a minute, or never did
export const relayOffline = (a: Partial<Pick<Account, "relay" | "teams">>) => !!a.relay && (a.teams === "unknown" || a.teams === "starting");

// Its last check: "Checked 14:05", "Check failed 14:05"
export const lastCheck = (a: Pick<Account, "checked" | "checkResult">) => `${a.checkResult === "failed" ? "Check failed" : "Checked"} ${clock(a.checked)}`;

// Its last check and the next one: "Checked 14:05 · next 15:05"
export function checkLine(a: Account, now = Date.now() / 1000): string {
  if (a.checking) return "Checking now";
  const next = a.nextCheck > now ? `next ${clock(a.nextCheck)}` : "next check soon";
  if (!a.checked) return `Checked every ${hours(a.checkEvery)} · ${next}`;
  return `${lastCheck(a)} · ${next}`;
}

// Time left, for the account menu: "45 min", "1 h 20 min", "2 h"; less than a minute is one
export function untilText(seconds: number): string {
  const min = Math.max(1, Math.ceil(seconds / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

// The status of an account on its row of the account menu: stopped, active (always on), or when the next check
// updates it. A check asked from the app has no time yet; a due one waits for the check of another account.
export function statusText(a: Pick<Account, "stopped" | "checkEvery" | "checking" | "nextCheck"> & Partial<Pick<Account, "relay" | "teams">>, now = Date.now() / 1000): string {
  if (a.relay) return relayOffline(a) ? "Not connected" : "Active";
  if (a.stopped) return "Stopped";
  if (!a.checkEvery) return "Active";
  if (a.checking) return "Updating now";
  return a.nextCheck > now ? `Updating in ${untilText(a.nextCheck - now)}` : "Updating soon";
}

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the choice is not remembered
  }
}

// The bell of new messages while the app is open (sw.js, App.tsx), per device: on unless turned off in Settings
const BELL_KEY = "bell";
export const bellOn = () => readStorage(BELL_KEY) !== "off";
export const setBellOn = (on: boolean) => writeStorage(BELL_KEY, on ? "on" : "off");
