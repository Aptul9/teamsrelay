import { BellOffIcon } from "lucide-react";
import { cn } from "cn";
import { Avatar as AvatarRoot, AvatarBadge, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials, mediaUrl } from "@/lib/client";

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

// Profile picture copied from Teams when there is one, otherwise initials on a tint derived from the name
export function Avatar({
  name,
  av,
  acc,
  muted,
  className,
  children,
}: {
  name: string;
  av?: string;
  acc: number;
  muted?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
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
        <AvatarBadge className="size-4! bg-muted text-muted-foreground [&>svg]:size-2.5! [&>svg]:block!" aria-label="Muted">
          <BellOffIcon />
        </AvatarBadge>
      ) : null}
      {children}
    </AvatarRoot>
  );
}

export function Logo({ className }: { className?: string }) {
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
