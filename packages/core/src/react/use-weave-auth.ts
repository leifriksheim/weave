import { useEffect, useSyncExternalStore } from 'react';
import type { AuthState, WeaveAuth } from '../session/auth.js';

/**
 * Follows a sign-in flow: re-renders on every change, and starts it.
 * Call the flow's own methods to act — `auth.signOut()`, `auth.addPasskey()`.
 *
 * @param auth From `createWeaveAuth`, made once for the page
 * @returns Its current state
 */
export function useWeaveAuth(auth: WeaveAuth): AuthState {
  useEffect(() => {
    void auth.start();
  }, [auth]);
  return useSyncExternalStore(auth.subscribe, auth.getState, auth.getState);
}
