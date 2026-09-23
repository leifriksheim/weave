/**
 * @fileoverview Manages connected peers.
 */

import type { PeerInfo } from '../types.js';

export type PeerDiscoveryEvents = {
  'peer-added': (info: PeerInfo) => void;
  'peer-removed': (info: PeerInfo) => void;
};

export interface PeerDiscovery {
  readonly addPeer: (info: PeerInfo) => void;
  readonly removePeer: (connectionId: string) => void;
  readonly getPeer: (did: string) => PeerInfo | undefined;
  readonly getPeerByConnectionId: (connectionId: string) => PeerInfo | undefined;
  readonly listPeers: () => ReadonlyArray<PeerInfo>;
  readonly hasPeer: (did: string) => boolean;
  readonly peerCount: () => number;
  readonly on: <K extends keyof PeerDiscoveryEvents>(event: K, callback: PeerDiscoveryEvents[K]) => void;
  readonly off: <K extends keyof PeerDiscoveryEvents>(event: K, callback: PeerDiscoveryEvents[K]) => void;
}

/**
 * Creates a peer discovery and tracking manager.
 * 
 * @returns The peer discovery instance.
 */
export function createPeerDiscovery(): PeerDiscovery {
  const peersByDid = new Map<string, PeerInfo>();
  const peersByConnectionId = new Map<string, PeerInfo>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners: { [K in keyof PeerDiscoveryEvents]?: Set<any> } = {};

  const emit = <K extends keyof PeerDiscoveryEvents>(event: K, ...args: Parameters<PeerDiscoveryEvents[K]>) => {
    const eventListeners = listeners[event];
    if (eventListeners) {
      eventListeners.forEach(callback => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (callback as any)(...args);
        } catch (e) {
          console.error(`Error in peer discovery event listener for ${event}:`, e);
        }
      });
    }
  };

  const on = <K extends keyof PeerDiscoveryEvents>(event: K, callback: PeerDiscoveryEvents[K]): void => {
    if (!listeners[event]) {
      listeners[event] = new Set();
    }
    listeners[event]!.add(callback);
  };

  const off = <K extends keyof PeerDiscoveryEvents>(event: K, callback: PeerDiscoveryEvents[K]): void => {
    if (listeners[event]) {
      listeners[event]!.delete(callback);
    }
  };

  const addPeer = (info: PeerInfo): void => {
    if (peersByDid.has(info.did)) {
      return;
    }
    const frozenInfo = Object.freeze({ ...info });
    peersByDid.set(info.did, frozenInfo);
    peersByConnectionId.set(info.connectionId, frozenInfo);
    emit('peer-added', frozenInfo);
  };

  const removePeer = (connectionId: string): void => {
    const info = peersByConnectionId.get(connectionId);
    if (!info) {
      return;
    }
    peersByDid.delete(info.did);
    peersByConnectionId.delete(connectionId);
    emit('peer-removed', info);
  };

  const getPeer = (did: string): PeerInfo | undefined => {
    return peersByDid.get(did);
  };

  const getPeerByConnectionId = (connectionId: string): PeerInfo | undefined => {
    return peersByConnectionId.get(connectionId);
  };

  const listPeers = (): ReadonlyArray<PeerInfo> => {
    return Object.freeze(Array.from(peersByDid.values()));
  };

  const hasPeer = (did: string): boolean => {
    return peersByDid.has(did);
  };

  const peerCount = (): number => {
    return peersByDid.size;
  };

  return Object.freeze({
    addPeer,
    removePeer,
    getPeer,
    getPeerByConnectionId,
    listPeers,
    hasPeer,
    peerCount,
    on,
    off
  });
}
