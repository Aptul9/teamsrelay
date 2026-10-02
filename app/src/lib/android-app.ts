// The Android app (mobile/) opens the server from its start page, bundled with the app and served at
// http://tauri.localhost (https:// with useHttpsScheme). The start page names itself in the address (?app=), and Change
// server (account menu, sign-in page) goes back there, to its form (#change). The device keeps it: the server page
// also loads without it (a tapped notification, the page after a sign-in). Only the app's own pages count.
import { useSyncExternalStore } from "react";
import { noSubscribe, readStorage, writeStorage } from "./client";

const KEY = "appstart";

export function appStartPage(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    const app = (u.protocol === "http:" || u.protocol === "https:") && u.hostname === "tauri.localhost" && !u.port && !u.username && !u.password;
    return app ? u.origin + u.pathname : null;
  } catch {
    return null;
  }
}

// From the address (?app=, or inside ?next= on the sign-in page), else as this device kept it
export function appStart(search: string): string | null {
  const q = new URLSearchParams(search);
  const next = q.get("next") ?? "";
  const inNext = next.startsWith("/") ? new URLSearchParams(next.split("?")[1] ?? "").get("app") : null;
  return appStartPage(q.get("app")) ?? appStartPage(inNext) ?? appStartPage(readStorage(KEY));
}

export function keepAppStart(page: string | null) {
  if (page) writeStorage(KEY, page);
}

const appStartNow = () => appStart(window.location.search);

// The start page of the Android app that opened this server; null in a browser, and while the page renders on the server
export const useAppStart = () => useSyncExternalStore(noSubscribe, appStartNow, () => null);
