/**
 * @module introductions
 * Letting peers introduce each other, so a relay is only needed to meet the
 * first one.
 *
 * Two browsers cannot find each other unaided — neither can accept an incoming
 * connection — so somebody has to make the introduction. That does not have to
 * be a relay every time. Once you are connected to one peer, its data channel
 * is a perfectly good channel for arranging the next connection, and the peers
 * it already knows are exactly the ones you are looking for.
 *
 * So a relay shrinks from permanent infrastructure to a bootstrap hint: the way
 * into a room you have never been in. After that the mesh introduces itself, and
 * the relay can go away without anyone noticing.
 *
 * Two messages do it. `__peers` says who I can see; `__signal` carries somebody
 * else's connection offer to somebody I can reach.
 */

/** Message types reserved for the mesh itself, never handed to the application */
export const PEERS_MESSAGE = '__peers';
export const SIGNAL_MESSAGE = '__signal';
/** The peer handshake (`peer-auth.ts`): a nonce each way, then a proof each way */
export const AUTH_HELLO_MESSAGE = '__auth-hello';
export const AUTH_PROOF_MESSAGE = '__auth-proof';
/** A peer is leaving a room, though the connection may go on for others */
export const LEAVE_MESSAGE = '__leave';

const CONTROL = new Set([PEERS_MESSAGE, SIGNAL_MESSAGE, AUTH_HELLO_MESSAGE, AUTH_PROOF_MESSAGE, LEAVE_MESSAGE]);

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

/**
 * How far a relayed signal travels.
 *
 * Three is generous for the shape these meshes take — everyone in a room tends
 * to end up within a hop or two of everyone else — and it bounds the work a
 * malicious peer can cause by injecting traffic.
 */
export const MAX_HOPS = 3;

/**
 * Decides which side opens the connection when two peers learn of each other
 * at the same moment.
 *
 * Both being told about the other simultaneously is the normal case for an
 * introduction, and both offering produces two half-open connections that then
 * have to be unpicked. Comparing identifiers costs nothing and both sides
 * always agree on the answer.
 *
 * @param us This peer
 * @param them The peer just learned about
 * @returns Whether this side should send the offer
 */
export function shouldInitiate(us: string, them: string): boolean {
  return us < them;
}

/** Remembers recently seen signals, so a flooded message is handled once. */
export interface SeenSignals {
  /** Records an id, returning whether it is new */
  accept(id: string): boolean;
}

/**
 * Creates a bounded record of signal ids.
 *
 * Bounded because it is fed by the network: an unbounded set would be a way for
 * a peer to make this tab run out of memory.
 *
 * @param limit How many ids to remember
 * @returns The record
 */
export function createSeenSignals(limit: number = 512): SeenSignals {
  const seen = new Set<string>();
  const order: string[] = [];

  return {
    accept(id: string): boolean {
      if (seen.has(id)) return false;

      seen.add(id);
      order.push(id);
      if (order.length > limit) {
        const oldest = order.shift();
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
  };
}

/** A fresh identifier for a relayed signal. */
export function signalId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
