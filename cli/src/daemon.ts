/**
 * The daemon: a node that stays up.
 *
 * It opens every space the account holds, serves sockets for browsers and
 * other nodes to dial in, and keeps looking for spaces added while it runs — by
 * a CLI command against the same folder, by a browser pointed at it, or by
 * pairing. That is the whole job. It is a peer with uptime, not a server with
 * authority: everything that arrives passes the same gates it would anywhere.
 */
import { createNode, type P2PNode } from '../../src/index.js';
import type { Unlocked } from './home.js';
import { createInboundPeers, serve, type Served } from './serve.js';

export interface DaemonOptions {
  readonly unlocked: Unlocked;
  readonly port: number;
  readonly host?: string;
  /** Other always-on nodes to hold sockets to, `ws(s)://host:port/peer` */
  readonly nodes?: ReadonlyArray<string>;
  /** How often to look for spaces added or left elsewhere. Default 5000 ms. */
  readonly rescanMs?: number;
  readonly log?: (line: string) => void;
}

export interface Daemon {
  readonly node: P2PNode;
  readonly port: number;
  close(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const log = options.log ?? (() => {});
  const inbound = createInboundPeers();

  const node = await createNode({
    signer: options.unlocked.signer,
    stores: options.unlocked.stores,
    // Following the account registry is what makes this *your* node: every
    // space the account joins, on any device, is served here too.
    accountKey: options.unlocked.accountKey,
    // No relays: WebRTC needs a browser. Peers reach this node over sockets.
    network: {
      transports: inbound.transports,
      ...(options.nodes?.length ? { nodes: options.nodes } : {}),
    },
  });

  const open = new Set<string>();
  const rescan = async () => {
    const held = new Set((await node.spaces.list()).map((space) => space.id));
    for (const id of held) {
      if (open.has(id)) continue;
      await node.spaces.open(id);
      open.add(id);
      log(`serving space ${id}`);
    }
    for (const id of [...open]) {
      if (held.has(id)) continue;
      await node.spaces.close(id);
      open.delete(id);
      log(`stopped serving space ${id}`);
    }
  };
  await rescan();

  let scanning = false;
  const timer = setInterval(() => rescanSoon(), options.rescanMs ?? 5000);

  const rescanSoon = () => {
    if (scanning) return;
    scanning = true;
    rescan()
      .catch((error: unknown) => log(`rescan failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        scanning = false;
      });
  };

  node.subscribe((event) => {
    // The registry just joined or left something: serve it now, not in five seconds.
    if (event.type === 'spaces') rescanSoon();
    if (event.type === 'rejected') log(`rejected a record from ${event.peer} in ${event.space}: ${event.reason}`);
  });

  let served: Served;
  try {
    served = await serve({ node, inbound, port: options.port, ...(options.host ? { host: options.host } : {}) });
  } catch (error) {
    clearInterval(timer);
    await node.close();
    if ((error as { code?: string }).code === 'EADDRINUSE') {
      throw new Error(`Port ${options.port} is already in use — is another "p2p run" going? Stop it, or pick another port with --port.`);
    }
    throw error;
  }
  log(`${node.did} listening on port ${served.port}`);

  return {
    node,
    port: served.port,
    async close() {
      clearInterval(timer);
      await served.close();
      await node.close();
    },
  };
}
