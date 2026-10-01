// The app tells the agent of the account which chat it shows: at once and every MARK_EVERY_MS while on screen, and at
// once when it stops, so Teams holds the chat open (and reads what arrives there) only while the user can see it.
import { describe, expect, it } from "vitest";
import { MARK_EVERY_MS, showViewing } from "@/lib/viewing";

// what the app sends, a timer run by hand, the pagehide of the window
function page() {
  const sent: { url: string; body: unknown }[] = [];
  let beat: (() => void) | null = null;
  let hide: (() => void) | null = null;
  const deps = {
    send: (url: string, body: object) => void sent.push({ url, body }),
    timer: {
      set: (fn: () => void, ms: number) => {
        expect(ms).toBe(MARK_EVERY_MS);
        beat = fn;
        return 1;
      },
      clear: () => void (beat = null),
    },
    onPageHide: (fn: () => void) => {
      hide = fn;
      return () => void (hide = null);
    },
  };
  return { deps, sent, beat: () => beat?.(), hide: () => hide?.(), bodies: () => sent.map((s) => s.body) };
}

describe("chat on screen", () => {
  it("is marked at once and at every beat while the app shows it", () => {
    const p = page();
    showViewing(2, "Anna Rossi", p.deps);
    p.beat();
    p.beat();
    expect(p.sent.map((s) => s.url)).toEqual(["/api/viewing?a=2", "/api/viewing?a=2", "/api/viewing?a=2"]);
    expect(p.bodies()).toEqual([{ chat: "Anna Rossi" }, { chat: "Anna Rossi" }, { chat: "Anna Rossi" }]);
  });

  it("is left at once when the app stops showing it, and marked no more", () => {
    const p = page();
    const stop = showViewing(2, "Anna Rossi", p.deps);
    stop();
    p.beat();
    p.hide();
    expect(p.bodies()).toEqual([{ chat: "Anna Rossi" }, { left: "Anna Rossi" }]);
  });

  // closed, reloaded, or kept in the back/forward cache: a page restored from there goes on with its beats
  it("is left when the page goes away, and marked again by a page restored", () => {
    const p = page();
    showViewing(2, "Anna Rossi", p.deps);
    p.hide();
    p.beat();
    expect(p.bodies()).toEqual([{ chat: "Anna Rossi" }, { left: "Anna Rossi" }, { chat: "Anna Rossi" }]);
  });
});
