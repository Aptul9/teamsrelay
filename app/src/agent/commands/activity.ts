import { readActivity } from "../jobs/activity";
import type { Handler } from "./index";

// Reads the Activity feed again
export const activity: Handler = async (a) => ((await readActivity(a)) === null ? "failed" : "done");
