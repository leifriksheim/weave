/**
 * Utility functions for encoding and decoding data.
 * @module encoding
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encodes a string to a UTF-8 Uint8Array.
 * @param {string} str - The string to encode.
 * @returns {Uint8Array} The UTF-8 encoded bytes.
 */
export function utf8Encode(str: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(str);
}

/**
 * Decodes a UTF-8 Uint8Array to a string.
 * @param {Uint8Array} bytes - The bytes to decode.
 * @returns {string} The decoded string.
 */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * Encodes a Uint8Array to a base64url string without padding.
 * @param {Uint8Array} bytes - The bytes to encode.
 * @returns {string} The base64url encoded string.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  const binString = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  const base64 = globalThis.btoa(binString);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Decodes a base64url string to a Uint8Array.
 * @param {string} str - The base64url string to decode.
 * @returns {Uint8Array} The decoded bytes.
 */
export function base64UrlDecode(str: string): Uint8Array<ArrayBuffer> {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binString = globalThis.atob(base64);
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Concatenates multiple Uint8Arrays into a single Uint8Array.
 * @param {...Uint8Array[]} arrays - The arrays to concatenate.
 * @returns {Uint8Array} The concatenated array.
 */
export function concatBytes(...arrays: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Encodes a Uint8Array to a hex string.
 * @param {Uint8Array} bytes - The bytes to encode.
 * @returns {string} The hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Decodes a hex string to a Uint8Array.
 * @param {string} hex - The hex string to decode.
 * @returns {Uint8Array} The decoded bytes.
 */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have an even length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
