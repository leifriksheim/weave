import { createContext, createElement, useContext, useEffect, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import type { AuthState, WeaveAuth, WeaveSession } from '../session/auth.js';
import type { P2PNode } from '../node/types.js';

interface WeaveContextValue {
  readonly auth: WeaveAuth | null;
  readonly node: P2PNode | null;
}

const WeaveContext = createContext<WeaveContextValue>({ auth: null, node: null });

const signedOut = (): AuthState | null => null;
const never = () => () => {};

export type WeaveProviderProps =
  /** A sign-in flow: the node is whoever is signed in, and changes with them */
  | { readonly auth: WeaveAuth; readonly node?: undefined; readonly children?: ReactNode }
  /** A node you started yourself — from `startConnectedNode`, say */
  | { readonly node: P2PNode; readonly auth?: undefined; readonly children?: ReactNode };

/**
 * Makes Weave available to every component below it, so they ask for what
 * they need — `useNode()`, `useQuery(space, …)` — instead of having it passed
 * down.
 *
 * ```tsx
 * <WeaveProvider auth={auth}>
 *   <App />
 * </WeaveProvider>
 * ```
 */
export function WeaveProvider(props: WeaveProviderProps): ReactElement {
  const auth = props.auth ?? null;
  const state = useSyncExternalStore(auth ? auth.subscribe : never, auth ? auth.getState : signedOut, auth ? auth.getState : signedOut);
  useEffect(() => {
    void auth?.start();
  }, [auth]);
  const node = props.node ?? state?.session?.node ?? null;
  return createElement(WeaveContext.Provider, { value: { auth, node } }, props.children);
}

/** The sign-in flow from the nearest `WeaveProvider`, and its state. */
export function useWeave(): { auth: WeaveAuth | null; state: AuthState | null; session: WeaveSession | null } {
  const { auth } = useContext(WeaveContext);
  const state = useSyncExternalStore(auth ? auth.subscribe : never, auth ? auth.getState : signedOut, auth ? auth.getState : signedOut);
  return { auth, state, session: state?.session ?? null };
}

/**
 * The signed-in node. For components that only appear once someone is in.
 * @throws Outside a `WeaveProvider`, or before sign-in
 */
export function useNode(): P2PNode {
  const { node } = useContext(WeaveContext);
  if (!node) throw new Error('useNode needs a signed-in WeaveProvider above it.');
  return node;
}

/**
 * The sign-in flow and its state, for screens that manage the account —
 * `auth.signOut()`, `auth.addPasskey()`, `state.entry`.
 * @throws Outside a `WeaveProvider` given `auth`
 */
export function useAuth(): { auth: WeaveAuth; state: AuthState } {
  const { auth, state } = useWeave();
  if (!auth || !state) throw new Error('useAuth needs a WeaveProvider with an auth flow above it.');
  return { auth, state };
}

/**
 * Who is signed in: the account, its identity, and its node.
 * @throws Outside a `WeaveProvider`, or before sign-in
 */
export function useSession(): WeaveSession {
  const { session } = useWeave();
  if (!session) throw new Error('useSession needs someone signed in.');
  return session;
}
