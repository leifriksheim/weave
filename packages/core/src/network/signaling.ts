/**
 * @fileoverview WebRTC signaling over one WebSocket to a relay.
 *
 * One socket serves every room this peer is in: it joins and leaves rooms as
 * spaces open and close, and joins them all again after a reconnect.
 */
import { createEmitter } from '../utils/events.js';
import { isObject } from '../utils/guards.js';

/** What a peer's connection offer, answer or candidate is */
export type SignalKind = 'offer' | 'answer' | 'candidate';

export interface SignalingMessage {
  readonly type: SignalKind | 'join' | 'leave' | 'ice';
  readonly from: string;
  readonly to?: string;
  readonly room?: string;
  readonly payload?: unknown;
}

export type SignalingEvents = {
  /** An offer, answer or candidate from a peer */
  signal: (message: SignalingMessage & { readonly type: SignalKind }) => void;
  'peer-joined': (did: string, room: string) => void;
  'peer-left': (did: string, room: string) => void;
  /**
   * TURN servers the relay offers, with passwords that stop working at
   * `expiresAt` (ms). For connections that cannot be made directly.
   */
  ice: (servers: ReadonlyArray<RTCIceServer>, expiresAt: number) => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
};

export interface SignalingClient {
  readonly connect: () => Promise<void>;
  readonly disconnect: () => void;
  /** Enters a room, now and after every reconnect, and hears who else is there. */
  readonly join: (room: string) => void;
  readonly leave: (room: string) => void;
  readonly signal: (kind: SignalKind, targetDid: string, payload: unknown) => void;
  /** Asks the relay for fresh TURN passwords; they arrive as an `ice` event, from relays that have TURN */
  readonly requestIce: () => void;
  readonly on: <K extends keyof SignalingEvents>(event: K, callback: SignalingEvents[K]) => void;
  readonly off: <K extends keyof SignalingEvents>(event: K, callback: SignalingEvents[K]) => void;
  readonly isConnected: () => boolean;
}

const SIGNAL_KINDS: ReadonlySet<unknown> = new Set(['offer', 'answer', 'candidate']);

/** Whether a value names an offer, answer or candidate */
export function isSignalKind(value: unknown): value is SignalKind {
  return SIGNAL_KINDS.has(value);
}

/** A relay's TURN offer, kept only if it has the shape of one: `turn:`/`turns:` URLs, a username and a password */
function iceFrom(payload: unknown): { servers: ReadonlyArray<RTCIceServer>; expiresAt: number } | null {
  if (!isObject(payload)) return null;
  const { servers, expiresAt } = payload;
  if (!Array.isArray(servers) || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  const kept: RTCIceServer[] = [];
  for (const server of servers.slice(0, 4)) {
    if (!isObject(server)) continue;
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
      (url): url is string => typeof url === 'string' && url.length < 256 && /^turns?:/.test(url),
    );
    if (urls.length === 0 || typeof server.username !== 'string' || typeof server.credential !== 'string')
      continue;
    kept.push({ urls, username: server.username, credential: server.credential });
  }
  return kept.length > 0 ? { servers: kept, expiresAt } : null;
}

/**
 * Creates a new signaling client.
 *
 * @param url - The relay's WebSocket URL.
 * @param did - The decentralized identifier of this peer.
 * @returns The signaling client instance.
 */
export function createSignalingClient(url: string, did: string): SignalingClient {
  let ws: WebSocket | null = null;
  let connected = false;
  let retryCount = 0;
  const maxRetries = 5;
  const maxBackoffMs = 30000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const rooms = new Set<string>();
  const { on, off, emit } = createEmitter<SignalingEvents>();

  const sendMessage = (msg: Omit<SignalingMessage, 'from'>) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ ...msg, from: did }));
  };

  const connect = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        resolve();
        return;
      }

      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      ws.onopen = () => {
        connected = true;
        retryCount = 0;
        emit('connected');
        for (const room of rooms) sendMessage({ type: 'join', room });
        resolve();
      };

      ws.onmessage = (event) => {
        try {
          const msg: unknown = JSON.parse(String(event.data));
          if (!isObject(msg)) throw new Error('Not a signaling message');
          const { type, from, room, to, payload } = msg;
          if (type === 'ice') {
            const offered = iceFrom(payload);
            if (offered) emit('ice', offered.servers, offered.expiresAt);
            return;
          }
          // The relay stamps who each message is from.
          if (typeof from !== 'string') return;
          if (isSignalKind(type))
            emit('signal', {
              type,
              from,
              payload,
              ...(typeof to === 'string' ? { to } : {}),
              ...(typeof room === 'string' ? { room } : {}),
            });
          else if (typeof room !== 'string') return;
          else if (type === 'join') emit('peer-joined', from, room);
          else if (type === 'leave') emit('peer-left', from, room);
        } catch (err) {
          emit('error', err instanceof Error ? err : new Error(String(err)));
        }
      };

      ws.onerror = () => {
        const error = new Error('WebSocket error occurred');
        emit('error', error);
        if (!connected) {
          reject(error);
        }
      };

      ws.onclose = () => {
        connected = false;
        emit('disconnected');

        if (retryCount < maxRetries) {
          const backoff = Math.min(1000 * Math.pow(2, retryCount), maxBackoffMs);
          retryCount++;
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
          }
          reconnectTimer = setTimeout(() => {
            connect().catch(() => {
              // Ignore promise rejection on reconnect attempt
            });
          }, backoff);
        }
      };
    });
  };

  const disconnect = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    retryCount = maxRetries; // Prevent reconnection
    if (ws) {
      ws.close();
      ws = null;
    }
    connected = false;
    rooms.clear();
  };

  return Object.freeze({
    connect,
    disconnect,
    join: (room: string) => {
      if (rooms.has(room)) return;
      rooms.add(room);
      sendMessage({ type: 'join', room });
    },
    leave: (room: string) => {
      if (rooms.delete(room)) sendMessage({ type: 'leave', room });
    },
    signal: (kind: SignalKind, targetDid: string, payload: unknown) =>
      sendMessage({ type: kind, to: targetDid, payload }),
    requestIce: () => sendMessage({ type: 'ice' }),
    on,
    off,
    isConnected: () => connected,
  });
}
