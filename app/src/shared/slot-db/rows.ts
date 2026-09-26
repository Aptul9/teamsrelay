// Rows of data/N/messages.db as the web app reads them and the PWA receives them.

export type Chat = { name: string; preview: string; tm: string; unread: number; mention: number; muted: number; av: string };

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

export const ACTIVITY_KINDS = ["reaction", "mention", "reply", "task", "team", "call", "meeting", "message"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

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
