/**
 * @module identity/hkdf
 * HKDF-SHA256 with an empty salt, for every key derived from a seed: the seed
 * is already uniformly random, so the `info` label alone separates the keys.
 */
import { bufferSource } from '../utils/guards.js';

async function hkdfMaterial(ikm: Uint8Array, usage: 'deriveBits' | 'deriveKey'): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', bufferSource(ikm), 'HKDF', false, [usage]);
}

function hkdfParams(info: Uint8Array): HkdfParams {
  return { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: bufferSource(info) };
}

/** `length` bytes of HKDF output */
export async function hkdf(ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const bits = await globalThis.crypto.subtle.deriveBits(
    hkdfParams(info),
    await hkdfMaterial(ikm, 'deriveBits'),
    length * 8,
  );
  return new Uint8Array(bits);
}

/** A non-extractable AES-256-GCM key: the same 32 bytes `hkdf` gives, never exposed */
export async function hkdfAesKey(ikm: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.deriveKey(
    hkdfParams(info),
    await hkdfMaterial(ikm, 'deriveKey'),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
