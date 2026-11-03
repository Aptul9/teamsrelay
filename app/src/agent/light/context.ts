import type { AgentHealth } from "@/shared/slot-db/state";
import type { Config } from "../config";
import type { NewMessageDetector } from "../logic/new-messages";
import type { Notify } from "../push/notifier";
import type { SlotStore } from "../store/slot-store";
import type { LightApi, Person } from "./api";
import type { LightToken } from "./token";

// What the light agent (an account with no browser of its own) works with
export type Light = {
  config: Config;
  store: SlotStore;
  notifier: Notify;
  detector: NewMessageDetector;
  api: LightApi;
  token: LightToken;
  // you: object id (the mri is 8:orgid:<oid>) and name, from the access token
  me: { oid: string; name: string };
  // the last chat list read: chat name to conversation id, conversation id to chat name, the other people (mri) of each
  // conversation
  list: { ids: Map<string, string>; names: Map<string, string>; members: Map<string, string[]> };
  // names of people, kept for the life of the process
  people: Map<string, Person>;
  // conversations with a mention of you the feed shows unread
  mentioned: Set<string>;
  // when the next chat list and Activity reads are due (ms), 0: at once
  due: { list: number; activity: number };
  // the last chat list read that worked (ms), the last error, Microsoft refused the sign-in
  scanAt: number;
  error: string;
  signedOut: boolean;
  health: AgentHealth | null;
  // when the process started (ms), and whether it read the feed once (src/agent/light/loop.ts)
  startedAt: number;
  feedRead: boolean;
};
