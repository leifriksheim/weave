import { base64UrlEncode, base64UrlDecode } from '../utils/encoding.js';

/**
 * Represents a space key that has been wrapped for a specific recipient.
 */
export interface WrappedKey {
  readonly recipientDid: string;
  readonly ephemeralPublicKey: string;
  readonly wrappedKeyData: string;
  readonly algorithm: string;
}

/**
 * A member's public key for key wrapping.
 */
export interface MemberPublicKey {
  readonly did: string;
  readonly publicKey: CryptoKey;
}

/**
 * Wraps a space key using ECDH + AES-KW.
 *
 * @param {CryptoKey} spaceKey - The space key to wrap.
 * @param {CryptoKey} recipientPublicKey - The recipient's public ECDH key.
 * @param {string} recipientDid - The DID of the recipient.
 * @returns {Promise<WrappedKey>} A promise resolving to the wrapped key.
 */
export async function wrapSpaceKey(
  spaceKey: CryptoKey, 
  recipientPublicKey: CryptoKey, 
  recipientDid: string
): Promise<WrappedKey> {
  const ephemeralPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const sharedSecret = await globalThis.crypto.subtle.deriveBits(
    { name: 'ECDH', public: recipientPublicKey },
    ephemeralPair.privateKey,
    256
  );

  const kek = await globalThis.crypto.subtle.importKey(
    'raw',
    sharedSecret,
    { name: 'AES-KW' },
    false,
    ['wrapKey']
  );

  const wrappedKeyBuffer = await globalThis.crypto.subtle.wrapKey(
    'raw',
    spaceKey,
    kek,
    { name: 'AES-KW' }
  );

  const ephemeralRaw = await globalThis.crypto.subtle.exportKey('raw', ephemeralPair.publicKey);

  return Object.freeze({
    recipientDid,
    ephemeralPublicKey: base64UrlEncode(new Uint8Array(ephemeralRaw)),
    wrappedKeyData: base64UrlEncode(new Uint8Array(wrappedKeyBuffer)),
    algorithm: 'ECDH-AES-KW'
  });
}

/**
 * Unwraps a wrapped space key using ECDH + AES-KW.
 *
 * @param {WrappedKey} wrapped - The wrapped key to unwrap.
 * @param {CryptoKey} recipientPrivateKey - The recipient's private ECDH key.
 * @returns {Promise<CryptoKey>} A promise resolving to the unwrapped space key.
 */
export async function unwrapSpaceKey(
  wrapped: WrappedKey, 
  recipientPrivateKey: CryptoKey
): Promise<CryptoKey> {
  const ephemeralRaw = base64UrlDecode(wrapped.ephemeralPublicKey);
  const ephemeralPublicKey = await globalThis.crypto.subtle.importKey(
    'raw',
    ephemeralRaw as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );

  const sharedSecret = await globalThis.crypto.subtle.deriveBits(
    { name: 'ECDH', public: ephemeralPublicKey },
    recipientPrivateKey,
    256
  );

  const kek = await globalThis.crypto.subtle.importKey(
    'raw',
    sharedSecret,
    { name: 'AES-KW' },
    false,
    ['unwrapKey']
  );

  const wrappedKeyData = base64UrlDecode(wrapped.wrappedKeyData);

  return globalThis.crypto.subtle.unwrapKey(
    'raw',
    wrappedKeyData as BufferSource,
    kek,
    { name: 'AES-KW' },
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Wraps a space key for multiple members.
 *
 * @param {CryptoKey} spaceKey - The space key to wrap.
 * @param {ReadonlyArray<MemberPublicKey>} memberPublicKeys - An array of member public keys.
 * @returns {Promise<ReadonlyArray<WrappedKey>>} A promise resolving to an array of wrapped keys.
 */
export async function distributeSpaceKey(
  spaceKey: CryptoKey,
  memberPublicKeys: ReadonlyArray<MemberPublicKey>
): Promise<ReadonlyArray<WrappedKey>> {
  const promises = memberPublicKeys.map(member => 
    wrapSpaceKey(spaceKey, member.publicKey, member.did)
  );
  const wrappedKeys = await Promise.all(promises);
  return Object.freeze([...wrappedKeys]);
}
