// Rows of state/relay.db as the API reads them and the app receives them.

export type Chat = { name: string; preview: string; tm: string; unread: number; mention: number; muted: number; av: string };

export type Reaction = { e: string; n: number; mine: boolean };

// Rich fields of a message, stored as JSON in chat_messages.extra: only the fields with a value are present.
// An image is a file in state/media (f) or, when the page could not fetch it, its public URL (url).
export type MessageExtra = {
  quote?: { author: string; text: string };
  images?: { f?: string; url?: string; w?: number; h?: number }[];
  files?: { name: string; url: string }[];
  reactions?: Reaction[];
  status?: string;
  edited?: boolean;
  html?: string;
  mentionsMe?: boolean;
  av?: string;
  deleted?: boolean;
};

export type Message = { mid: string; author: string; text: string; mine: number; reacts: string } & MessageExtra;
