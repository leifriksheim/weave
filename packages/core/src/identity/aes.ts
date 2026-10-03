/**
 * @module identity/aes
 * AES-GCM as every sealed thing here uses it: a fresh 96-bit nonce written in
 * front of the ciphertext, and optional additional data bound in.
 */
import { concatBytes } from '../utils/encoding.js';
import { bufferSource } from '../utils/guards.js';

export const NONCE_BYTES = 12;

function params(iv: Uint8Array, additionalData?: Uint8Array): AesGcmParams {
  return {
    name: 'AES-GCM',
    iv: bufferSource(iv),
    ...(additionalData ? { additionalData: bufferSource(additionalData) } : {}),
  };
}

/** Nonce ‖ ciphertext */
export async function aesSeal(
  key: CryptoKey,
  plaintext: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    params(iv, additionalData),
    key,
    bufferSource(plaintext),
  );
  return concatBytes(iv, new Uint8Array(ciphertext));
}

/** Opens what `aesSeal` sealed; throws on the wrong key, data or bytes */
export async function aesOpen(
  key: CryptoKey,
  sealed: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const plain = await globalThis.crypto.subtle.decrypt(
    params(sealed.subarray(0, NONCE_BYTES), additionalData),
    key,
    bufferSource(sealed.subarray(NONCE_BYTES)),
  );
  return new Uint8Array(plain);
}
