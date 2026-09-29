// One sequence of real input at a time per page. Playwright keeps one mouse position and one set of held keys per page:
// two sequences at once (the presence keeper of the loop, a click or a shortcut of the call watch) mix their moves and
// keys, and a click lands where the other sequence left the mouse.
const queues = new WeakMap<object, Promise<unknown>>();

export function withInput<T>(page: object, sequence: () => Promise<T>): Promise<T> {
  const run = (queues.get(page) ?? Promise.resolve()).then(sequence, sequence);
  queues.set(
    page,
    run.catch(() => undefined),
  );
  return run;
}
