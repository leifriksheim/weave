/**
 * @module peer-auth
 * Proving, over a socket, that you belong in a space.
 *
 * An always-on node serves a space to whoever connects. For a public space that
 * is fine — anyone may read it anyway. For a private one, serving the
 * ciphertext to anyone who knows the id hands out the space's whole shape and
 * history. So both ends prove they hold the space key before a byte of the
 * space moves:
 *
 * ```
 * node   → client   challenge { nonce: Nₛ, did: node }
 * client → node     hello     { did: client, nonce: N꜀, mac: MAC(client | space | client did | Nₛ) }
 * node   → client   welcome   { did: node, mac: MAC(server | space | node did | N꜀) }
 * ```
 *
 * The MAC key is derived from the space key, never the key itself. Each side
 * signs the other's fresh nonce, so a recorded exchange cannot be replayed, and
 * the node proves itself too — a client learns it is talking to a member, not
 * an impostor feeding it nothing.
 */
import type { SpaceKey } from '../privacy/space-encryption.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../utils/encoding.js';

export type PeerRole = 'client' | 'server';

/** Signs and checks handshake labels for one space. */
export interface PeerAuthenticator {
  sign(role: PeerRole, did: string, nonce: string): Promise<string>;
  verify(role: PeerRole, did: string, nonce: string, mac: unknown): Promise<boolean>;
}

const INFO = utf8Encode('weave/peer-auth/v1');

/** A fresh random nonce, as a string. */
export function peerNonce(): string {
  return base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * The authenticator for a private space, derived from its key.
 * @param spaceId The space — bound into every label, so a MAC for one space is useless in another
 * @param spaceKey The space's AES key; must be extractable
 */
export async function createPeerAuthenticator(spaceId: string, spaceKey: SpaceKey): Promise<PeerAuthenticator> {
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', spaceKey.key));
  const material = await globalThis.crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey']);
  const hmac = await globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: INFO as BufferSource },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );

  const label = (role: PeerRole, did: string, nonce: string) => utf8Encode(`weave-peer/v1|${role}|${spaceId}|${did}|${nonce}`);

  return Object.freeze({
    async sign(role: PeerRole, did: string, nonce: string) {
      const mac = await globalThis.crypto.subtle.sign('HMAC', hmac, label(role, did, nonce) as BufferSource);
      return base64UrlEncode(new Uint8Array(mac));
    },
    async verify(role: PeerRole, did: string, nonce: string, mac: unknown) {
      if (typeof mac !== 'string') return false;
      try {
        return await globalThis.crypto.subtle.verify('HMAC', hmac, base64UrlDecode(mac) as BufferSource, label(role, did, nonce) as BufferSource);
      } catch {
        return false;
      }
    },
  });
}
