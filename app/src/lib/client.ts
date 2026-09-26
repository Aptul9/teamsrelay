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
  unread: number;
  desktop: string;
};
export type { ActivityItem, Chat, Message, Reaction } from "@/shared/slot-db/rows";
export type { SlotHealth as Health } from "@/shared/slot-db/state";
export type CommandResult = { status: string; result: { f?: string } | null };

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

// Waits until the agent confirms the change on Teams (done) or gives up (failed)
export async function followCmd(id: number, acc: number): Promise<CommandResult> {
  for (let i = 0; i < 45; i++) {
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

export const mediaUrl = (file: string, acc: number) => `/media/${encodeURIComponent(file)}?a=${acc}`;
export const isSelf = (name: string) => /\(you\)/i.test(name || "");

// Teams keeps an activity bold until it is clicked in Teams itself, while its Activity badge counts only
// what arrived after the feed was last opened. The tab badge does the same with the ids already seen here.
export function unseenActivity(items: ActivityItem[], seen: string[] | null): number {
  if (!seen) return 0;
  const known = new Set(seen);
  return items.filter((a) => a.unread && !known.has(a.id)).length;
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
