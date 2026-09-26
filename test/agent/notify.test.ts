import { describe, expect, it } from "vitest";
import { PUSH_DEDUP_SECONDS, RecentPushes } from "@/agent/logic/notify";

describe("push deduplication", () => {
  it("drops the same text within 150 s, whatever the case and the spaces", () => {
    let now = 1_000_000;
    const r = new RecentPushes(() => now);
    expect(r.allow("Are you there?")).toBe(true);
    now += 10_000;
    expect(r.allow("  are you THERE?  ")).toBe(false);
    now += PUSH_DEDUP_SECONDS * 1000;
    expect(r.allow("Are you there?")).toBe(true);
  });

  it("compares the first 60 characters", () => {
    const r = new RecentPushes(() => 0);
    expect(r.allow("x".repeat(60) + " first")).toBe(true);
    expect(r.allow("x".repeat(60) + " second")).toBe(false);
  });

  it("always lets an empty text through", () => {
    const r = new RecentPushes(() => 0);
    expect(r.allow("")).toBe(true);
    expect(r.allow("   ")).toBe(true);
  });
});
