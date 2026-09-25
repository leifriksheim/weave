import type { Expression } from '../types.js';
import { base64UrlEncode, base64UrlDecode, utf8Encode, utf8Decode } from '../utils/encoding.js';
import { sha256 } from '../utils/hash.js';

/**
 * Represents a key used to encrypt a Space.
 */
export interface SpaceKey {
  readonly id: string;
  readonly key: CryptoKey;
  readonly createdAt: string;
  readonly version: number;
}

/**
 * The body of an expression after it has been encrypted.
 */
export interface EncryptedExpressionBody {
  readonly ciphertext: string;
  readonly iv: string;
  readonly keyId: string;
}

/**
 * An expression whose body has been encrypted.
 */
export type EncryptedExpression = Omit<Expression, 'body'> & {
  readonly body: EncryptedExpressionBody;
};

/**
 * Generates a new random AES-GCM-256 key for a Space.
 *
 * @returns {Promise<SpaceKey>} A promise resolving to a new SpaceKey.
 */
export async function generateSpaceKey(): Promise<SpaceKey> {
  const key = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const raw = await globalThis.crypto.subtle.exportKey('raw', key);
  const id = base64UrlEncode(new Uint8Array(await sha256(new Uint8Array(raw))));
  
  return Object.freeze({
    id,
    key,
    createdAt: new Date().toISOString(),
    version: 1
  });
}

/**
 * Encrypts an expression's body using AES-GCM.
 *
 * @param {Expression} expression - The expression to encrypt.
 * @param {SpaceKey} spaceKey - The key to use for encryption.
 * @returns {Promise<EncryptedExpression>} A promise resolving to the encrypted expression.
 */
export async function encryptExpression(expression: Expression, spaceKey: SpaceKey): Promise<EncryptedExpression> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const encodedBody = utf8Encode(JSON.stringify(expression.body));
  
  const ciphertextBuffer = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    spaceKey.key,
    encodedBody as BufferSource
  );
  
  const ciphertext = base64UrlEncode(new Uint8Array(ciphertextBuffer));
  
  return Object.freeze({
    ...expression,
    body: Object.freeze({
      ciphertext,
      iv: base64UrlEncode(iv),
      keyId: spaceKey.id
    })
  });
}

/**
 * Decrypts an encrypted expression's body using AES-GCM.
 *
 * @param {EncryptedExpression} encrypted - The encrypted expression.
 * @param {SpaceKey} spaceKey - The key to use for decryption.
 * @returns {Promise<Expression>} A promise resolving to the decrypted expression.
 * @throws {Error} If the key ID doesn't match the space key's ID.
 */
export async function decryptExpression(encrypted: EncryptedExpression, spaceKey: SpaceKey): Promise<Expression> {
  if (encrypted.body.keyId !== spaceKey.id) {
    throw new Error('Key ID mismatch');
  }
  
  const iv = base64UrlDecode(encrypted.body.iv);
  const ciphertext = base64UrlDecode(encrypted.body.ciphertext);
  
  const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    spaceKey.key,
    ciphertext as BufferSource
  );
  
  const body = JSON.parse(utf8Decode(new Uint8Array(decryptedBuffer)));
  
  return Object.freeze({
    ...encrypted,
    body
  });
}

/**
 * A space key from its raw bytes. Its id is the hash of the bytes, so a key
 * handed over — in an invite, a box — can be checked against the id a space
 * or its history names.
 */
export async function spaceKeyFromRaw(raw: Uint8Array, createdAt = new Date().toISOString()): Promise<SpaceKey> {
  const key = await globalThis.crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const id = base64UrlEncode(new Uint8Array(await sha256(raw)));
  return Object.freeze({ id, key, createdAt, version: 1 });
}

/** A space key's raw bytes */
export async function spaceKeyBytes(key: SpaceKey): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key.key));
}

/**
 * Seals a value with a space key, bound to `context`: only someone holding
 * the key opens it, and only where the context matches.
 * @returns base64url: the IV, then the ciphertext
 */
export async function sealWith(spaceKey: SpaceKey, value: unknown, context: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8Encode(context) as BufferSource },
    spaceKey.key,
    utf8Encode(JSON.stringify(value)) as BufferSource,
  );
  return base64UrlEncode(new Uint8Array([...iv, ...new Uint8Array(ciphertext)]));
}

/** Opens what `sealWith` sealed; null when it wasn't sealed with this key, for this context, or was changed */
export async function openWith(spaceKey: SpaceKey, sealed: unknown, context: string): Promise<unknown> {
  if (typeof sealed !== 'string' || sealed.length > 1_000_000) return null;
  try {
    const bytes = base64UrlDecode(sealed);
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12) as BufferSource, additionalData: utf8Encode(context) as BufferSource },
      spaceKey.key,
      bytes.subarray(12) as BufferSource,
    );
    return JSON.parse(utf8Decode(new Uint8Array(plain))) as unknown;
  } catch {
    return null;
  }
}
