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
 *
 * A room can name relays of its own: a space says where its members meet
 * (`sys.relays`), so two people whose apps use different relays still find
 * each other there. Those are joined for that room only, and dropped once no
 * room names them.
 */

import { createEmitter } from '../utils/events.js';
import { createSignalingClient, type SignalingClient, type SignalingEvents, type SignalKind } from './signaling.js';

/** A client over several relays, where a room may name relays of its own */
export interface MultiSignalingClient extends SignalingClient {
  /** Joins a room on every relay, and on `relays` as well — joining again with a different list moves to it */
  readonly join: (room: string, relays?: ReadonlyArray<string>) => void;
}

/**
 * Creates a signaling client spanning several relays.
 *
 * @param urls The relays to use for every room. One is fine; none is a programming error.
 * @param did This peer's identifier
 * @returns A client with the same contract as a single-relay one
 */
export function createMultiSignalingClient(
  urls: ReadonlyArray<string>,
  did: string,
): MultiSignalingClient {
  if (urls.length === 0) {
    throw new Error('At least one relay is needed to introduce peers.');
  }

  const defaults = new Set(urls);
  const byUrl = new Map<string, SignalingClient>();
  const clientList = () => [...byUrl.values()];
  /** Which rooms each relay of a room's own was joined for */
  const roomsOn = new Map<string, Set<string>>();
  /** Each room's own relays */
  const extraOf = new Map<string, ReadonlySet<string>>();
  let connecting = false;
  const { on, off, emit } = createEmitter<SignalingEvents>();

  /** Which relays a peer has been seen on, so replies go back the same way. */
  const routes = new Map<string, Set<SignalingClient>>();
  /** Relays that have said a peer is in a room, by `room did` — announced upward once, gone once none do. */
  const presence = new Map<string, Set<SignalingClient>>();

  /** TURN servers each relay offered, and when their passwords stop working */
  const turn = new Map<SignalingClient, { servers: ReadonlyArray<RTCIceServer>; expiresAt: number }>();

  const connectedCount = (): number => clientList().filter((client) => client.isConnected()).length;

  /** Remembers that a peer is reachable through this relay. */
  const remember = (peer: string, client: SignalingClient): void => {
    (routes.get(peer) ?? routes.set(peer, new Set()).get(peer)!).add(client);
  };

  /** The relays worth trying for a peer, best guess first. */
  const routesFor = (peer: string): ReadonlyArray<SignalingClient> => {
    const known = [...(routes.get(peer) ?? [])].filter((client) => client.isConnected());
    // Nothing known yet — an answer to an offer that arrived before this client
    // saw the peer join. Shout on every relay rather than dropping it.
    return known.length > 0 ? known : clientList().filter((client) => client.isConnected());
  };

  /** A relay's client, made and wired the first time it is needed */
  const clientFor = (url: string): SignalingClient => {
    const held = byUrl.get(url);
    if (held) return held;
    const client = createSignalingClient(url, did);
    byUrl.set(url, client);
    wire(client);
    // One of a room's own, added while running: connected now, like the rest.
    if (connecting) void client.connect().catch(() => {});
    return client;
  };

  /** Lets go of a room's own relay once no room names it */
  const release = (url: string, room: string): void => {
    const client = byUrl.get(url);
    if (!client) return;
    client.leave(room);
    const rooms = roomsOn.get(url);
    rooms?.delete(room);
    if (defaults.has(url) || (rooms && rooms.size > 0)) return;
    roomsOn.delete(url);
    byUrl.delete(url);
    turn.delete(client);
    for (const seenBy of routes.values()) seenBy.delete(client);
    for (const [where, seenBy] of presence) {
      if (!seenBy.delete(client) || seenBy.size > 0) continue;
      presence.delete(where);
      const space = where.indexOf(' ');
      emit('peer-left', where.slice(space + 1), where.slice(0, space));
    }
    client.disconnect();
  };

  function wire(client: SignalingClient): void {
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

  for (const url of defaults) clientFor(url);

  /**
   * Connects to every relay, succeeding if any of them answers.
   * @returns Once at least one relay is usable
   */
  const connect = async (): Promise<void> => {
    connecting = true;
    const all = [...byUrl.keys()];
    const results = await Promise.allSettled(clientList().map((client) => client.connect()));
    if (results.some((result) => result.status === 'fulfilled')) return;

    throw new Error(`None of the ${all.length} relays could be reached: ${all.join(', ')}`);
  };

  return Object.freeze({
    connect,

    disconnect: (): void => {
      connecting = false;
      for (const client of clientList()) client.disconnect();
      // A room's own relays are made again when a room names them.
      for (const url of [...byUrl.keys()]) if (!defaults.has(url)) byUrl.delete(url);
      roomsOn.clear();
      extraOf.clear();
      routes.clear();
      presence.clear();
      turn.clear();
    },

    join: (room: string, relays: ReadonlyArray<string> = []) => {
      const own = new Set(relays.filter((url) => !defaults.has(url)));
      for (const url of extraOf.get(room) ?? []) if (!own.has(url)) release(url, room);
      extraOf.set(room, own);
      for (const url of defaults) clientFor(url).join(room);
      for (const url of own) {
        (roomsOn.get(url) ?? roomsOn.set(url, new Set()).get(url)!).add(room);
        clientFor(url).join(room);
      }
    },

    leave: (room: string) => {
      for (const url of defaults) byUrl.get(url)?.leave(room);
      for (const url of extraOf.get(room) ?? []) release(url, room);
      extraOf.delete(room);
      for (const where of presence.keys()) if (where.startsWith(`${room} `)) presence.delete(where);
    },

    signal: (kind: SignalKind, target: string, payload: unknown) => {
      for (const client of routesFor(target)) client.signal(kind, target, payload);
    },

    requestIce: () => {
      for (const client of clientList()) if (client.isConnected()) client.requestIce();
    },

    on,
    off,
    isConnected: (): boolean => connectedCount() > 0,
  });
}
