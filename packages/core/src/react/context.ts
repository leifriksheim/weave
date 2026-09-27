import { createContext, createElement, useContext, useEffect, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import type { AuthState, WeaveAuth, WeaveSession } from '../session/auth.js';
import type { ConnectionState, WeaveConnection } from '../session/connection.js';
import type { P2PNode } from '../node/types.js';

interface WeaveContextValue {
  readonly auth: WeaveAuth | null;
  readonly connection: WeaveConnection | null;
  readonly node: P2PNode | null;
}

const WeaveContext = createContext<WeaveContextValue>({ auth: null, connection: null, node: null });

/** Something with state to follow — a sign-in flow, or a connection */
interface Store<S> {
  subscribe(listener: (state: S) => void): () => void;
  getState(): S;
  start(): Promise<void>;
}

const nothing = (): null => null;
const never = () => () => {};

/** Follows a flow's or a connection's state, and starts it; null when there is none. */
function useStore<S>(store: Store<S> | null): S | null {
  useEffect(() => {
    void store?.start();
  }, [store]);
  return useSyncExternalStore<S | null>(store ? store.subscribe : never, store ? store.getState : nothing, store ? store.getState : nothing);
}

export type WeaveProviderProps = { readonly children?: ReactNode } & (
  /** The account itself, signed in on this site — an account home */
  | { readonly auth: WeaveAuth; readonly connection?: undefined; readonly node?: undefined }
  /** An app acting for an account through its home — `createWeaveConnection` */
  | { readonly connection: WeaveConnection; readonly auth?: undefined; readonly node?: undefined }
  /** A node you started yourself */
  | { readonly node: P2PNode; readonly auth?: undefined; readonly connection?: undefined }
);

/**
 * Makes Weave available to every component below it, so they ask for what
 * they need — `useNode()`, `useQuery(space, …)` — instead of having it passed
 * down.
 *
 * ```tsx
 * <WeaveProvider connection={connection}>   // an app, through an account home
 * <WeaveProvider auth={auth}>               // the home itself
 * ```
 */
export function WeaveProvider(props: WeaveProviderProps): ReactElement {
  const auth = props.auth ?? null;
  const connection = props.connection ?? null;
  const authState = useStore<AuthState>(auth);
  const connectionState = useStore<ConnectionState>(connection);
  const node = props.node ?? authState?.session?.node ?? (connectionState?.status === 'ready' ? connectionState.node : null);
  return createElement(WeaveContext.Provider, { value: { auth, connection, node } }, props.children);
}

/** The sign-in flow from the nearest `WeaveProvider`, and its state — or nulls, for an app that connects instead. */
export function useWeave(): { auth: WeaveAuth | null; state: AuthState | null; session: WeaveSession | null } {
  const { auth } = useContext(WeaveContext);
  const state = useSyncExternalStore<AuthState | null>(auth ? auth.subscribe : never, auth ? auth.getState : nothing, auth ? auth.getState : nothing);
  return { auth, state, session: state?.session ?? null };
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
 * @throws Outside a `WeaveProvider` given `auth`, or before sign-in
 */
export function useSession(): WeaveSession {
  const { session } = useWeave();
  if (!session) throw new Error('useSession needs someone signed in.');
  return session;
}

/**
 * An app's connection to its account home, and its state — for the connect
 * button, and for "access ran out, connect again".
 * @throws Outside a `WeaveProvider` given `connection`
 */
export function useConnection(): { connection: WeaveConnection; state: ConnectionState } {
  const { connection } = useContext(WeaveContext);
  const state = useSyncExternalStore<ConnectionState | null>(
    connection ? connection.subscribe : never,
    connection ? connection.getState : nothing,
    connection ? connection.getState : nothing,
  );
  if (!connection || !state) throw new Error('useConnection needs a WeaveProvider with a connection above it.');
  return { connection, state };
}

/**
 * The account this page acts for — signed in here, or connected through a
 * home: its identity (what `root` and `createdBy` on a record name) and name.
 * @throws Before sign-in or connecting
 */
export function useAccount(): { did: string; name: string } {
  const { auth, connection } = useContext(WeaveContext);
  const authState = useSyncExternalStore<AuthState | null>(auth ? auth.subscribe : never, auth ? auth.getState : nothing, auth ? auth.getState : nothing);
  const connectionState = useSyncExternalStore<ConnectionState | null>(
    connection ? connection.subscribe : never,
    connection ? connection.getState : nothing,
    connection ? connection.getState : nothing,
  );
  if (authState?.session) return { did: authState.session.did, name: authState.session.account.name };
  if (connectionState?.grant) return { did: connectionState.grant.did, name: connectionState.grant.name };
  throw new Error('useAccount needs someone signed in or connected.');
}

/**
 * The node acting for the account. For components that only appear once
 * someone is in.
 * @throws Outside a `WeaveProvider`, or before sign-in or connecting
 */
export function useNode(): P2PNode {
  const { node } = useContext(WeaveContext);
  if (!node) throw new Error('useNode needs a signed-in or connected WeaveProvider above it.');
  return node;
}
