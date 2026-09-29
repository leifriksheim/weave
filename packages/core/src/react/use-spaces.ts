import { useCallback, useEffect, useRef, useState } from 'react';
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

export interface SpacesOptions {
  /**
   * Only spaces that define all of these collections: the spaces an app
   * works in, when it was given the whole account. A space still being
   * joined is kept, since its definitions have not arrived yet.
   */
  readonly having?: ReadonlyArray<string | { readonly name: string }>;
}

/**
 * The account's spaces, kept current — including ones joined on another device
 * of the account, which the account registry brings here.
 */
export function useSpaces(options: SpacesOptions = {}): SpacesState {
  const node = useNode();
  const [spaces, setSpaces] = useState<ReadonlyArray<SpaceSummary>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const having = (options.having ?? []).map((c) => (typeof c === 'string' ? c : c.name)).join('\n');

  // Which spaces are listed, so records arriving in one already there don't list them all again.
  const listed = useRef<ReadonlySet<string>>(new Set());

  /** Whether a space defines every collection in `having` */
  const fits = useCallback(
    async (space: SpaceSummary) => {
      if (!having || space.joining) return true;
      const defined = new Set(
        (await node.collections.list(space.id).catch(() => []))
          .filter((c) => c.version !== null)
          .map((c) => c.name),
      );
      return having.split('\n').every((name) => defined.has(name));
    },
    [node, having],
  );

  const refresh = useCallback(async () => {
    try {
      const all = await node.spaces.list();
      const fit = await Promise.all(all.map(fits));
      const kept = all.filter((_, i) => fit[i]);
      listed.current = new Set(kept.filter((space) => !space.joining).map((space) => space.id));
      setSpaces(kept);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your spaces');
    } finally {
      setLoading(false);
    }
  }, [node, fits]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load, then one per change
    void refresh();
    return node.subscribe((event) => {
      if (event.type === 'spaces') void refresh();
      // With `having`, a space's definitions arriving by sync can bring it into the list.
      else if (having && event.type === 'records' && !listed.current.has(event.space)) {
        void node.spaces
          .get(event.space)
          .then(async (space) => space && (await fits(space)) && refresh())
          .catch(() => {});
      }
    });
  }, [node, refresh, fits, having]);

  const attempt = useCallback(
    async <T>(work: () => Promise<T>, failed: string): Promise<T | null> => {
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
