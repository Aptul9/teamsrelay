import { useEffect, useRef } from "react";

// How deep the page was when an entry of its history was made: 0 for the list, more for each level opened over it
const depthOf = (state: unknown) => (state as { depth?: number } | null)?.depth ?? 0;

// The history follows the depth shown: an entry more for a level opened, back for a level the page closed itself (the
// arrow of a chat). True when it went back: its popstate comes later.
function follow(depth: number): boolean {
  const at = depthOf(window.history.state);
  if (depth > at) window.history.pushState({ depth }, "");
  if (depth >= at) return false;
  window.history.back();
  return true;
}

// Back (the Android button, the back gesture of a browser) closes the level on top instead of leaving the page: each
// level opened adds an entry to the history of the page, Back takes it away, and close gets the depth it went back to.
// The Android app closes only from the list, where the page has no entry to go back to: Tauri goes back in the WebView
// while it can (AppPlugin.kt). Next.js keeps its own state in these entries (it patches pushState).
export function useBack(depth: number, close: (to: number) => void) {
  const shown = useRef(depth);
  const onClose = useRef(close);
  // a back of follow on its way: its popstate is not a Back of the user
  const leaving = useRef(false);
  useEffect(() => {
    onClose.current = close;
  });
  useEffect(() => {
    shown.current = depth;
    if (!leaving.current) leaving.current = follow(depth);
  }, [depth]);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const to = depthOf(e.state);
      // after a back of follow, or forward onto a level closed since: the history catches up with the depth shown
      if (leaving.current || to > shown.current) leaving.current = follow(shown.current);
      else if (to < shown.current) onClose.current(to);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}
