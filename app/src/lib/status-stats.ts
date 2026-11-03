import { STATUSES, type Status } from "@/shared/status";

// Stats of the status challenge (app/status-challenge-spec.md, Stats), pure: the API computes them, the page sums them.
// Times are Unix seconds, days YYYY-MM-DD in the zone of the challenge.

export type Stretch = [since: number, until: number, status: Status];
export type Known = (typeof STATUSES)[number];
export type Hours = Record<Known | "nodata", number>;
export type DayStats = {
  day: string;
  hours: Hours;
  firstOnline: string;
  lastOnline: string;
  longestAvailable: number;
  green: number | null;
  byHour: (Known | "nodata")[];
  // the stretches of the day as the timeline draws them: joined, clipped to the day
  stretches: Stretch[];
};

const ONLINE: readonly Known[] = ["available", "busy", "dnd", "brb", "away"];
const round2 = (n: number) => Math.round(n * 100) / 100;

const parts = new Map<string, Intl.DateTimeFormat>();
function fields(t: number, zone: string) {
  let f = parts.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    parts.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

// seconds the zone is ahead of UTC at t
function offset(t: number, zone: string): number {
  const f = fields(t, zone);
  return (Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s) - t * 1000) / 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dayOf(t: number, zone: string): string {
  const f = fields(t, zone);
  return `${f.y}-${pad(f.mo)}-${pad(f.d)}`;
}

export function clock(t: number, zone: string): string {
  const f = fields(t, zone);
  return `${pad(f.h)}:${pad(f.mi)}`;
}

// Unix s of 00:00 of the day in the zone
export function dayStart(day: string, zone: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const local = Date.UTC(y, m - 1, d) / 1000;
  let t = local - offset(local, zone);
  t = local - offset(t, zone);
  return t;
}

export function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// The start of each hour of the day and the end of the day: 25 values, 24 or 26 on a DST change
export function hourBounds(day: string, zone: string): number[] {
  const start = dayStart(day, zone);
  const end = dayStart(nextDay(day), zone);
  const out: number[] = [];
  for (let t = start; t < end; t += 3600) out.push(t);
  out.push(end);
  return out;
}

// A stretch runs until the next one when that came at most `gap` after its last poll (a change of status between two
// polls), else until its last poll, the rest being no data; the newest one runs until now while it is fresh. Stretches
// of one status that touch are joined.
export function joinStretches(stretches: readonly Stretch[], gap: number, now: number): Stretch[] {
  const s = [...stretches].sort((a, b) => a[0] - b[0]);
  const out: Stretch[] = [];
  s.forEach(([since, until, status], i) => {
    const next = s[i + 1];
    let end = until;
    if (next && next[0] - until <= gap) end = Math.max(until, next[0]);
    else if (!next && now - until <= gap) end = Math.max(until, now);
    const last = out[out.length - 1];
    if (last && last[2] === status && last[1] >= since) last[1] = Math.max(last[1], end);
    else out.push([since, end, status]);
  });
  return out;
}

export function dayStats(stretches: readonly Stretch[], day: string, o: { zone: string; now: number; gap: number }): DayStats {
  const bounds = hourBounds(day, o.zone);
  const start = bounds[0];
  const limit = Math.max(start, Math.min(bounds[bounds.length - 1], o.now));
  const segs: Stretch[] = joinStretches(stretches, o.gap, o.now)
    .map(([a, b, s]): Stretch => [Math.max(a, start), Math.min(b, limit), s])
    .filter(([a, b]) => b > a);

  const seconds = Object.fromEntries([...STATUSES, "nodata"].map((k) => [k, 0])) as Hours;
  for (const [a, b, s] of segs) if (s !== "unknown") seconds[s] += b - a;
  const known = STATUSES.reduce((n, k) => n + seconds[k], 0);
  seconds.nodata = limit - start - known;
  const hours = Object.fromEntries(Object.entries(seconds).map(([k, v]) => [k, round2(v / 3600)])) as Hours;

  const online = segs.filter(([, , s]) => s !== "unknown" && ONLINE.includes(s));
  const end = bounds[bounds.length - 1];
  const clockOf = (t: number) => (t >= end ? "24:00" : clock(t, o.zone));
  const onlineSeconds = ONLINE.reduce((n, k) => n + seconds[k], 0);

  // the status that held most of each hour; no data (gaps, unknown, the hours still to come today) when that is most
  const byHour = bounds.slice(0, -1).map((h0, i) => {
    const h1 = bounds[i + 1];
    const cover = new Map<Known | "nodata", number>([["nodata", h1 - h0]]);
    for (const [a, b, s] of segs) {
      const x = Math.min(b, h1) - Math.max(a, h0);
      if (x <= 0 || s === "unknown") continue;
      cover.set(s, (cover.get(s) ?? 0) + x);
      cover.set("nodata", cover.get("nodata")! - x);
    }
    let best: Known | "nodata" = "nodata";
    for (const k of STATUSES) if ((cover.get(k) ?? 0) > cover.get(best)!) best = k;
    return best;
  });

  return {
    day,
    hours,
    firstOnline: online.length ? clockOf(online[0][0]) : "",
    lastOnline: online.length ? clockOf(online[online.length - 1][1]) : "",
    longestAvailable: Math.round(Math.max(0, ...segs.filter(([, , s]) => s === "available").map(([a, b]) => b - a)) / 60),
    green: onlineSeconds > 0 ? round2(seconds.available / onlineSeconds) : null,
    byHour,
    stretches: segs,
  };
}

// Hours per status over the days of the challenge, and per day on average
export function challengeTotals(days: readonly Pick<DayStats, "hours">[]): { days: number; total: Hours; average: Hours } {
  const keys = [...STATUSES, "nodata"] as const;
  const total = Object.fromEntries(keys.map((k) => [k, round2(days.reduce((n, d) => n + d.hours[k], 0))])) as Hours;
  const average = Object.fromEntries(keys.map((k) => [k, days.length ? round2(total[k] / days.length) : 0])) as Hours;
  return { days: days.length, total, average };
}

type Best<T> = { value: T; day: string } | null;

// The best day of each score: earliest first online, latest last online, longest Available streak, highest green share
export function bests(days: readonly Omit<DayStats, "stretches">[]): {
  firstOnline: Best<string>;
  lastOnline: Best<string>;
  longestAvailable: Best<number>;
  green: Best<number>;
} {
  const pick = <T>(values: [T, string][], better: (a: T, b: T) => boolean): Best<T> =>
    values.reduce<Best<T>>((b, [value, day]) => (!b || better(value, b.value) ? { value, day } : b), null);
  return {
    firstOnline: pick(days.filter((d) => d.firstOnline).map((d) => [d.firstOnline, d.day]), (a, b) => a < b),
    lastOnline: pick(days.filter((d) => d.lastOnline).map((d) => [d.lastOnline, d.day]), (a, b) => a > b),
    longestAvailable: pick(days.filter((d) => d.longestAvailable > 0).map((d) => [d.longestAvailable, d.day]), (a, b) => a > b),
    green: pick(days.filter((d) => d.green !== null).map((d) => [d.green as number, d.day]), (a, b) => a > b),
  };
}
