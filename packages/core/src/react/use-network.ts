import { useCallback, useSyncExternalStore } from 'react';
import type { MeshStatus } from '../network/mesh.js';
import type { P2PNode } from '../node/types.js';
import { useNode } from './context.js';

/** Each node's status as last read, so a render sees the same object until something changes */
const latest = new WeakMap<P2PNode, MeshStatus>();

/**
 * The node's relays and connections, across every space: which relays are
 * open, which are waiting to try again and why, and the peers connected or
 * being connected to. Changes as they do; `useNode().network.reconnect()`
 * tries a waiting relay now.
 */
export function useNetwork(): MeshStatus {
  const node = useNode();
  const subscribe = useCallback(
    (changed: () => void) => {
      // Read afresh from here on: nothing told the cache while nobody listened.
      latest.delete(node);
      return node.subscribe((event) => {
        if (event.type !== 'network') return;
        latest.delete(node);
        changed();
      });
    },
    [node],
  );
  const read = useCallback(() => {
    const held = latest.get(node);
    if (held) return held;
    const status = node.network.status();
    latest.set(node, status);
    return status;
  }, [node]);
  return useSyncExternalStore(subscribe, read, read);
}
