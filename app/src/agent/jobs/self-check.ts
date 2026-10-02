import type { Agent } from "../context";
import { selfCheckWindow } from "../logic/self-check";
import { errorText, log } from "../log";
import { readChats } from "./chat-list";
import { updateHealth } from "./health";

// Real check: Teams connected and the new message detection running
export async function selfCheck(a: Agent): Promise<{ ok: boolean; why: string }> {
  const h = await updateHealth(a);
  if (h.teams === "login") return { ok: false, why: "Teams signed out: sign in again" };
  if (h.teams !== "ok") return { ok: false, why: "Teams not fully loaded" };
  try {
    if (!(await readChats(a, false))) return { ok: false, why: "Chat list not readable" };
  } catch (e) {
    return { ok: false, why: `New message detection failed: ${errorText(e)}` };
  }
  return { ok: true, why: "" };
}

// Twice a day, 8-11 and 17-20, with a push of the outcome
export function selfCheckDue(a: Agent): string | null {
  const key = selfCheckWindow(new Date());
  return key && a.store.getState(key) !== "1" ? key : null;
}

export async function scheduledSelfCheck(a: Agent) {
  const key = selfCheckDue(a);
  if (!key) return;
  const { ok, why } = await selfCheck(a);
  a.store.setState(key, "1");
  // a check that passed can wait for the phone to wake up; a problem cannot
  await a.notifier.alert(ok ? "Teams OK" : "Teams: problem", ok ? "Automatic check: the whole chain works." : why, ok ? "normal" : "high");
  log.info("SELFCHECK", ok ? "ok" : "problem", { why: why || undefined });
}
