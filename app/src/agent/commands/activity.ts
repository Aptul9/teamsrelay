import { readActivity } from "../jobs/activity";
import type { Handler } from "./index";

// Milliseconds a refresh waits for the side bar: right after a start Teams shows it a few seconds after the chat
// list, then its loading bar covers it a few seconds more
const RAIL_WAIT = 20_000;

// Reads the Activity feed again
export const activity: Handler = async (a) => ((await readActivity(a, RAIL_WAIT)) === null ? "failed" : "done");
