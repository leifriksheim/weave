import { useSyncExternalStore } from 'react';

/**
 * Something with state to follow — a sign-in flow, a connection, calls. Its
 * methods are plain functions, so React may hold them on their own.
 */
export interface Followed<S> {
  subscribe(this: void, listener: () => void): () => void;
  getState(this: void): S;
}

const never = () => () => {};

/** Re-renders on every change to a store's state; `fallback` while there is no store */
export function useFollow<S, F>(store: Followed<S> | null, fallback: () => F): S | F {
  return useSyncExternalStore<S | F>(
    store ? store.subscribe : never,
    store ? store.getState : fallback,
    store ? store.getState : fallback,
  );
}
