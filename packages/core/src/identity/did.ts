import { base58 } from '@scure/base';
import { concatBytes } from '../utils/encoding.js';

/**
 * Multicodec `p256-pub` (0x1200) as a varint. Per the did:key spec the key that
 * follows is the 33-byte compressed point, which is why P-256 DIDs start `zDn`.
 */
export const P256_MULTICODEC = new Uint8Array([0x80, 0x24]);

/**
 * Converts a public key to a did:key string.
 * @param {Uint8Array} publicKeyBytes The public key bytes.
 * @param {Uint8Array} multicodecPrefix The multicodec prefix for the key type.
 * @returns {string} The formatted did:key string.
 */
export function publicKeyToDid(publicKeyBytes: Uint8Array, multicodecPrefix: Uint8Array): string {
  const prefixedKey = concatBytes(multicodecPrefix, publicKeyBytes);
  return `did:key:z${base58.encode(prefixedKey)}`;
}

/**
 * Parses a did:key string into its public key and multicodec prefix.
 * @param {string} did The did:key string.
 * @returns {{ publicKeyBytes: Uint8Array; multicodecPrefix: Uint8Array }} The parsed components.
 */
export function didToPublicKey(did: string): { publicKeyBytes: Uint8Array; multicodecPrefix: Uint8Array } {
  if (!did.startsWith('did:key:z')) {
    throw new Error('Invalid did:key format');
  }
  
  const base58Str = did.slice(9);
  const bytes = base58.decode(base58Str);
  
  let prefixLen = 1;
  while (prefixLen < bytes.length && (bytes[prefixLen - 1]! & 0x80) !== 0) {
    prefixLen++;
  }
  
  const multicodecPrefix = bytes.slice(0, prefixLen);
  const publicKeyBytes = bytes.slice(prefixLen);
  
  return { multicodecPrefix, publicKeyBytes };
}
