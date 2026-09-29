// The presence of a person, as the badge on their picture in the Teams chat list says it (Teams in English): the
// agent keeps one of these words per chat, "" where the list shows none (a group chat) or one it does not know.
export const PRESENCES = ["available", "busy", "dnd", "away", "offline", "ooo"] as const;
export type Presence = (typeof PRESENCES)[number];

export const PRESENCE_TEXT: Record<Presence, string> = {
  available: "Available",
  busy: "Busy",
  dnd: "Do not disturb",
  away: "Away",
  offline: "Offline",
  ooo: "Out of office",
};

// Out of office first: Teams joins it to another state ("Available, Out of office")
const LABELS: [Presence, RegExp][] = [
  ["ooo", /out of (the )?office/i],
  ["dnd", /do not disturb|presenting|focusing/i],
  ["busy", /busy|in a (call|meeting|conference)|on the phone/i],
  ["away", /away|be right back|inactive/i],
  ["offline", /offline/i],
  ["available", /available/i],
];

export function presenceOf(label: string): Presence | "" {
  for (const [p, re] of LABELS) if (re.test(label)) return p;
  return "";
}

export const isPresence = (p: string | null | undefined): p is Presence => (PRESENCES as readonly string[]).includes(p ?? "");
