import { useCallback, useEffect, useState } from 'react';
import type { SpaceRecord } from '@p2p-web/protocol';
import {
  listSpaces,
  createSpace,
  removeSpace,
  joinFromInvite,
  type NewSpace,
} from '../spaces';
import type { Session } from '../protocol';

/** The identity's lists, and the ways to add one. */
export function useSpaces(session: Session | null) {
  const [spaces, setSpaces] = useState<ReadonlyArray<SpaceRecord>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      setSpaces(await listSpaces());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your lists');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (params: NewSpace) => {
      setError(null);
      try {
        const record = await createSpace(params);
        await refresh();
        return record;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not create that list');
        return null;
      }
    },
    [refresh],
  );

  const join = useCallback(
    async (invite: string) => {
      setError(null);
      try {
        const record = await joinFromInvite(invite);
        await refresh();
        return record;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not join that list');
        return null;
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (spaceId: string) => {
      await removeSpace(spaceId);
      await refresh();
    },
    [refresh],
  );

  return { spaces, loading, error, refresh, create, join, remove };
}
