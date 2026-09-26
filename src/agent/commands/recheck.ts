import { selfCheck } from "../jobs/self-check";
import type { Handler } from "./index";

// Full check, outcome sent as a push
export const recheck: Handler = async (a) => {
  const { ok, why } = await selfCheck(a);
  await a.notifier.push("Teams", ok ? "Everything works" : `Problem: ${why}`);
  return "done";
};
