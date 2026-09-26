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
export function base32Encode(bytes: Uint8Array): string {
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
 * Decodes {@link base32Encode}'s output, either case.
 * @returns The bytes, or null when it is not base32 of whole bytes
 */
export function base32Decode(text: string): Uint8Array | null {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text.toUpperCase()) {
    const digit = BASE32_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = ((value << 5) | digit) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // Leftover bits must be padding: fewer than a byte, and all zero.
  if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

/** The 32-byte hash a content id (`b` + base32 of SHA-256) stands for, or null when it is not one */
export function cidDigest(cid: string): Uint8Array | null {
  if (cid.length !== 53 || cid[0] !== 'b') return null;
  const bytes = base32Decode(cid.slice(1));
  return bytes && bytes.length === 32 ? bytes : null;
}

/** The content id for a 32-byte hash — the inverse of {@link cidDigest} */
export const cidOfDigest = (digest: Uint8Array): string => 'b' + base32Encode(digest);

/**
 * Creates a CID-like content identifier (base32 of SHA-256).
 * @param {Uint8Array} data - The data to compute the identifier for.
 * @returns {Promise<string>} A promise that resolves to the CID-like string.
 */
export async function cidFromBytes(data: Uint8Array): Promise<string> {
  const hashBytes = await sha256(data);
  return 'b' + base32Encode(hashBytes);
}
