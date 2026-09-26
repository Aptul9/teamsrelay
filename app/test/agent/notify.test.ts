import { describe, expect, it } from "vitest";
import { accountLabel, chatTag, PUSH_DEDUP_SECONDS, pushRetryDelay, pushTitle, RecentPushes } from "@/agent/logic/notify";

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

  it("tags the notifications of a chat by account and chat", () => {
    expect(chatTag(2, "Anna Rossi")).toBe("chat-2-Anna Rossi");
  });
});

describe("push retry", () => {
  const now = Date.parse("2026-09-26T20:00:00Z");

  it("waits 5, 30 and 120 s after a server error or no answer, then stops", () => {
    expect([0, 1, 2, 3].map((attempt) => pushRetryDelay(503, undefined, attempt, now))).toEqual([5, 30, 120, null]);
    expect(pushRetryDelay(500, undefined, 0, now)).toBe(5);
    expect(pushRetryDelay(undefined, undefined, 1, now)).toBe(30);
  });

  it("waits as a 429 asks, in seconds or as a date, between 1 s and 15 minutes", () => {
    expect(pushRetryDelay(429, "42", 0, now)).toBe(42);
    expect(pushRetryDelay(429, "0", 0, now)).toBe(1);
    expect(pushRetryDelay(429, "86400", 0, now)).toBe(900);
    expect(pushRetryDelay(429, "Sat, 26 Sep 2026 20:01:00 GMT", 0, now)).toBe(60);
    expect(pushRetryDelay(429, "soon", 1, now)).toBe(30);
    expect(pushRetryDelay(429, undefined, 2, now)).toBe(120);
    expect(pushRetryDelay(429, "42", 3, now)).toBeNull();
  });

  it("never tries again a refusal", () => {
    for (const status of [400, 401, 403, 404, 410, 413]) expect(pushRetryDelay(status, undefined, 0, now)).toBeNull();
  });
});
