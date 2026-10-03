/**
 * @module serial
 * Work that must not overlap, and that is asked for in bursts.
 */

/**
 * Runs `task` one at a time. Asked while it runs, it runs once more after,
 * however often it was asked: changes arrive in bursts, and a queue of stale
 * runs helps nobody. What it returns settles once a run started after the ask
 * is done; `done` waits for whatever is running now, starting nothing.
 */
export function serial(
  task: () => Promise<void>,
): (() => Promise<void>) & { readonly done: () => Promise<void> } {
  let running: Promise<void> | null = null;
  let next: Promise<void> | null = null;
  const run = (): Promise<void> => {
    if (!running) {
      running = task().finally(() => {
        running = null;
      });
      return running;
    }
    return (next ??= running
      .catch(() => {})
      .then(() => {
        next = null;
        return run();
      }));
  };
  return Object.assign(run, { done: () => (next ?? running ?? Promise.resolve()).catch(() => {}) });
}
