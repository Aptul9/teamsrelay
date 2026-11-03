"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { StatusAnswer, StatusDay } from "@/lib/status-pages";
import { bests, challengeTotals, clock, dayStart, hourBounds, nextDay, type Known } from "@/lib/status-stats";
import { STATUSES, type Status } from "@/shared/status";

// The public dashboard of a status page (app/status-challenge-spec.md, Dashboard and visualization; design in
// app/design-system/status-challenge/). Charts in plain SVG with sizes in percent, so text keeps its size at any width.

type Shown = Known | "nodata";

const WORD: Record<Shown, string> = {
  available: "Available",
  busy: "Busy",
  dnd: "Do not disturb",
  brb: "Be right back",
  away: "Away",
  offline: "Offline",
  nodata: "No data",
};
const ORDER: Shown[] = [...STATUSES, "nodata"];
const shown = (s: Status | Shown): Shown => (s === "unknown" ? "nodata" : s);
// the fill of each status: solid, or a pattern of the defs below, so that no two read the same without color
const FILL: Record<Shown, string> = {
  available: "var(--success)",
  busy: "var(--destructive)",
  dnd: "url(#sc-dnd)",
  brb: "url(#sc-brb)",
  away: "var(--warning)",
  offline: "color-mix(in oklch, var(--muted-foreground) 38%, var(--card))",
  nodata: "url(#sc-nodata)",
};

function Patterns() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="sc-dnd" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="var(--destructive)" />
          <rect width="2.5" height="6" fill="var(--card)" opacity="0.75" />
        </pattern>
        <pattern id="sc-brb" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="var(--warning)" />
          <circle cx="3" cy="3" r="1.3" fill="var(--card)" opacity="0.85" />
        </pattern>
        <pattern id="sc-nodata" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="var(--muted)" />
          <rect width="1.5" height="6" fill="var(--muted-foreground)" opacity="0.45" />
        </pattern>
      </defs>
    </svg>
  );
}

function Swatch({ s, className = "size-3.5" }: { s: Shown; className?: string }) {
  return (
    <svg className={`${className} shrink-0 rounded-[3px]`} aria-hidden="true" focusable="false">
      <rect width="100%" height="100%" fill={FILL[s]} />
    </svg>
  );
}

function Legend({ items = ORDER }: { items?: Shown[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground" aria-label="Legend">
      {items.map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <Swatch s={s} />
          {WORD[s]}
        </li>
      ))}
    </ul>
  );
}

function duration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return "under 1 min";
  const h = Math.floor(m / 60);
  return h ? (m % 60 ? `${h} h ${m % 60} min` : `${h} h`) : `${m} min`;
}

const hoursText = (h: number) => `${h.toFixed(1)} h`;
const dayName = (day: string, zone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "long", day: "numeric", month: "long" }).format(new Date((dayStart(day, zone) + 12 * 3600) * 1000));
const shortDay = (day: string, zone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric" }).format(new Date((dayStart(day, zone) + 12 * 3600) * 1000));

function Section({ title, className = "", delay, children }: { title: string; className?: string; delay: number; children: React.ReactNode }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={`min-w-0 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10 animate-in fade-in slide-in-from-bottom-2 duration-350 fill-mode-both motion-reduce:animate-none md:p-5 ${className}`}
      style={{ animationDelay: `${delay * 60}ms` }}
    >
      <h2 id={id} className="mb-3 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

// The line under a chart with the values of the part hovered or focused; its height is kept when empty
function Readout({ text, hint }: { text: string; hint: string }) {
  return (
    <p data-testid="readout" aria-live="polite" className={`mt-2 min-h-5 text-sm tabular-nums ${text ? "text-foreground" : "text-muted-foreground"}`}>
      {text || hint}
    </p>
  );
}

function useReadout() {
  const [text, setText] = useState("");
  const bind = (t: string) => ({
    onMouseEnter: () => setText(t),
    onFocus: () => setText(t),
    onMouseLeave: () => setText(""),
    onBlur: () => setText(""),
  });
  return { text, bind };
}

const FOCUS = "outline-none focus-visible:stroke-foreground focus-visible:[stroke-width:3px] hover:opacity-85 cursor-pointer";

function Now({ data, now }: { data: StatusAnswer; now: number }) {
  const n = data.now;
  const fresh = !!n?.fresh;
  const s: Shown = n && fresh ? shown(n.status) : "nodata";
  const today = data.days.at(-1);
  return (
    <Section title="Now" delay={0}>
      <div className="flex flex-wrap items-center gap-4">
        <svg className="size-14 shrink-0" viewBox="0 0 56 56" aria-hidden="true" focusable="false">
          <circle cx="28" cy="28" r="26" fill={FILL[s]} />
          <circle cx="28" cy="28" r="26" fill="none" stroke="var(--foreground)" strokeOpacity="0.12" strokeWidth="2" />
        </svg>
        <div className="min-w-0">
          <p className="text-3xl font-semibold tracking-tight">{n && fresh ? WORD[s] : "No data"}</p>
          <p className="text-sm text-muted-foreground tabular-nums">
            {!n
              ? "Nothing collected yet"
              : fresh
                ? `since ${clock(n.since, data.zone)} · ${duration(now - n.since)}`
                : `No data since ${clock(data.updated, data.zone)}${data.ends && data.ends <= now ? " · the challenge has ended" : ""}`}
          </p>
        </div>
      </div>
      {today && (
        <dl className="mt-4 grid grid-cols-3 gap-3 border-t pt-4">
          {[
            ["Online today", hoursText(today.hours.available + today.hours.busy + today.hours.dnd + today.hours.brb + today.hours.away)],
            ["Available today", hoursText(today.hours.available)],
            ["Changes today", String(Math.max(0, (today.stretches ?? []).length - 1))],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

// The longest stretch of the status that held most of the online time
function todaySummary(d: StatusDay, zone: string): string {
  const online = (["available", "busy", "dnd", "brb", "away"] as const).filter((k) => d.hours[k] > 0);
  if (!online.length) return "Not online today so far.";
  const top = online.reduce((a, b) => (d.hours[b] > d.hours[a] ? b : a));
  const total = online.reduce((n, k) => n + d.hours[k], 0);
  const longest = (d.stretches ?? []).filter(([, , s]) => s === top).reduce<[number, number] | null>((b, [a, z]) => (!b || z - a > b[1] - b[0] ? [a, z] : b), null);
  const run = longest ? ` Longest: ${clock(longest[0], zone)} to ${clock(longest[1], zone)}.` : "";
  return `Mostly ${WORD[top].toLowerCase()} so far: ${hoursText(d.hours[top])} of ${hoursText(total)} online.${run}`;
}

function Today({ data, now }: { data: StatusAnswer; now: number }) {
  const { text, bind } = useReadout();
  const d = data.days.at(-1);
  if (!d) return null;
  const start = dayStart(d.day, data.zone);
  const end = dayStart(nextDay(d.day), data.zone);
  const at = (t: number) => ((Math.min(Math.max(t, start), end) - start) / (end - start)) * 100;
  const pct = (t: number) => `${at(t).toFixed(3)}%`;
  const live = now >= start && now < end;
  const until = live ? now : end;
  return (
    <Section title="Today" delay={1}>
      <p className="mb-3 text-sm">
        <span className="font-medium">{dayName(d.day, data.zone)}</span> <span className="text-muted-foreground">{todaySummary(d, data.zone)}</span>
      </p>
      <svg width="100%" height="44" role="group" aria-label={`Status from 00:00 to 24:00 of ${dayName(d.day, data.zone)}`} className="block overflow-visible">
        <rect x="0" y="4" width={pct(until)} height="32" fill={FILL.nodata} rx="3" />
        {live && <rect x={pct(now)} y="4" width={`${(100 - at(now)).toFixed(3)}%`} height="32" fill="var(--muted)" opacity="0.5" />}
        {(d.stretches ?? []).map(([a, z, st]) => {
          const label = `${WORD[shown(st)]}, ${clock(a, data.zone)} to ${z >= end ? "24:00" : clock(z, data.zone)}, ${duration(z - a)}`;
          return (
            <rect
              key={a}
              x={pct(a)}
              y="4"
              width={`${Math.max(0.15, at(z) - at(a)).toFixed(3)}%`}
              height="32"
              fill={FILL[shown(st)]}
              tabIndex={0}
              role="img"
              aria-label={label}
              className={FOCUS}
              {...bind(label.replace(/, /g, " · "))}
            />
          );
        })}
        {live && (
          <g aria-hidden="true">
            <line x1={pct(now)} x2={pct(now)} y1="0" y2="40" stroke="var(--foreground)" strokeWidth="2" />
          </g>
        )}
      </svg>
      <div className="relative mt-1 h-4 text-[11px] text-muted-foreground tabular-nums" aria-hidden="true">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: `${(h / 24) * 100}%` }}>
            {String(h).padStart(2, "0")}:00
          </span>
        ))}
      </div>
      <Readout text={text} hint="Hover, tap or focus a segment for its times." />
      <div className="mt-3">
        <Legend />
      </div>
    </Section>
  );
}

function glanceSummary(days: StatusDay[]): string {
  const counts = new Map<number, Map<Shown, number>>();
  for (const d of days)
    d.byHour.forEach((s, h) => {
      if (s === "nodata" || s === "offline") return;
      const m = counts.get(h) ?? new Map<Shown, number>();
      m.set(s, (m.get(s) ?? 0) + 1);
      counts.set(h, m);
    });
  const avail = [...counts].filter(([, m]) => (m.get("available") ?? 0) * 2 >= [...m.values()].reduce((a, b) => a + b, 0)).map(([h]) => h).sort((a, b) => a - b);
  if (!avail.length) return `${days.length} ${days.length === 1 ? "day" : "days"}: no hour mostly available yet.`;
  // the longest run of adjacent hours mostly available
  let best = [avail[0], avail[0]];
  let cur = [avail[0], avail[0]];
  for (const h of avail.slice(1)) {
    cur = h === cur[1] + 1 ? [cur[0], h] : [h, h];
    if (cur[1] - cur[0] > best[1] - best[0]) best = cur;
  }
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return `Over ${days.length} ${days.length === 1 ? "day" : "days"}: mostly available between ${hh(best[0])} and ${hh(best[1] + 1)}.`;
}

function Glance({ data, now }: { data: StatusAnswer; now: number }) {
  const { text, bind } = useReadout();
  function move(e: React.KeyboardEvent<SVGElement>) {
    const t = e.target as SVGElement;
    const r = Number(t.dataset.r);
    const c = Number(t.dataset.c);
    if (Number.isNaN(r)) return;
    const to = { ArrowRight: [r, c + 1], ArrowLeft: [r, c - 1], ArrowDown: [r + 1, c], ArrowUp: [r - 1, c] }[e.key];
    if (!to) return;
    const next = e.currentTarget.closest("[data-glance]")?.querySelector<SVGElement>(`[data-r="${to[0]}"][data-c="${to[1]}"]`);
    if (next) {
      e.preventDefault();
      next.focus();
    }
  }
  return (
    <Section title="Challenge at a glance" className="lg:col-span-2" delay={2}>
      <p className="mb-3 text-sm text-muted-foreground">{glanceSummary(data.days)} Each cell is the status that held most of that hour.</p>
      <div data-glance className="space-y-1">
        {data.days.map((d, r) => {
          const bounds = hourBounds(d.day, data.zone);
          const n = d.byHour.length;
          return (
            <div key={d.day} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">{shortDay(d.day, data.zone)}</span>
              <svg width="100%" height="22" role="group" aria-label={dayName(d.day, data.zone)} className="block min-w-0 flex-1" onKeyDown={move}>
                {d.byHour.map((s, c) => {
                  const from = bounds[c];
                  const to = bounds[c + 1];
                  const future = from >= now;
                  const label = `${dayName(d.day, data.zone)}, ${clock(from, data.zone)} to ${to >= bounds[n] ? "24:00" : clock(to, data.zone)}, ${future ? "to come" : WORD[s]}`;
                  return (
                    <rect
                      key={c}
                      x={`${(c / n) * 100}%`}
                      y="1"
                      width={`${100 / n}%`}
                      height="20"
                      rx="2"
                      fill={future ? "transparent" : FILL[s]}
                      stroke={future ? "var(--border)" : "var(--card)"}
                      strokeWidth="2"
                      tabIndex={r === 0 && c === 0 ? 0 : -1}
                      data-r={r}
                      data-c={c}
                      role="img"
                      aria-label={label}
                      className={FOCUS}
                      {...bind(label.replace(/, /g, " · "))}
                    />
                  );
                })}
              </svg>
            </div>
          );
        })}
      </div>
      <div className="relative mt-1 ml-16 h-4 text-[11px] text-muted-foreground tabular-nums" aria-hidden="true">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: `${(h / 24) * 100}%` }}>
            {String(h).padStart(2, "0")}
          </span>
        ))}
      </div>
      <Readout text={text} hint="Hover, tap or focus a cell; arrow keys move between hours and days." />
      <div className="mt-3">
        <Legend />
      </div>
    </Section>
  );
}

function HoursPerDay({ data }: { data: StatusAnswer }) {
  const { text, bind } = useReadout();
  const t = challengeTotals(data.days);
  const longest = Math.max(24, ...data.days.map((d) => ORDER.reduce((n, k) => n + d.hours[k], 0)));
  const online = (h: StatusDay["hours"]) => h.available + h.busy + h.dnd + h.brb + h.away;
  return (
    <Section title="Hours per day" delay={3}>
      <p className="mb-3 text-sm text-muted-foreground">
        Over {t.days} {t.days === 1 ? "day" : "days"}: {hoursText(t.average.available)} available and {hoursText(online(t.average))} online a day on average.
      </p>
      <div className="space-y-2">
        {data.days.map((d) => {
          let x = 0;
          return (
            <div key={d.day} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">{shortDay(d.day, data.zone)}</span>
              <svg width="100%" height="26" role="group" aria-label={`Hours of ${dayName(d.day, data.zone)}`} className="block min-w-0 flex-1">
                {ORDER.filter((k) => d.hours[k] > 0).map((k) => {
                  const w = (d.hours[k] / longest) * 100;
                  const left = x;
                  x += w;
                  const label = `${dayName(d.day, data.zone)}, ${WORD[k]}, ${hoursText(d.hours[k])}`;
                  return (
                    <g key={k}>
                      <rect x={`${left}%`} y="1" width={`${w}%`} height="24" fill={FILL[k]} tabIndex={0} role="img" aria-label={label} className={FOCUS} {...bind(label.replace(/, /g, " · "))} />
                      {w >= 12 && (
                        <text x={`${left + w / 2}%`} y="17" textAnchor="middle" className="pointer-events-none fill-foreground stroke-card text-[11px] font-medium tabular-nums [paint-order:stroke] [stroke-width:3px]" aria-hidden="true">
                          {hoursText(d.hours[k])}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>
          );
        })}
      </div>
      <Readout text={text} hint="Hover, tap or focus a segment for its hours." />
      <div className="mt-3">
        <Legend />
      </div>
    </Section>
  );
}

function Scoreboard({ data }: { data: StatusAnswer }) {
  const today = data.days.at(-1);
  const b = bests(data.days);
  const percent = (g: number | null) => (g === null ? "-" : `${Math.round(g * 100)}%`);
  const cards = [
    { label: "First online", value: today?.firstOnline || "-", best: b.firstOnline && { v: b.firstOnline.value, day: b.firstOnline.day }, note: "earliest" },
    { label: "Last online", value: today?.lastOnline || "-", best: b.lastOnline && { v: b.lastOnline.value, day: b.lastOnline.day }, note: "latest" },
    { label: "Longest Available", value: today?.longestAvailable ? duration(today.longestAvailable * 60) : "-", best: b.longestAvailable && { v: duration(b.longestAvailable.value * 60), day: b.longestAvailable.day }, note: "longest" },
    { label: "Green share", value: percent(today?.green ?? null), best: b.green && { v: percent(b.green.value), day: b.green.day }, note: "highest" },
  ];
  return (
    <Section title="Scoreboard" delay={4}>
      <p className="mb-3 text-sm text-muted-foreground">Today against the best day of the challenge. Green share: available over online time.</p>
      <dl className="grid grid-cols-2 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg bg-muted/60 p-3">
            <dt className="text-xs text-muted-foreground">{c.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{c.value}</dd>
            <dd className="mt-1 text-xs text-muted-foreground tabular-nums">
              {c.best ? (c.best.day === today?.day ? `${c.note} of the challenge` : `best ${c.best.v}, ${shortDay(c.best.day, data.zone)}`) : "no day yet"}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function DataTable({ data }: { data: StatusAnswer }) {
  const t = challengeTotals(data.days);
  const cells = (h: StatusDay["hours"]) => ORDER.map((k) => <td key={k} className="px-2 py-1.5 text-right">{h[k].toFixed(1)}</td>);
  return (
    <section className="min-w-0 rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10 lg:col-span-2">
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring md:px-5">
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Data per day</h2>
          <span className="text-xs text-muted-foreground group-open:hidden">Show the numbers</span>
          <span className="hidden text-xs text-muted-foreground group-open:inline">Hide</span>
        </summary>
        <div className="overflow-x-auto px-2 pb-4 md:px-3">
          <table className="w-full min-w-[46rem] text-sm tabular-nums">
            <caption className="sr-only">Hours per status, first and last online, longest Available streak and green share of each day</caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-2 py-1.5 text-left font-medium">Day</th>
                {ORDER.map((k) => (
                  <th key={k} scope="col" className="px-2 py-1.5 text-right font-medium">
                    {WORD[k]}
                  </th>
                ))}
                <th scope="col" className="px-2 py-1.5 text-right font-medium">First online</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Last online</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Longest Available</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Green</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.days.map((d) => (
                <tr key={d.day}>
                  <th scope="row" className="px-2 py-1.5 text-left font-medium whitespace-nowrap">{d.day}</th>
                  {cells(d.hours)}
                  <td className="px-2 py-1.5 text-right">{d.firstOnline || "-"}</td>
                  <td className="px-2 py-1.5 text-right">{d.lastOnline || "-"}</td>
                  <td className="px-2 py-1.5 text-right">{d.longestAvailable ? duration(d.longestAvailable * 60) : "-"}</td>
                  <td className="px-2 py-1.5 text-right">{d.green === null ? "-" : `${Math.round(d.green * 100)}%`}</td>
                </tr>
              ))}
              <tr className="font-medium">
                <th scope="row" className="px-2 py-1.5 text-left">Total</th>
                {cells(t.total)}
                <td colSpan={4} className="px-2 py-1.5 text-right text-muted-foreground">
                  {t.days} {t.days === 1 ? "day" : "days"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

const REFRESH_MS = 60_000;

export function StatusDashboard({ slug, initial, serverNow }: { slug: string; initial: StatusAnswer; serverNow: number }) {
  const [data, setData] = useState(initial);
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    let alive = true;
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    const load = async () => {
      try {
        const r = await fetch(`/api/status/${encodeURIComponent(slug)}`, { cache: "no-store" });
        if (r.ok && alive) setData((await r.json()) as StatusAnswer);
      } catch {
        // the last answer stays; the Now card tells when it gets old
      }
      tick();
    };
    tick();
    const every = setInterval(() => void load(), REFRESH_MS);
    const clockEvery = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(every);
      clearInterval(clockEvery);
    };
  }, [slug]);

  const updated = useMemo(() => (data.updated ? clock(data.updated, data.zone) : ""), [data.updated, data.zone]);

  return (
    <div className="min-h-dvh bg-background">
      <Patterns />
      <main className="mx-auto max-w-6xl px-3 pt-[calc(env(safe-area-inset-top)+1.25rem)] pb-[calc(env(safe-area-inset-bottom)+1.5rem)] md:px-6 md:pt-10">
        <header className="mb-4 md:mb-6">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Status challenge</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">{data.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground tabular-nums">
            Teams status as Teams shows it{updated ? `, updated ${updated}` : ""}. Times in {data.zone.replace("_", " ")}.
          </p>
        </header>
        <div className="grid gap-3 md:gap-4 lg:grid-cols-2">
          <Now data={data} now={now} />
          <Today data={data} now={now} />
          <Glance data={data} now={now} />
          <HoursPerDay data={data} />
          <Scoreboard data={data} />
          <DataTable data={data} />
        </div>
      </main>
    </div>
  );
}
