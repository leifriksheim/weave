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
 */
import type { RootSigner } from '../identity/root-signer.js';
import { remoteTransport, serveTransport } from '../network/remote-transport.js';
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

/** A `Worker`, or a port to one */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate?(): void;
}

const TAG = 'weave-worker';

/**
 * Starts a node in `worker` and returns it, used from here. Closing it closes
 * the node, stops the signer and connections kept here, and ends the worker.
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
  const nodes = new MessageChannel();
  const signing = new MessageChannel();
  const connections = new MessageChannel();
  const stopSigner = serveSigner(signer, signing.port1);
  const stopConnections = serveTransport(connections.port1);
  const stop = () => {
    stopSigner();
    stopConnections();
    for (const port of [nodes.port1, signing.port1, connections.port1]) port.close();
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
  worker.postMessage({ [TAG]: true, kind: 'start', config: sent }, [
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

/** What `runNodeWorker` listens on: a dedicated worker's scope */
interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/**
 * In a worker: starts a node each time a page asks (`startNodeInWorker`), and
 * serves it until the page closes it.
 */
export function runNodeWorker(
  scope: WorkerScope = globalThis,
  options: {
    /** Opens the stores the page described. Default `workerStores`; a test hands out memory ones. */
    readonly openStores?: (stores: WorkerStores) => StoreFactory;
  } = {},
): void {
  const openStores = options.openStores ?? workerStores;
  scope.addEventListener('message', (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message) || message[TAG] !== true || message.kind !== 'start') return;
    const [nodePort, signerPort, transportPort] = event.ports;
    if (!nodePort || !signerPort || !transportPort) return;
    void start(message.config, openStores, nodePort, signerPort, transportPort);
  });
}

async function start(
  sent: unknown,
  openStores: (stores: WorkerStores) => StoreFactory,
  nodePort: MessagePort,
  signerPort: MessagePort,
  transportPort: MessagePort,
): Promise<void> {
  try {
    if (!isWorkerNodeConfig(sent)) throw new Error('The page sent no node config');
    const { stores, network, ...rest } = sent;
    const node = await createNode({
      ...rest,
      signer: await remoteSigner(signerPort),
      stores: openStores(stores),
      ...(network
        ? {
            network: {
              ...network,
              createTransport: (iceServers) => remoteTransport(transportPort, iceServers),
            },
          }
        : {}),
    });
    // Said before serving, so it reaches the page ahead of any reply. The page ends the worker when it closes the node.
    nodePort.postMessage({ [TAG]: true, ok: true });
    serveNode(node, nodePort);
  } catch (error) {
    nodePort.postMessage({
      [TAG]: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isWorkerNodeConfig(value: unknown): value is WorkerNodeConfig {
  return isRecord(value) && isRecord(value.stores);
}
