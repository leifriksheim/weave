/**
 * @module identity/contact-key
 * The contact key: what lets someone seal a message only you can open, while
 * you are offline.
 *
 * It is a P-256 key pair for key agreement (ECDH), derived from the account's
 * seed like the root key but under its own label — the same on every device,
 * and back with the recovery code. It is not the root key: apps never hold the
 * seed, and one key should not both sign and decrypt. It is not a session key
 * either: those change every hour, and a request read next week would be
 * locked to a key that is gone.
 *
 * The public half goes on the account's profile in every space it writes in
 * (`sys.profile`). The private half stays with the account home, and goes to
 * apps the person lets handle contacts.
 *
 * Sealing works like wrapping a space key (`privacy/key-distribution.ts`): a
 * fresh key pair for each message, a secret shared with the recipient's
 * public key, and AES-GCM. The `context` is bound in as additional data, so a
 * sealed message moved anywhere its context no longer matches doesn't open.
 */
import { p256 } from '@noble/curves/nist.js';
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from '../utils/encoding.js';

/** Domain separation for the contact key. Changing it changes every account's contact key. */
const CONTACT_KEY_INFO = 'weave/p256-contact-key/v1';
const SEAL_INFO = 'weave/contact-seal/v1';
const MEMBER_KEY_INFO = 'weave/p256-member-key/v1';

/** 48 bytes reduce to a P-256 scalar without bias, as for the root key (`crypto-p256.ts`) */
const P256_SEED_BYTES = 48;
const POINT_BYTES = 65;
const IV_BYTES = 12;

export interface ContactKeyPair {
  /** The public half: a compressed P-256 point, base64url. What goes on a profile. */
  readonly publicKey: string;
  /** The private half, for opening what was sealed to the public one. Not extractable. */
  readonly privateKey: CryptoKey;
}

async function hkdf(ikm: Uint8Array, info: string, length: number): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Encode(info) as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * The contact key's private scalar, from the account seed — 32 bytes. This is
 * what an account home hands an app it lets handle contacts.
 */
export async function deriveContactKeyBytes(seed: Uint8Array): Promise<Uint8Array> {
  return p256.utils.randomSecretKey(await hkdf(seed, CONTACT_KEY_INFO, P256_SEED_BYTES));
}

/**
 * An account's **member key** for one space: the same kind of key pair, derived
 * from the account's vault key and the space id. When a private space's key
 * changes, the new key is sealed to each member's member key (`sys.box`).
 *
 * One per space, not one per account, so an account home can hand an app the
 * member keys for exactly the spaces it grants — and a new space key reaches
 * that app without it holding anything that opens other spaces' keys.
 * @param accountKey The vault key bytes (`deriveVaultKeyBytes(seed)`)
 */
export async function deriveMemberKeyBytes(accountKey: Uint8Array, spaceId: string): Promise<Uint8Array> {
  return p256.utils.randomSecretKey(await hkdf(accountKey, `${MEMBER_KEY_INFO}|${spaceId}`, P256_SEED_BYTES));
}

/** The public half, from the private scalar */
export function contactPublicKey(secret: Uint8Array): string {
  return base64UrlEncode(p256.getPublicKey(secret, true));
}

/** Whether a string is a contact key's public half: a point on P-256 */
export function isContactPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  try {
    p256.Point.fromBytes(base64UrlDecode(value)).assertValidity();
    return true;
  } catch {
    return false;
  }
}

/** The key pair, from the private scalar (`deriveContactKeyBytes`) */
export async function contactKeyPair(secret: Uint8Array): Promise<ContactKeyPair> {
  const point = p256.getPublicKey(secret, false);
  const privateKey = await globalThis.crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(point.subarray(1, 33)),
      y: base64UrlEncode(point.subarray(33, 65)),
      d: base64UrlEncode(secret),
      ext: false,
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  return Object.freeze({ publicKey: contactPublicKey(secret), privateKey });
}

/** The AES key two sides agree on, bound to the ephemeral key it came from */
async function sealKey(shared: ArrayBuffer, ephemeral: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const ikm = new Uint8Array([...new Uint8Array(shared), ...ephemeral]);
  const material = await hkdf(ikm, SEAL_INFO, 32);
  return globalThis.crypto.subtle.importKey('raw', material as BufferSource, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/**
 * Seals a value so only the holder of a contact key can open it.
 * @param recipient The contact key's public half, as a profile carries it
 * @param value Anything JSON can carry
 * @param context What the sealed value belongs to; opening needs the same
 * @returns base64url: the ephemeral public point, the IV, and the ciphertext
 */
export async function sealFor(recipient: string, value: unknown, context: string): Promise<string> {
  const recipientKey = await globalThis.crypto.subtle.importKey(
    'raw',
    p256.Point.fromBytes(base64UrlDecode(recipient)).toBytes(false) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ephemeral = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephemeralPoint = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const shared = await globalThis.crypto.subtle.deriveBits({ name: 'ECDH', public: recipientKey }, ephemeral.privateKey, 256);
  const key = await sealKey(shared, ephemeralPoint, 'encrypt');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: utf8Encode(context) as BufferSource },
      key,
      utf8Encode(JSON.stringify(value)) as BufferSource,
    ),
  );
  return base64UrlEncode(new Uint8Array([...ephemeralPoint, ...iv, ...ciphertext]));
}

/**
 * Opens what `sealFor` sealed.
 * @returns The value, or null when it was not sealed for this key, or for this context, or was changed
 */
export async function openSealed(privateKey: CryptoKey, sealed: string, context: string): Promise<unknown> {
  try {
    const bytes = base64UrlDecode(sealed);
    if (bytes.length <= POINT_BYTES + IV_BYTES) return null;
    const ephemeralPoint = bytes.subarray(0, POINT_BYTES);
    const ephemeral = await globalThis.crypto.subtle.importKey(
      'raw',
      ephemeralPoint as BufferSource,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const shared = await globalThis.crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeral }, privateKey, 256);
    const key = await sealKey(shared, ephemeralPoint, 'decrypt');
    const plain = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.subarray(POINT_BYTES, POINT_BYTES + IV_BYTES) as BufferSource,
        additionalData: utf8Encode(context) as BufferSource,
      },
      key,
      bytes.subarray(POINT_BYTES + IV_BYTES) as BufferSource,
    );
    return JSON.parse(utf8Decode(new Uint8Array(plain))) as unknown;
  } catch {
    return null;
  }
}
