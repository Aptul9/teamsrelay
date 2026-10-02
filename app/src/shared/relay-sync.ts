import { z } from "zod";
import { COMMAND_STATUSES } from "./slot-db/commands";

// /api/relay/* between the local relay of an account on another computer (src/local/server-link.ts) and the web app
// of the server it joins (src/lib/relay.ts): docs/design/2026-09-27-relay-joins-server.md. Rows go as the slot
// schema holds them (src/shared/slot-db/schema.ts).

// Key under which the relay queues a command of the server in relay.db: when the account took its slot (a slot freed
// and taken again starts a new series of ids), then the id of the command in data/N/messages.db
export const serverCommandKey = (added: number, id: number) => `srv-${added}-${id}`;
export const SERVER_COMMAND_KEY = /^srv-(\d+)-(\d+)$/;

// Longest wait of GET /api/relay/commands before it answers with nothing
export const COMMANDS_WAIT_MS = 25_000;

// The websocket of the sound of a call answered or placed from the app on an account on another computer: the relay
// (src/local/call-bridge.ts) and the page of the app open it on the server (src/server/call-audio-hub.ts)
export const CALL_AUDIO_PATH = "/api/call/audio/socket";

// The websocket of the browser of a relay for MCP clients: the relay (src/local/browser-link.ts) opens it on the server
// (src/server/browser-hub.ts), which sends tools/list and tools/call down it. A screenshot of a whole page is a few MB:
// a message is at most this large, both ways.
export const RELAY_BROWSER_PATH = "/api/relay/browser/socket";
export const MAX_BROWSER_MESSAGE = 32 * 1024 * 1024;

// The result of a tool call that failed, as MCP gives it
export const toolError = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true as const });

const int = z.number().int();
const text = (max: number) => z.string().max(max);

// name of the computer of the relay (HOST_LABEL), as long as the server takes it
export const HOST_LENGTH = 100;
export const ChatName = text(1000);
export const StateKey = text(1000);
export const StateValue = text(2_000_000);

export const ChatRow = z.object({
  name: ChatName,
  preview: text(20_000).nullable(),
  pos: int.nullable(),
  ts: int.nullable(),
  tm: text(100).nullable(),
  unread: int.nullable(),
  mention: int.nullable(),
  muted: int.nullable(),
  av: text(100).nullable(),
  // relays of earlier releases send none
  presence: text(20).nullable().optional(),
  // one (1:1), group or meeting: the Call button and /api/call/start need it; relays of earlier releases send none
  kind: text(50).nullable().optional(),
});
export type ChatRow = z.infer<typeof ChatRow>;

export const MessageRow = z.object({
  idx: int,
  mid: text(200).nullable(),
  author: text(1000).nullable(),
  text: text(200_000).nullable(),
  mine: int.nullable(),
  reacts: text(20_000).nullable(),
  extra: text(2_000_000).nullable(),
});
export type MessageRow = z.infer<typeof MessageRow>;

export const ActivityRow = z.object({
  id: text(200),
  pos: int.nullable(),
  kind: text(50).nullable(),
  actor: text(1000).nullable(),
  title: text(20_000).nullable(),
  emoji: text(100).nullable(),
  preview: text(20_000).nullable(),
  tm: text(100).nullable(),
  chat: text(1000).nullable(),
  channel: int.nullable(),
  unread: int.nullable(),
  ts: int.nullable(),
  av: text(100).nullable(),
});
export type ActivityRow = z.infer<typeof ActivityRow>;

export const CallRow = z.object({ since: int, caller: text(1000).nullable(), seconds: int.nullable() });
export type CallRow = z.infer<typeof CallRow>;

export const ReadByRow = z.object({ mid: text(200), chat: text(1000).nullable(), label: text(1000).nullable(), names: text(100_000).nullable(), ts: int.nullable() });
export type ReadByRow = z.infer<typeof ReadByRow>;

// POST /api/relay/sync: the parts of relay.db that changed since the last sync the server took. The caps are the
// server's; the relay sends less at a time (src/local/server-link.ts).
export const SyncBody = z.object({
  // name of the computer of the relay (HOST_LABEL)
  host: text(HOST_LENGTH),
  // the clock of the relay when it sent this (ms): the server reads the times of the relay by its own clock from it
  now: int.positive(),
  chats: z.array(ChatRow).max(2000).optional(),
  // rows of each chat that changed; [] for a chat whose rows are gone
  messages: z
    .record(ChatName, z.array(MessageRow).max(2000))
    .refine((m) => Object.keys(m).length <= 2000, "too many chats")
    .optional(),
  // keys that changed; null for a key gone
  state: z
    .record(StateKey, StateValue.nullable())
    .refine((s) => Object.keys(s).length <= 5000, "too many keys")
    .optional(),
  activity: z.array(ActivityRow).max(2000).optional(),
  calls: z.array(CallRow).max(500).optional(),
  // rows that changed
  readby: z.array(ReadByRow).max(20_000).optional(),
  // status of the commands of the server (their id there) that changed
  commands: z.array(z.object({ id: int.positive(), status: z.enum(COMMAND_STATUSES) })).max(5000).optional(),
});
export type SyncBody = z.infer<typeof SyncBody>;

// A command the app queued for the account, as GET /api/relay/commands gives it (ts: Unix seconds it was queued)
export type ServerCommand = { id: number; ts: number; type: string; arg1: string; arg2: string };

export type CommandsAnswer = {
  // when the account took its slot: the series of its command ids
  added: number;
  commands: ServerCommand[];
  // the chat the app shows ("" once it stopped showing one), when that changed later than vts
  viewing: { chat: string; ts: number } | null;
  // devices of the owner the notifications go to
  devices: number;
};

// POST /api/relay/have: of these files, the ones the server lacks
export const HaveBody = z.object({ media: z.array(text(100)).max(20_000), files: z.array(text(100)).max(20_000) });
export type HaveBody = z.infer<typeof HaveBody>;

// POST /api/relay/push: a notification of the account, sent by the web app to the devices of its owner
export const PushBody = z.discriminatedUnion("op", [
  z.object({ op: z.literal("message"), title: text(1000), body: text(20_000), chat: text(1000) }),
  z.object({ op: z.literal("alert"), title: text(1000), body: text(20_000), urgency: z.enum(["very-low", "low", "normal", "high"]) }),
  z.object({ op: z.literal("call"), caller: text(1000), state: z.enum(["ringing", "again", "ended"]), since: int, seconds: int }),
  z.object({ op: z.literal("missedCall"), caller: text(1000), time: text(100) }),
]);
export type PushBody = z.infer<typeof PushBody>;
