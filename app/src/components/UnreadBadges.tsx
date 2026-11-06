import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { capped, type Unread } from "@/lib/client";

// chats and notifications share the purple count; missed calls have a red one of their own
export const total = (u: Unread) => u.chats + u.notifications;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const unreadText = (u: Unread) =>
  [u.chats > 0 && plural(u.chats, "unread chat", "unread chats"), u.notifications > 0 && plural(u.notifications, "new notification", "new notifications")]
    .filter(Boolean)
    .join(", ");
export const callsText = (n: number) => plural(n, "missed call", "missed calls");

export function MissedBadge({ n, className }: { n: number; className?: string }) {
  if (!n) return null;
  return (
    <Badge className={cn("h-5 min-w-5 rounded-full bg-destructive px-1.5 text-white tabular-nums", className)} title={callsText(n)}>
      {capped(n)}
      <span className="sr-only"> ({callsText(n)})</span>
    </Badge>
  );
}

export const NO_UNREAD: Unread = { chats: 0, notifications: 0, calls: 0 };
export const addUnread = (a: Unread, b: Unread): Unread => ({ chats: a.chats + b.chats, notifications: a.notifications + b.notifications, calls: a.calls + b.calls });

// What waits in one account, as its rows show it: the purple count, then the red one
export function UnreadBadges({ u, className }: { u: Unread; className?: string }) {
  return (
    <>
      {total(u) > 0 && (
        <Badge className={cn("h-5 min-w-5 rounded-full px-1.5 tabular-nums", className)} title={unreadText(u)}>
          {capped(total(u))}
          <span className="sr-only"> ({unreadText(u)})</span>
        </Badge>
      )}
      <MissedBadge n={u.calls} className={className} />
    </>
  );
}
