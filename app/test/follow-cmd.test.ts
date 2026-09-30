// A command of a call (answer, hang-up, mute) followed closely: the agent runs it within a look of its call watch and
// Teams shows it within a second, so the app reads its outcome every CALL_CMD_EVERY ms, for about ten seconds, and the
// other commands as before.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_CMD_EVERY, CALL_CMD_TRIES, followCmd } from "@/lib/client";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// the agent: pending for the first `pending` reads, then done
function agent(pending: number) {
  let reads = 0;
  const fetch = vi.fn(async () => new Response(JSON.stringify({ status: reads++ < pending ? "pending" : "done", result: null }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("following a command", () => {
  it("reads the outcome of a command of a call every 150 ms, for about ten seconds", async () => {
    vi.useFakeTimers();
    expect(CALL_CMD_EVERY).toBe(150);
    expect(CALL_CMD_EVERY * CALL_CMD_TRIES).toBeGreaterThanOrEqual(10_000);
    const fetch = agent(2);
    const outcome = followCmd(7, 2, CALL_CMD_TRIES, CALL_CMD_EVERY);
    await vi.advanceTimersByTimeAsync(CALL_CMD_EVERY);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/cmd/7?a=2", expect.anything());
    await vi.advanceTimersByTimeAsync(2 * CALL_CMD_EVERY);
    await expect(outcome).resolves.toEqual({ status: "done", result: null });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("reads the other commands every 700 ms as before", async () => {
    vi.useFakeTimers();
    const fetch = agent(0);
    const outcome = followCmd(8, 2);
    await vi.advanceTimersByTimeAsync(699);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({ status: "done" });
  });

  it("gives up as failed after its tries", async () => {
    vi.useFakeTimers();
    agent(Infinity);
    const outcome = followCmd(9, 2, 3, CALL_CMD_EVERY);
    await vi.advanceTimersByTimeAsync(3 * CALL_CMD_EVERY);
    await expect(outcome).resolves.toEqual({ status: "failed", result: null });
  });
});
