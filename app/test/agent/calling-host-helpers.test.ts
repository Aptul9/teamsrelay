import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { callingRequestAllowed, dominantNotes, goertzelFraction, MELODY, melodyFrame, melodyHeard, PEER_TONE, safePath, scrub } from "../../scripts/calling-host-helpers.mjs";

const tone = (hz: number, rate: number, n: number) => Array.from({ length: n }, (_, i) => 8000 * Math.sin((2 * Math.PI * hz * i) / rate));

// the melody as the host sends it, n seconds at 48 kHz
function melody(seconds: number) {
  const out: number[] = [];
  for (let start = 0; start < seconds * 48000; start += 480) out.push(...melodyFrame(start));
  return out;
}

describe("browserless calling host network policy", () => {
  it.each([
    "https://teams.microsoft.com/trap/tokens",
    "https://api-emea.flightproxy.teams.microsoft.com/api/v2/epconv",
    "https://api.flightproxy.teams.microsoft.com/api/v2/ep/conv-euwe-05-prod-aks.conv.skype.com/conv/x/leave",
    "https://config.teams.microsoft.com/config/v1/Skype/1415_1.0.0.0",
    "https://gateway-eu.az.relay.teams.cloud.microsoft/",
  ])("allows Teams service request %s", (url) => {
    expect(callingRequestAllowed(url)).toBe(true);
  });

  it.each([
    "http://teams.microsoft.com/trap/tokens",
    "https://teams.microsoft.com.evil.test/",
    "https://user:pw@teams.microsoft.com/",
    "https://eu-ic3.events.data.microsoft.com/OneCollector/1.0/",
    "https://example.com/",
    "not a url",
  ])("denies %s", (url) => {
    expect(callingRequestAllowed(url)).toBe(false);
  });
});

describe("browserless calling host log hygiene", () => {
  it("removes tokens and authorization values", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJza3lwZWlkIjoib3JnaWQ6eCJ9.c2lnbmF0dXJlLXZhbHVl";
    const line = `X-Skypetoken: ${jwt} skypetoken=abc123 Authorization: Bearer secretvalue`;
    const out = scrub(line);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("secretvalue");
  });

  it("masks identifiers in paths", () => {
    expect(safePath("/conv/0f8fad5b-d9cb-469f-a165-70867728950e/leave")).toBe("/conv/<uuid>/leave");
    expect(safePath(`/v4/f/${"a".repeat(64)}/`)).toBe("/v4/f/<64>/");
  });
});

describe("browserless calling host test signal", () => {
  it("measures the energy share at one frequency", () => {
    const a = tone(440, 48000, 4800);
    expect(goertzelFraction(a, 48000, 440)).toBeGreaterThan(0.9);
    expect(goertzelFraction(a, 48000, 660)).toBeLessThan(0.05);
    expect(goertzelFraction(new Array(4800).fill(0), 48000, 440)).toBe(0);
  });

  it("sends the melody in order with a silent gap after each note", () => {
    const notes = dominantNotes(melody(3), 48000);
    expect(notes.filter((n) => n).length).toBeGreaterThan(15);
    expect(new Set(notes.filter((n) => n))).toEqual(new Set(MELODY));
    expect(melodyHeard(notes)).toBe(true);
    // the 50 ms gap: the last 10 ms frame of each 250 ms slot is silent
    expect([...melodyFrame(12000 - 480)].every((s) => s === 0)).toBe(true);
  });

  it("detects the melody after resampling to 16 kHz, as Teams delivers it", () => {
    const down = melody(3).filter((_, i) => i % 3 === 0);
    expect(melodyHeard(dominantNotes(down, 16000))).toBe(true);
  });

  it("does not take a steady tone, silence or the peer's tone for the melody", () => {
    expect(melodyHeard(dominantNotes(tone(440, 16000, 48000), 16000))).toBe(false);
    expect(melodyHeard(dominantNotes(new Array(48000).fill(0), 16000))).toBe(false);
    const peer = dominantNotes(tone(PEER_TONE, 16000, 48000), 16000);
    expect(peer.every((n) => n === PEER_TONE)).toBe(true);
    expect(melodyHeard(peer)).toBe(false);
  });
});


describe("outgoing command completion", () => {
  it("acknowledges placement while the callee is still ringing", () => {
    const host = fs.readFileSync(new URL("../../scripts/calling-live-host.mjs", import.meta.url), "utf8");
    const outgoing = host.slice(host.indexOf('if (message.op === "call")'), host.indexOf('if (!current) throw'));
    expect(outgoing).not.toContain("await joined");
    expect(outgoing).not.toContain("await current.start");
    expect(outgoing).toContain("[2, 3].includes(outgoing.state)");
    expect(outgoing).toContain(".addParticipant(message.peer).catch");
    expect(host).toContain("active: [2, 3].includes(current.state)");
  });
});
