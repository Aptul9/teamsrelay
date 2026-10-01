// The chat on screen in the app, told to the agent of its account (POST /api/viewing): at once and every MARK_EVERY_MS
// while the app shows it, and at once when it stops showing it (another chat, the list, another tab or window, the
// app closed). The Teams page reads what arrives in the chat it shows: the agent holds the chat open only meanwhile,
// and pushes no notification for it (src/agent/logic/parking.ts).

export const MARK_EVERY_MS = 10_000;

type Deps = {
  send: (url: string, body: object) => void;
  timer: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };
  // the page goes away: closed, reloaded, or kept in the back/forward cache
  onPageHide: (fn: () => void) => () => void;
};

// Marks `chat` of account `acc` as shown until the function returned is called
export function showViewing(acc: number, chat: string, d: Deps = browser()): () => void {
  const url = `/api/viewing?a=${acc}`;
  const mark = () => d.send(url, { chat });
  const leave = () => d.send(url, { left: chat });
  mark();
  const beat = d.timer.set(mark, MARK_EVERY_MS);
  // a page restored from the back/forward cache goes on with its beats
  const off = d.onPageHide(leave);
  return () => {
    off();
    d.timer.clear(beat);
    leave();
  };
}

function browser(): Deps {
  return {
    // a beacon leaves even while the page goes away, with the session cookie (same site)
    send: (url, body) => {
      const data = new Blob([JSON.stringify(body)], { type: "application/json" });
      if (navigator.sendBeacon?.(url, data)) return;
      void fetch(url, { method: "POST", body: data, credentials: "same-origin", keepalive: true }).catch(() => undefined);
    },
    timer: { set: (fn, ms) => setInterval(fn, ms), clear: (t) => clearInterval(t as ReturnType<typeof setInterval>) },
    onPageHide: (fn) => {
      window.addEventListener("pagehide", fn);
      return () => window.removeEventListener("pagehide", fn);
    },
  };
}
