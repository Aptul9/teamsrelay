// Browser-side helpers of the PWA: API calls, command follow-up, formatting.

import type { ActivityItem } from "@/shared/slot-db/rows";

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
  added: number;
  desktop: string;
};
export type { ActivityItem, Chat, Message, Reaction } from "@/shared/slot-db/rows";
export type { SlotHealth as Health } from "@/shared/slot-db/state";
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

// Waits until the agent confirms the change on Teams (done) or gives up (failed), polling `tries` times
export async function followCmd(id: number, acc: number, tries = 45): Promise<CommandResult> {
  for (let i = 0; i < tries; i++) {
    await sleep(700);
    try {
      const r = await call<CommandResult>(`/api/cmd/${id}`, undefined, acc);
      if (r.status === "done" || r.status === "failed") return r;
    } catch {
      // keep trying until the deadline
    }
  }
  return { status: "failed", result: null };
}

export async function runCmd(path: string, body: unknown, acc: number): Promise<CommandResult> {
  try {
    const { id } = await post<{ id: number }>(path, body, acc);
    return await followCmd(id, acc);
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
// what arrived after the feed was last opened. The tab badge does the same with the ids already seen here.
export function unseenActivity(items: ActivityItem[], seen: string[] | null): number {
  return unseenIds(items.filter((a) => a.unread).map((a) => a.id), seen);
}

// Same count from the ids of the unread items, as /api/accounts gives them for every account
export function unseenIds(unread: string[], seen: string[] | null): number {
  if (!seen) return 0;
  const known = new Set(seen);
  return unread.filter((id) => !known.has(id)).length;
}

export type Unread = { chats: number; notifications: number };

// What waits in an account the app does not show: unread chats and the notifications this device has not shown yet,
// the numbers its Chats and Notifications tabs would have. A stopped account reads nothing new from Teams and would
// keep its last numbers until started again: it counts nothing.
export function accountUnread(a: Account, seen: string[] | null): Unread {
  if (a.stopped) return { chats: 0, notifications: 0 };
  return { chats: a.unread, notifications: unseenIds(a.unreadActivity ?? [], seen) };
}

// What waits in the accounts not on screen: the account menu button shows it and, on a phone, the back arrow of an
// open chat, where the menu is hidden. Like Teams, the account on screen has its numbers on its own tabs.
export function unreadInOthers(accounts: Account[], shown: number, unreadOf: (a: Account) => Unread): number {
  return accounts.reduce((n, a) => {
    if (a.slot === shown) return n;
    const u = unreadOf(a);
    return n + u.chats + u.notifications;
  }, 0);
}

export function markActivitySeen(seen: string[] | null, items: ActivityItem[]): string[] {
  const ids = items.map((a) => a.id);
  const now = new Set(ids);
  return [...ids, ...(seen ?? []).filter((id) => !now.has(id))].slice(0, 200);
}

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

// Notification ids already seen on this device, per slot. An account met here for the first time takes the unread
// ones it has now as seen, like the first feed of the selected account: only what comes later counts. Nothing is
// stored for an account whose feed the agent has not saved yet.
export function loadSeen(accounts: Account[]): Record<number, string[]> {
  const seen: Record<number, string[]> = {};
  for (const a of accounts) {
    const stored = parseSeen(readStorage(seenKey(a)));
    if (stored) seen[a.slot] = stored;
    else if (a.unreadActivity) {
      seen[a.slot] = a.unreadActivity;
      writeStorage(seenKey(a), JSON.stringify(a.unreadActivity));
    }
  }
  return seen;
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
