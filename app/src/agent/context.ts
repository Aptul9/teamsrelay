import type { AgentHealth } from "@/shared/slot-db/state";
import type { NewMessageDetector } from "./logic/new-messages";
import type { Media } from "./media";
import type { Notify } from "./push/notifier";
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
  // calls answered and hung up from the app, sound through the remote desktop: an account of the browsers container only
  answerCalls: boolean;
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
  notifier: Notify;
  media: Media;
  detector: NewMessageDetector;
  tp: TeamsPage;
  // last health row written, null until the first one
  health: AgentHealth | null;
  // the Activity button of the side bar could be clicked at the last health check: right after a start Teams shows
  // the chat list first, then the side bar under its loading bar
  railReady?: boolean;
  // the web app starts this account only to check it, every few hours (server only)
  checkedOnly?: () => boolean;
  // a call is in progress: the Teams page records from the microphone (src/agent/jobs/calls.ts)
  inCall?: boolean;
  // a call rings: its toast shows (src/agent/jobs/calls.ts)
  ringing?: boolean;
  // when the last call in progress ended (ms): Teams shows a call in its main window and may leave a post-meeting page
  callOverAt?: number;
  // since when the side bar of Teams shows without the chat list (ms), and the tries to go back to it (backToChats)
  loadingSince?: number;
  backTries?: number;
  backAt?: number;
  // the owner's last click, key or wheel turn on the page (ms), not sent by the agent; whether the pause it gives was
  // logged as started (logic/owner.ts)
  ownerAt?: number;
  ownerPaused?: boolean;
};

export const nowSeconds = () => Math.floor(Date.now() / 1000);
