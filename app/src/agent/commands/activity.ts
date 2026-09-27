import { readActivity } from "../jobs/activity";
import type { Handler } from "./index";

// Milliseconds a refresh waits for the side bar: it runs once the health check found it clickable (runPendingCommands),
// a few seconds earlier; right after a start Teams can still show its loading bar over it for a moment
export const RAIL_WAIT = 10_000;

// Reads the Activity feed again
export const activity: Handler = async (a) => ((await readActivity(a, RAIL_WAIT)) === null ? "failed" : "done");
