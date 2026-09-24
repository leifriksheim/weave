/**
 * @fileoverview Network orchestrator wiring together signaling, transport, and discovery.
 */

import type { PeerInfo, NetworkMessage } from '../types.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';
import type { SignalingClient, SignalingMessage } from './signaling.js';
import { createMultiSignalingClient } from './multi-signaling.js';
import { createRTCTransport } from './rtc-transport.js';
import { isSignalledTransport, type PeerTransport, type SignalledTransport } from './transport.js';
import { createPeerDiscovery } from './peer-discovery.js';
import { peerNonce, type MeshAuth } from './peer-auth.js';
import {
  PEERS_MESSAGE,
  SIGNAL_MESSAGE,
  AUTH_HELLO_MESSAGE,
  AUTH_PROOF_MESSAGE,
  MAX_HOPS,
  MAX_INTRODUCED,
  isPeerDid,
  isControlMessage,
  shouldInitiate,
  createSeenSignals,
  signalId,
  type RelayedSignal,
} from './introductions.js';

export interface NetworkManagerConfig {
  /** A single relay. Prefer {@link signalingUrls}. Signalled transports only. */
  readonly signalingUrl?: string;
  /**
   * Several relays, used all at once.
   *
   * Failover would still strand two people who happened to pick different
   * relays; being present on all of them means they meet wherever either is
   * looking. None of them can do anything but introduce peers, so adding more
   * costs a websocket and removes a single point of failure.
   *
   * Required for a signalled transport (the default, WebRTC); ignored by one
   * that dials on its own.
   */
  readonly signalingUrls?: ReadonlyArray<string>;
  readonly did: string;
  readonly iceServers?: ReadonlyArray<RTCIceServer>;
  /**
   * Let connected peers introduce the peers they know, so the relay is only
   * needed for the first connection. On by default; signalled transports only,
   * since an introduction is an offer carried by a peer.
   */
  readonly introductions?: boolean;
  /**
   * How bytes reach peers. Defaults to WebRTC over the configured relays,
   * which is exactly the behaviour before this option existed.
   */
  readonly createTransport?: () => PeerTransport;
  /**
   * Makes every connection prove who is at the other end — and, in a private
   * space, that they may read it — before it counts as a peer
   * (`peer-auth.ts`). Without it, a peer is whoever it says it is: fine for a
   * transport that authenticates on its own, like the socket to a node.
   */
  readonly auth?: MeshAuth;
  /** How long a new connection has to finish the handshake. Default 10 s. */
  readonly authTimeoutMs?: number;
}

export type NetworkEvents = {
  message: (message: NetworkMessage) => void;
  'peer-connected': (info: PeerInfo) => void;
  'peer-disconnected': (info: PeerInfo) => void;
  error: (error: Error) => void;
};

export interface NetworkManager {
  readonly connect: () => Promise<void>;
  readonly disconnect: () => void;
  readonly send: (peerId: string, message: NetworkMessage) => void;
  readonly broadcast: (message: NetworkMessage) => void;
  readonly getPeers: () => ReadonlyArray<PeerInfo>;
  readonly on: <K extends keyof NetworkEvents>(event: K, callback: NetworkEvents[K]) => void;
  readonly off: <K extends keyof NetworkEvents>(event: K, callback: NetworkEvents[K]) => void;
  readonly isConnected: () => boolean;
}

/**
 * Creates the main network orchestrator.
 * 
 * @param config - The network configuration.
 * @returns The network manager instance.
 */
export function createNetworkManager(config: NetworkManagerConfig): NetworkManager {
  const transport: PeerTransport =
    config.createTransport?.() ?? createRTCTransport({ iceServers: config.iceServers });

  // Relays and introductions exist to carry offers. A transport that dials on
  // its own has none to carry, so it gets neither.
  const rtc: SignalledTransport | null = isSignalledTransport(transport) ? transport : null;

  let signaling: SignalingClient | null = null;
  if (rtc) {
    const relays = config.signalingUrls ?? (config.signalingUrl ? [config.signalingUrl] : []);
    if (relays.length === 0) {
      throw new Error('A network manager needs at least one relay to bootstrap from.');
    }
    signaling = createMultiSignalingClient(relays, config.did);
  }

  const discovery = createPeerDiscovery();
  const introduce = rtc !== null && config.introductions !== false;

  /**
   * Peers a connection has been started with, so learning about one twice —
   * from a relay and from an introduction — does not open it twice.
   */
  const attempted = new Set<string>();
  const seenSignals = createSeenSignals();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners: { [K in keyof NetworkEvents]?: Set<any> } = {};

  const emit = <K extends keyof NetworkEvents>(event: K, ...args: Parameters<NetworkEvents[K]>) => {
    const eventListeners = listeners[event];
    if (eventListeners) {
      eventListeners.forEach(callback => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (callback as any)(...args);
        } catch (e) {
          console.error(`Error in network manager event listener for ${event}:`, e);
        }
      });
    }
  };

  const on = <K extends keyof NetworkEvents>(event: K, callback: NetworkEvents[K]): void => {
    if (!listeners[event]) {
      listeners[event] = new Set();
    }
    listeners[event]!.add(callback);
  };

  const off = <K extends keyof NetworkEvents>(event: K, callback: NetworkEvents[K]): void => {
    if (listeners[event]) {
      listeners[event]!.delete(callback);
    }
  };


  // ─── Introductions ───────────────────────────────────────────────────
  //
  // A relay gets you your first connection. After that the peers you can
  // already reach are the best source of the ones you cannot: their data
  // channels carry connection offers just as happily as they carry todos.

  /** Sends a mesh control message straight to a connected peer. */
  const sendControl = (peerId: string, type: string, payload: unknown): void => {
    try {
      transport.send(peerId, utf8Encode(JSON.stringify({ type, from: config.did, payload })));
    } catch {
      // The channel closed between listing the peer and writing to it. The
      // disconnect event will tidy up.
    }
  };

  /** Pushes somebody's signaling out across the mesh, skipping where it came from. */
  const floodSignal = (signal: RelayedSignal, except?: string): void => {
    for (const peer of discovery.listPeers()) {
      if (peer.did !== except) sendControl(peer.did, SIGNAL_MESSAGE, signal);
    }
  };

  /** Routes our signaling to a peer we cannot reach directly, through those we can. */
  const throughMesh =
    (target: string) =>
    (kind: RelayedSignal['kind'], data: unknown): void =>
      floodSignal({ id: signalId(), origin: config.did, target, kind, data, hops: MAX_HOPS });

  /** Routes our signaling to a peer over the relay. */
  const throughRelay =
    (relay: SignalingClient, target: string) =>
    (kind: RelayedSignal['kind'], data: unknown): void => {
      if (kind === 'offer') relay.sendOffer(target, data as RTCSessionDescriptionInit);
      else if (kind === 'answer') relay.sendAnswer(target, data as RTCSessionDescriptionInit);
      else relay.sendCandidate(target, data as RTCIceCandidateInit);
    };

  /** Opens a connection to a peer, sending its signaling however the caller says. */
  const offerTo = async (
    rtc: SignalledTransport,
    peerDid: string,
    deliver: (kind: RelayedSignal['kind'], data: unknown) => void,
  ): Promise<void> => {
    try {
      const offer = await rtc.createOffer(peerDid, (candidate) => deliver('candidate', candidate));
      deliver('offer', offer);
    } catch (err) {
      emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  };

  /** Accepts a connection, sending the reply back the way the offer came. */
  const answerTo = async (
    rtc: SignalledTransport,
    peerDid: string,
    offer: RTCSessionDescriptionInit,
    deliver: (kind: RelayedSignal['kind'], data: unknown) => void,
  ): Promise<void> => {
    try {
      const answer = await rtc.handleOffer(peerDid, offer, (candidate) => deliver('candidate', candidate));
      deliver('answer', answer);
    } catch (err) {
      emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  };

  /** Acts on somebody's introduction of peers we have not met. */
  const handlePeerList = (peers: unknown): void => {
    if (!rtc || !introduce || !Array.isArray(peers)) return;

    for (const peer of peers.slice(0, MAX_INTRODUCED)) {
      if (!isPeerDid(peer) || peer === config.did || attempted.has(peer)) continue;

      // Both sides are told about each other at the same moment, so without a
      // rule both would offer and there would be two half-open connections to
      // unpick. Comparing identifiers is free and both sides always agree.
      if (!shouldInitiate(config.did, peer)) continue;

      attempted.add(peer);
      void offerTo(rtc, peer, throughMesh(peer));
    }
  };

  /** Acts on signaling that was addressed to us and arrived over the mesh. */
  const handleRelayedSignal = async (rtc: SignalledTransport, signal: RelayedSignal): Promise<void> => {
    const deliver = throughMesh(signal.origin);

    // A connection that has proved itself is not replaced by an offer that has
    // not: anyone can put someone else's name on one.
    if (isPeer(signal.origin)) return;
    try {
      if (signal.kind === 'offer') {
        attempted.add(signal.origin);
        await answerTo(rtc, signal.origin, signal.data as RTCSessionDescriptionInit, deliver);
      } else if (signal.kind === 'answer') {
        await rtc.handleAnswer(signal.origin, signal.data as RTCSessionDescriptionInit);
      } else {
        await rtc.addIceCandidate(signal.origin, signal.data as RTCIceCandidateInit);
      }
    } catch (err) {
      emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  };

  // Wire signaling -> RTC
  const wireRelay = (relay: SignalingClient, rtc: SignalledTransport): void => {
    relay.on('peer-joined', async (peerDid: string) => {
      if (peerDid === config.did || attempted.has(peerDid)) return;
      attempted.add(peerDid);
      await offerTo(rtc, peerDid, throughRelay(relay, peerDid));
    });

    relay.on('offer', async (msg: SignalingMessage) => {
      if (!msg.payload || typeof msg.payload !== 'object' || isPeer(msg.from)) return;
      attempted.add(msg.from);
      await answerTo(rtc, msg.from, msg.payload as RTCSessionDescriptionInit, throughRelay(relay, msg.from));
    });

    relay.on('answer', async (msg: SignalingMessage) => {
      if (!msg.payload || typeof msg.payload !== 'object' || isPeer(msg.from)) return;
      try {
        await rtc.handleAnswer(msg.from, msg.payload as RTCSessionDescriptionInit);
      } catch (err) {
        emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    });

    relay.on('candidate', async (msg: SignalingMessage) => {
      if (!msg.payload || typeof msg.payload !== 'object' || isPeer(msg.from)) return;
      try {
        await rtc.addIceCandidate(msg.from, msg.payload as RTCIceCandidateInit);
      } catch (err) {
        emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    });
  };
  if (signaling && rtc) wireRelay(signaling, rtc);

  // ─── Who is at the other end ─────────────────────────────────────────
  //
  // With `auth`, a connection is only a peer once it has proved itself; until
  // then nothing but the handshake crosses it, in either direction.

  interface Handshake {
    readonly nonce: string;
    theirNonce: string | null;
    proved: boolean;
    verified: boolean;
    readonly timer: ReturnType<typeof setTimeout>;
  }
  const handshakes = new Map<string, Handshake>();
  const isPeer = (did: string) => discovery.listPeers().some((peer) => peer.did === did);

  const refuse = (peerId: string) => {
    const handshake = handshakes.get(peerId);
    if (handshake) clearTimeout(handshake.timer);
    handshakes.delete(peerId);
    transport.close(peerId);
  };

  const handshakeWith = (peerId: string): Handshake => {
    let handshake = handshakes.get(peerId);
    if (!handshake) {
      handshake = {
        nonce: peerNonce(),
        theirNonce: null,
        proved: false,
        verified: false,
        timer: setTimeout(() => refuse(peerId), config.authTimeoutMs ?? 10_000),
      };
      handshakes.set(peerId, handshake);
      sendControl(peerId, AUTH_HELLO_MESSAGE, { nonce: handshake.nonce });
    }
    return handshake;
  };

  const onHandshake = async (auth: MeshAuth, peerId: string, type: string, payload: unknown): Promise<void> => {
    const handshake = handshakeWith(peerId);
    const binding = transport.binding?.(peerId) ?? null;
    if (type === AUTH_HELLO_MESSAGE) {
      const nonce = (payload as { nonce?: unknown } | null)?.nonce;
      if (typeof nonce !== 'string' || handshake.theirNonce !== null) return;
      handshake.theirNonce = nonce;
      sendControl(peerId, AUTH_PROOF_MESSAGE, await auth.prove(peerId, nonce, binding));
      handshake.proved = true;
    } else if (!handshake.verified) {
      if (!(await auth.check(peerId, handshake.nonce, binding, payload))) return refuse(peerId);
      handshake.verified = true;
    }
    if (handshake.proved && handshake.verified && handshakes.get(peerId) === handshake) {
      clearTimeout(handshake.timer);
      handshakes.delete(peerId);
      admit(peerId);
    }
  };

  // Wire transport -> Discovery & Events
  transport.on('connected', (peerId: string) => {
    attempted.add(peerId);
    if (config.auth) handshakeWith(peerId);
    else admit(peerId);
  });

  /** A connection becomes a peer: announced, and introduced to the others. */
  const admit = (peerId: string): void => {
    discovery.addPeer({
      did: peerId,
      connectionId: peerId, // using did as connectionId for simplicity
      connectedAt: new Date().toISOString(),
    });

    if (!introduce) return;

    // Introduce in both directions. Telling only the newcomer would leave the
    // side with the higher identifier waiting for an offer nobody will send.
    const others = discovery.listPeers().map((peer) => peer.did).filter((did) => did !== peerId);
    if (others.length === 0) return;

    sendControl(peerId, PEERS_MESSAGE, others);
    for (const other of others) sendControl(other, PEERS_MESSAGE, [peerId]);
  };

  transport.on('disconnected', (peerId: string) => {
    const handshake = handshakes.get(peerId);
    if (handshake) clearTimeout(handshake.timer);
    handshakes.delete(peerId);
    attempted.delete(peerId);
    discovery.removePeer(peerId);
  });

  transport.on('data', (peerId: string, data: Uint8Array) => {
    try {
      const message = JSON.parse(utf8Decode(data)) as NetworkMessage;

      // Before the handshake is done, the handshake is all there is.
      if (config.auth && !isPeer(peerId)) {
        if (message.type === AUTH_HELLO_MESSAGE || message.type === AUTH_PROOF_MESSAGE) {
          void onHandshake(config.auth, peerId, message.type, message.payload).catch(() => refuse(peerId));
        }
        return;
      }

      // Mesh housekeeping never reaches the application above. The sender is
      // the connection it arrived on, not whatever the message claims.
      if (!isControlMessage(message.type)) {
        emit('message', { ...message, from: peerId });
        return;
      }

      // Introductions carry offers, which only mean something to WebRTC.
      if (!rtc) return;

      if (message.type === PEERS_MESSAGE) {
        handlePeerList(message.payload);
        return;
      }
      if (message.type !== SIGNAL_MESSAGE) return;

      const signal = message.payload as RelayedSignal;
      // Flooding means the same signal can arrive by several routes; act once.
      if (typeof signal?.id !== 'string' || signal.id.length > 64 || !seenSignals.accept(signal.id)) return;
      if (!isPeerDid(signal.origin) || !isPeerDid(signal.target) || !['offer', 'answer', 'candidate'].includes(signal.kind)) return;
      if (!signal.data || typeof signal.data !== 'object') return;

      if (signal.target === config.did) {
        void handleRelayedSignal(rtc, signal);
      } else if (typeof signal.hops === 'number' && signal.hops > 0) {
        // The sender says how far it may go; never further than we would send it.
        floodSignal({ ...signal, hops: Math.min(signal.hops, MAX_HOPS) - 1 }, peerId);
      }
    } catch (err) {
      emit('error', err instanceof Error ? err : new Error('Failed to parse incoming message'));
    }
  });

  transport.on('error', (peerId: string, error: Error) => {
    emit('error', new Error(`Transport error with peer ${peerId}: ${error.message}`));
  });

  // Wire Discovery -> Events
  discovery.on('peer-added', (info: PeerInfo) => {
    emit('peer-connected', info);
  });

  discovery.on('peer-removed', (info: PeerInfo) => {
    emit('peer-disconnected', info);
  });

  const connect = async (): Promise<void> => {
    await Promise.all([signaling?.connect(), transport.connect?.()]);
  };

  const disconnect = (): void => {
    for (const handshake of handshakes.values()) clearTimeout(handshake.timer);
    handshakes.clear();
    signaling?.disconnect();
    transport.closeAll();
    attempted.clear();
  };

  const send = (peerId: string, message: NetworkMessage): void => {
    try {
      const jsonStr = JSON.stringify(message);
      const data = utf8Encode(jsonStr);
      transport.send(peerId, data);
    } catch (err) {
      emit('error', err instanceof Error ? err : new Error('Failed to send message'));
    }
  };

  const broadcast = (message: NetworkMessage): void => {
    const peers = discovery.listPeers();
    for (const peer of peers) {
      try {
        send(peer.did, message);
      } catch (err) {
        // Continue broadcasting even if one peer fails
        console.warn(`Failed to broadcast to ${peer.did}:`, err);
      }
    }
  };

  return Object.freeze({
    connect,
    disconnect,
    send,
    broadcast,
    getPeers: discovery.listPeers,
    on,
    off,
    // Connected means reachable, which after the first introduction no longer
    // depends on a relay being up.
    isConnected: () => (signaling?.isConnected() ?? false) || discovery.listPeers().length > 0
  });
}
