import { REACTION_EMOJI, type ActivityKind } from "@/shared/slot-db/rows";
import type { ActivityEntry } from "../store/slot-store";
import type { Notification } from "./api";
import { listTime } from "./list";

const FEED_LIMIT = 40;

// The kind the page feed gives the item (src/agent/teams/scripts/activity.ts)
export function activityKind(type = "", subtype = ""): ActivityKind {
  if (type === "call") return "call";
  if (type === "mentionInChat" || type === "mentions" || /mention/i.test(type)) return "mention";
  if (/reaction/i.test(type)) return "reaction";
  if (/reply/i.test(type)) return "reply";
  if (/task/i.test(subtype)) return "task";
  if (/meeting/i.test(subtype) || /meeting/i.test(type)) return "meeting";
  if (/team|channel/i.test(type)) return "team";
  return "message";
}

function title(kind: ActivityKind, actor: string): string {
  const who = actor || "Someone";
  switch (kind) {
    case "call":
      return actor ? `Missed call from ${actor}` : "Missed call";
    case "mention":
      return `${who} mentioned you`;
    case "reaction":
      return `${who} reacted to your message`;
    case "reply":
      return `${who} replied`;
    default:
      return who;
  }
}

// The Activity feed of a light account, as the page feed saves it: its ids are the activity ids of Teams, the ones the
// page feed shows too (prod, 2026-11-03), so the missed calls and mentions told before a change of mode stay told. A
// chat goes by the name the chat list gives it; a 1:1 chat and a call by the person; a channel by its topic.
export function lightFeed(items: readonly Notification[], chatOf: (conversation: string) => string, now: Date): ActivityEntry[] {
  const at = (n: Notification) => Date.parse(n.activity.activityTimestamp ?? "") || 0;
  return [...items]
    .filter((n) => n.activity.activityId !== undefined && n.activity.activityId !== "")
    .sort((x, y) => at(y) - at(x))
    .slice(0, FEED_LIMIT)
    .map((n) => {
      const a = n.activity;
      const kind = activityKind(a.activityType, a.activitySubtype);
      const actor = (a.sourceUserImDisplayName ?? "").trim();
      const channel = /topic|space|channel/i.test(a.sourceThreadType ?? "");
      const listed = a.sourceThreadId ? chatOf(a.sourceThreadId) : "";
      const chat = kind === "call" ? actor : channel ? (a.sourceThreadTopic ?? "") : listed || (a.sourceThreadId?.includes("@unq.gbl.spaces") ? actor : (a.sourceThreadTopic ?? ""));
      return {
        id: String(a.activityId),
        kind,
        actor,
        title: title(kind, actor),
        emoji: kind === "reaction" ? (REACTION_EMOJI[a.activitySubtype === "sad" ? "cry" : (a.activitySubtype ?? "")] ?? "") : "",
        preview: (a.messagePreview ?? "").slice(0, 300),
        tm: listTime(new Date(at(n)), now),
        chat,
        channel,
        unread: !n.read,
        av: "",
      };
    });
}
