/**
 * @fileoverview WebRTC data channel transport management.
 */

import type { CandidateSink, PeerTransportEvents, SignalledTransport } from './transport.js';
import { createEmitter } from '../utils/events.js';

export interface RTCTransportConfig {
  /** Fixed, or asked for each new connection — TURN passwords a relay hands out change */
  readonly iceServers?: ReadonlyArray<RTCIceServer> | (() => ReadonlyArray<RTCIceServer>);
}

export type RTCTransportEvents = PeerTransportEvents;

/** WebRTC data channels: a transport whose connections start with an offer. */
export type RTCTransport = SignalledTransport;

interface PeerConnectionData {
  readonly connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
}

/** The DTLS certificate fingerprint a session description commits to */
function fingerprintOf(description: RTCSessionDescription | null): string | null {
  const match = description?.sdp?.match(/^a=fingerprint:\s*(\S+)\s+(\S+)/im);
  return match ? `${match[1]!.toLowerCase()} ${match[2]!.toUpperCase()}` : null;
}

export const DEFAULT_ICE_SERVERS: ReadonlyArray<RTCIceServer> = [
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
  const configured = config?.iceServers ?? DEFAULT_ICE_SERVERS;
  const iceServers = () => (typeof configured === 'function' ? configured() : configured);
  const connections = new Map<string, PeerConnectionData>();

  const { on, off, emit } = createEmitter<RTCTransportEvents>();

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
    const connection = new RTCPeerConnection({ iceServers: [...iceServers()] });
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

  const binding = (peerId: string) => {
    const connection = connections.get(peerId)?.connection;
    const local = fingerprintOf(connection?.localDescription ?? null);
    const remote = fingerprintOf(connection?.remoteDescription ?? null);
    return local && remote ? { local, remote } : null;
  };

  return Object.freeze({
    createOffer,
    handleOffer,
    handleAnswer,
    addIceCandidate,
    send,
    close,
    closeAll,
    binding,
    on,
    off
  });
}
