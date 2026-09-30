// Rows of data/N/messages.db as the web app reads them and the PWA receives them.

// presence: a word of shared/presence, "" when the list shows none; kind: a ChatKind, "" when the list shows none
export type Chat = { name: string; preview: string; tm: string; unread: number; mention: number; muted: number; av: string; presence: string; kind: string };

// The kinds of chat the Teams list marks: a 1:1 chat with a person (the only one the app can call), a group chat, the
// chat of a meeting
export const CHAT_KINDS = ["one", "group", "meeting"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

export type Reaction = { e: string; n: number; mine: boolean };
export type ReadBy = { label: string; names: string[] };

// Rich fields of a message, stored as JSON in chat_messages.extra: only the fields with a value are present.
// An image is a file in data/N/media (f) or, when the page could not fetch it, its public URL (url).
export type MessageExtra = {
  quote?: { author: string; text: string };
  images?: { f?: string; url?: string; w?: number; h?: number }[];
  files?: { name: string; url: string }[];
  reactions?: Reaction[];
  status?: string;
  edited?: boolean;
  readby?: ReadBy;
  html?: string;
  mentionsMe?: boolean;
  av?: string;
  deleted?: boolean;
};

export type Message = { mid: string; author: string; text: string; mine: number; reacts: string } & MessageExtra;

// Names of the files in the media folder, the only ones the apps serve from it
export const MEDIA_NAME = /^[0-9a-f]{16}\.(png|jpg|gif|webp)$/;
// Names of the attachments the agent downloaded into the files folder
export const FILE_NAME = /^[0-9a-f]{16}(\.[a-z0-9]{1,8})?$/;

export const ACTIVITY_KINDS = ["reaction", "mention", "reply", "task", "team", "call", "meeting", "message"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

// An Activity item saved without its Teams id gets its place as id (x0, x1...: src/agent/store/slot-store.ts): once
// the feed moves the id names another item, so no count and no push goes by it
export const hasTeamsId = (id: string) => !/^x\d+$/.test(id);
// The same in SQL, for the id column of the activity table
export const HAS_TEAMS_ID = "id NOT GLOB 'x[0-9]*'";

// A call the agent saw ring (since: ms on the wall clock, seconds it rang), newest first
export type CallLogEntry = { caller: string; since: number; seconds: number };

export type ActivityItem = {
  id: string;
  kind: string;
  actor: string;
  title: string;
  emoji: string;
  preview: string;
  tm: string;
  chat: string;
  channel: number;
  unread: number;
  av: string;
};
