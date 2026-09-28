// The ring of the web app, made in the page: two short trills and a rest, looped by the browser while a call rings;
// and the bell of a new message, played once
import { describe, expect, it } from "vitest";
import { BELL, bellSamples, RING, ringSamples } from "@/lib/ring";

const RATE = 8000;

// loudness of the samples between two times of the loop, in seconds
function rms(s: Float32Array, from: number, to: number) {
  const part = s.subarray(Math.round(from * RATE), Math.round(to * RATE));
  return Math.sqrt(part.reduce((sum, x) => sum + x * x, 0) / part.length);
}

describe("ring", () => {
  const s = ringSamples(RATE);

  it("lasts one period of the loop", () => {
    expect(s).toHaveLength(Math.round(RING.period * RATE));
  });

  it("rings twice, then rests until the loop starts again", () => {
    const [first, second] = RING.bursts;
    expect(rms(s, first[0] + 0.05, first[1] - 0.05)).toBeGreaterThan(0.1);
    expect(rms(s, first[1] + 0.02, second[0] - 0.02)).toBe(0);
    expect(rms(s, second[0] + 0.05, second[1] - 0.05)).toBeGreaterThan(0.1);
    expect(rms(s, second[1] + 0.02, RING.period)).toBe(0);
  });

  it("stays under half of full scale, and starts and ends at zero: no click where the loop joins", () => {
    expect(Math.max(...s.map(Math.abs))).toBeLessThanOrEqual(0.5);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBe(0);
  });
});

describe("bell", () => {
  const s = bellSamples(RATE);
  const at = (i: number) => BELL.notes[i][0];

  it("lasts the length of the bell, played once", () => {
    expect(s).toHaveLength(Math.round(BELL.length * RATE));
  });

  it("strikes two notes, each one fading away", () => {
    // each note is loud right after its strike, and much quieter a few decays later
    expect(rms(s, at(0) + 0.01, at(1) - 0.01)).toBeGreaterThan(0.05);
    expect(rms(s, at(1) + 0.01, at(1) + 0.1)).toBeGreaterThan(0.05);
    const late = at(1) + 4 * BELL.decay;
    expect(rms(s, late, late + 0.05)).toBeLessThan(rms(s, at(1) + 0.01, at(1) + 0.06) / 10);
  });

  it("stays under half of full scale, and starts and ends at zero: no click", () => {
    expect(Math.max(...s.map(Math.abs))).toBeLessThanOrEqual(0.5);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBe(0);
  });

  it("does not sound like the ring of a call: other notes, and over before the ring would ring again", () => {
    expect(BELL.notes.map(([, f]) => f)).not.toEqual([...RING.tones]);
    expect(BELL.length).toBeLessThan(RING.period);
  });
});
