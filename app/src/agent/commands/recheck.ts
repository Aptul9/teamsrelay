import { selfCheck } from "../jobs/self-check";
import type { Handler } from "./index";

// Full check, outcome sent as a push: from the app, it also shows that notifications reach the phone
export const recheck: Handler = async (a) => {
  const { ok, why } = await selfCheck(a);
  await a.notifier.alert("Teams", ok ? "Everything works" : `Problem: ${why}`);
  return "done";
};
