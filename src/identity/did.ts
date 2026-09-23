import { concatBytes } from '../utils/encoding.js';

export const P256_MULTICODEC = new Uint8Array([0x80, 0x24]);

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encodes a Uint8Array to a base58btc string.
 * @param {Uint8Array} buffer The buffer to encode.
 * @returns {string} The base58 string.
 */
function encodeBase58Btc(buffer: Uint8Array): string {
  if (buffer.length === 0) return '';
  const digits = [0];
  for (let i = 0; i < buffer.length; i++) {
    let carry = buffer[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = '';
  for (let i = 0; i < buffer.length && buffer[i]! === 0; i++) {
    str += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    str += ALPHABET[digits[i]!]!;
  }
  return str;
}

/**
 * Decodes a base58btc string to a Uint8Array.
 * @param {string} str The string to decode.
 * @returns {Uint8Array} The decoded buffer.
 */
function decodeBase58Btc(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const char = str[i]!;
    const value = ALPHABET.indexOf(char);
    if (value === -1) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry = carry >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = carry >> 8;
    }
  }
  let leadingZeros = 0;
  for (let i = 0; i < str.length && str[i]! === '1'; i++) {
    leadingZeros++;
  }
  const result = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    result[leadingZeros + i] = bytes[bytes.length - 1 - i]!;
  }
  return result;
}

/**
 * Converts a public key to a did:key string.
 * @param {Uint8Array} publicKeyBytes The public key bytes.
 * @param {Uint8Array} multicodecPrefix The multicodec prefix for the key type.
 * @returns {string} The formatted did:key string.
 */
export function publicKeyToDid(publicKeyBytes: Uint8Array, multicodecPrefix: Uint8Array): string {
  const prefixedKey = concatBytes(multicodecPrefix, publicKeyBytes);
  return `did:key:z${encodeBase58Btc(prefixedKey)}`;
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
  const bytes = decodeBase58Btc(base58Str);
  
  let prefixLen = 1;
  while (prefixLen < bytes.length && (bytes[prefixLen - 1]! & 0x80) !== 0) {
    prefixLen++;
  }
  
  const multicodecPrefix = bytes.slice(0, prefixLen);
  const publicKeyBytes = bytes.slice(prefixLen);
  
  return { multicodecPrefix, publicKeyBytes };
}
