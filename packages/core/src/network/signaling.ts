/**
 * @fileoverview WebRTC signaling over one WebSocket to a relay.
 *
 * One socket serves every room this peer is in: it joins and leaves rooms as
 * spaces open and close, and joins them all again after a reconnect. It
 * reconnects for as long as it is wanted: a relay unreachable for a minute,
 * a laptop asleep, a network switched, all end with the socket back.
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
  /**
   * The relay refused this DID (close `4009`): it has a socket with the same
   * DID in the room already. Another node signing with the same key, or this
   * one's own earlier socket not yet let go of.
   */
  refused: () => void;
  error: (error: Error) => void;
  /** The socket opened, closed, or is waiting to try again */
  status: (status: RelayStatus) => void;
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
  /** Where the socket stands */
  readonly status: () => RelayStatus;
  /** Tries again now, if waiting to */
  readonly reconnect: () => void;
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

/** Where one relay's socket stands */
export type RelayState =
  /** Opening a socket */
  | 'connecting'
  /** Open: peers can be introduced through it */
  | 'open'
  /** Closed, and trying again at `retryAt` */
  | 'waiting'
  /** Let go on purpose, or never asked to connect */
  | 'stopped';

/** One relay's connection, for showing and for deciding when to try again */
export interface RelayStatus {
  readonly url: string;
  readonly state: RelayState;
  /** When the state last changed (ms) */
  readonly since: number;
  /** When the socket last opened (ms), or null if it never has */
  readonly openedAt: number | null;
  /** Attempts in a row that did not open */
  readonly failures: number;
  /** When the next attempt is due (ms), while waiting */
  readonly retryAt: number | null;
  /** Why the last socket closed or failed, in a sentence, or null */
  readonly problem: string | null;
  /**
   * The close code the relay gave the last socket, or null. `4009` means this
   * DID is already connected there: an earlier socket not yet let go of, or
   * the same key in use elsewhere — another tab of the same app, say.
   */
  readonly closeCode: number | null;
  /** Rooms this socket joins */
  readonly rooms: number;
}

/** What the relay closes a socket with when its DID is already in a room (`packages/relay/relay.mjs`) */
export const CLOSE_DID_TAKEN = 4009;
/** Longest wait between attempts. There is no last attempt: a relay that comes back is found again. */
const MAX_BACKOFF_MS = 30_000;
/**
 * After a refusal: the relay reaps a silent socket within two heartbeats (15 s
 * each), so trying much sooner is refused again; and a live node holding the
 * DID lets go only when it stops, so each refusal in a row waits twice as long.
 */
const DID_TAKEN_WAIT_MS = 10_000;
const MAX_DID_TAKEN_WAIT_MS = 60_000;

/** Waits a little longer each time, spread out so peers that dropped together do not return together. */
function backoff(failures: number): number {
  const base = Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** Why a socket closed, for a person to read */
function closeReason(code: number | undefined, reason: string | undefined, opened: boolean): string {
  if (code === CLOSE_DID_TAKEN)
    return 'The relay already has a connection with this key: this app open in another tab or window, or an earlier connection it lets go of within 30 seconds.';
  if (reason) return reason;
  return opened ? 'The connection to the relay closed.' : 'Could not reach the relay.';
}

/**
 * Creates a new signaling client.
 *
 * Once connected it stays connected: a socket that closes is opened again,
 * waiting longer each time up to 30 seconds and never giving up, and sooner
 * when the device comes back online or its page is looked at again. Only
 * `disconnect` stops it.
 *
 * @param url - The relay's WebSocket URL.
 * @param did - The decentralized identifier of this peer.
 * @returns The signaling client instance.
 */
export function createSignalingClient(url: string, did: string): SignalingClient {
  let ws: WebSocket | null = null;
  let wanted = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Refusals in a row; the count of failures cannot tell them, since a refused socket did open */
  let refusals = 0;
  const rooms = new Set<string>();
  const { on, off, emit } = createEmitter<SignalingEvents>();

  let status: RelayStatus = Object.freeze({
    url,
    state: 'stopped',
    since: Date.now(),
    openedAt: null,
    failures: 0,
    retryAt: null,
    problem: null,
    closeCode: null,
    rooms: 0,
  });
  const setStatus = (patch: Partial<RelayStatus>): void => {
    const next = { ...status, ...patch, rooms: rooms.size };
    if (next.state !== status.state) next.since = Date.now();
    status = Object.freeze(next);
    emit('status', status);
  };

  const sendMessage = (msg: Omit<SignalingMessage, 'from'>) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ ...msg, from: did }));
  };

  const clearRetry = (): void => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = (delay: number): void => {
    clearRetry();
    setStatus({ state: 'waiting', retryAt: Date.now() + delay });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open().catch(() => {
        // Its close schedules the next try.
      });
    }, delay);
  };

  /** Opens a socket, unless one is open or opening. Settles when it opens or fails. */
  const open = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        resolve();
        return;
      }
      clearRetry();

      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setStatus({ failures: status.failures + 1, problem: error.message });
        if (wanted) scheduleRetry(backoff(status.failures));
        reject(error);
        return;
      }
      ws = socket;
      let opened = false;
      setStatus({ state: 'connecting', retryAt: null });

      socket.onopen = () => {
        if (ws !== socket) return;
        opened = true;
        setStatus({ state: 'open', openedAt: Date.now(), failures: 0, problem: null, closeCode: null });
        emit('connected');
        for (const room of rooms) sendMessage({ type: 'join', room });
        resolve();
      };

      socket.onmessage = (event) => {
        if (ws !== socket) return;
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

      socket.onerror = () => {
        if (ws !== socket) return;
        const error = new Error('WebSocket error occurred');
        emit('error', error);
        if (!opened) reject(error);
      };

      // A socket already replaced or let go of says nothing about the one in use.
      socket.onclose = (event: Partial<CloseEvent> | undefined) => {
        if (ws !== socket) return;
        ws = null;
        const failures = opened ? 0 : status.failures + 1;
        const problem = closeReason(event?.code, event?.reason, opened);
        setStatus({ failures, problem, closeCode: event?.code ?? null });
        const refused = event?.code === CLOSE_DID_TAKEN;
        refusals = refused ? refusals + 1 : 0;
        if (opened) emit('disconnected');
        else reject(new Error(problem));
        if (refused) emit('refused');
        if (!wanted) {
          setStatus({ state: 'stopped', retryAt: null });
          return;
        }
        // Refused for holding the DID twice: an old socket goes at the relay's pace, and
        // another node's when it stops; either way, asking every second does not help.
        scheduleRetry(
          refused
            ? Math.min(DID_TAKEN_WAIT_MS * 2 ** (refusals - 1), MAX_DID_TAKEN_WAIT_MS)
            : backoff(failures),
        );
      };
    });

  /** Tries now rather than at the scheduled time, and from a fresh backoff. */
  const reconnect = (): void => {
    if (!wanted || status.state !== 'waiting') return;
    setStatus({ failures: 0 });
    open().catch(() => {});
  };

  // Back online, or looked at again after a sleep: the network may well be back.
  const onVisible = (): void => {
    if (globalThis.document?.visibilityState !== 'hidden') reconnect();
  };
  const listen = (listening: boolean): void => {
    const method = listening ? 'addEventListener' : 'removeEventListener';
    if (typeof globalThis.addEventListener === 'function') globalThis[method]('online', reconnect);
    globalThis.document?.[method]('visibilitychange', onVisible);
  };

  const connect = (): Promise<void> => {
    if (!wanted) {
      wanted = true;
      listen(true);
    }
    return open();
  };

  const disconnect = (): void => {
    const was = status.state === 'open';
    if (wanted) listen(false);
    wanted = false;
    clearRetry();
    const socket = ws;
    ws = null;
    socket?.close();
    rooms.clear();
    refusals = 0;
    setStatus({ state: 'stopped', retryAt: null, failures: 0 });
    if (was) emit('disconnected');
  };

  return Object.freeze({
    connect,
    disconnect,
    join: (room: string) => {
      if (rooms.has(room)) return;
      rooms.add(room);
      sendMessage({ type: 'join', room });
      setStatus({});
    },
    leave: (room: string) => {
      if (!rooms.delete(room)) return;
      sendMessage({ type: 'leave', room });
      setStatus({});
    },
    signal: (kind: SignalKind, targetDid: string, payload: unknown) =>
      sendMessage({ type: kind, to: targetDid, payload }),
    requestIce: () => sendMessage({ type: 'ice' }),
    reconnect,
    on,
    off,
    isConnected: () => status.state === 'open',
    status: () => status,
  });
}
