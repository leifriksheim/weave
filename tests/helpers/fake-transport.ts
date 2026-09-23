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

export interface FakeHubOptions {
  /** Milliseconds per delivery. 0 still defers to a later task. */
  readonly latencyMs?: number;
  /** Fraction of data frames silently lost, 0–1 */
  readonly dropRate?: number;
}

export interface FakeHub {
  transport(did: string): PeerTransport;
  signalled(did: string): SignalledTransport;
  /** Severs one link, as a network failure would — both sides see `disconnected`. */
  cut(a: string, b: string): void;
  /** Frames delivered so far */
  readonly delivered: () => number;
}

interface Endpoint {
  readonly did: string;
  readonly links: Set<string>;
  emit<K extends keyof PeerTransportEvents>(event: K, ...args: Parameters<PeerTransportEvents[K]>): void;
}

function createEmitter() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners: { [K in keyof PeerTransportEvents]?: Set<any> } = {};
  return {
    on<K extends keyof PeerTransportEvents>(event: K, callback: PeerTransportEvents[K]) {
      (listeners[event] ??= new Set()).add(callback);
    },
    off<K extends keyof PeerTransportEvents>(event: K, callback: PeerTransportEvents[K]) {
      listeners[event]?.delete(callback);
    },
    emit<K extends keyof PeerTransportEvents>(event: K, ...args: Parameters<PeerTransportEvents[K]>) {
      for (const callback of listeners[event] ?? []) callback(...args);
    },
  };
}

export function createFakeHub(options: FakeHubOptions = {}): FakeHub {
  const latencyMs = options.latencyMs ?? 0;
  const dropRate = options.dropRate ?? 0;
  const endpoints = new Map<string, Endpoint>();
  /** Unsignalled transports that have called connect() — the "everyone reaches it" pool */
  const dialled = new Set<string>();
  let delivered = 0;

  const later = (fn: () => void) => {
    setTimeout(fn, latencyMs);
  };

  const link = (a: string, b: string) => {
    const ea = endpoints.get(a);
    const eb = endpoints.get(b);
    if (!ea || !eb || ea.links.has(b)) return;
    ea.links.add(b);
    eb.links.add(a);
    later(() => {
      ea.emit('connected', b);
      eb.emit('connected', a);
    });
  };

  const unlink = (a: string, b: string) => {
    const ea = endpoints.get(a);
    const eb = endpoints.get(b);
    if (!ea?.links.delete(b)) return;
    eb?.links.delete(a);
    later(() => {
      ea.emit('disconnected', b);
      eb?.emit('disconnected', a);
    });
  };

  const base = (did: string) => {
    const emitter = createEmitter();
    const endpoint: Endpoint = { did, links: new Set(), emit: emitter.emit };
    endpoints.set(did, endpoint);

    const send = (peerId: string, data: Uint8Array) => {
      if (!endpoint.links.has(peerId)) throw new Error(`Not connected to ${peerId}`);
      if (Math.random() < dropRate) return;
      // Copy, as a real wire would: the receiver must not share the sender's buffer.
      const copy = new Uint8Array(data);
      later(() => {
        if (!endpoint.links.has(peerId)) return;
        delivered += 1;
        endpoints.get(peerId)?.emit('data', did, copy);
      });
    };

    return {
      endpoint,
      send,
      close: (peerId: string) => unlink(did, peerId),
      closeAll: () => {
        dialled.delete(did);
        for (const peer of [...endpoint.links]) unlink(did, peer);
      },
      on: emitter.on,
      off: emitter.off,
    };
  };

  return {
    transport(did) {
      const { endpoint: _endpoint, ...rest } = base(did);
      return Object.freeze({
        ...rest,
        async connect() {
          dialled.add(did);
          for (const other of dialled) if (other !== did) link(did, other);
        },
      });
    },

    signalled(did) {
      const { endpoint: _endpoint, ...rest } = base(did);
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
          link(did, peerId);
        },
        async addIceCandidate() {
          // Accepted and ignored: the fake needs no route discovery.
        },
      });
    },

    cut: unlink,
    delivered: () => delivered,
  };
}
