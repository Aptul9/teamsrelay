import { describe, expect, it } from "vitest";
import { accountLabel, PUSH_DEDUP_SECONDS, pushTitle, RecentPushes } from "@/agent/logic/notify";

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

describe("notification title", () => {
  const me = { name: "Anna Rossi", email: "anna.rossi@contoso.example", tenant: "Contoso", av: "" };

  it("names the account only when the owner has more than one", () => {
    expect(accountLabel(false, me, 2)).toBe("");
    expect(accountLabel(true, me, 2)).toBe("Contoso");
    expect(accountLabel(true, { ...me, tenant: "" }, 2)).toBe("anna.rossi@contoso.example");
    expect(accountLabel(true, { ...me, tenant: "", email: "" }, 2)).toBe("account 2");
  });

  it("appends the label to the title", () => {
    expect(pushTitle("Anna Rossi", "Contoso")).toBe("Anna Rossi · Contoso");
    expect(pushTitle("", "")).toBe("TeamsRelay");
  });
});
