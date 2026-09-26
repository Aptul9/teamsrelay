import { avColor, initials, isSelf, mediaUrl } from "@/lib/client";

export const BELL_OFF = (
  <svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-label="Muted">
    <path d="M4 7.57c.04-.82.24-1.59.58-2.28L2.15 2.85a.5.5 0 1 1 .7-.7l15 15a.5.5 0 0 1-.7.7L14.3 15h-1.8v.17a2.5 2.5 0 0 1-5 0V15H4a1 1 0 0 1-.26-.03l-.13-.04a1 1 0 0 1-.6-1.05l.02-.13.05-.13L4 11.4V7.57ZM13.3 14 5.34 6.05a4.6 4.6 0 0 0-.32 1.33L5 7.6V11.5l-.04.2L4 14h9.3Zm-1.8 1h-3v.14a1.5 1.5 0 0 0 1.36 1.34l.14.01c.78 0 1.42-.6 1.5-1.36V15ZM10 3a5 5 0 0 1 5 4.78V11.4l.87 2.1-.95-.95L14 10.6V8a4 4 0 0 0-6.63-3.01l-.7-.7A4.98 4.98 0 0 1 10 3Z" />
  </svg>
);

// Profile picture copied from Teams when there is one, otherwise initials on a colour
export function Avatar({
  name,
  av,
  acc,
  muted,
  className = "",
  hidden,
  children,
}: {
  name: string;
  av?: string;
  acc: number;
  muted?: boolean;
  className?: string;
  hidden?: boolean;
  children?: React.ReactNode;
}) {
  const cls = `av${muted ? " muted" : ""}${hidden ? " sp" : ""}${className ? ` ${className}` : ""}`;
  if (hidden) return <div className={cls} />;
  if (muted) return <div className={cls}>{BELL_OFF}</div>;
  if (av) {
    return (
      <div className={cls} style={{ background: "transparent" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- files served by the app, with the session cookie */}
        <img src={mediaUrl(av, acc)} alt="" />
        {children}
      </div>
    );
  }
  return (
    <div className={cls} style={{ background: avColor(name || "?") }}>
      {isSelf(name) ? "★" : initials(name)}
      {children}
    </div>
  );
}

export function Logo({ size = 19 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 8h14" />
      <path d="M12 8v9.5" />
      <path d="M7.7 5.7 5 8l2.7 2.3" />
      <path d="M16.3 5.7 19 8l-2.7 2.3" />
    </svg>
  );
}
