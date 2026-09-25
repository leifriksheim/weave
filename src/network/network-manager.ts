/**
 * @fileoverview Peers over a transport that dials on its own — a socket to an
 * always-on node, a local link, an in-memory fake in tests. Such a transport
 * authenticates, or is trusted, by itself; relays and WebRTC are the mesh's
 * (`mesh.ts`), which hands each space the same {@link NetworkManager}.
 */

import type { PeerInfo, NetworkMessage } from '../types.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';
import { createEmitter } from '../utils/events.js';
import type { PeerTransport } from './transport.js';

export interface NetworkManagerConfig {
  readonly did: string;
  readonly createTransport: () => PeerTransport;
}

export type NetworkEvents = {
  message: (message: NetworkMessage) => void;
  'peer-connected': (info: PeerInfo) => void;
  'peer-disconnected': (info: PeerInfo) => void;
  error: (error: Error) => void;
};

/** One space's peers, whatever carries them */
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
 * Creates a network manager over a transport that dials on its own.
 *
 * @param config - Who this is, and the transport to use.
 * @returns The network manager instance.
 */
export function createNetworkManager(config: NetworkManagerConfig): NetworkManager {
  const transport = config.createTransport();
  const peers = new Map<string, PeerInfo>();
  const { on, off, emit } = createEmitter<NetworkEvents>();

  transport.on('connected', (peerId) => {
    const info: PeerInfo = { did: peerId, connectionId: peerId, connectedAt: new Date().toISOString() };
    peers.set(peerId, info);
    emit('peer-connected', info);
  });

  transport.on('disconnected', (peerId) => {
    const info = peers.get(peerId);
    if (info && peers.delete(peerId)) emit('peer-disconnected', info);
  });

  transport.on('data', (peerId, data) => {
    try {
      const message = JSON.parse(utf8Decode(data)) as NetworkMessage;
      // The sender is the connection it arrived on, not whatever the message claims.
      emit('message', { ...message, from: peerId });
    } catch {
      emit('error', new Error('Failed to parse incoming message'));
    }
  });

  transport.on('error', (peerId, error) => emit('error', new Error(`Transport error with peer ${peerId}: ${error.message}`)));

  const send = (peerId: string, message: NetworkMessage): void => {
    try {
      transport.send(peerId, utf8Encode(JSON.stringify(message)));
    } catch (err) {
      emit('error', err instanceof Error ? err : new Error('Failed to send message'));
    }
  };

  return Object.freeze({
    connect: async () => {
      await transport.connect?.();
    },
    disconnect: () => transport.closeAll(),
    send,
    broadcast: (message: NetworkMessage) => {
      for (const peerId of peers.keys()) send(peerId, message);
    },
    getPeers: () => [...peers.values()],
    on,
    off,
    isConnected: () => peers.size > 0,
  });
}
