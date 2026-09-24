/**
 * @fileoverview Network module exports for P2P networking phase 4.
 */

export { createSignalingClient } from './signaling.js';
export type { SignalingClient, SignalingMessage, SignalingEvents } from './signaling.js';

export { isSignalledTransport } from './transport.js';
export type { PeerTransport, PeerTransportEvents, SignalledTransport, CandidateSink } from './transport.js';

export { createRTCTransport } from './rtc-transport.js';
export type { RTCTransport, RTCTransportConfig, RTCTransportEvents } from './rtc-transport.js';

export { createWebSocketTransport } from './ws-transport.js';
export type { WebSocketTransportConfig } from './ws-transport.js';

export { createPeerDiscovery } from './peer-discovery.js';
export type { PeerDiscovery, PeerDiscoveryEvents } from './peer-discovery.js';

export { createNetworkManager } from './network-manager.js';
export type { NetworkManager, NetworkManagerConfig, NetworkEvents } from './network-manager.js';

export { createLocalHub } from './local-transport.js';
export type { LocalHub } from './local-transport.js';
