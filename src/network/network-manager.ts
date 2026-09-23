/**
 * @fileoverview Network orchestrator wiring together signaling, transport, and discovery.
 */

import type { PeerInfo, NetworkMessage } from '../types.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';
import { SignalingMessage } from './signaling.js';
import { createMultiSignalingClient } from './multi-signaling.js';
import { createRTCTransport } from './rtc-transport.js';
import { createPeerDiscovery } from './peer-discovery.js';
import {
  PEERS_MESSAGE,
  SIGNAL_MESSAGE,
  MAX_HOPS,
  isControlMessage,
  shouldInitiate,
  createSeenSignals,
  signalId,
  type RelayedSignal,
} from './introductions.js';

export interface NetworkManagerConfig {
  /** A single relay. Prefer {@link signalingUrls}. */
  readonly signalingUrl?: string;
  /**
   * Several relays, used all at once.
   *
   * Failover would still strand two people who happened to pick different
   * relays; being present on all of them means they meet wherever either is
   * looking. None of them can do anything but introduce peers, so adding more
   * costs a websocket and removes a single point of failure.
   */
  readonly signalingUrls?: ReadonlyArray<string>;
  readonly did: string;
  readonly iceServers?: ReadonlyArray<RTCIceServer>;
  /**
   * Let connected peers introduce the peers they know, so the relay is only
   * needed for the first connection. On by default.
   */
  readonly introductions?: boolean;
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
  const relays = config.signalingUrls ?? (config.signalingUrl ? [config.signalingUrl] : []);
  if (relays.length === 0) {
    throw new Error('A network manager needs at least one relay to bootstrap from.');
  }

  const signaling = createMultiSignalingClient(relays, config.did);
  const rtcTransport = createRTCTransport({ iceServers: config.iceServers });
  const discovery = createPeerDiscovery();
  const introduce = config.introductions !== false;

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
      rtcTransport.send(peerId, utf8Encode(JSON.stringify({ type, from: config.did, payload })));
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
    (target: string) =>
    (kind: RelayedSignal['kind'], data: unknown): void => {
      if (kind === 'offer') signaling.sendOffer(target, data as RTCSessionDescriptionInit);
      else if (kind === 'answer') signaling.sendAnswer(target, data as RTCSessionDescriptionInit);
      else signaling.sendCandidate(target, data as RTCIceCandidateInit);
    };

  /** Opens a connection to a peer, sending its signaling however the caller says. */
  const offerTo = async (
    peerDid: string,
    deliver: (kind: RelayedSignal['kind'], data: unknown) => void,
  ): Promise<void> => {
    try {
      const { offer, connection } = await rtcTransport.createOffer(peerDid);
      connection.onicecandidate = (event) => {
        if (event.candidate) deliver('candidate', event.candidate.toJSON());
      };
      deliver('offer', offer);
    } catch (err) {
      emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  };

  /** Accepts a connection, sending the reply back the way the offer came. */
  const answerTo = async (
    peerDid: string,
    offer: RTCSessionDescriptionInit,
    deliver: (kind: RelayedSignal['kind'], data: unknown) => void,
  ): Promise<void> => {
    try {
      const { answer, connection } = await rtcTransport.handleOffer(peerDid, offer);
      connection.onicecandidate = (event) => {
        if (event.candidate) deliver('candidate', event.candidate.toJSON());
      };
      deliver('answer', answer);
    } catch (err) {
      emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  };

  /** Acts on somebody's introduction of peers we have not met. */
  const handlePeerList = (peers: unknown): void => {
    if (!introduce || !Array.isArray(peers)) return;

    for (const peer of peers) {
      if (typeof peer !== 'string' || peer === config.did || attempted.has(peer)) continue;

      // Both sides are told about each other at the same moment, so without a
      // rule both would offer and there would be two half-open connections to
      // unpick. Comparing identifiers is free and both sides always agree.
      if (!shouldInitiate(config.did, peer)) continue;

      attempted.add(peer);
      void offerTo(peer, throughMesh(peer));
    }
  };

  /** Acts on signaling that was addressed to us and arrived over the mesh. */
  const handleRelayedSignal = async (signal: RelayedSignal): Promise<void> => {
    const deliver = throughMesh(signal.origin);

    try {
      if (signal.kind === 'offer') {
        attempted.add(signal.origin);
        await answerTo(signal.origin, signal.data as RTCSessionDescriptionInit, deliver);
      } else if (signal.kind === 'answer') {
        await rtcTransport.handleAnswer(signal.origin, signal.data as RTCSessionDescriptionInit);
      } else {
        await rtcTransport.addIceCandidate(signal.origin, signal.data as RTCIceCandidateInit);
      }
    } catch (err) {
      emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  };

  // Wire signaling -> RTC
  signaling.on('peer-joined', async (peerDid: string) => {
    if (peerDid === config.did || attempted.has(peerDid)) return;
    attempted.add(peerDid);
    await offerTo(peerDid, throughRelay(peerDid));
  });

  signaling.on('offer', async (msg: SignalingMessage) => {
    if (!msg.payload || typeof msg.payload !== 'object') return;
    attempted.add(msg.from);
    await answerTo(msg.from, msg.payload as RTCSessionDescriptionInit, throughRelay(msg.from));
  });

  signaling.on('answer', async (msg: SignalingMessage) => {
    if (!msg.payload || typeof msg.payload !== 'object') return;
    try {
      await rtcTransport.handleAnswer(msg.from, msg.payload as RTCSessionDescriptionInit);
    } catch (err) {
      emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  });

  signaling.on('candidate', async (msg: SignalingMessage) => {
    if (!msg.payload || typeof msg.payload !== 'object') return;
    try {
      await rtcTransport.addIceCandidate(msg.from, msg.payload as RTCIceCandidateInit);
    } catch (err) {
      emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  });

  // Wire RTC -> Discovery & Events
  rtcTransport.on('connected', (peerId: string) => {
    attempted.add(peerId);
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
  });

  rtcTransport.on('disconnected', (peerId: string) => {
    attempted.delete(peerId);
    discovery.removePeer(peerId);
  });

  rtcTransport.on('data', (peerId: string, data: Uint8Array) => {
    try {
      const message = JSON.parse(utf8Decode(data)) as NetworkMessage;

      // Mesh housekeeping never reaches the application above.
      if (!isControlMessage(message.type)) {
        emit('message', message);
        return;
      }

      if (message.type === PEERS_MESSAGE) {
        handlePeerList(message.payload);
        return;
      }

      const signal = message.payload as RelayedSignal;
      // Flooding means the same signal can arrive by several routes; act once.
      if (typeof signal?.id !== 'string' || !seenSignals.accept(signal.id)) return;

      if (signal.target === config.did) {
        void handleRelayedSignal(signal);
      } else if (signal.hops > 0) {
        floodSignal({ ...signal, hops: signal.hops - 1 }, peerId);
      }
    } catch (err) {
      emit('error', err instanceof Error ? err : new Error('Failed to parse incoming message'));
    }
  });

  rtcTransport.on('error', (peerId: string, error: Error) => {
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
    await signaling.connect();
  };

  const disconnect = (): void => {
    signaling.disconnect();
    rtcTransport.closeAll();
    attempted.clear();
  };

  const send = (peerId: string, message: NetworkMessage): void => {
    try {
      const jsonStr = JSON.stringify(message);
      const data = utf8Encode(jsonStr);
      rtcTransport.send(peerId, data);
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
    isConnected: () => signaling.isConnected() || discovery.listPeers().length > 0
  });
}
