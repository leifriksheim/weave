import type { Expression } from '../types.js';
import { base64UrlEncode, base64UrlDecode, concatBytes, utf8Encode, utf8Decode } from '../utils/encoding.js';
import { aesOpen, aesSeal, NONCE_BYTES } from '../identity/aes.js';
import { sha256 } from '../utils/hash.js';
import { bufferSource } from '../utils/guards.js';

/** Represents a key used to encrypt a Space. */
export interface SpaceKey {
  readonly id: string;
  readonly key: CryptoKey;
  readonly createdAt: string;
  readonly version: number;
}

/** The body of an expression after it has been encrypted. */
export interface EncryptedExpressionBody {
  readonly ciphertext: string;
  readonly iv: string;
  readonly keyId: string;
}

/** An expression whose body has been encrypted. */
export type EncryptedExpression = Omit<Expression, 'body'> & {
  readonly body: EncryptedExpressionBody;
};

/** A new random AES-256-GCM key for a space */
export async function generateSpaceKey(): Promise<SpaceKey> {
  const key = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const raw = await globalThis.crypto.subtle.exportKey('raw', key);
  const id = base64UrlEncode(new Uint8Array(await sha256(new Uint8Array(raw))));

  return Object.freeze({
    id,
    key,
    createdAt: new Date().toISOString(),
    version: 1,
  });
}

/** Encrypts an expression's body under a space key */
export async function encryptExpression(
  expression: Expression,
  spaceKey: SpaceKey,
): Promise<EncryptedExpression> {
  const sealed = await aesSeal(spaceKey.key, utf8Encode(JSON.stringify(expression.body)));
  return Object.freeze({
    ...expression,
    body: Object.freeze({
      ciphertext: base64UrlEncode(sealed.subarray(NONCE_BYTES)),
      iv: base64UrlEncode(sealed.subarray(0, NONCE_BYTES)),
      keyId: spaceKey.id,
    }),
  });
}

/** Decrypts an encrypted expression's body; throws when the key id doesn't match */
export async function decryptExpression(
  encrypted: EncryptedExpression,
  spaceKey: SpaceKey,
): Promise<Expression> {
  if (encrypted.body.keyId !== spaceKey.id) {
    throw new Error('Key ID mismatch');
  }
  const sealed = concatBytes(base64UrlDecode(encrypted.body.iv), base64UrlDecode(encrypted.body.ciphertext));
  const body: unknown = JSON.parse(utf8Decode(await aesOpen(spaceKey.key, sealed)));
  return Object.freeze({ ...encrypted, body });
}

/**
 * A space key from its raw bytes. Its id is the hash of the bytes, so a key
 * handed over — in an invite, a box — can be checked against the id a space
 * or its history names.
 */
export async function spaceKeyFromRaw(
  raw: Uint8Array,
  createdAt = new Date().toISOString(),
): Promise<SpaceKey> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    bufferSource(raw),
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
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
  return base64UrlEncode(await aesSeal(spaceKey.key, utf8Encode(JSON.stringify(value)), utf8Encode(context)));
}

/** Opens what `sealWith` sealed; null when it wasn't sealed with this key, for this context, or was changed */
export async function openWith(spaceKey: SpaceKey, sealed: unknown, context: string): Promise<unknown> {
  if (typeof sealed !== 'string' || sealed.length > 1_000_000) return null;
  try {
    return JSON.parse(utf8Decode(await aesOpen(spaceKey.key, base64UrlDecode(sealed), utf8Encode(context))));
  } catch {
    return null;
  }
}
