import { describe, expect, it } from "vitest";
import { desktopSlot, pickSlot, safeNext } from "@/lib/authz";

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

describe("desktopSlot", () => {
  it("reads the slot of desktop paths", () => {
    expect(desktopSlot("/desktop/2/")).toBe(2);
    expect(desktopSlot("/desktop/12/websockify?token=x")).toBe(12);
  });

  it("ignores anything else", () => {
    expect(desktopSlot("/")).toBeNull();
    expect(desktopSlot("/desktop/")).toBeNull();
    expect(desktopSlot("/desktop/abc/")).toBeNull();
    expect(desktopSlot("/api/chats")).toBeNull();
  });
});

describe("safeNext", () => {
  it("keeps same-origin paths only", () => {
    expect(safeNext("/desktop/1/")).toBe("/desktop/1/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
});
