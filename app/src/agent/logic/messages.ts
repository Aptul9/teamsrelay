import type { MessageExtra } from "@/shared/slot-db/rows";

const EXTRA_KEYS = ["quote", "images", "files", "reactions", "status", "edited", "readby", "html", "mentionsMe", "av", "deleted"] as const;

// A value worth storing: empty strings, lists and objects, false, 0 and null are left out
function hasValue(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return !!v;
}

// chat_messages.extra: the rich fields of a message that have a value, null when none has
export function extraOf(m: MessageExtra): MessageExtra | null {
  const extra: Record<string, unknown> = {};
  for (const k of EXTRA_KEYS) if (hasValue(m[k])) extra[k] = m[k];
  return Object.keys(extra).length ? (extra as MessageExtra) : null;
}
