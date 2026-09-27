// Page scripts of an incoming call: Teams web shows it as a toast in the page, with the buttons to answer and
// decline, and plays its ringtone until the call stops. Nothing here clicks them.
// They run inside the Teams page: self-contained, type imports only.
import type { Selectors, Texts } from "../selectors";

// The call ringing now, or null. caller is empty when the text of the toast is not the one known.
export function readIncomingCall({ s, t }: { s: Selectors; t: Texts }): { caller: string } | null {
  const toast = [...document.querySelectorAll<HTMLElement>(s.callToast)].find((e) => e.getClientRects().length > 0);
  if (!toast) return null;
  const text = ((toast.querySelector<HTMLElement>(s.callText) || toast).innerText || "").replace(/\s+/g, " ").trim();
  const m = text.match(t.callingYou);
  return { caller: m ? m[1].replace(t.externalMark, "").trim() : "" };
}
