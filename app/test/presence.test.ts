import { describe, expect, it } from "vitest";
import { PRESENCES, PRESENCE_TEXT, presenceOf } from "@/shared/presence";

describe("the presence of a person", () => {
  it("is read from the label Teams gives the badge of the picture", () => {
    const labels = ["Available", "Busy", "In a call", "In a meeting", "Do not disturb", "Presenting", "Focusing", "Away", "Be right back", "Appear away", "Offline", "Appear offline", "Out of office", "Available, Out of office"];
    expect(labels.map(presenceOf)).toEqual(["available", "busy", "busy", "busy", "dnd", "dnd", "dnd", "away", "away", "away", "offline", "offline", "ooo", "ooo"]);
  });

  it("is unknown without a badge or with a label it does not know", () => {
    expect(["", "Status unknown", "Blocked"].map(presenceOf)).toEqual(["", "", ""]);
  });

  it("has words for each value, as the app shows them", () => {
    for (const p of PRESENCES) expect(PRESENCE_TEXT[p], p).toMatch(/^[A-Z][a-z ]+$/);
  });
});
