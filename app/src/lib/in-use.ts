import { useSyncExternalStore } from "react";

// The app in use: on screen and its window focused, clicked into. A window behind another application, a background
// tab, a phone in the pocket: the user reads nothing there, so Teams must not read the open chat either (the agent
// leaves it, lib/viewing.ts), and its notifications stay (user 2026-09-30).
function onInUseChange(cb: () => void): () => void {
  document.addEventListener("visibilitychange", cb);
  window.addEventListener("focus", cb);
  window.addEventListener("blur", cb);
  return () => {
    document.removeEventListener("visibilitychange", cb);
    window.removeEventListener("focus", cb);
    window.removeEventListener("blur", cb);
  };
}

const inUseNow = () => document.visibilityState === "visible" && document.hasFocus();

export const useInUse = () => useSyncExternalStore(onInUseChange, inUseNow, () => true);
