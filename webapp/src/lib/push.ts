// Web Push on this device: the service worker receives the notifications the agents send to the user.
import { call, post } from "./client";

export type PushState = "on" | "off" | "unsupported";

function urlB64ToUint8(s: string) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a;
}

const iosBrowserTab = () => {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;
  return !standalone && /iPhone|iPad/i.test(navigator.userAgent);
};

export async function pushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    return (await reg.pushManager.getSubscription()) ? "on" : "off";
  } catch {
    return "unsupported";
  }
}

// Throws an Error whose message can be shown as it is
export async function enablePush(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || iosBrowserTab()) {
    throw new Error('On iPhone notifications work only in the installed app: Share, "Add to Home Screen", then open TeamsRelay from there.');
  }
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notification permission denied in the browser settings.");
  const { key } = await call<{ key: string }>("/api/vapidkey", undefined, 0);
  if (!key) throw new Error("Push keys are not configured on the server.");
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) }));
  await post("/api/push/subscribe", sub.toJSON(), 0);
}
