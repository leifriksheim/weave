/**
 * Waiting for something that happens asynchronously. A deadline only decides
 * how soon a failing test says so, so it is generous: CI runs four test files
 * at once on two CPUs, where a wait can take several times what it does on a
 * laptop.
 */

/** How long to wait for what takes `ms` on a quiet machine */
export const patience = (ms: number) => ms * 5;

/** Polls `predicate` until it holds, and fails after `patience(ms)` */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  ms = 5000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + patience(ms);
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
