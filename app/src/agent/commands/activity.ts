import { readActivity } from "../jobs/activity";
import { pushMissedCalls } from "../jobs/missed-calls";
import type { Handler } from "./index";

// Milliseconds a refresh waits for the side bar: it runs once the health check found it clickable (runPendingCommands),
// a few seconds earlier; right after a start Teams can still show its loading bar over it for a moment
export const RAIL_WAIT = 10_000;

// Reads the Activity feed again. A missed call it shows first alerts now, as after a read of the loop, not at the
// next one when the app has shown it already.
export const activity: Handler = async (a) => {
  if ((await readActivity(a, RAIL_WAIT)) === null) return "failed";
  if (!a.checkedOnly?.()) await pushMissedCalls(a);
  return "done";
};
