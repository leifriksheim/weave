/** How long to wait before try `attempt` (from 0): doubling from `first` up to `max`, spread so peers that dropped together do not return together. */
export function backoff(attempt: number, max: number, first = 1000): number {
  return Math.round(Math.min(first * 2 ** attempt, max) * (0.75 + Math.random() / 2));
}

/** One pending retry of `run`: scheduling again replaces it. */
export function createRetry(run: () => unknown) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return Object.freeze({
    clear,
    pending: () => timer !== null,
    schedule: (delay: number): void => {
      clear();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delay);
    },
  });
}
