/**
 * In-memory transports, so a whole mesh runs in one process with no browser and
 * no sockets.
 *
 * `createFakeHub()` is a switchboard. `hub.transport(did)` makes an unsignalled
 * transport that, on `connect()`, links to every other transport that has
 * connected — the way every peer reaches an always-on node. `hub.signalled(did)`
 * makes a WebRTC stand-in: it links only when an offer and answer have been
 * carried between the two sides, by a relay or through the mesh, so the network
 * manager's signalling paths are exercised for real.
 *
 * Delivery is never synchronous. Real transports are async, and a synchronous
 * fake hides reentrancy bugs.
 */
import type {
  CandidateSink,
  PeerTransport,
  PeerTransportEvents,
  SignalledTransport,
} from '../../src/network/transport.js';
import { createEmitter } from '../../src/utils/events.js';

export interface FakeHubOptions {
  /** Milliseconds per delivery. 0 still defers to a later task. */
  readonly latencyMs?: number;
  /** Fraction of data frames silently lost, 0–1 */
  readonly dropRate?: number;
}

export interface FakeHub {
  /**
   * @param room Keeps spaces apart, as a real network does: one node holding
   *   two spaces has two transports, and they must not replace each other.
   */
  transport(did: string, room?: string): PeerTransport;
  signalled(did: string, room?: string): SignalledTransport;
  /** Severs one link, as a network failure would — both sides see `disconnected`. */
  cut(a: string, b: string, room?: string): void;
  /** Frames delivered so far */
  readonly delivered: () => number;
}

interface Endpoint {
  readonly did: string;
  readonly links: Set<string>;
  emit<K extends keyof PeerTransportEvents>(event: K, ...args: Parameters<PeerTransportEvents[K]>): void;
}

export function createFakeHub(options: FakeHubOptions = {}): FakeHub {
  const latencyMs = options.latencyMs ?? 0;
  const dropRate = options.dropRate ?? 0;
  /** Keyed by `room|did` */
  const endpoints = new Map<string, Endpoint>();
  /** Unsignalled transports that have called connect() — the "everyone reaches it" pool, per room */
  const dialled = new Map<string, Set<string>>();
  const at = (room: string, did: string) => `${room}|${did}`;
  let delivered = 0;

  const later = (fn: () => void) => {
    setTimeout(fn, latencyMs);
  };

  const link = (room: string, a: string, b: string) => {
    const ea = endpoints.get(at(room, a));
    const eb = endpoints.get(at(room, b));
    if (!ea || !eb || ea.links.has(b)) return;
    ea.links.add(b);
    eb.links.add(a);
    later(() => {
      ea.emit('connected', b);
      eb.emit('connected', a);
    });
  };

  const unlink = (room: string, a: string, b: string) => {
    const ea = endpoints.get(at(room, a));
    const eb = endpoints.get(at(room, b));
    if (!ea?.links.delete(b)) return;
    eb?.links.delete(a);
    later(() => {
      ea.emit('disconnected', b);
      eb?.emit('disconnected', a);
    });
  };

  const base = (did: string, room: string) => {
    const emitter = createEmitter<PeerTransportEvents>();
    const endpoint: Endpoint = { did, links: new Set(), emit: emitter.emit };
    endpoints.set(at(room, did), endpoint);

    const send = (peerId: string, data: Uint8Array) => {
      if (!endpoint.links.has(peerId)) throw new Error(`Not connected to ${peerId}`);
      if (Math.random() < dropRate) return;
      // Copy, as a real wire would: the receiver must not share the sender's buffer.
      const copy = new Uint8Array(data);
      later(() => {
        if (!endpoint.links.has(peerId)) return;
        delivered += 1;
        endpoints.get(at(room, peerId))?.emit('data', did, copy);
      });
    };

    return {
      endpoint,
      send,
      close: (peerId: string) => unlink(room, did, peerId),
      closeAll: () => {
        dialled.get(room)?.delete(did);
        for (const peer of [...endpoint.links]) unlink(room, did, peer);
      },
      on: emitter.on,
      off: emitter.off,
    };
  };

  return {
    transport(did, room = '') {
      const { endpoint: _endpoint, ...rest } = base(did, room);
      return Object.freeze({
        ...rest,
        async connect() {
          const pool = dialled.get(room) ?? new Set<string>();
          dialled.set(room, pool);
          pool.add(did);
          for (const other of pool) if (other !== did) link(room, did, other);
        },
      });
    },

    signalled(did, room = '') {
      const { endpoint: _endpoint, ...rest } = base(did, room);
      /** Offers made or accepted, keyed by peer — a link opens when both halves exist */
      const offered = new Set<string>();

      const fakeCandidate = (onCandidate: CandidateSink) =>
        later(() => onCandidate({ candidate: `candidate:${did}`, sdpMid: '0' }));

      return Object.freeze({
        ...rest,
        async createOffer(peerId: string, onCandidate: CandidateSink) {
          offered.add(peerId);
          fakeCandidate(onCandidate);
          return { type: 'offer' as const, sdp: `offer:${did}->${peerId}` };
        },
        async handleOffer(peerId: string, offer: RTCSessionDescriptionInit, onCandidate: CandidateSink) {
          if (offer.sdp !== `offer:${peerId}->${did}`) throw new Error('Offer was not meant for this peer');
          fakeCandidate(onCandidate);
          return { type: 'answer' as const, sdp: `answer:${did}->${peerId}` };
        },
        async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit) {
          if (!offered.has(peerId)) throw new Error(`No offer outstanding to ${peerId}`);
          if (answer.sdp !== `answer:${peerId}->${did}`) throw new Error('Answer was not meant for this peer');
          offered.delete(peerId);
          link(room, did, peerId);
        },
        async addIceCandidate() {
          // Accepted and ignored: the fake needs no route discovery.
        },
      });
    },

    cut: (a: string, b: string, room = '') => unlink(room, a, b),
    delivered: () => delivered,
  };
}
