/**
 * The daemon's server: one port, three jobs.
 *
 * - `/peer?space=<id>` — browsers and other nodes dial in with the protocol's
 *   WebSocket transport. Every peer first proves the DID it gives is its own,
 *   and for a private space that it holds the space's key
 *   (`src/network/peer-auth.ts`); a public one is otherwise open, as it is to
 *   anyone anyway. Each socket becomes a peer in that space, with no relay and
 *   no TURN in between.
 * - any other path, `?room=<id>` — the signaling relay, so a self-hoster runs
 *   one process to bootstrap a space.
 * - `GET /health` — alive or not, for monitoring.
 *
 * It listens on this machine only unless told otherwise (`--host 0.0.0.0`):
 * a node on a server sits behind whatever terminates TLS, and one on a laptop
 * has no business being reachable from the café's Wi-Fi.
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

/** The same limits as the public relay (`server/signaling-server.mjs`) */
const RELAY_MAX_ROOM_LENGTH = 128;
const RELAY_MAX_PEERS_PER_ROOM = 64;
const RELAY_MESSAGES_PER_SECOND = 50;
const RELAY_BURST = 100;
const DID_PATTERN = /^did:key:z[1-9A-HJ-NP-Za-km-z]{1,250}$/;

function createRelay() {
  const rooms = new Map<string, Set<RelayClient>>();

  const broadcast = (sender: RelayClient, payload: string) => {
    for (const peer of rooms.get(sender.room) ?? []) {
      if (peer !== sender && peer.did && peer.socket.readyState === peer.socket.OPEN) peer.socket.send(payload);
    }
  };

  return {
    rooms,
    accept(socket: WebSocket, room: string) {
      if (room.length > RELAY_MAX_ROOM_LENGTH || (rooms.get(room)?.size ?? 0) >= RELAY_MAX_PEERS_PER_ROOM) {
        socket.close(1008, 'room refused');
        return;
      }
      const client: RelayClient = { socket, room, did: null };
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room)!.add(client);

      // A token bucket: bursts are fine, a flood is cut off.
      let tokens = RELAY_BURST;
      let refilled = Date.now();

      socket.on('message', (data: RawData, isBinary: boolean) => {
        const now = Date.now();
        tokens = Math.min(RELAY_BURST, tokens + ((now - refilled) / 1000) * RELAY_MESSAGES_PER_SECOND);
        refilled = now;
        if ((tokens -= 1) < 0) {
          socket.close(1008, 'too many messages');
          return;
        }
        if (isBinary) return;
        let message: { type?: unknown; from?: unknown; to?: unknown; payload?: unknown };
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (typeof message?.type !== 'string') return;
        // Only peers already present hear about a newcomer, so exactly one
        // side creates the offer and the two never collide. A socket joins
        // once, as one DID, and a DID already here is not handed to another.
        if (message.type === 'join') {
          if (client.did || typeof message.from !== 'string' || !DID_PATTERN.test(message.from)) return;
          if ([...rooms.get(room)!].some((peer) => peer.did === message.from)) {
            socket.close(4009, 'that DID is already in this room');
            return;
          }
          client.did = message.from;
          broadcast(client, JSON.stringify({ type: 'join', from: client.did }));
          return;
        }
        if (!client.did || !['offer', 'answer', 'candidate'].includes(message.type) || typeof message.to !== 'string') return;
        const target = [...(rooms.get(room) ?? [])].find((peer) => peer.did === message.to);
        // Always from the sender as it joined, whatever the message claims.
        const forwarded = { type: message.type, from: client.did, to: message.to, payload: message.payload };
        if (target && target.socket.readyState === target.socket.OPEN) target.socket.send(JSON.stringify(forwarded));
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

function parseHello(data: RawData, isBinary: boolean): { did: string; nonce: string; proof: { sig?: unknown; read?: unknown } } | null {
  if (isBinary) return null;
  try {
    const hello = JSON.parse(String(data)) as { type?: unknown; did?: unknown; nonce?: unknown; sig?: unknown; read?: unknown };
    return hello.type === 'hello' && typeof hello.did === 'string' && DID_PATTERN.test(hello.did) && typeof hello.nonce === 'string'
      ? { did: hello.did, nonce: hello.nonce, proof: { sig: hello.sig, read: hello.read } }
      : null;
  } catch {
    return null;
  }
}

export async function serve(options: ServeOptions): Promise<Served> {
  const { node, inbound } = options;
  const relay = createRelay();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  // Signaling is offers and candidates: a few kilobytes at most.
  const relaySockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const http = createServer((req, res) => {
    // Up or not, and nothing more: which account runs here, and how much it
    // holds, is nobody's business who can reach the port.
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('This endpoint speaks WebSocket only.\n');
  });

  /** Spaces a peer has asked for: held from then on, for as long as this node serves */
  const served = new Set<string>();
  const onPeer = async (socket: WebSocket, url: URL) => {
    const spaceId = url.searchParams.get('space');
    if (!spaceId) {
      socket.close(4000, 'missing ?space=');
      return;
    }
    // Challenge first, whatever the space: a node that answered "not here"
    // before any proof would tell every web page that asks which spaces this
    // machine holds. One that does not hold the space refuses the hello the
    // same way it refuses a stranger.
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
        if (!authenticator || !(await authenticator.checkHello(hello.did, node.sessionDid, nonce, hello.proof))) {
          socket.close(4003, 'not a reader of this space');
          return;
        }
        if (!served.has(spaceId)) {
          await node.spaces.hold(spaceId);
          served.add(spaceId);
        }
        const sig = await authenticator.welcome(node.sessionDid, hello.nonce);
        socket.send(JSON.stringify({ type: 'welcome', did: node.sessionDid, sig }));
        inbound.accept(spaceId, socket, hello.did);
      })().catch(() => socket.close(1011, 'could not open space'));
    });

    socket.send(JSON.stringify({ type: 'challenge', nonce, did: node.sessionDid }));
  };

  http.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/peer') {
      sockets.handleUpgrade(req, socket, head, (ws) => void onPeer(ws, url).catch(() => ws.close(1011, 'internal error')));
    } else {
      relaySockets.handleUpgrade(req, socket, head, (ws) => relay.accept(ws, url.searchParams.get('room') ?? 'default'));
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    port,
    async close() {
      for (const client of [...sockets.clients, ...relaySockets.clients]) client.terminate();
      sockets.close();
      relaySockets.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
