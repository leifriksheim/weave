import { useEffect } from 'react';
import type { NodeCollection, NodeRecord, SpaceProfile, SpaceStatus } from '../node/types.js';
import { useNode } from './context.js';
import { useLive } from './use-live.js';

/**
 * Keeps a space syncing while the component is on screen. Reading or writing
 * opens a space anyway; this is for a view that should hear from peers even
 * before it asks for anything.
 */
export function useOpenSpace(spaceId: string): void {
  const node = useNode();
  useEffect(() => {
    void node.spaces.open(spaceId).catch(() => {});
    return () => void node.spaces.close(spaceId);
  }, [node, spaceId]);
}

/** A record's current version: undefined while loading, null when there is none. */
export function useRecord<T = unknown>(spaceId: string, key: string): NodeRecord<T> | null | undefined {
  return useLive(spaceId, (node) => node.records.get<T>(spaceId, key), [key]);
}

/** The records whose current version points at this one — optionally in one role, or one collection. */
export function useLinked<T = unknown>(
  spaceId: string,
  key: string,
  options: { rel?: string; collection?: string } = {},
): ReadonlyArray<NodeRecord<T>> | undefined {
  return useLive(spaceId, (node) => node.records.linked<T>(spaceId, key, options), [key, options.rel, options.collection]);
}

/** What the space holds: its kinds of things, with their schemas and counts. */
export function useCollections(spaceId: string): ReadonlyArray<NodeCollection> {
  return useLive(spaceId, (node) => node.collections.list(spaceId), []) ?? [];
}

/** Who is who in the space: the name each person gave. */
export function useProfiles(spaceId: string): ReadonlyArray<SpaceProfile> {
  return useLive(spaceId, (node) => node.spaces.profiles(spaceId), []) ?? [];
}

/** Connection, peers, and how many records peers sent that failed checks. */
export function useSpaceStatus(spaceId: string): SpaceStatus | undefined {
  return useLive(spaceId, (node) => node.spaces.status(spaceId), []);
}

/**
 * Whether this account may `create` in a collection (`target` = its name), or
 * `edit` / `delete` a record (`target` = its key). False until known — for
 * hiding a button rather than showing an error.
 */
export function useCan(spaceId: string, action: 'create' | 'edit' | 'delete', target: string): boolean {
  return useLive(spaceId, (node) => node.records.can(spaceId, action, target), [action, target]) ?? false;
}
