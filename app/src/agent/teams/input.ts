// One sequence of real input at a time per page. Playwright keeps one mouse position and one set of held keys per page:
// two sequences at once (the presence keeper of the loop, a click or a shortcut of the call watch) mix their moves and
// keys, and a click lands where the other sequence left the mouse.
const queues = new WeakMap<object, Promise<unknown>>();

export function withInput<T>(page: object, sequence: () => Promise<T>): Promise<T> {
  const own = () => asAgent(page, sequence);
  const run = (queues.get(page) ?? Promise.resolve()).then(own, own);
  queues.set(
    page,
    run.catch(() => undefined),
  );
  return run;
}

// The page sees the agent's CDP input as trusted input, like the owner's in the remote desktop: the agent keeps the
// spans of time it runs something that sends input to a page, and input then, or up to TAIL_MS after (events of a
// sequence still on their way), is its own. Spans are kept KEEP_MS: the loop reads the page at every round.
export const TAIL_MS = 1000;
const KEEP_MS = 120_000;
const spans = new WeakMap<object, { from: number; to: number }[]>();

export async function asAgent<T>(page: object, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const span = { from: now, to: Infinity };
  spans.set(page, [...(spans.get(page) ?? []).filter((s) => now - s.to < KEEP_MS), span]);
  try {
    return await fn();
  } finally {
    span.to = Date.now();
  }
}

// Input at `at` (ms) on that page came from the agent
export function byAgent(page: object, at: number): boolean {
  return (spans.get(page) ?? []).some((s) => at >= s.from && at <= s.to + TAIL_MS);
}
