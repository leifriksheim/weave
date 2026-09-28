/**
 * @module node/worker
 * A browser node in a worker, off the page's main thread, so checking
 * signatures, decrypting and syncing never make the page stutter.
 *
 * The page calls {@link startNodeInWorker} and gets a node with the usual API.
 * The worker runs {@link runNodeWorker} (the `@weaveprotocol/core/node-worker`
 * entry does it) and holds the node itself. Two things stay on the page: the
 * root signer, since a passkey needs a document and a key in a tab should stay
 * there, and WebRTC, since not every browser has it in workers. The worker
 * reaches both by message.
 *
 * In a `SharedWorker`, every tab of a site that opens the same account's
 * stores shares one node: one copy in memory, one set of connections, and
 * nothing to tell the other tabs when it writes. Each tab brings its signer
 * and its WebRTC; the node uses the WebRTC of the tab open longest, and moves
 * to the next when that tab goes. It closes when the last tab leaves. A tab
 * that goes without saying so is noticed by a Web Lock it holds while open.
 */
import type { RootSigner } from '../identity/root-signer.js';
import type { UCANToken } from '../identity/ucan.js';
import { createTransportSwitch, remoteTransport, serveTransport } from '../network/remote-transport.js';
import { isRecord } from '../utils/guards.js';
import { createNode } from './node.js';
import { remoteNode, remoteSigner, serveNode, serveSigner } from './remote.js';
import { workerStores, type StoreFactory, type WorkerStores } from './stores.js';
import type { NodeConfig, NodeNetworkConfig, P2PNode } from './types.js';

/**
 * What a worker needs to start a node: `NodeConfig`, less what can't be sent
 * to it. The signer stays on the page, and the stores are described.
 */
export interface WorkerNodeConfig extends Pick<
  NodeConfig,
  'accountKey' | 'contactKey' | 'contactsSpace' | 'sessionTtlSeconds' | 'sessionKey' | 'cache'
> {
  readonly stores: WorkerStores;
  readonly network?: Pick<NodeNetworkConfig, 'relays' | 'nodes' | 'iceServers'>;
}

/** What of a network config reaches the worker: plain data, never transports */
export function workerNetwork(network: NodeNetworkConfig): NonNullable<WorkerNodeConfig['network']> {
  return {
    ...(network.relays ? { relays: network.relays } : {}),
    ...(network.nodes ? { nodes: network.nodes } : {}),
    ...(network.iceServers ? { iceServers: network.iceServers } : {}),
  };
}

/** A `Worker`, a `SharedWorker`'s port, or a port to either */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  /** A dedicated worker ends with the node it holds */
  terminate?(): void;
}

const TAG = 'weave-worker';

/** The lock a tab holds while it uses a node, so the worker learns when the tab is gone */
const tabLock = (tab: string) => `weave-node-tab:${tab}`;

/** Web Locks, where this runtime has them */
function locks(): LockManager | null {
  return globalThis.navigator?.locks ?? null;
}

/**
 * Starts a node in `worker`, or joins the one it already runs for the same
 * account and stores (a `SharedWorker`), and returns it, used from here.
 * Closing it lets go of it from this tab: the signer and connections kept
 * here stop, a dedicated worker ends, and a shared node closes once no tab
 * uses it.
 *
 * @param worker Running `runNodeWorker`, as `@weaveprotocol/core/node-worker` does
 * @param config.signer Who the node acts for; its key stays on this side
 * @throws When the worker could not start the node, with its reason
 */
export async function startNodeInWorker(
  worker: WorkerLike,
  config: WorkerNodeConfig & { readonly signer: RootSigner },
): Promise<P2PNode> {
  const { signer, ...sent } = config;
  const tab = globalThis.crypto.randomUUID();
  const nodes = new MessageChannel();
  const signing = new MessageChannel();
  const connections = new MessageChannel();
  const stopSigner = serveSigner(signer, signing.port1);
  const stopConnections = serveTransport(connections.port1);

  // Held until this tab lets go of the node, or is gone.
  let letGo = () => {};
  const held = locks();
  if (held) {
    await new Promise<void>((granted) => {
      held
        .request(tabLock(tab), () => {
          granted();
          return new Promise<void>((resolve) => {
            letGo = resolve;
          });
        })
        // Taken from this tab (\`steal\`): the worker has let go of it already.
        .catch(() => {});
    });
  }
  const stop = () => {
    stopSigner();
    stopConnections();
    for (const port of [nodes.port1, signing.port1, connections.port1]) port.close();
    letGo();
    worker.terminate?.();
  };

  const started = new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const message: unknown = event.data;
      if (!isRecord(message) || message[TAG] !== true) return;
      nodes.port1.removeEventListener('message', onMessage);
      if (message.ok === true) resolve();
      else reject(new Error(typeof message.error === 'string' ? message.error : 'The node could not start'));
    };
    nodes.port1.addEventListener('message', onMessage);
    nodes.port1.start();
  });
  worker.postMessage({ [TAG]: true, kind: 'start', tab, config: sent }, [
    nodes.port2,
    signing.port2,
    connections.port2,
  ]);

  try {
    await started;
    const node = await remoteNode(nodes.port1);
    return Object.freeze({
      ...node,
      async close() {
        try {
          await node.close();
        } finally {
          stop();
        }
      },
    } satisfies P2PNode);
  } catch (error) {
    stop();
    throw error;
  }
}

/** A signer made of every tab's: the newest first, since an app's newest tab holds its freshest grant */
function createSignerSwitch(did: string, custody: RootSigner['custody']) {
  const signers = new Map<string, RootSigner>();
  const signer: RootSigner = Object.freeze({
    did,
    custody,
    async delegate(params: Parameters<RootSigner['delegate']>[0]): Promise<UCANToken> {
      let refused: unknown = new Error('No tab is open to sign with');
      for (const each of [...signers.values()].reverse()) {
        try {
          return await each.delegate(params);
        } catch (error) {
          refused = error;
        }
      }
      throw refused;
    },
  });
  return {
    signer,
    add: (tab: string, added: RootSigner) => void signers.set(tab, added),
    remove: (tab: string) => void signers.delete(tab),
  };
}

/** A node the worker holds, and the tabs using it */
interface Held {
  readonly node: Promise<P2PNode>;
  readonly tabs: Map<string, () => void>;
  readonly signers: ReturnType<typeof createSignerSwitch>;
  readonly connections: ReturnType<typeof createTransportSwitch>;
  /** The ICE servers the mesh last asked for, which each tab's connections use */
  readonly iceServers: () => ReadonlyArray<RTCIceServer>;
}

/** The same account's same stores: what makes two tabs' nodes one */
function nodeKey(did: string, stores: WorkerStores): string {
  return 'indexedDB' in stores ? `${did} idb:${stores.indexedDB}` : `${did} folder:${stores.basePath ?? ''}`;
}

/** What `runNodeWorker` listens on: a dedicated worker's scope, or a shared worker's */
interface WorkerScope {
  addEventListener(type: 'message' | 'connect', listener: (event: MessageEvent) => void): void;
}

/**
 * In a worker: starts a node when a page asks (`startNodeInWorker`), or lets
 * the page share the one already running for the same account and stores,
 * and serves it until the last page using it lets go. In a `SharedWorker`
 * each page arrives by `connect`.
 */
export function runNodeWorker(
  scope: WorkerScope = globalThis,
  options: {
    /** Opens the stores the page described. Default `workerStores`; a test hands out memory ones. */
    readonly openStores?: (stores: WorkerStores) => StoreFactory;
  } = {},
): void {
  const openStores = options.openStores ?? workerStores;
  const held = new Map<string, Held>();

  const attach = async (tab: string, sent: unknown, ports: ReadonlyArray<MessagePort>): Promise<void> => {
    const [nodePort, signerPort, transportPort] = ports;
    if (!nodePort || !signerPort || !transportPort) return;
    const fail = (error: unknown) =>
      nodePort.postMessage({
        [TAG]: true,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    let entry: Held | undefined;
    try {
      if (!isWorkerNodeConfig(sent)) throw new Error('The page sent no node config');
      const signer = await remoteSigner(signerPort);
      const key = nodeKey(signer.did, sent.stores);
      entry = held.get(key) ?? start(key, sent, signer);
      entry.signers.add(tab, signer);
      entry.connections.add(tab, remoteTransport(transportPort, entry.iceServers));
      const own = entry;
      const detach = async () => {
        const stopServing = own.tabs.get(tab);
        if (!stopServing) return;
        own.tabs.delete(tab);
        stopServing();
        own.signers.remove(tab);
        own.connections.remove(tab);
        if (own.tabs.size > 0) return;
        held.delete(key);
        await (await own.node).close();
      };
      own.tabs.set(tab, () => {});
      const node = await own.node;
      // Said before serving, so it reaches the page ahead of any reply.
      nodePort.postMessage({ [TAG]: true, ok: true });
      // This tab's view: closing it lets go of the node, which others may still use.
      own.tabs.set(tab, serveNode(Object.freeze({ ...node, close: detach }), nodePort));
      // The tab is gone when its lock comes free: nobody is left to answer on its ports.
      void locks()
        ?.request(tabLock(tab), async () => {
          await detach();
          for (const port of ports) port.close();
        })
        .catch(() => {});
    } catch (error) {
      if (entry) {
        entry.tabs.delete(tab);
        entry.signers.remove(tab);
        entry.connections.remove(tab);
      }
      fail(error);
    }
  };

  const start = (key: string, config: WorkerNodeConfig, signer: RootSigner): Held => {
    const { stores, network, ...rest } = config;
    const signers = createSignerSwitch(signer.did, signer.custody);
    const connections = createTransportSwitch();
    let meshIce: () => ReadonlyArray<RTCIceServer> = () => [];
    const entry: Held = {
      signers,
      connections,
      iceServers: () => meshIce(),
      tabs: new Map(),
      node: createNode({
        ...rest,
        signer: signers.signer,
        stores: openStores(stores),
        ...(network
          ? {
              network: {
                ...network,
                createTransport: (iceServers) => {
                  meshIce = iceServers;
                  return connections.transport;
                },
              },
            }
          : {}),
      }),
    };
    held.set(key, entry);
    // A node that fails to start is forgotten, so the next tab tries again.
    entry.node.catch(() => {
      if (held.get(key) === entry) held.delete(key);
    });
    return entry;
  };

  const listen = (port: { addEventListener: WorkerScope['addEventListener'] }) =>
    port.addEventListener('message', (event: MessageEvent) => {
      const message: unknown = event.data;
      if (!isRecord(message) || message[TAG] !== true || message.kind !== 'start') return;
      const tab = typeof message.tab === 'string' ? message.tab : globalThis.crypto.randomUUID();
      void attach(tab, message.config, event.ports);
    });

  // A shared worker hears from each page on a port of its own; a dedicated one, on its scope.
  scope.addEventListener('connect', (event: MessageEvent) => {
    for (const port of event.ports) {
      listen(port);
      port.start();
    }
  });
  listen(scope);
}

function isWorkerNodeConfig(value: unknown): value is WorkerNodeConfig {
  return isRecord(value) && isRecord(value.stores);
}
