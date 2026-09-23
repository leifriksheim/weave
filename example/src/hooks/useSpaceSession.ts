import { useCallback, useEffect, useState } from 'react';
import type { NodeCollection, SpaceSummary } from '@p2p-web/protocol';
import { openSpace, type SpaceSession, type SpaceStatus, type TodoView } from '../space-session';

const OFFLINE: SpaceStatus = { peers: [], connection: 'offline', mstRoot: null, rejected: 0 };

/** Opens one space and keeps its todos and connection state fresh. */
export function useSpaceSession(record: SpaceSummary | null) {
  const [space, setSpace] = useState<SpaceSession | null>(null);
  const [todos, setTodos] = useState<ReadonlyArray<TodoView>>([]);
  const [status, setStatus] = useState<SpaceStatus>(OFFLINE);
  const [collections, setCollections] = useState<ReadonlyArray<NodeCollection>>([]);
  const [loading, setLoading] = useState(false);

  // Open on select, and always close on the way out so the relay connection
  // and the database handle do not leak.
  useEffect(() => {
    if (!record) {
      setSpace(null);
      setTodos([]);
      setStatus(OFFLINE);
      return;
    }

    let live = true;
    let opened: SpaceSession | null = null;
    setLoading(true);

    void openSpace(record).then((session) => {
      if (!live) {
        session.close();
        return;
      }
      opened = session;
      setSpace(session);
      setLoading(false);
    });

    return () => {
      live = false;
      opened?.close();
    };
  }, [record]);

  const refresh = useCallback(async () => {
    if (!space) return;
    setTodos(await space.list());
    setStatus(await space.status());
    setCollections(await space.collections());
  }, [space]);

  useEffect(() => {
    if (!space) return;
    void refresh();
    return space.subscribe(() => void refresh());
  }, [space, refresh]);

  const add = useCallback(
    async (text: string) => {
      await space?.add(text);
      await refresh();
    },
    [space, refresh],
  );

  const toggle = useCallback(
    async (todo: TodoView) => {
      await space?.toggle(todo);
      await refresh();
    },
    [space, refresh],
  );

  const remove = useCallback(
    async (key: string) => {
      await space?.remove(key);
      await refresh();
    },
    [space, refresh],
  );

  return { todos, status, collections, loading, add, toggle, remove, refresh };
}
