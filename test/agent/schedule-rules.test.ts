import { describe, expect, it } from "vitest";
import { selfCheckWindow } from "@/agent/logic/self-check";

describe("automatic check window", () => {
  const at = (h: number, m = 0) => selfCheckWindow(new Date(2026, 8, 26, h, m));

  it("runs from 8 to 11 and from 17 to 20, local time", () => {
    expect(at(7, 59)).toBeNull();
    expect(at(8)).toBe("hc_20260926_am");
    expect(at(10, 59)).toBe("hc_20260926_am");
    expect(at(11)).toBeNull();
    expect(at(17)).toBe("hc_20260926_pm");
    expect(at(19, 59)).toBe("hc_20260926_pm");
    expect(at(20)).toBeNull();
  });

  it("writes the day with two-digit month and day", () => {
    expect(selfCheckWindow(new Date(2026, 0, 5, 9))).toBe("hc_20260105_am");
  });
});
