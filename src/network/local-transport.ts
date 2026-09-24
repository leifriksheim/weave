/**
 * @module network/local-transport
 * Peers in one process, linked directly — no relay, no socket.
 *
 * A carrier keeps a space twice: in its own database, and in the person's pod
 * folder when it can reach it. Rather than a second way of copying records,
 * the two copies are two peers on a local link, and the sync that already runs
 * between devices keeps them in step — the pod catching up with whatever
 * arrived while it was out of reach, and the database hearing about writes
 * another site made to the folder.
 *
 * `createLocalHub()` is a switchboard: every transport made from it that has
 * connected is linked to every other. Delivery is always on a later task, as
 * on a real wire.
 */
import type { PeerTransport, PeerTransportEvents } from './transport.js';

export interface LocalHub {
  /** A transport for `did`. It links to the others once `connect()` is called, and leaves on `closeAll()`. */
  transport(did: string): PeerTransport;
}

interface Endpoint {
  readonly links: Set<string>;
  emit<K extends keyof PeerTransportEvents>(event: K, ...args: Parameters<PeerTransportEvents[K]>): void;
}

const later = (fn: () => void) => void setTimeout(fn, 0);

export function createLocalHub(): LocalHub {
  /** Transports that have connected, by DID */
  const connected = new Map<string, Endpoint>();

  const unlink = (a: string, b: string) => {
    const ea = connected.get(a);
    const eb = connected.get(b);
    if (ea?.links.delete(b)) later(() => ea.emit('disconnected', b));
    if (eb?.links.delete(a)) later(() => eb.emit('disconnected', a));
  };

  return {
    transport(did: string): PeerTransport {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const listeners: { [K in keyof PeerTransportEvents]?: Set<any> } = {};
      const endpoint: Endpoint = {
        links: new Set(),
        emit(event, ...args) {
          for (const callback of listeners[event] ?? []) callback(...args);
        },
      };

      return Object.freeze({
        async connect() {
          connected.set(did, endpoint);
          for (const [other, peer] of connected) {
            if (other === did || endpoint.links.has(other)) continue;
            endpoint.links.add(other);
            peer.links.add(did);
            later(() => {
              endpoint.emit('connected', other);
              peer.emit('connected', did);
            });
          }
        },
        send(peerId: string, data: Uint8Array) {
          if (!endpoint.links.has(peerId)) return;
          // Copied, as a wire would: the receiver must not share the sender's buffer.
          const copy = new Uint8Array(data);
          later(() => {
            if (endpoint.links.has(peerId)) connected.get(peerId)?.emit('data', did, copy);
          });
        },
        close: (peerId: string) => unlink(did, peerId),
        closeAll() {
          for (const peer of [...endpoint.links]) unlink(did, peer);
          if (connected.get(did) === endpoint) connected.delete(did);
        },
        on<K extends keyof PeerTransportEvents>(event: K, callback: PeerTransportEvents[K]) {
          (listeners[event] ??= new Set()).add(callback);
        },
        off<K extends keyof PeerTransportEvents>(event: K, callback: PeerTransportEvents[K]) {
          listeners[event]?.delete(callback);
        },
      });
    },
  };
}
