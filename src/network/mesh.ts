/**
 * @module mesh
 * One set of connections for every space a node has open.
 *
 * A node holds one socket per relay and one WebRTC connection per peer, however
 * many spaces the two share. Each space is a room: it joins the room on the
 * relays, and on every connection it proves itself separately (`peer-auth.ts`)
 * before a byte of it crosses. So sharing the connection shares nothing else:
 * a peer you share one space with is a peer only in that one.
 *
 * Everything on a connection is a JSON frame `{ room?, type, from, payload }`.
 * Frames about a space carry its room; the offers peers carry for each other
 * (`introductions.ts`) do not, since a connection belongs to no one space.
 *
 * ```
 * A → B   { room, __auth-hello, { nonce: Nₐ } }        either side, once it knows the other is in the room
 * B → A   { room, __auth-hello, { nonce: N_b } }
 * A → B   { room, __auth-proof, proof over N_b }        (none in a room without auth)
 * B → A   { room, __auth-proof, proof over Nₐ }
 * ```
 *
 * A connection that ends up in no room is closed.
 */
import type { PeerInfo, NetworkMessage } from '../types.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';
import { createEmitter, type Emitter } from '../utils/events.js';
import type { SignalKind } from './signaling.js';
import { createMultiSignalingClient } from './multi-signaling.js';
import { createRTCTransport } from './rtc-transport.js';
import type { SignalledTransport } from './transport.js';
import { peerNonce, type MeshAuth } from './peer-auth.js';
import type { NetworkEvents, NetworkManager } from './network-manager.js';
import {
  PEERS_MESSAGE,
  SIGNAL_MESSAGE,
  AUTH_HELLO_MESSAGE,
  AUTH_PROOF_MESSAGE,
  LEAVE_MESSAGE,
  MAX_HOPS,
  MAX_INTRODUCED,
  isPeerDid,
  isControlMessage,
  shouldInitiate,
  createSeenSignals,
  signalId,
  type RelayedSignal,
} from './introductions.js';

export interface MeshConfig {
  readonly did: string;
  /** Relays, used all at once (`multi-signaling.ts`) */
  readonly relays: ReadonlyArray<string>;
  readonly iceServers?: ReadonlyArray<RTCIceServer>;
  /**
   * Let connected peers introduce the peers they know, so the relay is only
   * needed for the first connection. On by default.
   */
  readonly introductions?: boolean;
  /** How connections are made. WebRTC unless a test says otherwise. */
  readonly createTransport?: () => SignalledTransport;
  /** How long a peer has to prove itself in a room. Default 10 s. */
  readonly authTimeoutMs?: number;
}

export interface Mesh {
  /**
   * A space's share of the mesh: the peers that proved themselves in its room.
   * `connect()` enters the room and `disconnect()` leaves it; the relays and
   * connections are held while any room is.
   *
   * @param room The space's room — a hash of its id
   * @param auth What peers must prove here; null lets anyone in the room in
   */
  join(room: string, auth?: MeshAuth | null): NetworkManager;
}

interface Handshake {
  readonly nonce: string;
  proved: boolean;
  verified: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Room {
  readonly auth: MeshAuth | null;
  readonly peers: Map<string, PeerInfo>;
  readonly handshakes: Map<string, Handshake>;
  readonly events: Emitter<NetworkEvents>;
}

interface Frame {
  readonly room?: unknown;
  readonly type?: unknown;
  readonly payload?: unknown;
}

type Deliver = (kind: SignalKind, data: unknown) => void;

export function createMesh(config: MeshConfig): Mesh {
  const { did } = config;
  const transport = config.createTransport?.() ?? createRTCTransport({ iceServers: config.iceServers });
  const signaling = createMultiSignalingClient(config.relays, did);
  const introduce = config.introductions !== false;
  const authTimeoutMs = config.authTimeoutMs ?? 10_000;

  const rooms = new Map<string, Room>();
  /** Connections that are open */
  const links = new Set<string>();
  /** Peers a connection has been started with, so hearing of one twice does not open it twice */
  const attempted = new Set<string>();
  /** Rooms to greet a peer in once its connection opens */
  const expected = new Map<string, Set<string>>();
  /** Connections waiting to be put to use in some room, or closed */
  const idle = new Map<string, ReturnType<typeof setTimeout>>();
  const seenSignals = createSeenSignals();
  let started: Promise<void> | null = null;

  const fail = (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const room of rooms.values()) room.events.emit('error', err);
  };

  const sendFrame = (peer: string, frame: { room?: string; type: string; payload?: unknown }): void => {
    try {
      transport.send(peer, utf8Encode(JSON.stringify({ ...frame, from: did })));
    } catch {
      // The channel closed between listing the peer and writing to it. The
      // disconnect event will tidy up.
    }
  };

  /** Peers proved in at least one room — the only ones anything but a handshake is taken from */
  const isAdmitted = (peer: string) => [...rooms.values()].some((room) => room.peers.has(peer));

  /** Forgets a connection — closed by either side. */
  const lost = (peer: string): void => {
    clearTimeout(idle.get(peer));
    idle.delete(peer);
    links.delete(peer);
    attempted.delete(peer);
    expected.delete(peer);
    for (const room of rooms.values()) drop(room, peer);
  };

  /** Closes a connection that no room has a use for. */
  const closeIfIdle = (peer: string): void => {
    if (!links.has(peer)) return;
    if ([...rooms.values()].some((room) => room.peers.has(peer) || room.handshakes.has(peer))) return;
    transport.close(peer);
    // Closing it here is not always reported back as a disconnect.
    lost(peer);
  };

  // ─── Proving, per room ──────────────────────────────────────────────

  const endHandshake = (room: Room, peer: string) => {
    const handshake = room.handshakes.get(peer);
    if (handshake) clearTimeout(handshake.timer);
    room.handshakes.delete(peer);
  };

  const refuse = (room: Room, peer: string) => {
    endHandshake(room, peer);
    closeIfIdle(peer);
  };

  /** Starts proving ourselves to a peer in a room, unless that is under way or done. */
  const greet = (name: string, peer: string): Handshake | null => {
    const room = rooms.get(name);
    if (!room || room.peers.has(peer)) return null;
    let handshake = room.handshakes.get(peer);
    if (!handshake) {
      handshake = { nonce: peerNonce(), proved: false, verified: room.auth === null, timer: setTimeout(() => refuse(room, peer), authTimeoutMs) };
      room.handshakes.set(peer, handshake);
      sendFrame(peer, { room: name, type: AUTH_HELLO_MESSAGE, payload: { nonce: handshake.nonce } });
    }
    return handshake;
  };

  const onHandshake = async (name: string, peer: string, type: string, payload: unknown): Promise<void> => {
    const room = rooms.get(name);
    if (!room) return;
    const binding = transport.binding?.(peer) ?? null;
    if (type === AUTH_HELLO_MESSAGE) {
      const handshake = greet(name, peer);
      const nonce = (payload as { nonce?: unknown } | null)?.nonce;
      if (!handshake || handshake.proved || typeof nonce !== 'string') return;
      handshake.proved = true;
      if (room.auth) sendFrame(peer, { room: name, type: AUTH_PROOF_MESSAGE, payload: await room.auth.prove(peer, nonce, binding) });
    } else {
      const handshake = room.handshakes.get(peer);
      if (!handshake || handshake.verified || !room.auth) return;
      if (!(await room.auth.check(peer, handshake.nonce, binding, payload))) return refuse(room, peer);
      handshake.verified = true;
    }
    const handshake = room.handshakes.get(peer);
    if (handshake?.proved && handshake.verified && rooms.get(name) === room) {
      endHandshake(room, peer);
      admit(name, room, peer);
    }
  };

  /** A connection becomes a peer in a room: announced, and introduced to the room's others. */
  const admit = (name: string, room: Room, peer: string): void => {
    const info: PeerInfo = { did: peer, connectionId: peer, connectedAt: new Date().toISOString() };
    room.peers.set(peer, info);
    room.events.emit('peer-connected', info);

    if (!introduce) return;
    // Introduce in both directions. Telling only the newcomer would leave the
    // side with the higher identifier waiting for an offer nobody will send.
    const others = [...room.peers.keys()].filter((other) => other !== peer);
    if (others.length === 0) return;
    sendFrame(peer, { room: name, type: PEERS_MESSAGE, payload: others });
    for (const other of others) sendFrame(other, { room: name, type: PEERS_MESSAGE, payload: [peer] });
  };

  const drop = (room: Room, peer: string): void => {
    endHandshake(room, peer);
    const info = room.peers.get(peer);
    if (info && room.peers.delete(peer)) room.events.emit('peer-disconnected', info);
  };

  // ─── Connecting ─────────────────────────────────────────────────────
  //
  // A relay gets you your first connection. After that the peers you can
  // already reach are the best source of the ones you cannot: their data
  // channels carry connection offers just as happily as they carry todos.

  /** Pushes somebody's signaling out across the mesh, skipping where it came from. */
  const floodSignal = (signal: RelayedSignal, except?: string): void => {
    for (const peer of links) {
      if (peer !== except && isAdmitted(peer)) sendFrame(peer, { type: SIGNAL_MESSAGE, payload: signal });
    }
  };

  const throughMesh = (target: string): Deliver => (kind, data) =>
    floodSignal({ id: signalId(), origin: did, target, kind, data, hops: MAX_HOPS });
  const throughRelay = (target: string): Deliver => (kind, data) => signaling.signal(kind, target, data);

  const offerTo = async (peer: string, deliver: Deliver): Promise<void> => {
    try {
      const offer = await transport.createOffer(peer, (candidate) => deliver('candidate', candidate));
      deliver('offer', offer);
    } catch (err) {
      fail(err);
    }
  };

  /** Acts on a peer's offer, answer or candidate, sending replies back the way it came. */
  const onSignal = async (peer: string, kind: SignalKind, data: unknown, deliver: Deliver): Promise<void> => {
    // A connection that has proved itself is not replaced by an offer that has
    // not: anyone can put someone else's name on one.
    if (!data || typeof data !== 'object' || isAdmitted(peer)) return;
    try {
      if (kind === 'offer') {
        attempted.add(peer);
        const answer = await transport.handleOffer(peer, data as RTCSessionDescriptionInit, (candidate) => deliver('candidate', candidate));
        deliver('answer', answer);
      } else if (kind === 'answer') {
        await transport.handleAnswer(peer, data as RTCSessionDescriptionInit);
      } else {
        await transport.addIceCandidate(peer, data as RTCIceCandidateInit);
      }
    } catch (err) {
      fail(err);
    }
  };

  /** Learned that a peer is in a room: greet it there, or connect first. */
  const meet = (name: string, peer: string, offer: Deliver | null): void => {
    if (peer === did || !rooms.has(name)) return;
    if (links.has(peer)) {
      greet(name, peer);
      return;
    }
    (expected.get(peer) ?? expected.set(peer, new Set()).get(peer)!).add(name);
    if (offer && !attempted.has(peer)) {
      attempted.add(peer);
      void offerTo(peer, offer);
    }
  };

  signaling.on('peer-joined', (peer, room) => meet(room, peer, throughRelay(peer)));
  signaling.on('signal', (message) => void onSignal(message.from, message.type, message.payload, throughRelay(message.from)));

  /** Acts on somebody's introduction of the peers in a room. */
  const handlePeerList = (name: string, peers: unknown): void => {
    if (!introduce || !Array.isArray(peers)) return;
    for (const peer of peers.slice(0, MAX_INTRODUCED)) {
      if (!isPeerDid(peer)) continue;
      // Both sides are told about each other at the same moment, so without a
      // rule both would offer and there would be two half-open connections to
      // unpick. Comparing identifiers is free and both sides always agree.
      meet(name, peer, shouldInitiate(did, peer) ? throughMesh(peer) : null);
    }
  };

  const onRelayedSignal = (from: string, signal: RelayedSignal): void => {
    // Flooding means the same signal can arrive by several routes; act once.
    if (typeof signal?.id !== 'string' || signal.id.length > 64 || !seenSignals.accept(signal.id)) return;
    if (!isPeerDid(signal.origin) || !isPeerDid(signal.target) || !['offer', 'answer', 'candidate'].includes(signal.kind)) return;
    if (signal.target === did) {
      void onSignal(signal.origin, signal.kind, signal.data, throughMesh(signal.origin));
    } else if (typeof signal.hops === 'number' && signal.hops > 0) {
      // The sender says how far it may go; never further than we would send it.
      floodSignal({ ...signal, hops: Math.min(signal.hops, MAX_HOPS) - 1 }, from);
    }
  };

  transport.on('connected', (peer) => {
    links.add(peer);
    attempted.add(peer);
    for (const name of expected.get(peer) ?? []) greet(name, peer);
    expected.delete(peer);
    // The other side greets in the rooms it knows we share; if none does, the connection has no use.
    idle.set(peer, setTimeout(() => {
      idle.delete(peer);
      closeIfIdle(peer);
    }, authTimeoutMs));
  });

  transport.on('disconnected', lost);

  transport.on('data', (peer, data) => {
    let frame: Frame;
    try {
      frame = JSON.parse(utf8Decode(data)) as Frame;
    } catch {
      return fail(new Error('Failed to parse incoming message'));
    }
    const { type, payload } = frame;
    const name = typeof frame.room === 'string' ? frame.room : null;
    if (typeof type !== 'string') return;

    // Before a peer has proved itself somewhere, the handshake is all there is.
    if (type === AUTH_HELLO_MESSAGE || type === AUTH_PROOF_MESSAGE) {
      if (name) void onHandshake(name, peer, type, payload).catch(() => { const room = rooms.get(name); if (room) refuse(room, peer); });
      return;
    }
    if (!isAdmitted(peer)) return;
    if (type === SIGNAL_MESSAGE) return onRelayedSignal(peer, payload as RelayedSignal);

    const room = name ? rooms.get(name) : undefined;
    if (!name || !room?.peers.has(peer)) return;
    if (type === PEERS_MESSAGE) return handlePeerList(name, payload);
    if (type === LEAVE_MESSAGE) {
      drop(room, peer);
      return closeIfIdle(peer);
    }
    // Mesh housekeeping never reaches the space. The sender is the connection
    // it arrived on, not whatever the frame claims.
    if (!isControlMessage(type)) room.events.emit('message', { type, from: peer, payload });
  });

  transport.on('error', (peer, error) => fail(new Error(`Transport error with peer ${peer}: ${error.message}`)));

  // ─── Rooms ──────────────────────────────────────────────────────────

  const start = (): Promise<void> => {
    started ??= signaling.connect().catch((error) => {
      started = null;
      throw error;
    });
    return started;
  };

  return {
    join(name: string, auth: MeshAuth | null = null): NetworkManager {
      const room: Room = { auth, peers: new Map(), handshakes: new Map(), events: createEmitter<NetworkEvents>() };
      const send = (peer: string, message: NetworkMessage) => {
        if (room.peers.has(peer)) sendFrame(peer, { room: name, type: message.type, payload: message.payload });
      };

      return Object.freeze({
        async connect() {
          if (rooms.has(name)) throw new Error('This mesh is already in that room');
          rooms.set(name, room);
          signaling.join(name);
          await start();
        },
        disconnect() {
          if (rooms.get(name) !== room) return;
          for (const peer of room.peers.keys()) sendFrame(peer, { room: name, type: LEAVE_MESSAGE });
          for (const peer of [...room.handshakes.keys()]) endHandshake(room, peer);
          room.peers.clear();
          rooms.delete(name);
          signaling.leave(name);
          for (const peer of [...links]) closeIfIdle(peer);
          if (rooms.size === 0) {
            for (const timer of idle.values()) clearTimeout(timer);
            idle.clear();
            signaling.disconnect();
            started = null;
          }
        },
        send,
        broadcast: (message: NetworkMessage) => {
          for (const peer of room.peers.keys()) send(peer, message);
        },
        getPeers: () => [...room.peers.values()],
        on: room.events.on,
        off: room.events.off,
        // Connected means reachable, which after the first introduction no longer
        // depends on a relay being up.
        isConnected: () => signaling.isConnected() || room.peers.size > 0,
      });
    },
  };
}
