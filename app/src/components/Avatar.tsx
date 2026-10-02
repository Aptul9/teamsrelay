import { BellOffIcon } from "lucide-react";
import { cn } from "cn";
import { Avatar as AvatarRoot, AvatarBadge, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials, mediaUrl } from "@/lib/client";
import { isPresence, PRESENCE_TEXT, type Presence } from "@/shared/presence";

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

// Colours of Teams: green available, red busy or do not disturb, yellow away, grey offline, purple out of office
const PRESENCE_DOT: Record<Presence, string> = {
  available: "bg-emerald-500",
  busy: "bg-red-500",
  dnd: "bg-red-500",
  away: "bg-amber-400",
  offline: "bg-zinc-400",
  ooo: "bg-fuchsia-500",
};

// Profile picture copied from Teams when there is one, otherwise initials on a tint derived from the name. presence:
// the dot of the person's presence in Teams, at the bottom; a muted chat keeps its crossed bell, at the top when
// there is a dot.
export function Avatar({
  name,
  av,
  acc,
  muted,
  presence,
  className,
  children,
}: {
  name: string;
  av?: string;
  acc: number;
  muted?: boolean;
  presence?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const p = isPresence(presence) ? presence : null;
  return (
    <AvatarRoot className={cn("size-10", className)}>
      {av ? <AvatarImage src={mediaUrl(av, acc)} alt="" /> : null}
      <AvatarFallback
        style={{ "--h": hue(name || "?") } as React.CSSProperties}
        className="bg-[oklch(0.92_0.05_var(--h))] font-semibold text-[oklch(0.4_0.12_var(--h))] dark:bg-[oklch(0.34_0.07_var(--h))] dark:text-[oklch(0.9_0.06_var(--h))]"
      >
        {initials(name)}
      </AvatarFallback>
      {muted ? (
        <AvatarBadge className={cn("size-4! bg-muted text-muted-foreground [&>svg]:size-2.5! [&>svg]:block!", p && "top-0 bottom-auto")} aria-label="Muted">
          <BellOffIcon />
        </AvatarBadge>
      ) : null}
      {p ? (
        <AvatarBadge data-presence={p} role="img" aria-label={PRESENCE_TEXT[p]} title={PRESENCE_TEXT[p]} className={cn("size-3!", PRESENCE_DOT[p])}>
          {/* do not disturb: the white bar of Teams, apart from busy */}
          {p === "dnd" ? <span className="h-0.5 w-1.5 rounded-full bg-white" /> : null}
        </AvatarBadge>
      ) : null}
      {children}
    </AvatarRoot>
  );
}

function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 8h14" />
      <path d="M12 8v9.5" />
      <path d="M7.7 5.7 5 8l2.7 2.3" />
      <path d="M16.3 5.7 19 8l-2.7 2.3" />
    </svg>
  );
}

export function LogoTile({ className }: { className?: string }) {
  return (
    <div className={cn("grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm", className)}>
      <Logo className="size-[55%]" />
    </div>
  );
}
