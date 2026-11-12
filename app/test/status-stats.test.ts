import { describe, expect, it } from "vitest";
import { bests, challengeTotals, clock, dayOf, dayStart, dayStats, hourBounds, joinStretches, nextDay, type Stretch } from "@/lib/status-stats";

const ROME = "Europe/Rome";
const GAP = 180;
const H = 3600;
// 2026-11-03 00:00 in Rome
const D = Date.UTC(2026, 10, 2, 23) / 1000;
const at = (h: number, m = 0) => D + h * H + m * 60;
const past = { zone: ROME, now: at(48), gap: GAP };
const sum = (hours: Record<string, number>) => Object.values(hours).reduce((a, b) => a + b, 0);

describe("days in the zone of the challenge", () => {
  it("start at midnight there and have 23 or 25 hours on a DST change", () => {
    expect(dayStart("2026-11-03", ROME)).toBe(D);
    expect(dayOf(D, ROME)).toBe("2026-11-03");
    expect(dayOf(D - 1, ROME)).toBe("2026-11-02");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(hourBounds("2026-11-03", ROME)).toHaveLength(25);
    expect(hourBounds("2026-03-29", ROME)).toHaveLength(24);
    expect(hourBounds("2026-10-25", ROME)).toHaveLength(26);
    expect(clock(at(9, 5), ROME)).toBe("09:05");
  });
});

describe("the stretches of a person", () => {
  it("hold a status until the next one when it came within the gap, leave a longer gap as no data, run to now while fresh", () => {
    const s: Stretch[] = [
      [at(9), at(10), "busy"],
      [at(10, 1), at(11), "available"],
      [at(12), at(13), "away"],
    ];
    expect(joinStretches(s, GAP, at(13, 2))).toEqual([
      [at(9), at(10, 1), "busy"],
      [at(10, 1), at(11), "available"],
      [at(12), at(13, 2), "away"],
    ]);
    expect(joinStretches(s, GAP, at(14))).toEqual([
      [at(9), at(10, 1), "busy"],
      [at(10, 1), at(11), "available"],
      [at(12), at(13), "away"],
    ]);
  });
});

describe("the stats of a day", () => {
  it("of a past day add up to its length, no data included, unknown counted as no data", () => {
    const d = dayStats([[at(8), at(12), "available"], [at(12, 1), at(14), "unknown"], [at(14, 1), at(18), "busy"]], "2026-11-03", past);
    expect(sum(d.hours)).toBeCloseTo(24, 1);
    expect(d.hours.available).toBeCloseTo(4.02, 2);
    expect(d.hours.busy).toBeCloseTo(3.98, 2);
    expect(d.hours.nodata).toBeCloseTo(16, 1);
    expect(d.hours.offline).toBe(0);
  });

  it("of today add up to the time elapsed so far", () => {
    const d = dayStats([[at(8), at(10), "available"]], "2026-11-03", { zone: ROME, now: at(10, 30), gap: GAP });
    expect(sum(d.hours)).toBeCloseTo(10.5, 1);
    expect(d.hours.available).toBe(2);
    expect(d.byHour).toHaveLength(24);
  });

  it("clip a stretch across midnight to each day", () => {
    const s: Stretch[] = [[at(-1), at(1), "dnd"]];
    expect(dayStats(s, "2026-11-03", past).hours.dnd).toBe(1);
    expect(dayStats(s, "2026-11-02", past).hours.dnd).toBe(1);
  });

  it("break the longest Available streak at a gap, not at a change of poll", () => {
    const s: Stretch[] = [
      [at(9), at(10), "available"],
      [at(10, 1), at(11), "available"],
      [at(11, 30), at(13), "available"],
    ];
    expect(dayStats(s, "2026-11-03", past).longestAvailable).toBe(120);
  });

  it("give first and last online from statuses other than offline and unknown", () => {
    const s: Stretch[] = [
      [at(6), at(8, 47), "offline"],
      [at(8, 47), at(9), "away"],
      [at(9), at(18, 12), "busy"],
      [at(18, 12), at(23), "offline"],
      [at(23), at(23, 30), "unknown"],
    ];
    const d = dayStats(s, "2026-11-03", past);
    expect([d.firstOnline, d.lastOnline]).toEqual(["08:47", "18:12"]);
    expect(dayStats([[at(6), at(8), "offline"]], "2026-11-03", past)).toMatchObject({ firstOnline: "", lastOnline: "", green: null, longestAvailable: 0 });
  });

  it("give the green share as available over online hours", () => {
    const d = dayStats([[at(9), at(12), "available"], [at(12), at(13), "busy"], [at(13), at(20), "offline"]], "2026-11-03", past);
    expect(d.green).toBe(0.75);
  });

  it("give by hour the status that held most of it, no data where the gap holds most", () => {
    const d = dayStats([[at(9), at(9, 40), "available"], [at(9, 40), at(10, 10), "busy"]], "2026-11-03", past);
    expect(d.byHour.slice(8, 11)).toEqual(["nodata", "available", "nodata"]);
  });

  it("have 23 and 25 hours by hour on the DST days, and add up to them", () => {
    const spring = dayStart("2026-03-29", ROME);
    const autumn = dayStart("2026-10-25", ROME);
    const o = { zone: ROME, now: at(0), gap: GAP };
    const a = dayStats([[spring, spring + 23 * H, "available"]], "2026-03-29", o);
    const b = dayStats([[autumn, autumn + 25 * H, "offline"]], "2026-10-25", o);
    expect([a.byHour.length, sum(a.hours), a.hours.available]).toEqual([23, 23, 23]);
    expect([b.byHour.length, sum(b.hours), b.hours.offline]).toEqual([25, 25, 25]);
  });

  it("carry the stretches of the day, clipped", () => {
    const d = dayStats([[at(-1), at(1), "dnd"]], "2026-11-03", past);
    expect(d.stretches).toEqual([[at(0), at(1), "dnd"]]);
  });
});

describe("the challenge", () => {
  const days = [
    dayStats([[at(8, 30), at(12), "available"], [at(12), at(17), "busy"]], "2026-11-03", past),
    dayStats([[at(24 + 9), at(24 + 19), "available"]], "2026-11-04", past),
  ];

  it("totals and averages the hours per day", () => {
    const t = challengeTotals(days);
    expect(t.days).toBe(2);
    expect(t.total.available).toBeCloseTo(13.5, 1);
    expect(t.average.available).toBeCloseTo(6.75, 2);
  });

  it("finds the best day of each score", () => {
    expect(bests(days)).toEqual({
      firstOnline: { value: "08:30", day: "2026-11-03" },
      lastOnline: { value: "19:00", day: "2026-11-04" },
      longestAvailable: { value: 600, day: "2026-11-04" },
      green: { value: 1, day: "2026-11-04" },
    });
  });

  it("has no best green share while no day had available time", () => {
    const away = dayStats([[at(9), at(12), "away"]], "2026-11-03", past);
    expect(away.green).toBe(0);
    expect(bests([away]).green).toBeNull();
  });
});
