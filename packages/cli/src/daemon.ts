/**
 * The daemon: a node that stays up.
 *
 * It opens every space the account holds, serves sockets for browsers and
 * other nodes to dial in, and keeps looking for spaces added while it runs — by
 * a CLI command against the same folder, by a browser pointed at it, or by
 * pairing. Given relays, it also meets the account's other devices through
 * them, over WebRTC, so a fresh account on a laptop finds its spaces with
 * nothing pointed at it. That is the whole job. It is a peer with uptime, not a
 * server with authority: everything that arrives passes the same gates.
 */
import type { P2PNode } from '@weaveprotocol/core';
import { enableWebRTC, holdEverySpace } from './agent.js';
import { nodeFor, type Unlocked } from './home.js';
import { errorCode, messageOf } from './json.js';
import { createInboundPeers, serve, type Served } from './serve.js';

export interface DaemonOptions {
  readonly unlocked: Unlocked;
  readonly port: number;
  readonly host?: string;
  /** Other always-on nodes to hold sockets to, `ws(s)://host:port/peer` */
  readonly nodes?: ReadonlyArray<string>;
  /** Relays to meet devices on, over WebRTC. None, or WebRTC that won't load, and peers reach it over sockets only. */
  readonly relays?: ReadonlyArray<string>;
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
  // WebRTC is a native module: a single-file binary doesn't carry it, and is reached over sockets instead.
  const relays = options.relays?.length
    ? await enableWebRTC().then(
        () => options.relays ?? [],
        (error: unknown) => {
          log(`no WebRTC here (${messageOf(error)}), so no relays: peers reach this node over sockets`);
          return [];
        },
      )
    : [];

  // Following the account registry is what makes this *your* node: every
  // space the account joins, on any device, is served here too.
  const node = await nodeFor(options.unlocked, {
    network: {
      transports: inbound.transports,
      ...(relays.length ? { relays } : {}),
      ...(options.nodes?.length ? { nodes: options.nodes } : {}),
    },
  });
  const stopHolding = await holdEverySpace(node, {
    everyMs: options.rescanMs ?? 5000,
    onHold: (id) => log(`serving space ${id}`),
    onRelease: (id) => log(`stopped serving space ${id}`),
    log,
  });
  node.subscribe((event) => {
    if (event.type === 'rejected')
      log(`rejected a record from ${event.peer} in ${event.space}: ${event.reason}`);
  });

  let served: Served;
  try {
    served = await serve({
      node,
      inbound,
      port: options.port,
      ...(options.host ? { host: options.host } : {}),
    });
  } catch (error) {
    stopHolding();
    await node.close();
    if (errorCode(error) === 'EADDRINUSE') {
      throw new Error(
        `Port ${options.port} is already in use — is another "weave run" going? Stop it, or pick another port with --port.`,
      );
    }
    throw error;
  }
  log(
    `${node.did} listening on port ${served.port}${relays.length ? `, meeting devices at ${relays.join(', ')}` : ''}`,
  );

  return {
    node,
    port: served.port,
    async close() {
      stopHolding();
      await served.close();
      await node.close();
    },
  };
}
