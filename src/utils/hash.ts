/**
 * Hashing utilities.
 * @module hash
 */

/**
 * Computes the SHA-256 hash of the given data.
 * @param {Uint8Array} data - The data to hash.
 * @returns {Promise<Uint8Array>} A promise that resolves to the hash bytes.
 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buffer = await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(buffer);
}

/**
 * Base32 encoding alphabet (RFC 4648).
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encodes bytes to a base32 string without padding.
 * @param {Uint8Array} bytes - The bytes to encode.
 * @returns {string} The base32 encoded string.
 */
function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  }

  return output.toLowerCase();
}

/**
 * Creates a CID-like content identifier (base32 of SHA-256).
 * @param {Uint8Array} data - The data to compute the identifier for.
 * @returns {Promise<string>} A promise that resolves to the CID-like string.
 */
export async function cidFromBytes(data: Uint8Array): Promise<string> {
  const hashBytes = await sha256(data);
  return 'b' + base32Encode(hashBytes);
}
