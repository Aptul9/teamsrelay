import { describe, expect, it } from "vitest";
import { readByDone, readByTodo, READBY_EVERY } from "@/agent/logic/read-by";
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

describe("read by", () => {
  it("is complete when everybody read the message", () => {
    expect(readByDone("Read by 3 of 3")).toBe(true);
    expect(readByDone("Read by 2 of 3")).toBe(false);
    expect(readByDone("Seen")).toBe(false);
    expect(readByDone("")).toBe(false);
  });

  it("reads again unknown messages, and incomplete ones older than a minute", () => {
    const now = 10_000;
    const known = new Map([
      ["done", { label: "Read by 3 of 3", ts: now - 600 }],
      ["old", { label: "Read by 1 of 3", ts: now - READBY_EVERY - 1 }],
      ["recent", { label: "Read by 1 of 3", ts: now - 10 }],
    ]);
    expect(readByTodo(["new", "done", "old", "recent"], known, now)).toEqual(["new", "old"]);
  });
});
