/**
 * @module multi-signaling
 * Several rendezvous points behind one interface.
 *
 * A relay is a phone book, not an authority: it forwards connection offers and
 * never sees an expression. But with exactly one of them configured there is
 * still, in practice, a single point of failure and a single operator who can
 * decide nobody gets introduced today. Pointing at several removes that without
 * changing what any of them can do.
 *
 * They are used all at once rather than in order. Failover would still leave two
 * people stranded when one is on the first relay and the other on the second;
 * being present on all of them means they meet wherever either is looking. The
 * cost is a handful of websockets, which is what a torrent client has always
 * done with its tracker list.
 *
 * Peers are announced once however many relays mention them, because a duplicate
 * announcement would have both sides opening a second connection to each other.
 */

import {
  createSignalingClient,
  type SignalingClient,
  type SignalingEvents,
  type SignalingMessage,
} from './signaling.js';

/**
 * Creates a signaling client spanning several relays.
 *
 * @param urls The relays to use. One is fine; none is a programming error.
 * @param did This peer's identifier
 * @returns A client with the same contract as a single-relay one
 */
export function createMultiSignalingClient(
  urls: ReadonlyArray<string>,
  did: string,
): SignalingClient {
  if (urls.length === 0) {
    throw new Error('At least one relay is needed to introduce peers.');
  }

  const clients = urls.map((url) => createSignalingClient(url, did));

  /** Which relays a peer has been seen on, so replies go back the same way. */
  const routes = new Map<string, Set<SignalingClient>>();
  /** Peers already announced upward, so a second relay does not re-announce. */
  const announced = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners: { [K in keyof SignalingEvents]?: Set<any> } = {};

  const emit = <K extends keyof SignalingEvents>(
    event: K,
    ...args: Parameters<SignalingEvents[K]>
  ): void => {
    for (const callback of listeners[event] ?? []) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (callback as any)(...args);
      } catch (error) {
        console.error(`Error in signaling event listener for ${event}:`, error);
      }
    }
  };

  const on = <K extends keyof SignalingEvents>(event: K, callback: SignalingEvents[K]): void => {
    (listeners[event] ??= new Set()).add(callback);
  };

  const off = <K extends keyof SignalingEvents>(event: K, callback: SignalingEvents[K]): void => {
    listeners[event]?.delete(callback);
  };

  const connectedCount = (): number => clients.filter((client) => client.isConnected()).length;

  /** Remembers that a peer is reachable through this relay. */
  const remember = (peer: string, client: SignalingClient): void => {
    (routes.get(peer) ?? routes.set(peer, new Set()).get(peer)!).add(client);
  };

  /** The relays worth trying for a peer, best guess first. */
  const routesFor = (peer: string): ReadonlyArray<SignalingClient> => {
    const known = [...(routes.get(peer) ?? [])].filter((client) => client.isConnected());
    // Nothing known yet — an answer to an offer that arrived before this client
    // saw the peer join. Shout on every relay rather than dropping it.
    return known.length > 0 ? known : clients.filter((client) => client.isConnected());
  };

  for (const client of clients) {
    client.on('peer-joined', (peer: string) => {
      remember(peer, client);
      if (peer === did || announced.has(peer)) return;
      announced.add(peer);
      emit('peer-joined', peer);
    });

    client.on('peer-left', (peer: string) => {
      routes.get(peer)?.delete(client);

      // Still reachable through another relay: not gone, just quieter.
      if ((routes.get(peer)?.size ?? 0) > 0) return;

      routes.delete(peer);
      if (announced.delete(peer)) emit('peer-left', peer);
    });

    for (const kind of ['offer', 'answer', 'candidate'] as const) {
      client.on(kind, (message: SignalingMessage) => {
        remember(message.from, client);
        emit(kind, message);
      });
    }

    client.on('connected', () => {
      if (connectedCount() === 1) emit('connected');
    });

    client.on('disconnected', () => {
      if (connectedCount() === 0) emit('disconnected');
    });

    // A relay being down is normal when several are configured, so it is not
    // worth surfacing on its own. Total failure shows up through `connect`.
    client.on('error', () => {});
  }

  /**
   * Connects to every relay, succeeding if any of them answers.
   * @returns Once at least one relay is usable
   */
  const connect = async (): Promise<void> => {
    const results = await Promise.allSettled(clients.map((client) => client.connect()));
    if (results.some((result) => result.status === 'fulfilled')) return;

    throw new Error(
      `None of the ${clients.length} configured relays could be reached: ${urls.join(', ')}`,
    );
  };

  const sendVia = (
    peer: string,
    send: (client: SignalingClient) => void,
  ): void => {
    for (const client of routesFor(peer)) send(client);
  };

  return Object.freeze({
    connect,

    disconnect: (): void => {
      for (const client of clients) client.disconnect();
      routes.clear();
      announced.clear();
    },

    sendOffer: (target: string, offer: RTCSessionDescriptionInit): void =>
      sendVia(target, (client) => client.sendOffer(target, offer)),

    sendAnswer: (target: string, answer: RTCSessionDescriptionInit): void =>
      sendVia(target, (client) => client.sendAnswer(target, answer)),

    sendCandidate: (target: string, candidate: RTCIceCandidateInit): void =>
      sendVia(target, (client) => client.sendCandidate(target, candidate)),

    on,
    off,
    isConnected: (): boolean => connectedCount() > 0,
  });
}
