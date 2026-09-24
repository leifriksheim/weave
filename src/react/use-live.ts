import { useEffect, useState } from 'react';
import type { P2PNode } from '../node/types.js';

/**
 * Loads something from a space, and loads it again whenever that space's
 * records or connection change — locally or by sync. One load at a time; a
 * change during a load triggers one more, never a queue of stale ones.
 *
 * For a query, {@link useQuery} is simpler. This is for everything else:
 * collections, profiles, status, `can()`.
 *
 * @param node The signed-in node
 * @param spaceId The space to follow
 * @param load What to read
 * @param deps When these change, start over
 * @returns The latest value, or undefined until the first load finishes
 */
export function useLive<T>(
  node: P2PNode,
  spaceId: string,
  load: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    let running = false;
    let again = false;
    const run = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      do {
        again = false;
        try {
          const next = await load();
          if (!stopped) setValue(next);
        } catch (error) {
          console.warn('useLive:', error);
        }
      } while (again && !stopped);
      running = false;
    };
    void run();
    const unsubscribe = node.subscribe((event) => {
      if ('space' in event && event.space === spaceId) void run();
    });
    return () => {
      stopped = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, spaceId, ...deps]);

  return value;
}
