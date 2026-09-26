// Jobs of the agent loop. A round runs about once a second. A job runs every N rounds, at an offset that keeps
// the heavy ones off the same round, or every N seconds.
export type Every = { rounds: number; offset?: number } | { seconds: number };

export type Job<C> = {
  name: string;
  every: Every;
  run: (ctx: C) => unknown;
  // due on every round while true, whatever the period (the identity, until it is known)
  force?: (ctx: C) => boolean;
  // not run while false
  when?: (ctx: C) => boolean;
  // also on the Microsoft sign-in page; every other job needs the Teams page
  anyPage?: boolean;
};

export type RoundContext = { onTeams: boolean };

export class Scheduler<C extends RoundContext> {
  private rounds = 0;
  private readonly lastRun = new Map<string, number>();

  constructor(
    private readonly jobs: Job<C>[],
    private readonly onError: (job: string, e: unknown) => void,
    private readonly clock: () => number = Date.now,
  ) {}

  get round() {
    return this.rounds;
  }

  private due(job: Job<C>, ctx: C): boolean {
    if (job.force?.(ctx)) return true;
    if ("seconds" in job.every) return this.clock() - (this.lastRun.get(job.name) ?? -Infinity) >= job.every.seconds * 1000;
    return this.rounds % job.every.rounds === (job.every.offset ?? 0);
  }

  // Runs the due jobs in the order they were declared, then moves to the next round. A failing job is
  // reported and the round goes on with the next one.
  async runRound(ctx: C) {
    for (const job of this.jobs) {
      if (!ctx.onTeams && !job.anyPage) continue;
      if (!this.due(job, ctx) || (job.when && !job.when(ctx))) continue;
      this.lastRun.set(job.name, this.clock());
      try {
        await job.run(ctx);
      } catch (e) {
        this.onError(job.name, e);
      }
    }
    this.rounds++;
  }
}
