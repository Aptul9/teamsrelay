import type { AgentHealth } from "@/shared/slot-db/state";
import type { NewMessageDetector } from "./logic/new-messages";
import type { Media } from "./media";
import type { Notifier } from "./push/notifier";
import type { SlotStore } from "./store/slot-store";
import type { TeamsPage } from "./teams/page";

// What the jobs and the command handlers take from the configuration of the product that runs them: the agent of
// a server slot (src/agent/config.ts) or the local relay (src/local/config.ts)
export type AgentSettings = {
  // images the web app queued to send (server only: the local app sends text)
  uploadsDir: string;
  // Activity feed and "Read by": read only where an app shows them
  activity: boolean;
  readBy: boolean;
  alerts: {
    // seconds a problem lasts before its push: Teams signed out, browser not starting
    signInAfter: number;
    browserAfter: number;
    // how to sign in again, and which browser does not start: the first sentence of those pushes
    signIn: string;
    browserDown: string;
  };
};

// What the jobs and the command handlers work with. tp is the Teams page of the current round.
export type Agent = {
  config: AgentSettings;
  store: SlotStore;
  notifier: Notifier;
  media: Media;
  detector: NewMessageDetector;
  tp: TeamsPage;
  // last health row written, null until the first one
  health: AgentHealth | null;
};

export const nowSeconds = () => Math.floor(Date.now() / 1000);
