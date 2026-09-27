/**
 * @module session/connection
 * An app's side of an account home, as one object any UI can draw — the twin
 * of `createWeaveAuth`, for apps that never sign anyone in themselves.
 *
 * ```ts
 * const connection = createWeaveConnection({
 *   home: 'https://weave-home.example/connect',   // a default; people can bring their own
 *   request: { name: 'Todo', access: 'write', scope: 'account' },
 *   network: { relays },
 * });
 * button.onclick = () => connection.connect();   // from a click: it opens a popup
 * connection.subscribe(({ status, node }) => …);
 * ```
 *
 * It remembers the grant between visits and starts the node from it; when the
 * grant runs out it says so (`expired`), and connecting again renews it. When
 * the home disconnects the app, it forgets the grant and says so.
 *
 * The home is the person's, not the app's: `home` is only a default.
 * `connect('weave.example.com')` uses theirs, and it is remembered — for
 * reconnecting, and for linking to their account settings.
 */
import type { NodeNetworkConfig, P2PNode } from '../node/types.js';
import type { StoreFactory } from '../node/stores.js';
import {
  appKey,
  connectToHome,
  homeAddress,
  forgetAppKey,
  grantStore,
  startConnectedNode,
  type ConnectRequest,
  type Grant,
} from './connect.js';
import type { KeyValueStore } from './stay-signed-in.js';

export interface WeaveConnectionConfig {
  /** The account home to suggest — the person can use their own instead */
  readonly home: string;
  /** What to ask for */
  readonly request: Omit<ConnectRequest, 'v' | 'audience'>;
  /** Relays and always-on nodes the node connects to. Omit to stay offline. */
  readonly network?: NodeNetworkConfig;
  /** Where the grant is kept. Default `localStorage`. */
  readonly storage?: KeyValueStore | null;
  /** Where the node keeps its data. Default: this site's IndexedDB. */
  readonly stores?: (grant: Grant) => StoreFactory;
}

/**
 * `starting` — looking for a grant from an earlier visit.
 * `disconnected` — none; show a way to connect. `error` says why, when the home disconnected the app.
 * `connecting` — the home is open, waiting on the person.
 * `ready` — `node` acts for the account.
 * `expired` — the grant ran out; connecting again renews it.
 */
export type ConnectionStatus = 'starting' | 'disconnected' | 'connecting' | 'ready' | 'expired';

export interface ConnectionState {
  readonly status: ConnectionStatus;
  /** The home this app connects to: the person's own, once they chose one, else the default */
  readonly home: string;
  readonly grant: Grant | null;
  readonly node: P2PNode | null;
  readonly error: string | null;
}

export interface WeaveConnection {
  getState(): ConnectionState;
  subscribe(listener: (state: ConnectionState) => void): () => void;
  /** Picks up a grant from an earlier visit. Safe to call more than once. */
  start(): Promise<void>;
  /**
   * Opens the home and asks. Call it from a click.
   * @param home The person's own home — `weave.example.com` is enough. Default: the one in `state.home`.
   */
  connect(home?: string): Promise<void>;
  /** Forgets the grant and this app's key, and stops the node. The account is untouched. */
  disconnect(): Promise<void>;
}

export function createWeaveConnection(config: WeaveConnectionConfig): WeaveConnection {
  const storage =
    config.storage !== undefined ? config.storage : ((globalThis as { localStorage?: KeyValueStore }).localStorage ?? null);
  const grants = grantStore(storage);
  const HOME = 'weave.home';
  const rememberedHome = (() => {
    try {
      return storage?.getItem(HOME) ?? null;
    } catch {
      return null;
    }
  })();

  let state: ConnectionState = Object.freeze({
    status: 'starting',
    home: rememberedHome ?? homeAddress(config.home),
    grant: null,
    node: null,
    error: null,
  });
  const listeners = new Set<(state: ConnectionState) => void>();
  const update = (patch: Partial<ConnectionState>) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener(state);
  };

  let started: Promise<void> | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let unwatch: (() => void) | null = null;

  /** Forgets the grant and this app's key, and stops the node */
  async function end(error: string | null): Promise<void> {
    if (expiry) globalThis.clearTimeout(expiry);
    unwatch?.();
    unwatch = null;
    grants.forget();
    const node = state.node;
    update({ status: 'disconnected', grant: null, node: null, error });
    await node?.close();
    await forgetAppKey().catch(() => {});
  }

  async function open(grant: Grant): Promise<void> {
    unwatch?.();
    await state.node?.close();
    const node = await startConnectedNode({
      grant,
      key: await appKey(),
      ...(config.network ? { network: config.network } : {}),
      ...(config.stores ? { stores: config.stores(grant) } : {}),
    });
    update({ status: 'ready', home: grant.home, grant, node, error: null });

    // The home disconnected this app: nothing it writes counts any more, so stop.
    unwatch = node.subscribe((event) => {
      if (event.type === 'revoked' && state.node === node) void end('Your account home disconnected this app.');
    });

    // Writes stop working when the note runs out; say so rather than fail quietly.
    if (expiry) globalThis.clearTimeout(expiry);
    const left = grant.expiresAt * 1000 - Date.now();
    expiry = globalThis.setTimeout(() => update({ status: 'expired' }), Math.min(left, 2 ** 31 - 1));
  }

  const connection: WeaveConnection = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      started ??= (async () => {
        const grant = grants.load();
        if (!grant) {
          update({ status: 'disconnected' });
          return;
        }
        try {
          await open(grant);
        } catch (error) {
          update({ status: 'disconnected', error: error instanceof Error ? error.message : String(error) });
        }
      })();
      return started;
    },

    async connect(home) {
      const was = state.status;
      let address: string;
      try {
        address = home === undefined ? state.home : homeAddress(home);
      } catch (error) {
        update({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
      update({ status: 'connecting', error: null });
      try {
        // Nothing awaited before this: the popup must open inside the click.
        const grant = await connectToHome({ home: address, request: config.request });
        grants.save(grant);
        try {
          storage?.setItem(HOME, address);
        } catch {
          // Remembering is a convenience.
        }
        update({ home: address });
        await open(grant);
      } catch (error) {
        update({
          status: was === 'expired' || was === 'ready' ? was : 'disconnected',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    disconnect: () => end(null),
  };

  return connection;
}
