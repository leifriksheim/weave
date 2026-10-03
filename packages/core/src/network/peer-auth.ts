/**
 * Proving, over a connection, who you are — and that you may read a space.
 * The client signs with the key its DID names and, in a private space, with
 * the read key; the node signs its welcome with its own key. Between peers
 * both sides do the same, bound to the connection's DTLS fingerprints.
 * spec/04-network.md says why each part is there.
 */
import type { CryptoProvider } from '../types.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../utils/encoding.js';
import { didToPublicKey } from '../identity/did.js';
import { isObject } from '../utils/guards.js';

/** What a client sends to prove itself: its own signature, and in a private space the read key's */
export interface HelloProof {
  readonly sig: string;
  readonly read?: string;
  /** The read key that signed `read`, when it is not the one the space names now */
  readonly readKey?: string;
  /** Its note, sealed with the space key behind `readKey` — for a reader that may be behind */
  readonly member?: string;
  /** The same proof by the older read keys it still holds, newest first — for a verifier that may be behind */
  readonly earlier?: ReadonlyArray<{ readonly readKey: string; readonly read: string }>;
}

/** How many older keys a reader proves with: enough for a verifier away through a few changes */
export const MAX_EARLIER_READ_KEYS = 4;

/**
 * Who may read a private space, as one side of a connection knows it — asked
 * at every handshake, since the space's key can change while it is open.
 */
export interface ReadAccess {
  /** The read key this side proves with, or null when it holds none */
  key(): Promise<{ readonly did: string; readonly privateKey: CryptoKey } | null>;
  /** The read key every reader must prove, as the space names it now */
  current(): string;
  /** The older read keys this side still holds, newest first, not counting the one `key` gives */
  earlier?(): Promise<ReadonlyArray<{ readonly did: string; readonly privateKey: CryptoKey }>>;
  /**
   * This side's note, sealed with the space key behind the read key it
   * proves with — sent along when that may not be the current one.
   */
  membership?(): Promise<string | null>;
  /** Whether a peer proving an older read key, with this sealed note, is still a member */
  admits?(peerDid: string, readKey: string, membership: unknown): Promise<boolean>;
  /**
   * Told the read key a peer was let in on — so a peer let in on a key that is
   * no longer current can be let go once nothing else would let it in.
   */
  admitted?(peerDid: string, readKey: string): void;
}

/** What a caller may pass for a space's read access: the full thing, or a fixed key pair and the public half it must match */
export type ReadAccessInput =
  | ReadAccess
  | {
      readonly key: { readonly privateKey: CryptoKey; readonly did?: string } | null;
      readonly publicDid: string;
    };

/** Every form of read access as one: a public read key alone checks, a bare private key proves as whatever the other side names now */
function readAccessOf(
  read: ReadAccessInput | { readonly privateKey: CryptoKey } | string | null,
): ReadAccess | null {
  if (read === null) return null;
  if (typeof read === 'string') return { key: async () => null, current: () => read };
  if ('current' in read) return read;
  if (!('publicDid' in read))
    return { key: async () => ({ did: '', privateKey: read.privateKey }), current: () => '' };
  const { key, publicDid } = read;
  return {
    key: async () => (key ? { did: key.did ?? publicDid, privateKey: key.privateKey } : null),
    current: () => publicDid,
  };
}

/**
 * Signs `label` as a reader: with its newest read key, named, and its sealed
 * note, since it cannot know whether the other side has moved on; and with
 * the older keys it holds, for another side that has not.
 */
async function proveRead(
  access: ReadAccess,
  label: Uint8Array,
  provider: CryptoProvider,
): Promise<Omit<HelloProof, 'sig'> | null> {
  const key = await access.key();
  if (!key) return null;
  const read = await sign(provider, key.privateKey, label);
  // A bare key pair has no name to give; the other side takes it as its current one.
  if (!key.did) return { read };
  const member = (await access.membership?.()) ?? null;
  const older = ((await access.earlier?.()) ?? [])
    .filter((held) => held.did !== key.did)
    .slice(0, MAX_EARLIER_READ_KEYS);
  const earlier = await Promise.all(
    older.map(async (held) => ({
      readKey: held.did,
      read: await sign(provider, held.privateKey, label),
    })),
  );
  return { read, readKey: key.did, ...(member ? { member } : {}), ...(earlier.length ? { earlier } : {}) };
}

/** Whether a proof shows a reader: the current read key, or an older one with a note from someone still a member */
async function checkRead(
  access: ReadAccess,
  peerDid: string,
  label: Uint8Array,
  proof: Record<string, unknown>,
  provider: CryptoProvider,
) {
  const current = access.current();
  const admit = (readKey: string) => {
    access.admitted?.(peerDid, readKey);
    return true;
  };
  const claimed = typeof proof.readKey === 'string' ? proof.readKey : current;
  if (await verifyBy(provider, claimed, proof.read, label)) {
    if (claimed === current) return admit(current);
    if (access.admits && (await access.admits(peerDid, claimed, proof.member))) return admit(claimed);
  }
  // The reader may be ahead of us: then it proves the key we call current among its older ones.
  const earlier: unknown[] = Array.isArray(proof.earlier)
    ? proof.earlier.slice(0, MAX_EARLIER_READ_KEYS)
    : [];
  const ours = earlier.find(
    (item): item is Record<string, unknown> => isObject(item) && item.readKey === current,
  );
  return ours !== undefined && (await verifyBy(provider, current, ours.read, label)) && admit(current);
}

/** Whether `did` signed `label`, and in a private space proved it may read */
async function checkProof(
  provider: CryptoProvider,
  access: ReadAccess | null,
  did: string,
  label: Uint8Array,
  proof: unknown,
): Promise<boolean> {
  const given: Record<string, unknown> = isObject(proof) ? proof : {};
  if (!(await verifyBy(provider, did, given.sig, label))) return false;
  return access ? checkRead(access, did, label, given, provider) : true;
}

/** The connecting side: proves who it is and that it may read, and checks the node's welcome. */
export interface ClientAuth {
  hello(clientDid: string, nodeDid: string, nodeNonce: string): Promise<HelloProof>;
  checkWelcome(nodeDid: string, clientNonce: string, sig: unknown): Promise<boolean>;
}

/** The serving side: checks a peer's hello, and signs its welcome. */
export interface ServerAuth {
  checkHello(clientDid: string, nodeDid: string, nodeNonce: string, proof: unknown): Promise<boolean>;
  welcome(nodeDid: string, clientNonce: string): Promise<string>;
}

/** A fresh random nonce */
export function peerNonce(): string {
  return base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

const helloLabel = (spaceId: string, clientDid: string, nodeDid: string, nonce: string) =>
  utf8Encode(`weave-peer/v3|client|${spaceId}|${clientDid}|${nodeDid}|${nonce}`);
const welcomeLabel = (spaceId: string, nodeDid: string, nonce: string) =>
  utf8Encode(`weave-peer/v3|server|${spaceId}|${nodeDid}|${nonce}`);

async function verifyBy(
  provider: CryptoProvider,
  did: string,
  sig: unknown,
  data: Uint8Array,
): Promise<boolean> {
  if (typeof sig !== 'string' || !did.startsWith('did:key:')) return false;
  try {
    const publicKey = await provider.importPublicKey(didToPublicKey(did).publicKeyBytes);
    return await provider.verify(publicKey, base64UrlDecode(sig), data);
  } catch {
    return false;
  }
}

async function sign(provider: CryptoProvider, key: CryptoKey, label: Uint8Array): Promise<string> {
  return base64UrlEncode(await provider.sign(key, label));
}

/**
 * The client side. `spaceId` is bound into every signature, so a proof for one
 * space is useless in another; `read` is how it proves it may read a private
 * space (or just the read key, `deriveReadKey`), null in a public one.
 */
export function createClientAuth(
  spaceId: string,
  session: { readonly did: string; readonly key: CryptoKey },
  read: ReadAccess | { readonly privateKey: CryptoKey } | null,
  provider: CryptoProvider,
): ClientAuth {
  const access = readAccessOf(read);
  return Object.freeze({
    async hello(clientDid: string, nodeDid: string, nodeNonce: string) {
      const label = helloLabel(spaceId, clientDid, nodeDid, nodeNonce);
      const proof = access && (await proveRead(access, label, provider));
      return { sig: await sign(provider, session.key, label), ...proof };
    },
    checkWelcome(nodeDid: string, clientNonce: string, sig: unknown) {
      return verifyBy(provider, nodeDid, sig, welcomeLabel(spaceId, nodeDid, clientNonce));
    },
  });
}

/** The node side, which needs no secret of the space's: `read` is who may read a private space, or just its public read key. */
export function createServerAuth(
  spaceId: string,
  read: ReadAccess | string | null,
  nodeKey: CryptoKey,
  provider: CryptoProvider,
): ServerAuth {
  const access = readAccessOf(read);
  return Object.freeze({
    checkHello: (clientDid: string, nodeDid: string, nodeNonce: string, proof: unknown) =>
      checkProof(provider, access, clientDid, helloLabel(spaceId, clientDid, nodeDid, nodeNonce), proof),
    welcome: (nodeDid: string, clientNonce: string) =>
      sign(provider, nodeKey, welcomeLabel(spaceId, nodeDid, clientNonce)),
  });
}

// ─── Between peers ───────────────────────────────────────────────────
//
// A WebRTC connection is set up by carrying an offer and an answer through a
// relay, or through other peers. Nothing in that proves who is at the other
// end: the name on an offer is whatever its sender typed, and a relay could
// swap in its own offer and sit in the middle. So once the channel is open,
// and before anything else crosses it, each side proves:
//
// ```
// A → B   hello  { nonce: Nₐ }
// B → A   hello  { nonce: N_b }
// A → B   proof  { sig: A's key signs T(A, B, N_b), read?: read key signs the same }
// B → A   proof  { sig: B's key signs T(B, A, Nₐ),  read?: … }
//
// T(prover, verifier, nonce) = space | prover | verifier | nonce | prover's certificate | verifier's certificate
// ```
//
// The signature by the key its DID names proves the name. The certificates are
// the DTLS fingerprints each side sees for this very connection: someone in the
// middle holds a different pair on each side, so a proof relayed through them
// does not check out. In a private space the read key signs too, so only those
// who may read it get a connection at all — a relay that learns the room, or
// a stranger who learns the space's id, gets nothing.

/** The fingerprints of one connection's two ends, as this side sees them */
export interface ChannelBinding {
  readonly local: string;
  readonly remote: string;
}

/** What one side sends to prove itself — as a client's hello */
export type MeshProof = HelloProof;

/** Proving who you are to a peer — and, in a private space, that you may read it. */
export interface MeshAuth {
  prove(peerDid: string, peerNonce: string, binding: ChannelBinding | null): Promise<MeshProof>;
  check(peerDid: string, ourNonce: string, binding: ChannelBinding | null, proof: unknown): Promise<boolean>;
}

const meshLabel = (
  spaceId: string,
  prover: string,
  verifier: string,
  nonce: string,
  proverCert: string,
  verifierCert: string,
) => utf8Encode(`weave-mesh/v1|${spaceId}|${prover}|${verifier}|${nonce}|${proverCert}|${verifierCert}`);

/** One side of the handshake between peers; `read` is, in a private space, the read key to prove with and the public half to check others against. */
export function createMeshAuth(
  spaceId: string,
  session: { readonly did: string; readonly key: CryptoKey },
  read: ReadAccessInput | null,
  provider: CryptoProvider,
): MeshAuth {
  const access = readAccessOf(read);
  return Object.freeze({
    async prove(peerDid: string, peerNonce: string, binding: ChannelBinding | null) {
      const label = meshLabel(
        spaceId,
        session.did,
        peerDid,
        peerNonce,
        binding?.local ?? '',
        binding?.remote ?? '',
      );
      const proof = access && (await proveRead(access, label, provider));
      // A node without the space's key cannot prove it may read — and should not be served.
      if (access && !proof) throw new Error('This node cannot read the space, so it cannot join its peers');
      return { sig: await sign(provider, session.key, label), ...proof };
    },
    check(peerDid: string, ourNonce: string, binding: ChannelBinding | null, proof: unknown) {
      // What they signed, seen from this end: their certificate is our remote one.
      const label = meshLabel(
        spaceId,
        peerDid,
        session.did,
        ourNonce,
        binding?.remote ?? '',
        binding?.local ?? '',
      );
      return checkProof(provider, access, peerDid, label, proof);
    },
  });
}
