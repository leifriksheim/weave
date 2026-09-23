import { useCallback, useEffect, useState } from 'react';
import type { SpaceSummary } from 'weave-protocol';
import {
  listSpaces,
  createSpace,
  removeSpace,
  joinFromInvite,
  type NewSpace,
} from '../spaces';
import type { Session } from '../protocol';

/** The identity's spaces, and the ways to add one. */
export function useSpaces(session: Session | null) {
  const [spaces, setSpaces] = useState<ReadonlyArray<SpaceSummary>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      setSpaces(await listSpaces());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your spaces');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Spaces also arrive from elsewhere: another device of this account joins
  // one, and the account registry brings it here.
  useEffect(() => {
    if (!session) return;
    return session.node.subscribe((event) => {
      if (event.type === 'spaces') void refresh();
    });
  }, [session, refresh]);

  const create = useCallback(
    async (params: NewSpace) => {
      setError(null);
      try {
        const record = await createSpace(params);
        await refresh();
        return record;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not create that space');
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
        setError(e instanceof Error ? e.message : 'Could not join that space');
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
