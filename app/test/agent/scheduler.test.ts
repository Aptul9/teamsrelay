import { describe, expect, it } from "vitest";
import { Scheduler, type Job } from "@/agent/scheduler";

type Ctx = { onTeams: boolean; flag: boolean };

function recorder() {
  const runs: string[] = [];
  const job = (name: string, every: Job<Ctx>["every"], extra: Partial<Job<Ctx>> = {}): Job<Ctx> => ({ name, every, run: () => void runs.push(name), ...extra });
  return { runs, job };
}

async function rounds(s: Scheduler<Ctx>, n: number, ctx: Ctx = { onTeams: true, flag: false }) {
  for (let i = 0; i < n; i++) await s.runRound(ctx);
}

describe("scheduler", () => {
  it("runs a job every N rounds at its offset", async () => {
    const { runs, job } = recorder();
    const s = new Scheduler([job("chats", { rounds: 3 }), job("full", { rounds: 5, offset: 1 })], () => {});
    const seen: string[][] = [];
    for (let i = 0; i < 7; i++) {
      runs.length = 0;
      await s.runRound({ onTeams: true, flag: false });
      seen.push([...runs]);
    }
    expect(seen).toEqual([["chats"], ["full"], [], ["chats"], [], [], ["chats", "full"]]);
  });

  it("runs a job every N seconds of the clock", async () => {
    let now = 0;
    const { runs, job } = recorder();
    const s = new Scheduler([job("input", { seconds: 60 })], () => {}, () => now);
    await rounds(s, 3);
    now = 59_999;
    await rounds(s, 1);
    now = 60_000;
    await rounds(s, 2);
    expect(runs).toEqual(["input", "input"]);
  });

  it("runs a forced job on every round and never a job whose condition is false", async () => {
    const { runs, job } = recorder();
    const s = new Scheduler(
      [job("identity", { rounds: 300, offset: 7 }, { force: (c) => c.flag }), job("activity", { rounds: 1 }, { when: (c) => c.flag })],
      () => {},
    );
    await rounds(s, 2, { onTeams: true, flag: false });
    expect(runs).toEqual([]);
    await rounds(s, 2, { onTeams: true, flag: true });
    expect(runs).toEqual(["identity", "activity", "identity", "activity"]);
  });

  it("runs a job that catches up at the first round it is allowed, after skipping the round it was due", async () => {
    const { runs, job } = recorder();
    const s = new Scheduler(
      [job("activity", { rounds: 10, offset: 2 }, { when: (c) => c.flag, catchUp: true }), job("full", { rounds: 10, offset: 2 }, { when: (c) => c.flag })],
      () => {},
    );
    // due at round 2 on the sign-in page, then not allowed at rounds 3 and 4
    await rounds(s, 3, { onTeams: false, flag: true });
    await rounds(s, 2, { onTeams: true, flag: false });
    expect(runs).toEqual([]);
    await rounds(s, 2, { onTeams: true, flag: true });
    expect(runs).toEqual(["activity"]);
    // then at its own rounds again
    await rounds(s, 6, { onTeams: true, flag: true });
    expect(runs).toEqual(["activity", "activity", "full"]);
  });

  it("runs only the jobs meant for any page on the sign-in page, and still counts the round", async () => {
    const { runs, job } = recorder();
    const s = new Scheduler([job("health", { rounds: 5 }, { anyPage: true }), job("chats", { rounds: 1 })], () => {});
    await rounds(s, 6, { onTeams: false, flag: false });
    expect(runs).toEqual(["health", "health"]);
    expect(s.round).toBe(6);
  });

  it("reports a failing job and goes on with the next one", async () => {
    const errors: string[] = [];
    const { runs, job } = recorder();
    const failing: Job<Ctx> = {
      name: "broken",
      every: { rounds: 1 },
      run: () => {
        throw new Error("boom");
      },
    };
    const s = new Scheduler([failing, job("after", { rounds: 1 })], (name, e) => errors.push(`${name}: ${(e as Error).message}`));
    await rounds(s, 1);
    expect(errors).toEqual(["broken: boom"]);
    expect(runs).toEqual(["after"]);
  });
});
