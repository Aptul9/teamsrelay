import { EventEmitter } from "node:events";
import type { BrowserContext } from "playwright-core";
import { describe, expect, it } from "vitest";
import { BrowserKeeper } from "@/local/browser";

// A browser context as the keeper sees it: its tabs, its close event
function fakeContext(url = "https://teams.cloud.microsoft/") {
  const events = new EventEmitter();
  const visited: string[] = [];
  const page = { url: () => url, goto: async (u: string) => void visited.push(u) };
  const context = {
    pages: () => [page],
    on: (event: string, fn: () => void) => events.on(event, fn),
    close: async () => void events.emit("close"),
    newPage: async () => page,
  };
  return { context: context as unknown as BrowserContext, visited, closeFromOutside: () => events.emit("close") };
}

describe("browser keeper", () => {
  it("launches once, and again after the browser closed", async () => {
    const made: ReturnType<typeof fakeContext>[] = [];
    const keeper = new BrowserKeeper(async () => {
      made.push(fakeContext());
      return made[made.length - 1].context;
    }, "https://teams.cloud.microsoft/");
    const first = await keeper.context();
    expect(await keeper.context()).toBe(first);
    made[0].closeFromOutside();
    const second = await keeper.context();
    expect(second).not.toBe(first);
    expect(made).toHaveLength(2);
  }, 10_000);

  it("opens Teams in a browser that starts on a blank tab", async () => {
    const blank = fakeContext("about:blank");
    const keeper = new BrowserKeeper(async () => blank.context, "https://teams.cloud.microsoft/");
    await keeper.context();
    expect(blank.visited).toEqual(["https://teams.cloud.microsoft/"]);
  });

  it("waits longer after each failed launch", async () => {
    let tries = 0;
    const keeper = new BrowserKeeper(async () => {
      if (++tries <= 2) throw new Error("Chrome is being updated");
      return fakeContext().context;
    }, "https://teams.cloud.microsoft/");
    const t0 = Date.now();
    await expect(keeper.context()).rejects.toThrow(/updated/);
    await expect(keeper.context()).rejects.toThrow(/updated/);
    await keeper.context();
    // 1 s after the first failure, 2 s after the second
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
    expect(tries).toBe(3);
  }, 15_000);

  it("launches nothing once the relay stops", async () => {
    const one = fakeContext();
    const keeper = new BrowserKeeper(async () => one.context, "https://teams.cloud.microsoft/");
    await keeper.context();
    await keeper.close();
    await expect(keeper.context()).rejects.toThrow(/stopping/);
  });

  it("sends a blank tab back to Teams after a few seconds, a sign-in page only after ten minutes", async () => {
    const tab = fakeContext("about:blank");
    const keeper = new BrowserKeeper(async () => tab.context, "https://teams.cloud.microsoft/");
    expect(await keeper.noTeamsTab(tab.context, { ms: 4_000, url: "" })).toBe(false);
    expect(await keeper.noTeamsTab(tab.context, { ms: 6_000, url: "" })).toBe(true);
    const signIn = "https://adfs.contoso.example/adfs/ls/";
    expect(await keeper.noTeamsTab(tab.context, { ms: 9 * 60_000, url: signIn })).toBe(false);
    expect(await keeper.noTeamsTab(tab.context, { ms: 11 * 60_000, url: signIn })).toBe(true);
    expect(tab.visited).toEqual(["https://teams.cloud.microsoft/", "https://teams.cloud.microsoft/"]);
  });
});
