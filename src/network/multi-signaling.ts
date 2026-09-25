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
 * Peers are announced once per room however many relays mention them, because a
 * duplicate announcement would have both sides opening a second connection.
 */

import { createEmitter } from '../utils/events.js';
import { createSignalingClient, type SignalingClient, type SignalingEvents, type SignalKind } from './signaling.js';

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
  const { on, off, emit } = createEmitter<SignalingEvents>();

  /** Which relays a peer has been seen on, so replies go back the same way. */
  const routes = new Map<string, Set<SignalingClient>>();
  /** Relays that have said a peer is in a room, by `room did` — announced upward once, gone once none do. */
  const presence = new Map<string, Set<SignalingClient>>();

  /** TURN servers each relay offered, and when their passwords stop working */
  const turn = new Map<SignalingClient, { servers: ReadonlyArray<RTCIceServer>; expiresAt: number }>();

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
    client.on('peer-joined', (peer, room) => {
      remember(peer, client);
      if (peer === did) return;
      const where = `${room} ${peer}`;
      const seenBy = presence.get(where) ?? presence.set(where, new Set()).get(where)!;
      seenBy.add(client);
      if (seenBy.size === 1) emit('peer-joined', peer, room);
    });

    client.on('peer-left', (peer, room) => {
      const where = `${room} ${peer}`;
      const seenBy = presence.get(where);
      // Still in the room through another relay: not gone, just quieter.
      if (!seenBy?.delete(client) || seenBy.size > 0) return;
      presence.delete(where);
      emit('peer-left', peer, room);
    });

    client.on('signal', (message) => {
      remember(message.from, client);
      emit('signal', message);
    });

    client.on('ice', (servers, expiresAt) => {
      turn.set(client, { servers, expiresAt });
      const offers = [...turn.values()];
      emit('ice', offers.flatMap((offer) => offer.servers), Math.min(...offers.map((offer) => offer.expiresAt)));
    });

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

  return Object.freeze({
    connect,

    disconnect: (): void => {
      for (const client of clients) client.disconnect();
      routes.clear();
      presence.clear();
      turn.clear();
    },

    join: (room: string) => {
      for (const client of clients) client.join(room);
    },

    leave: (room: string) => {
      for (const client of clients) client.leave(room);
      for (const where of presence.keys()) if (where.startsWith(`${room} `)) presence.delete(where);
    },

    signal: (kind: SignalKind, target: string, payload: unknown) => {
      for (const client of routesFor(target)) client.signal(kind, target, payload);
    },

    requestIce: () => {
      for (const client of clients) if (client.isConnected()) client.requestIce();
    },

    on,
    off,
    isConnected: (): boolean => connectedCount() > 0,
  });
}
