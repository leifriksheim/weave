/**
 * @module peer-auth
 * Proving, over a socket, that you may read a space.
 *
 * An always-on node serves a space to whoever connects. For a public space that
 * is fine — anyone may read it anyway. For a private one, serving the
 * ciphertext to anyone who knows the id hands out the space's whole shape and
 * history. So a client proves it can read before a byte of the space moves:
 *
 * ```
 * node   → client   challenge { nonce: Nₛ, did: node }
 * client → node     hello     { did: client, nonce: N꜀, sig: read key signs (client | space | client did | node did | Nₛ) }
 * node   → client   welcome   { did: node, sig: node key signs (server | space | node did | N꜀) }
 * ```
 *
 * The client signs with the space's **read key**, derived from the space key
 * (`space/space-access.ts`). The node checks it against the public half, which
 * is part of the space — so a node needs no secret to do it, and a host that
 * cannot read the space checks readers exactly as a member's own node does.
 *
 * The node signs with **its own key**, the one its DID names. That proves the
 * welcome comes from the node that sent the challenge; which node to trust is
 * the client's choice of URL. Naming the node in the client's signature keeps
 * a hello from being replayed to a different node.
 */
import type { CryptoProvider } from '../types.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../utils/encoding.js';
import { didToPublicKey } from '../identity/did.js';

/** The connecting side: proves it may read, and checks the node's welcome. */
export interface ClientAuth {
  hello(clientDid: string, nodeDid: string, nodeNonce: string): Promise<string>;
  checkWelcome(nodeDid: string, clientNonce: string, sig: unknown): Promise<boolean>;
}

/** The serving side: checks a reader's hello, and signs its welcome. */
export interface ServerAuth {
  checkHello(clientDid: string, nodeDid: string, nodeNonce: string, sig: unknown): Promise<boolean>;
  welcome(nodeDid: string, clientNonce: string): Promise<string>;
}

/** A fresh random nonce, as a string. */
export function peerNonce(): string {
  return base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

const helloLabel = (spaceId: string, clientDid: string, nodeDid: string, nonce: string) =>
  utf8Encode(`weave-peer/v2|client|${spaceId}|${clientDid}|${nodeDid}|${nonce}`);
const welcomeLabel = (spaceId: string, nodeDid: string, nonce: string) =>
  utf8Encode(`weave-peer/v2|server|${spaceId}|${nodeDid}|${nonce}`);

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
 * The client side for a private space.
 * @param spaceId The space — bound into every signature, so a proof for one space is useless in another
 * @param readKey The space's read key (`deriveReadKey`)
 */
export function createClientAuth(spaceId: string, readKey: { readonly privateKey: CryptoKey }, provider: CryptoProvider): ClientAuth {
  return Object.freeze({
    async hello(clientDid: string, nodeDid: string, nodeNonce: string) {
      return base64UrlEncode(await provider.sign(readKey.privateKey, helloLabel(spaceId, clientDid, nodeDid, nodeNonce)));
    },
    checkWelcome(nodeDid: string, clientNonce: string, sig: unknown) {
      return verifyBy(provider, nodeDid, sig, welcomeLabel(spaceId, nodeDid, clientNonce));
    },
  });
}

/**
 * The node side for a private space. Holds no secret of the space's.
 * @param readKey The space's public read key, from the space itself
 * @param nodeKey The private key of the DID the node introduces itself as
 */
export function createServerAuth(spaceId: string, readKey: string, nodeKey: CryptoKey, provider: CryptoProvider): ServerAuth {
  return Object.freeze({
    checkHello(clientDid: string, nodeDid: string, nodeNonce: string, sig: unknown) {
      return verifyBy(provider, readKey, sig, helloLabel(spaceId, clientDid, nodeDid, nodeNonce));
    },
    async welcome(nodeDid: string, clientNonce: string) {
      return base64UrlEncode(await provider.sign(nodeKey, welcomeLabel(spaceId, nodeDid, clientNonce)));
    },
  });
}
