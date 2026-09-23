/**
 * @fileoverview A WebSocket to one always-on node, as a transport.
 *
 * Browsers cannot accept connections, but they can dial a node that has a DNS
 * name and a TLS certificate — no relay, no offer and answer, and no TURN for
 * peers that could not otherwise reach each other. The node appears as a
 * single peer.
 *
 * The wire is deliberately plain:
 *
 * 1. After the socket opens, each side sends one text frame:
 *    `{"type":"hello","did":"<its did>"}`.
 * 2. Everything after that is binary frames, passed through untouched.
 *
 * The node's `did` in its hello is a claim, not a proof. That is acceptable for
 * data — every expression is signed and validated on arrival, so a node lying
 * about who it is still cannot forge anything — but anything that trusts the
 * node *as a party* needs a signed challenge first. That belongs to the node's
 * own block, not here.
 */

import type { PeerTransport, PeerTransportEvents } from './transport.js';

export interface WebSocketTransportConfig {
  /** `wss://node.example.com/peer` */
  readonly url: string;
  /** This side's DID, sent in the hello */
  readonly did: string;
  /** Redial after an unexpected close. Default true. */
  readonly reconnect?: boolean;
  /** Ceiling for the redial backoff. Default 30 s. */
  readonly maxBackoffMs?: number;
}

interface Hello {
  readonly type: 'hello';
  readonly did: string;
}

function parseHello(data: unknown): Hello | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data) as Partial<Hello>;
    return parsed?.type === 'hello' && typeof parsed.did === 'string' && parsed.did.length > 0
      ? { type: 'hello', did: parsed.did }
      : null;
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

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'hello', did: config.did } satisfies Hello));
      };

      socket.onmessage = (event: MessageEvent) => {
        if (peerId === null) {
          const hello = parseHello(event.data);
          if (!hello) {
            // A node that does not introduce itself first is not speaking this protocol.
            const error = new Error('Expected a hello frame from the node');
            emit('error', config.url, error);
            if (!settled) {
              settled = true;
              reject(error);
            }
            // Clients may only send 1000 or 3000–4999; 4002 mirrors 1002 "protocol error".
            socket.close(4002, 'protocol error');
            return;
          }
          peerId = hello.did;
          retryCount = 0;
          settled = true;
          emit('connected', peerId);
          resolve();
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          emit('data', peerId, new Uint8Array(event.data));
        }
        // Text after the hello has no meaning in this protocol; ignore it.
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
          reject(new Error(`Connection to ${config.url} closed before the node said hello`));
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
