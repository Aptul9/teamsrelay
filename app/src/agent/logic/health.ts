import type { AgentHealth, TeamsState } from "@/shared/slot-db/state";

// What the agent reads on the page for the health row; null when reading it failed
export type PageProbe = {
  url: string;
  // Teams says the session expired or syncs in reduced mode
  reduced: boolean;
  // editor or chat list in the page
  domReady: boolean;
  hookInstalled: boolean;
  // own status from the Teams header, only on the Teams page
  presence?: string;
};

export type HealthInputs = { probe: PageProbe | null; pushSubs: number; lastMsgTs: number; lastScanTs: number; now: number };

// A chat list read in the last minute means new message detection is running
export const SCAN_FRESH = 60;

export function computeHealth({ probe, pushSubs, lastMsgTs, lastScanTs, now }: HealthInputs): AgentHealth {
  let teams: TeamsState = "err";
  const page: Partial<AgentHealth> = {};
  if (probe) {
    const signedOut = /login|signin/.test(probe.url.toLowerCase());
    teams = signedOut || probe.reduced ? "login" : probe.domReady ? "ok" : "loading";
    page.reduced = probe.reduced;
    page.hook = probe.hookInstalled ? "ok" : "no";
    if (probe.presence !== undefined) page.presence = probe.presence;
  } else {
    page.hook = "no";
  }
  const fresh = !!lastScanTs && now - lastScanTs < SCAN_FRESH;
  return {
    cdp: "ok",
    ts: now,
    teams,
    ...page,
    push_subs: pushSubs,
    last_msg_ts: lastMsgTs,
    last_scan_ts: lastScanTs,
    watcher: fresh ? "ok" : "stale",
    overall: teams === "login" || teams === "err" ? "red" : fresh ? "green" : "yellow",
  };
}

// One push when the session expires or Teams drops to reduced mode, only for an account signed in once
// already: a slot just added still has its first sign-in to do
export function sessionExpired(teams: string, previous: string, signedInOnce: boolean): boolean {
  return teams === "login" && previous !== "login" && signedInOnce;
}
