// Page scripts about the Teams page as a whole: visibility, notification hook, health probe, signed-in user.
// They run inside the Teams page: self-contained, type imports only.
import type { Selectors, Texts } from "../selectors";

type Captured = { title: string; body: string };
type RelayWindow = Window & { __teamsVisible?: boolean; __teamsHookInstalled?: boolean; __teamsMsgs?: Captured[] };

// Teams keeps the user Available only while its page is visible and focused: the page says so from its first
// script (init script) on. Also run on every round, for a page loaded before the agent attached.
export function makeVisible(): "already" | "installed" | "failed" {
  const w = window as RelayWindow;
  if (w.__teamsVisible) return "already";
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.hasFocus = () => true;
    w.__teamsVisible = true;
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    return "installed";
  } catch {
    return "failed";
  }
}

// Captures the notifications Teams shows (page and service worker), a second source of new messages, and
// answers "granted" to the notification permission checks.
export function installNotificationHook(): "already" | "installed" {
  const w = window as RelayWindow;
  if (w.__teamsHookInstalled) return "already";
  w.__teamsMsgs = w.__teamsMsgs || [];
  const capture = (title: unknown, body: unknown) => {
    try {
      (w.__teamsMsgs as Captured[]).push({ title: String(title || ""), body: String(body || "") });
    } catch {
      // the page replaced the array: the next round installs it again
    }
  };
  try {
    const Original = window.Notification;
    // called with new by Teams: returning an object makes it the result of new
    const Wrapped = function (title: string, options?: NotificationOptions) {
      capture(title, options && options.body);
      try {
        return new Original(title, options);
      } catch {
        return { close() {} };
      }
    } as unknown as { requestPermission: unknown };
    try {
      Wrapped.requestPermission = (cb?: (p: string) => void) => {
        if (cb) cb("granted");
        return Promise.resolve("granted");
      };
    } catch {}
    try {
      Object.defineProperty(Wrapped, "permission", { get: () => "granted" });
    } catch {}
    (window as unknown as { Notification: unknown }).Notification = Wrapped;
  } catch {}
  try {
    const proto = window.ServiceWorkerRegistration && ServiceWorkerRegistration.prototype;
    if (proto && proto.showNotification) {
      const show = proto.showNotification;
      proto.showNotification = function (this: ServiceWorkerRegistration, title: string, options?: NotificationOptions) {
        capture(title, options && options.body);
        return show.call(this, title, options);
      };
    }
  } catch {}
  try {
    const perms = navigator.permissions;
    const query = perms && perms.query ? perms.query.bind(perms) : null;
    if (query) {
      perms.query = ((d: PermissionDescriptor) =>
        d && d.name === "notifications" ? Promise.resolve({ state: "granted", onchange: null }) : query(d)) as typeof perms.query;
    }
  } catch {}
  w.__teamsHookInstalled = true;
  return "installed";
}

export function drainNotifications(): Captured[] {
  const w = window as RelayWindow;
  const captured = w.__teamsMsgs || [];
  w.__teamsMsgs = [];
  return captured;
}

// A point of the first visible element of `sel` that nothing covers (a tooltip, a popup), or null
export function uncoveredPoint(sel: string): { x: number; y: number } | null {
  const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  for (const fy of [0.5, 0.85, 0.15]) {
    for (const fx of [0.5, 0.2, 0.8]) {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) return { x, y };
    }
  }
  return null;
}

// What the health row needs from the page. presence: own status as the header shows it (available, away,
// busy, do not disturb...), read on the Teams page only.
export function probePage({ s, t, withPresence }: { s: Selectors; t: Texts; withPresence: boolean }) {
  const reduced = t.sessionLost.test((document.body && document.body.innerText) || "");
  const domReady = !!document.querySelector(s.editor) || !!document.querySelector(s.listItem);
  const hookInstalled = !!(window as RelayWindow).__teamsHookInstalled;
  if (!withPresence) return { reduced, domReady, hookInstalled };
  const badge = document.querySelector(s.presence);
  return { reduced, domReady, hookInstalled, presence: badge ? (badge.getAttribute("aria-label") || "").trim().toLowerCase() : "" };
}

// Who is signed in: name, email and organization from the profile Teams keeps in localStorage, picture from
// the profile button
export function readIdentity(s: Selectors) {
  const read = (k: string | undefined) => {
    try {
      return JSON.parse(localStorage.getItem(k || "") || "null");
    } catch {
      return null;
    }
  };
  const user = read(s.userKey);
  const profile = (user && user.item && user.item.profile) || {};
  const tenants: { tenantId?: string; tenantName?: string }[] = (read(Object.keys(localStorage).find((k) => s.tenantsKey.test(k))) || {}).item || [];
  const img = document.querySelector<HTMLImageElement>(s.meAvatar);
  return {
    name: String(profile.name || ""),
    email: String(profile.preferred_username || profile.upn || ""),
    tenant: String((tenants.find((x) => x.tenantId === profile.tid) || {}).tenantName || ""),
    avsrc: img && img.naturalWidth ? img.currentSrc || img.src : "",
  };
}
