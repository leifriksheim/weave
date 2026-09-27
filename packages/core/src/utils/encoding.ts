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
export function utf8Encode(str: string): Uint8Array {
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
export function base64UrlDecode(str: string): Uint8Array {
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
export function concatBytes(...arrays: readonly Uint8Array[]): Uint8Array {
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
 * Encodes a number as an unsigned LEB128 varint.
 * @param {number} n - The number to encode.
 * @returns {Uint8Array} The varint encoded bytes.
 */
export function varintEncode(n: number): Uint8Array {
  const bytes: number[] = [];
  let value = n;
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (value !== 0);
  return new Uint8Array(bytes);
}

/**
 * Decodes an unsigned LEB128 varint from a Uint8Array.
 * @param {Uint8Array} bytes - The bytes to decode.
 * @param {number} [offset=0] - The offset to start decoding from.
 * @returns {{ value: number; bytesRead: number }} The decoded number and the number of bytes read.
 */
export function varintDecode(bytes: Uint8Array, offset: number = 0): { readonly value: number; readonly bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (true) {
    if (offset + bytesRead >= bytes.length) {
      throw new Error('Varint decode out of bounds');
    }
    const byte = bytes[offset + bytesRead]!;
    bytesRead++;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  return { value, bytesRead };
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
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have an even length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
