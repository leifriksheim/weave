import { useCallback, useEffect, useState } from 'react';
import type { NewSpace, SpaceSummary } from '../node/types.js';
import { useNode } from './context.js';

export interface SpacesState {
  readonly spaces: ReadonlyArray<SpaceSummary>;
  readonly loading: boolean;
  readonly error: string | null;
  refresh(): Promise<void>;
  /** Makes a space; null when it failed, with `error` saying why */
  create(params: NewSpace): Promise<SpaceSummary | null>;
  /** Joins from an invite; null when it failed */
  join(invite: string): Promise<SpaceSummary | null>;
  /** Forgets a space on this device */
  leave(spaceId: string): Promise<void>;
}

/**
 * The account's spaces, kept current — including ones joined on another device
 * of the account, which the account registry brings here.
 */
export function useSpaces(): SpacesState {
  const node = useNode();
  const [spaces, setSpaces] = useState<ReadonlyArray<SpaceSummary>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSpaces(await node.spaces.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your spaces');
    } finally {
      setLoading(false);
    }
  }, [node]);

  useEffect(() => {
    void refresh();
    return node.subscribe((event) => {
      if (event.type === 'spaces') void refresh();
    });
  }, [node, refresh]);

  const attempt = useCallback(
    async <T,>(work: () => Promise<T>, failed: string): Promise<T | null> => {
      setError(null);
      try {
        const done = await work();
        await refresh();
        return done;
      } catch (e) {
        setError(e instanceof Error ? e.message : failed);
        return null;
      }
    },
    [refresh],
  );

  return {
    spaces,
    loading,
    error,
    refresh,
    create: (params) => attempt(() => node.spaces.create(params), 'Could not create that space'),
    join: (invite) => attempt(() => node.spaces.join(invite), 'Could not join that space'),
    leave: async (spaceId) => {
      await attempt(() => node.spaces.leave(spaceId), 'Could not leave that space');
    },
  };
}
