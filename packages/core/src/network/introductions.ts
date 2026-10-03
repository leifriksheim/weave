/**
 * Peers introduce each other over the data channels they already have, so a
 * relay is needed only to meet the first one. `__peers` says who I can see;
 * `__signal` carries somebody else's offer to somebody I can reach.
 */
import { bytesToHex } from '../utils/encoding.js';

/** Message types reserved for the mesh itself, never handed to the application */
export const PEERS_MESSAGE = '__peers';
export const SIGNAL_MESSAGE = '__signal';
/** The peer handshake (`peer-auth.ts`): a nonce each way, then a proof each way */
export const AUTH_HELLO_MESSAGE = '__auth-hello';
export const AUTH_PROOF_MESSAGE = '__auth-proof';
/** A peer is leaving a room, though the connection may go on for others */
export const LEAVE_MESSAGE = '__leave';

const CONTROL = new Set([
  PEERS_MESSAGE,
  SIGNAL_MESSAGE,
  AUTH_HELLO_MESSAGE,
  AUTH_PROOF_MESSAGE,
  LEAVE_MESSAGE,
]);

/** Whether a message belongs to the mesh rather than the application above it */
export function isControlMessage(type: string): boolean {
  return CONTROL.has(type);
}

/** The most peers one introduction may name — more is someone trying to make us dial the world */
export const MAX_INTRODUCED = 64;

/** Whether a string could be a peer's name: a did:key of sane length */
export function isPeerDid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

/** Somebody else's signaling, travelling over a data channel */
export interface RelayedSignal {
  /** Distinguishes this from copies arriving by another route */
  readonly id: string;
  /** Who wants to connect */
  readonly origin: string;
  /** Who they want to connect to */
  readonly target: string;
  readonly kind: 'offer' | 'answer' | 'candidate';
  readonly data: unknown;
  /** Forwards left before this is dropped */
  readonly hops: number;
}

/** How far a relayed signal travels: everyone in a room tends to be within a hop or two, and it bounds what a peer can inject */
export const MAX_HOPS = 3;

/** Which side offers when two peers learn of each other at once, so they never make two half-open connections */
export function shouldInitiate(us: string, them: string): boolean {
  return us < them;
}

/** Remembers recently seen signals, so a flooded message is handled once. */
export interface SeenSignals {
  /** Records an id, returning whether it is new */
  accept(id: string): boolean;
}

/** Bounded, because the network feeds it: an unbounded set would let a peer exhaust this tab's memory. */
export function createSeenSignals(limit = 512): SeenSignals {
  const seen = new Set<string>();
  return {
    accept(id: string): boolean {
      if (seen.has(id)) return false;
      seen.add(id);
      // A set iterates in insertion order: the first is the oldest.
      if (seen.size > limit) seen.delete(seen.values().next().value ?? id);
      return true;
    },
  };
}

/** A fresh identifier for a relayed signal. */
export function signalId(): string {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(8)));
}
