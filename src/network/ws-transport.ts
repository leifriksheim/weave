/**
 * @fileoverview A WebSocket to one always-on node, as a transport.
 *
 * Browsers cannot accept connections, but they can dial a node that has a DNS
 * name and a TLS certificate — no relay, no offer and answer, and no TURN for
 * peers that could not otherwise reach each other. The node appears as a
 * single peer.
 *
 * The wire is deliberately plain — three text frames, then binary:
 *
 * 1. node → `{"type":"challenge","nonce":…,"did":…}`
 * 2. client → `{"type":"hello","did":…,"nonce":…,"mac"?:…}`
 * 3. node → `{"type":"welcome","did":…,"mac"?:…}`
 * 4. binary frames either way, passed through untouched.
 *
 * For a private space both MACs are required and prove each side holds the
 * space key (see `peer-auth.ts`); a node that cannot prove it is dropped. A
 * public space needs no proof — anyone may read it anyway.
 */

import type { PeerTransport, PeerTransportEvents } from './transport.js';
import { peerNonce, type PeerAuthenticator } from './peer-auth.js';

export interface WebSocketTransportConfig {
  /** `wss://node.example.com/peer` */
  readonly url: string;
  /** This side's DID, sent in the hello */
  readonly did: string;
  /** Redial after an unexpected close. Default true. */
  readonly reconnect?: boolean;
  /** Ceiling for the redial backoff. Default 30 s. */
  readonly maxBackoffMs?: number;
  /** Proves membership of a private space, and checks the node's proof. Omit for a public space. */
  readonly authenticator?: PeerAuthenticator | null;
}

interface Frame {
  readonly type?: unknown;
  readonly did?: unknown;
  readonly nonce?: unknown;
  readonly mac?: unknown;
}

function parseFrame(data: unknown, type: string): Frame | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data) as Frame;
    return parsed?.type === type && typeof parsed.did === 'string' && parsed.did.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Creates a transport that holds one socket to one node, redialling it with
 * backoff for as long as the transport is wanted.
 *
 * @param config - Where to dial, and as whom.
 * @returns The transport; call `connect()` to start.
 */
export function createWebSocketTransport(config: WebSocketTransportConfig): PeerTransport {
  const reconnect = config.reconnect !== false;
  const maxBackoffMs = config.maxBackoffMs ?? 30_000;

  let ws: WebSocket | null = null;
  /** The node's DID, once its hello has arrived */
  let peerId: string | null = null;
  /** Set by close/closeAll: an intentional shutdown must never be fought */
  let stopped = false;
  let retryCount = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners: { [K in keyof PeerTransportEvents]?: Set<any> } = {};

  const emit = <K extends keyof PeerTransportEvents>(event: K, ...args: Parameters<PeerTransportEvents[K]>) => {
    listeners[event]?.forEach((callback) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (callback as any)(...args);
      } catch (e) {
        console.error(`Error in WebSocket transport event listener for ${event}:`, e);
      }
    });
  };

  const on = <K extends keyof PeerTransportEvents>(event: K, callback: PeerTransportEvents[K]): void => {
    (listeners[event] ??= new Set()).add(callback);
  };

  const off = <K extends keyof PeerTransportEvents>(event: K, callback: PeerTransportEvents[K]): void => {
    listeners[event]?.delete(callback);
  };

  const scheduleRedial = () => {
    if (stopped || !reconnect || reconnectTimer) return;
    // Exponential, capped, with jitter so a node restart is not met by every
    // client at the same instant.
    const base = Math.min(1000 * 2 ** retryCount, maxBackoffMs);
    const delay = base / 2 + Math.random() * (base / 2);
    retryCount += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      dial().catch(() => {
        // The close handler schedules the next attempt.
      });
    }, delay);
  };

  const dial = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (stopped) {
        reject(new Error('Transport was closed'));
        return;
      }

      let socket: WebSocket;
      try {
        socket = new WebSocket(config.url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        scheduleRedial();
        return;
      }
      ws = socket;
      socket.binaryType = 'arraybuffer';
      let settled = false;
      let stage: 'challenge' | 'welcome' | 'open' = 'challenge';
      const ourNonce = peerNonce();
      const authenticator = config.authenticator ?? null;

      const refuse = (reason: string) => {
        const error = new Error(reason);
        emit('error', config.url, error);
        if (!settled) {
          settled = true;
          reject(error);
        }
        // Clients may only send 1000 or 3000–4999; 4002 mirrors 1002 "protocol error".
        socket.close(4002, 'protocol error');
      };

      const handle = async (event: MessageEvent) => {
        if (stage === 'challenge') {
          const challenge = parseFrame(event.data, 'challenge');
          if (!challenge || typeof challenge.nonce !== 'string') return refuse('Expected a challenge from the node');
          const mac = authenticator ? await authenticator.sign('client', config.did, challenge.nonce) : undefined;
          socket.send(JSON.stringify({ type: 'hello', did: config.did, nonce: ourNonce, ...(mac ? { mac } : {}) }));
          stage = 'welcome';
          return;
        }

        if (stage === 'welcome') {
          const welcome = parseFrame(event.data, 'welcome');
          if (!welcome) return refuse('Expected a welcome from the node');
          const did = welcome.did as string;
          if (authenticator && !(await authenticator.verify('server', did, ourNonce, welcome.mac))) {
            return refuse('The node could not prove it belongs to this space');
          }
          stage = 'open';
          peerId = did;
          retryCount = 0;
          settled = true;
          emit('connected', peerId);
          resolve();
          return;
        }

        if (event.data instanceof ArrayBuffer && peerId !== null) {
          emit('data', peerId, new Uint8Array(event.data));
        }
        // Text after the welcome has no meaning in this protocol; ignore it.
      };

      // Frames are handled one at a time: the handshake awaits crypto, and a
      // data frame must not overtake the welcome that opens the connection.
      let queue: Promise<void> = Promise.resolve();
      socket.onmessage = (event: MessageEvent) => {
        queue = queue
          .then(() => handle(event))
          .catch((error: unknown) => refuse(error instanceof Error ? error.message : String(error)));
      };

      socket.onerror = () => {
        const error = new Error(`WebSocket error on ${config.url}`);
        emit('error', peerId ?? config.url, error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      socket.onclose = () => {
        if (ws === socket) ws = null;
        const wasConnected = peerId;
        peerId = null;
        if (wasConnected) emit('disconnected', wasConnected);
        if (!settled) {
          settled = true;
          reject(new Error(`Connection to ${config.url} closed before the handshake finished`));
        }
        scheduleRedial();
      };
    });

  const connect = (): Promise<void> => {
    stopped = false;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve();
    }
    return dial();
  };

  const send = (target: string, data: Uint8Array): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN || target !== peerId) {
      throw new Error(`Not connected to ${target}`);
    }
    ws.send(data);
  };

  const closeAll = (): void => {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close(1000, 'closed');
  };

  return Object.freeze({
    connect,
    send,
    // One socket, one peer: closing the peer closes the transport.
    close: (target: string) => {
      if (target === peerId) closeAll();
    },
    closeAll,
    on,
    off,
  });
}
