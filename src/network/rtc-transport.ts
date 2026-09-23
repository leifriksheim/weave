/**
 * @fileoverview WebRTC data channel transport management.
 */

import type { CandidateSink, PeerTransportEvents, SignalledTransport } from './transport.js';

export interface RTCTransportConfig {
  readonly iceServers?: ReadonlyArray<RTCIceServer>;
}

export type RTCTransportEvents = PeerTransportEvents;

/** WebRTC data channels: a transport whose connections start with an offer. */
export type RTCTransport = SignalledTransport;

interface PeerConnectionData {
  readonly connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
}

const DEFAULT_ICE_SERVERS: ReadonlyArray<RTCIceServer> = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

/**
 * Creates a new WebRTC transport manager.
 * 
 * @param config - Optional configuration for ICE servers.
 * @returns The RTC transport instance.
 */
export function createRTCTransport(config?: RTCTransportConfig): RTCTransport {
  const iceServers = config?.iceServers ?? DEFAULT_ICE_SERVERS;
  const connections = new Map<string, PeerConnectionData>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners: { [K in keyof RTCTransportEvents]?: Set<any> } = {};

  const emit = <K extends keyof RTCTransportEvents>(event: K, ...args: Parameters<RTCTransportEvents[K]>) => {
    const eventListeners = listeners[event];
    if (eventListeners) {
      eventListeners.forEach(callback => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (callback as any)(...args);
        } catch (e) {
          console.error(`Error in RTC transport event listener for ${event}:`, e);
        }
      });
    }
  };

  const on = <K extends keyof RTCTransportEvents>(event: K, callback: RTCTransportEvents[K]): void => {
    if (!listeners[event]) {
      listeners[event] = new Set();
    }
    listeners[event]!.add(callback);
  };

  const off = <K extends keyof RTCTransportEvents>(event: K, callback: RTCTransportEvents[K]): void => {
    if (listeners[event]) {
      listeners[event]!.delete(callback);
    }
  };

  const setupDataChannel = (peerId: string, channel: RTCDataChannel) => {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      emit('connected', peerId);
    };
    channel.onclose = () => {
      emit('disconnected', peerId);
      close(peerId);
    };
    channel.onerror = (ev) => {
      const errEvent = ev as RTCErrorEvent;
      emit('error', peerId, errEvent.error || new Error('Data channel error'));
    };
    channel.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        emit('data', peerId, new Uint8Array(event.data));
      } else {
        // Handle other types if necessary, though we strictly use arraybuffer
        console.warn('Received non-ArrayBuffer data on RTC channel');
      }
    };
  };

  const createConnection = (peerId: string, onCandidate: CandidateSink): RTCPeerConnection => {
    if (connections.has(peerId)) {
      close(peerId);
    }
    const connection = new RTCPeerConnection({ iceServers: [...iceServers] });
    connections.set(peerId, { connection, channel: null });

    // Attached before any description is set, so no candidate can be missed.
    connection.onicecandidate = (event) => {
      if (event.candidate) onCandidate(event.candidate.toJSON());
    };

    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
        emit('disconnected', peerId);
        close(peerId);
      }
    };

    return connection;
  };

  const createOffer = async (peerId: string, onCandidate: CandidateSink): Promise<RTCSessionDescriptionInit> => {
    const connection = createConnection(peerId, onCandidate);
    const channel = connection.createDataChannel('data', { ordered: true });
    setupDataChannel(peerId, channel);
    
    const peerData = connections.get(peerId);
    if (peerData) {
      peerData.channel = channel;
    }

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);

    return offer;
  };

  const handleOffer = async (
    peerId: string,
    offer: RTCSessionDescriptionInit,
    onCandidate: CandidateSink,
  ): Promise<RTCSessionDescriptionInit> => {
    const connection = createConnection(peerId, onCandidate);
    
    connection.ondatachannel = (event) => {
      const channel = event.channel;
      setupDataChannel(peerId, channel);
      const peerData = connections.get(peerId);
      if (peerData) {
        peerData.channel = channel;
      }
    };

    await connection.setRemoteDescription(offer);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);

    return answer;
  };

  const handleAnswer = async (peerId: string, answer: RTCSessionDescriptionInit): Promise<void> => {
    const peerData = connections.get(peerId);
    if (!peerData) {
      throw new Error(`No connection found for peer ${peerId}`);
    }
    await peerData.connection.setRemoteDescription(answer);
  };

  const addIceCandidate = async (peerId: string, candidate: RTCIceCandidateInit): Promise<void> => {
    const peerData = connections.get(peerId);
    if (!peerData) {
      throw new Error(`No connection found for peer ${peerId}`);
    }
    await peerData.connection.addIceCandidate(candidate);
  };

  const send = (peerId: string, data: Uint8Array): void => {
    const peerData = connections.get(peerId);
    if (!peerData || !peerData.channel || peerData.channel.readyState !== 'open') {
      throw new Error(`Data channel not open for peer ${peerId}`);
    }
    peerData.channel.send(data.buffer as ArrayBuffer);
  };

  const close = (peerId: string): void => {
    const peerData = connections.get(peerId);
    if (peerData) {
      if (peerData.channel) {
        peerData.channel.close();
      }
      peerData.connection.close();
      connections.delete(peerId);
    }
  };

  const closeAll = (): void => {
    const allPeers = Array.from(connections.keys());
    for (const peerId of allPeers) {
      close(peerId);
    }
  };

  return Object.freeze({
    createOffer,
    handleOffer,
    handleAnswer,
    addIceCandidate,
    send,
    close,
    closeAll,
    on,
    off
  });
}
