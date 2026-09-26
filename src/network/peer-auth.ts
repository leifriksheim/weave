/**
 * @module peer-auth
 * Proving, over a connection, who you are — and that you may read a space.
 *
 * An always-on node serves a space to whoever connects. For a public space that
 * is fine — anyone may read it anyway. For a private one, serving the
 * ciphertext to anyone who knows the id hands out the space's whole shape and
 * history. And in either, a peer that could claim any name could knock the
 * real owner of that name off the node and take its place. So before a byte
 * of the space moves:
 *
 * ```
 * node   → client   challenge { nonce: Nₛ, did: node }
 * client → node     hello     { did: client, nonce: N꜀, sig: client key signs H, read?: read key signs H }
 * node   → client   welcome   { did: node, sig: node key signs (server | space | node did | N꜀) }
 *
 * H = client | space | client did | node did | Nₛ
 * ```
 *
 * The client signs with **the key its DID names**, proving the name, and in a
 * private space with the space's **read key** too, derived from the space key
 * (`space/space-access.ts`). The node checks the read signature against the
 * public half, which is part of the space — so a node needs no secret to do
 * it, and a host that cannot read the space checks readers exactly as a
 * member's own node does.
 *
 * **A private space's key changes** when someone is removed (`sys.key`), and
 * with it the read key. A reader proves the one the space names now. One
 * that was offline when it changed still holds only an older one: it proves
 * that, and sends its note — the delegation from its account — sealed with
 * the older space key, so only those who could read the space then can open
 * it. A peer holding that key opens the note and lets it in if its account is
 * still a member. Someone removed holds the older key too, but is no member.
 * A peer without any key of the space's (a host) takes the current read key
 * only.
 *
 * The node signs with **its own key**, the one its DID names. That proves the
 * welcome comes from the node that sent the challenge; which node to trust is
 * the client's choice of URL. Naming the node in the client's signature keeps
 * a hello from being replayed to a different node.
 */
import type { CryptoProvider } from '../types.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../utils/encoding.js';
import { didToPublicKey } from '../identity/did.js';

/** What a client sends to prove itself: its own signature, and in a private space the read key's */
export interface HelloProof {
  readonly sig: string;
  readonly read?: string;
  /** The read key that signed `read`, when it is not the one the space names now */
  readonly readKey?: string;
  /** Its note, sealed with the space key behind `readKey` — for a reader that may be behind */
  readonly member?: string;
}

/**
 * Who may read a private space, as one side of a connection knows it — asked
 * at every handshake, since the space's key can change while it is open.
 */
export interface ReadAccess {
  /** The read key this side proves with, or null when it holds none */
  key(): Promise<{ readonly did: string; readonly privateKey: CryptoKey } | null>;
  /** The read key every reader must prove, as the space names it now */
  current(): string;
  /**
   * This side's note, sealed with the space key behind the read key it
   * proves with — sent along when that may not be the current one.
   */
  membership?(): Promise<string | null>;
  /** Whether a peer proving an older read key, with this sealed note, is still a member */
  admits?(peerDid: string, readKey: string, membership: unknown): Promise<boolean>;
}

/** What a caller may pass for a space's read access: the full thing, or a fixed key pair and the public half it must match */
export type ReadAccessInput =
  | ReadAccess
  | { readonly key: { readonly privateKey: CryptoKey; readonly did?: string } | null; readonly publicDid: string };

function readAccessOf(read: ReadAccessInput | null): ReadAccess | null {
  if (!read) return null;
  if ('current' in read) return read;
  const { key, publicDid } = read;
  return { key: async () => (key ? { did: key.did ?? publicDid, privateKey: key.privateKey } : null), current: () => publicDid };
}

/** Signs `label` as a reader: with the read key, saying which one when it is not the current one, and the sealed note then */
async function proveRead(access: ReadAccess, label: Uint8Array, provider: CryptoProvider): Promise<Omit<HelloProof, 'sig'> | null> {
  const key = await access.key();
  if (!key) return null;
  const read = base64UrlEncode(await provider.sign(key.privateKey, label));
  if (key.did === access.current()) return { read };
  const member = (await access.membership?.()) ?? null;
  return { read, readKey: key.did, ...(member ? { member } : {}) };
}

/** Whether a proof shows a reader: the current read key, or an older one with a note from someone still a member */
async function checkRead(access: ReadAccess, peerDid: string, label: Uint8Array, proof: Partial<HelloProof>, provider: CryptoProvider) {
  const current = access.current();
  const claimed = typeof proof.readKey === 'string' ? proof.readKey : current;
  if (!claimed.startsWith('did:key:') || !(await verifyBy(provider, claimed, proof.read, label))) return false;
  if (claimed === current) return true;
  return access.admits ? access.admits(peerDid, claimed, proof.member) : false;
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

/** A fresh random nonce, as a string. */
export function peerNonce(): string {
  return base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

const helloLabel = (spaceId: string, clientDid: string, nodeDid: string, nonce: string) =>
  utf8Encode(`weave-peer/v3|client|${spaceId}|${clientDid}|${nodeDid}|${nonce}`);
const welcomeLabel = (spaceId: string, nodeDid: string, nonce: string) =>
  utf8Encode(`weave-peer/v3|server|${spaceId}|${nodeDid}|${nonce}`);

async function verifyBy(provider: CryptoProvider, did: string, sig: unknown, data: Uint8Array): Promise<boolean> {
  if (typeof sig !== 'string') return false;
  try {
    const publicKey = await provider.importPublicKey(didToPublicKey(did).publicKeyBytes);
    return await provider.verify(publicKey, base64UrlDecode(sig), data);
  } catch {
    return false;
  }
}

/**
 * The client side.
 * @param spaceId The space — bound into every signature, so a proof for one space is useless in another
 * @param session This side's DID and the key it names
 * @param read In a private space, how this side proves it may read — or just the read key (`deriveReadKey`); null in a public one
 */
export function createClientAuth(
  spaceId: string,
  session: { readonly did: string; readonly key: CryptoKey },
  read: ReadAccess | { readonly privateKey: CryptoKey } | null,
  provider: CryptoProvider,
): ClientAuth {
  // A bare key pair proves itself as whatever the node names now.
  const access: ReadAccess | null = !read ? null : 'current' in read ? read : { key: async () => ({ did: '', privateKey: read.privateKey }), current: () => '' };
  return Object.freeze({
    async hello(clientDid: string, nodeDid: string, nodeNonce: string) {
      const label = helloLabel(spaceId, clientDid, nodeDid, nodeNonce);
      const sig = base64UrlEncode(await provider.sign(session.key, label));
      if (!access) return { sig };
      const proof = await proveRead(access, label, provider);
      return proof ? { sig, ...proof } : { sig };
    },
    checkWelcome(nodeDid: string, clientNonce: string, sig: unknown) {
      return verifyBy(provider, nodeDid, sig, welcomeLabel(spaceId, nodeDid, clientNonce));
    },
  });
}

/**
 * The node side. Needs no secret of the space's.
 * @param read In a private space, who may read it — or just its public read key; null in a public one
 * @param nodeKey The private key of the DID the node introduces itself as
 */
export function createServerAuth(spaceId: string, read: ReadAccess | string | null, nodeKey: CryptoKey, provider: CryptoProvider): ServerAuth {
  const access: ReadAccess | null = read === null ? null : typeof read === 'string' ? { key: async () => null, current: () => read } : read;
  return Object.freeze({
    async checkHello(clientDid: string, nodeDid: string, nodeNonce: string, proof: unknown) {
      const given = (proof ?? {}) as Partial<HelloProof>;
      const label = helloLabel(spaceId, clientDid, nodeDid, nodeNonce);
      if (!clientDid.startsWith('did:key:') || !(await verifyBy(provider, clientDid, given.sig, label))) return false;
      return access ? checkRead(access, clientDid, label, given, provider) : true;
    },
    async welcome(nodeDid: string, clientNonce: string) {
      return base64UrlEncode(await provider.sign(nodeKey, welcomeLabel(spaceId, nodeDid, clientNonce)));
    },
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

const meshLabel = (spaceId: string, prover: string, verifier: string, nonce: string, proverCert: string, verifierCert: string) =>
  utf8Encode(`weave-mesh/v1|${spaceId}|${prover}|${verifier}|${nonce}|${proverCert}|${verifierCert}`);

/**
 * One side of the handshake between peers.
 * @param spaceId The space — bound into every proof
 * @param session This side's DID and the key it names
 * @param read In a private space: the read key to prove with, and the public half the space names to check others against
 */
export function createMeshAuth(
  spaceId: string,
  session: { readonly did: string; readonly key: CryptoKey },
  read: ReadAccessInput | null,
  provider: CryptoProvider,
): MeshAuth {
  const access = readAccessOf(read);
  return Object.freeze({
    async prove(peerDid: string, peerNonce: string, binding: ChannelBinding | null) {
      const label = meshLabel(spaceId, session.did, peerDid, peerNonce, binding?.local ?? '', binding?.remote ?? '');
      const sig = base64UrlEncode(await provider.sign(session.key, label));
      if (!access) return { sig };
      const proof = await proveRead(access, label, provider);
      // A node without the space's key cannot prove it may read — and should not be served.
      if (!proof) throw new Error('This node cannot read the space, so it cannot join its peers');
      return { sig, ...proof };
    },
    async check(peerDid: string, ourNonce: string, binding: ChannelBinding | null, proof: unknown) {
      const given = (proof ?? {}) as Partial<HelloProof>;
      // What they signed, seen from this end: their certificate is our remote one.
      const label = meshLabel(spaceId, peerDid, session.did, ourNonce, binding?.remote ?? '', binding?.local ?? '');
      if (!peerDid.startsWith('did:key:') || !(await verifyBy(provider, peerDid, given.sig, label))) return false;
      return access ? checkRead(access, peerDid, label, given, provider) : true;
    },
  });
}
