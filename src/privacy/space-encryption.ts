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
