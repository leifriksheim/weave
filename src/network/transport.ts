/**
 * @fileoverview What the network manager needs from any way of moving bytes
 * between peers.
 *
 * Two kinds exist. A **signalled** transport (WebRTC) cannot open a connection
 * on its own: an offer and an answer have to be carried to the other side by
 * something else — a relay, or a peer already connected to both. An
 * **unsignalled** one (a WebSocket to an always-on node, an in-memory fake in
 * tests) just dials. The network manager sets up relays and introductions only
 * for the first kind.
 */

export type PeerTransportEvents = {
  data: (peerId: string, data: Uint8Array) => void;
  connected: (peerId: string) => void;
  disconnected: (peerId: string) => void;
  error: (peerId: string, error: Error) => void;
};

export interface PeerTransport {
  /**
   * Starts dialling, for a transport that reaches out on its own. Called by
   * the network manager's `connect()`. A signalled transport has nothing to
   * start — its connections begin with an offer.
   */
  readonly connect?: () => Promise<void>;
  readonly send: (peerId: string, data: Uint8Array) => void;
  readonly close: (peerId: string) => void;
  /** Closes every connection. Deliberate: a transport must not reconnect after it. */
  readonly closeAll: () => void;
  readonly on: <K extends keyof PeerTransportEvents>(event: K, callback: PeerTransportEvents[K]) => void;
  readonly off: <K extends keyof PeerTransportEvents>(event: K, callback: PeerTransportEvents[K]) => void;
}

/** Receives the ICE candidates a connection discovers, to be carried to the other side. */
export type CandidateSink = (candidate: RTCIceCandidateInit) => void;

export interface SignalledTransport extends PeerTransport {
  /** Opens a connection and returns the offer to carry to the peer. */
  readonly createOffer: (peerId: string, onCandidate: CandidateSink) => Promise<RTCSessionDescriptionInit>;
  /** Accepts a peer's offer and returns the answer to carry back. */
  readonly handleOffer: (peerId: string, offer: RTCSessionDescriptionInit, onCandidate: CandidateSink) => Promise<RTCSessionDescriptionInit>;
  readonly handleAnswer: (peerId: string, answer: RTCSessionDescriptionInit) => Promise<void>;
  readonly addIceCandidate: (peerId: string, candidate: RTCIceCandidateInit) => Promise<void>;
}

/** Whether a transport needs offers carried for it. */
export function isSignalledTransport(transport: PeerTransport): transport is SignalledTransport {
  return typeof (transport as Partial<SignalledTransport>).createOffer === 'function';
}
