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
 * Sealing uses a fresh key pair for each message, a secret shared with the
 * recipient's public key, and AES-GCM. The `context` is bound in as additional data, so a
 * sealed message moved anywhere its context no longer matches doesn't open.
 */
import { p256 } from '@noble/curves/nist.js';
import { base64UrlDecode, base64UrlEncode, concatBytes, utf8Decode, utf8Encode } from '../utils/encoding.js';
import { bufferSource } from '../utils/guards.js';
import { hkdf } from './hkdf.js';
import { aesOpen, aesSeal, NONCE_BYTES } from './aes.js';

/** Domain separation for the contact key. Changing it changes every account's contact key. */
const CONTACT_KEY_INFO = 'weave/p256-contact-key/v1';
const SEAL_INFO = 'weave/contact-seal/v1';
const MEMBER_KEY_INFO = 'weave/p256-member-key/v1';
const DOOR_KEY_INFO = 'weave/p256-door-key/v1';
const DOOR_SIGN_KEY_INFO = 'weave/p256-door-sign-key/v1';

/** 48 bytes reduce to a P-256 scalar without bias, as for the root key (`crypto-p256.ts`) */
const P256_SEED_BYTES = 48;
const POINT_BYTES = 65;

export interface ContactKeyPair {
  /** The public half: a compressed P-256 point, base64url. What goes on a profile. */
  readonly publicKey: string;
  /** The private half, for opening what was sealed to the public one. Not extractable. */
  readonly privateKey: CryptoKey;
}

/** A P-256 scalar from key material, under its own label */
async function deriveScalar(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  return p256.utils.randomSecretKey(await hkdf(ikm, utf8Encode(info), P256_SEED_BYTES));
}

/** A private scalar as a Web Crypto key; the JWK form needs its public point too */
function importScalar(
  secret: Uint8Array,
  algorithm: 'ECDSA' | 'ECDH',
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const point = p256.getPublicKey(secret, false);
  return globalThis.crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(point.subarray(1, 33)),
      y: base64UrlEncode(point.subarray(33, 65)),
      d: base64UrlEncode(secret),
      ext: false,
    },
    { name: algorithm, namedCurve: 'P-256' },
    false,
    usages,
  );
}

/**
 * The contact key's private scalar, from the account seed — 32 bytes. This is
 * what an account home hands an app it lets handle contacts.
 */
export async function deriveContactKeyBytes(seed: Uint8Array): Promise<Uint8Array> {
  return deriveScalar(seed, CONTACT_KEY_INFO);
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
  return deriveScalar(accountKey, `${MEMBER_KEY_INFO}|${spaceId}`);
}

/**
 * A **door key**: the key a door's knocks are sealed to (`doors/doors.ts`).
 * Derived from the contact key and the door's id, so every device and app
 * holding the contact key opens the same doors, and a new door is a new id.
 *
 * Not the contact key itself: that one's public half is on your profile in
 * every space you write in, and a door is handed to people who may not know
 * who you are yet. A door key says nothing about the account behind it.
 * @param contactKey The contact key's private scalar (`deriveContactKeyBytes`)
 * @param doorId The door's id, as its `std.door` record names it
 */
export async function deriveDoorKeyBytes(contactKey: Uint8Array, doorId: string): Promise<Uint8Array> {
  return deriveScalar(contactKey, `${DOOR_KEY_INFO}|${doorId}`);
}

/**
 * A door's **signing key**: what proves you own a door, without saying whose
 * it is — to a relay, when clearing the door's mailbox, and to someone who
 * knocked, when you answer. Separate from the door key, which only opens
 * knocks: one key should not both sign and decrypt.
 */
export async function deriveDoorSignKeyBytes(contactKey: Uint8Array, doorId: string): Promise<Uint8Array> {
  return deriveScalar(contactKey, `${DOOR_SIGN_KEY_INFO}|${doorId}`);
}

/**
 * Signs with a P-256 private scalar: ECDSA over SHA-256, 64 bytes r ‖ s,
 * base64url — for door signing keys.
 */
export async function signWithScalar(secret: Uint8Array, data: Uint8Array): Promise<string> {
  const key = await importScalar(secret, 'ECDSA', ['sign']);
  return base64UrlEncode(
    new Uint8Array(
      await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bufferSource(data)),
    ),
  );
}

/** Checks what `signWithScalar` signed, against a compressed public key (base64url) */
export async function verifyWithPoint(
  publicKey: string,
  data: Uint8Array,
  signature: string,
): Promise<boolean> {
  try {
    const point = p256.Point.fromBytes(base64UrlDecode(publicKey)).toBytes(false);
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      bufferSource(point),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      bufferSource(base64UrlDecode(signature)),
      bufferSource(data),
    );
  } catch {
    return false;
  }
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
  const privateKey = await importScalar(secret, 'ECDH', ['deriveBits']);
  return Object.freeze({ publicKey: contactPublicKey(secret), privateKey });
}

/** The AES key two sides agree on, bound to the ephemeral key it came from */
async function sealKey(shared: ArrayBuffer, ephemeral: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const ikm = new Uint8Array([...new Uint8Array(shared), ...ephemeral]);
  const material = await hkdf(ikm, utf8Encode(SEAL_INFO), 32);
  return globalThis.crypto.subtle.importKey(
    'raw',
    bufferSource(material),
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
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
    bufferSource(p256.Point.fromBytes(base64UrlDecode(recipient)).toBytes(false)),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ephemeral = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const ephemeralPoint = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const shared = await globalThis.crypto.subtle.deriveBits(
    { name: 'ECDH', public: recipientKey },
    ephemeral.privateKey,
    256,
  );
  const key = await sealKey(shared, ephemeralPoint, 'encrypt');
  const sealed = await aesSeal(key, utf8Encode(JSON.stringify(value)), utf8Encode(context));
  return base64UrlEncode(concatBytes(ephemeralPoint, sealed));
}

/**
 * Opens what `sealFor` sealed.
 * @returns The value, or null when it was not sealed for this key, or for this context, or was changed
 */
export async function openSealed(privateKey: CryptoKey, sealed: string, context: string): Promise<unknown> {
  try {
    const bytes = base64UrlDecode(sealed);
    if (bytes.length <= POINT_BYTES + NONCE_BYTES) return null;
    const ephemeralPoint = bytes.subarray(0, POINT_BYTES);
    const ephemeral = await globalThis.crypto.subtle.importKey(
      'raw',
      bufferSource(ephemeralPoint),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const shared = await globalThis.crypto.subtle.deriveBits(
      { name: 'ECDH', public: ephemeral },
      privateKey,
      256,
    );
    const key = await sealKey(shared, ephemeralPoint, 'decrypt');
    const plain = await aesOpen(key, bytes.subarray(POINT_BYTES), utf8Encode(context));
    return JSON.parse(utf8Decode(plain));
  } catch {
    return null;
  }
}
