import type { AgentHealth } from "@/shared/slot-db/state";
import type { Config } from "@/relay/config";
import type { NewMessageDetector } from "./logic/new-messages";
import type { Media } from "./media";
import type { Notifier } from "./push/notifier";
import type { SlotStore } from "./store/slot-store";
import type { TeamsPage } from "./teams/page";

// What the jobs and the command handlers work with. tp is the Teams page of the current round.
export type Agent = {
  config: Config;
  store: SlotStore;
  notifier: Notifier;
  media: Media;
  detector: NewMessageDetector;
  tp: TeamsPage;
  // last health row written, null until the first one
  health: AgentHealth | null;
};

export const nowSeconds = () => Math.floor(Date.now() / 1000);
