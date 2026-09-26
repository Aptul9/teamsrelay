import { describe, expect, it } from "vitest";
import { pickSlot, safeNext } from "@/lib/authz";

describe("pickSlot", () => {
  it("defaults to the first owned slot", () => {
    expect(pickSlot([2, 3], null)).toBe(2);
    expect(pickSlot([2, 3], "")).toBe(2);
  });

  it("accepts an owned slot", () => {
    expect(pickSlot([2, 3], "3")).toBe(3);
  });

  it("refuses a slot owned by someone else, or none at all", () => {
    expect(() => pickSlot([2, 3], "1")).toThrow(/Account not found/);
    expect(() => pickSlot([2, 3], "x")).toThrow(/Account not found/);
    expect(() => pickSlot([], null)).toThrow(/Account not found/);
  });
});

describe("safeNext", () => {
  it("keeps same-origin paths only", () => {
    expect(safeNext("/desktop/")).toBe("/desktop/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
});
