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
 * @param readKey In a private space, the space's read key (`deriveReadKey`); null in a public one
 */
export function createClientAuth(
  spaceId: string,
  session: { readonly did: string; readonly key: CryptoKey },
  readKey: { readonly privateKey: CryptoKey } | null,
  provider: CryptoProvider,
): ClientAuth {
  return Object.freeze({
    async hello(clientDid: string, nodeDid: string, nodeNonce: string) {
      const label = helloLabel(spaceId, clientDid, nodeDid, nodeNonce);
      const sig = base64UrlEncode(await provider.sign(session.key, label));
      return readKey ? { sig, read: base64UrlEncode(await provider.sign(readKey.privateKey, label)) } : { sig };
    },
    checkWelcome(nodeDid: string, clientNonce: string, sig: unknown) {
      return verifyBy(provider, nodeDid, sig, welcomeLabel(spaceId, nodeDid, clientNonce));
    },
  });
}

/**
 * The node side. Holds no secret of the space's.
 * @param readKey In a private space, its public read key, from the space itself; null in a public one
 * @param nodeKey The private key of the DID the node introduces itself as
 */
export function createServerAuth(spaceId: string, readKey: string | null, nodeKey: CryptoKey, provider: CryptoProvider): ServerAuth {
  return Object.freeze({
    async checkHello(clientDid: string, nodeDid: string, nodeNonce: string, proof: unknown) {
      const { sig, read } = (proof ?? {}) as { sig?: unknown; read?: unknown };
      const label = helloLabel(spaceId, clientDid, nodeDid, nodeNonce);
      if (!clientDid.startsWith('did:key:') || !(await verifyBy(provider, clientDid, sig, label))) return false;
      return readKey ? verifyBy(provider, readKey, read, label) : true;
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

/** What one side sends to prove itself */
export interface MeshProof {
  readonly sig: string;
  readonly read?: string;
}

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
  read: { readonly key: { readonly privateKey: CryptoKey } | null; readonly publicDid: string } | null,
  provider: CryptoProvider,
): MeshAuth {
  return Object.freeze({
    async prove(peerDid: string, peerNonce: string, binding: ChannelBinding | null) {
      const label = meshLabel(spaceId, session.did, peerDid, peerNonce, binding?.local ?? '', binding?.remote ?? '');
      const sig = base64UrlEncode(await provider.sign(session.key, label));
      if (!read) return { sig };
      // A node without the space's key cannot prove it may read — and should not be served.
      if (!read.key) throw new Error('This node cannot read the space, so it cannot join its peers');
      return { sig, read: base64UrlEncode(await provider.sign(read.key.privateKey, label)) };
    },
    async check(peerDid: string, ourNonce: string, binding: ChannelBinding | null, proof: unknown) {
      const { sig, read: readSig } = (proof ?? {}) as { sig?: unknown; read?: unknown };
      // What they signed, seen from this end: their certificate is our remote one.
      const label = meshLabel(spaceId, peerDid, session.did, ourNonce, binding?.remote ?? '', binding?.local ?? '');
      if (!peerDid.startsWith('did:key:') || !(await verifyBy(provider, peerDid, sig, label))) return false;
      return read ? verifyBy(provider, read.publicDid, readSig, label) : true;
    },
  });
}
