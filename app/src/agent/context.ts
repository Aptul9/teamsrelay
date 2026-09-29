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
    // seconds signed out before the one press of Sign in, and seconds it has to bring Teams back before the push
    // (SIGN_IN_TRY_AFTER and SIGN_IN_TRY_WAIT when not given)
    signInTryAfter?: number;
    signInTryWait?: number;
    // how to sign in again, and which browser does not start: the first sentence of those pushes
    signIn: string;
    browserDown: string;
  };
  // the remote desktop of the browsers container, watched for the owner (jobs/desktop.ts); none for the local relay
  desktop?: DesktopWatch | null;
};

// The websocket of the remote desktop (its viewers are connections to that port) and how to ask its compositor which
// window is in front: as the desktop user, in its session
export type DesktopWatch = { port: number; uid: number; gid: number; appId: string; session: Record<string, string> };

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
  // a viewer of the remote desktop with the window of this account in front, at the last look (jobs/desktop.ts); the
  // last time one was seen (ms); the connections of the desktop could not be read
  onDesktop?: boolean;
  desktopSeenAt?: number;
  desktopUnknown?: boolean;
};

export const nowSeconds = () => Math.floor(Date.now() / 1000);
