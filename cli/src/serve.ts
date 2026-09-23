/**
 * The daemon's server: one port, three jobs.
 *
 * - `/peer?space=<id>` — browsers and other nodes dial in with the protocol's
 *   WebSocket transport. For a private space both sides first prove they hold
 *   its key (`src/network/peer-auth.ts`); a public one is open, as it is to
 *   anyone anyway. Each socket becomes a peer in that space, with no relay and
 *   no TURN in between.
 * - any other path, `?room=<id>` — the signaling relay, so a self-hoster runs
 *   one process to bootstrap a space.
 * - `GET /health` — rooms, peers and spaces, for monitoring.
 *
 * The node is an anchor, not a host: it validates everything that arrives with
 * the same gates as any peer, and holds no authority a peer does not.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { peerNonce, type P2PNode, type PeerTransport, type PeerTransportEvents } from '../../src/index.js';

// ─── Inbound peers ─────────────────────────────────────────────────────

interface SpacePeers {
  readonly transport: PeerTransport;
  accept(socket: WebSocket, peerDid: string): void;
}

function createSpacePeers(): SpacePeers {
  const sockets = new Map<string, WebSocket>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners: { [K in keyof PeerTransportEvents]?: Set<any> } = {};
  const emit = <K extends keyof PeerTransportEvents>(event: K, ...args: Parameters<PeerTransportEvents[K]>) => {
    for (const callback of listeners[event] ?? []) {
      try {
        callback(...args);
      } catch (error) {
        console.error(`inbound ${event} listener failed:`, error);
      }
    }
  };

  const transport: PeerTransport = {
    send(peerId, data) {
      const socket = sockets.get(peerId);
      if (!socket || socket.readyState !== socket.OPEN) throw new Error(`Not connected to ${peerId}`);
      socket.send(data, { binary: true });
    },
    close(peerId) {
      sockets.get(peerId)?.close(1000, 'closed');
    },
    closeAll() {
      for (const socket of sockets.values()) socket.close(1001, 'node shutting down');
    },
    on: (event, callback) => void (listeners[event] ??= new Set()).add(callback),
    off: (event, callback) => void listeners[event]?.delete(callback),
  };

  return {
    transport,
    accept(socket, peerDid) {
      // The same key reconnecting replaces its old socket rather than doubling up.
      sockets.get(peerDid)?.close(4009, 'replaced by a newer connection');
      sockets.set(peerDid, socket);
      socket.on('message', (data: RawData, isBinary: boolean) => {
        if (!isBinary) return;
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        emit('data', peerDid, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      });
      socket.on('close', () => {
        if (sockets.get(peerDid) !== socket) return;
        sockets.delete(peerDid);
        emit('disconnected', peerDid);
      });
      socket.on('error', (error: Error) => emit('error', peerDid, error));
      emit('connected', peerDid);
    },
  };
}

/**
 * Inbound transports, one per open space.
 *
 * A fresh one each time the node opens a space: a closed space's network
 * manager still holds listeners on the old one, and reusing it would feed a
 * stopped sync engine.
 */
export function createInboundPeers() {
  const spaces = new Map<string, SpacePeers>();
  return {
    /** For `NodeNetworkConfig.transports` — called by the node as it opens a space */
    transports: (spaceId: string): ReadonlyArray<PeerTransport> => {
      const peers = createSpacePeers();
      spaces.set(spaceId, peers);
      return [peers.transport];
    },
    accept: (spaceId: string, socket: WebSocket, peerDid: string) => {
      const peers = spaces.get(spaceId);
      if (!peers) throw new Error(`Space ${spaceId} is not open`);
      peers.accept(socket, peerDid);
    },
    count: () => spaces.size,
  };
}

export type InboundPeers = ReturnType<typeof createInboundPeers>;

// ─── Relay ─────────────────────────────────────────────────────────────

interface RelayClient {
  readonly socket: WebSocket;
  readonly room: string;
  did: string | null;
}

function createRelay() {
  const rooms = new Map<string, Set<RelayClient>>();

  const broadcast = (sender: RelayClient, payload: string) => {
    for (const peer of rooms.get(sender.room) ?? []) {
      if (peer !== sender && peer.socket.readyState === peer.socket.OPEN) peer.socket.send(payload);
    }
  };

  return {
    rooms,
    accept(socket: WebSocket, room: string) {
      const client: RelayClient = { socket, room, did: null };
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room)!.add(client);

      socket.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        let message: { type?: unknown; from?: unknown; to?: unknown };
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (typeof message?.type !== 'string') return;
        // Only peers already present hear about a newcomer, so exactly one
        // side creates the offer and the two never collide.
        if (message.type === 'join') {
          client.did = typeof message.from === 'string' ? message.from : null;
          broadcast(client, JSON.stringify(message));
          return;
        }
        if (typeof message.to === 'string') {
          const target = [...(rooms.get(room) ?? [])].find((peer) => peer.did === message.to);
          if (target && target.socket.readyState === target.socket.OPEN) target.socket.send(JSON.stringify(message));
        }
      });

      socket.on('close', () => {
        const peers = rooms.get(room);
        if (!peers?.delete(client)) return;
        if (peers.size === 0) rooms.delete(room);
        if (client.did) broadcast(client, JSON.stringify({ type: 'leave', from: client.did }));
      });
    },
  };
}

// ─── Server ────────────────────────────────────────────────────────────

export interface ServeOptions {
  readonly node: P2PNode;
  readonly inbound: InboundPeers;
  readonly port: number;
  readonly host?: string;
  /** Close a peer that has not said hello within this many ms. Default 10 000. */
  readonly helloTimeoutMs?: number;
}

export interface Served {
  readonly port: number;
  close(): Promise<void>;
}

function parseHello(data: RawData, isBinary: boolean): { did: string; nonce: string; sig?: unknown } | null {
  if (isBinary) return null;
  try {
    const hello = JSON.parse(String(data)) as { type?: unknown; did?: unknown; nonce?: unknown; sig?: unknown };
    return hello.type === 'hello' && typeof hello.did === 'string' && hello.did.startsWith('did:') && typeof hello.nonce === 'string'
      ? { did: hello.did, nonce: hello.nonce, sig: hello.sig }
      : null;
  } catch {
    return null;
  }
}

export async function serve(options: ServeOptions): Promise<Served> {
  const { node, inbound } = options;
  const relay = createRelay();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  const http = createServer((req, res) => {
    if (req.url === '/health') {
      void node.spaces.list().then((spaces) => {
        const peers = [...relay.rooms.values()].reduce((total, room) => total + room.size, 0);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, did: node.did, spaces: spaces.length, rooms: relay.rooms.size, relayPeers: peers }));
      });
      return;
    }
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('This endpoint speaks WebSocket only.\n');
  });

  const onPeer = async (socket: WebSocket, url: URL) => {
    const spaceId = url.searchParams.get('space');
    if (!spaceId) {
      socket.close(4000, 'missing ?space=');
      return;
    }
    // Not a space this node keeps. Saying so plainly beats a silent stall.
    if (!(await node.spaces.get(spaceId))) {
      socket.close(4004, 'this node does not hold that space');
      return;
    }
    const authenticator = await node.spaces.authenticator(spaceId);
    const nonce = peerNonce();
    const timer = setTimeout(() => socket.close(4008, 'no hello'), options.helloTimeoutMs ?? 10_000);

    socket.once('message', (data: RawData, isBinary: boolean) => {
      clearTimeout(timer);
      void (async () => {
        const hello = parseHello(data, isBinary);
        if (!hello) {
          socket.close(4002, 'expected a hello frame');
          return;
        }
        if (authenticator && !(await authenticator.checkHello(hello.did, node.sessionDid, nonce, hello.sig))) {
          socket.close(4003, 'not a reader of this space');
          return;
        }
        await node.spaces.open(spaceId);
        const sig = authenticator ? await authenticator.welcome(node.sessionDid, hello.nonce) : undefined;
        socket.send(JSON.stringify({ type: 'welcome', did: node.sessionDid, ...(sig ? { sig } : {}) }));
        inbound.accept(spaceId, socket, hello.did);
      })().catch(() => socket.close(1011, 'could not open space'));
    });

    socket.send(JSON.stringify({ type: 'challenge', nonce, did: node.sessionDid }));
  };

  http.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    sockets.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === '/peer') void onPeer(ws, url).catch(() => ws.close(1011, 'internal error'));
      else relay.accept(ws, url.searchParams.get('room') ?? 'default');
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host ?? '0.0.0.0', () => resolve());
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    port,
    async close() {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
