/**
 * @module account-vault
 * The lock on a data folder.
 *
 * A folder that holds its seed in the clear is a bearer token: whoever copies it
 * is you, and the AES key for every private space sits in the same directory as
 * the ciphertext it opens. So the seed is never stored — only **wrapped copies**
 * of it are, one per way of unlocking.
 *
 * ```
 * account seed (16 bytes, never written in the clear)
 *   ├── HKDF → vault key ──encrypts──> space keys and space records at rest
 *   └── stored only as wraps:
 *         device     a random key in this origin's storage, gated by a passkey
 *         passphrase PBKDF2-SHA256 → AES-GCM
 * ```
 *
 * Both wraps are shortcuts for one origin, and neither carries the account
 * anywhere — that is what the code is for. Adding an app means adding a wrap
 * there, and two shortcuts end up meaning one account without a delegation
 * chain anywhere in sight.
 *
 * The recovery code needs no wrap at all: it *is* the seed, in printable form.
 * It is shown once and never stored, and it is the way in when no wrap fits —
 * a phone, Safari, or an origin that has never seen this folder.
 *
 * ## What this does not protect
 *
 * Expression files keep their author DID, timestamps and collection names in
 * the clear, and public spaces keep their bodies that way by design. Locking
 * those too would mean an opaque blob store, which would cost the property that
 * makes a folder worth having — that you can open it and see what is in it.
 */

import { base64UrlEncode, base64UrlDecode, utf8Encode } from '../utils/encoding.js';
import { protocolError } from '../utils/errors.js';

/** AES-GCM wants 96 bits of nonce. */
const IV_BYTES = 12;
const SALT_BYTES = 16;

/**
 * PBKDF2 rounds for a passphrase wrap.
 *
 * Tuned to roughly a quarter-second in a browser, on the reasoning that this
 * runs once per unlock and the thing it guards is an identity rather than a
 * session.
 */
export const PASSPHRASE_ITERATIONS = 600_000;

const VAULT_KEY_INFO = utf8Encode('p2p-vault-key-v1');

/** Fields every wrap carries, whatever unlocks it */
interface WrapBase {
  /** Distinguishes wraps within one file */
  readonly id: string;
  /** Shown when asking which one to use */
  readonly label: string;
  readonly addedAt: string;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

/**
 * A seed wrapped under a key held on one device.
 *
 * The key is not derived from the passkey — a passkey only yields key material
 * through the PRF extension, which several widely used providers do not
 * implement. It is a random key in this origin's storage, and the passkey in
 * front of it is a user-verification gate rather than the source of the
 * secret. See {@link module:device-key} for what that does and does not
 * protect against.
 */
export interface DeviceWrap extends WrapBase {
  readonly kind: 'device';
  /**
   * The origin this belongs to. The key it names lives in that origin's
   * storage, so a wrap from another app is not merely likely to fail — it is
   * unreachable from here.
   */
  readonly rpId: string;
  /** Which local key opens it. Missing from this device means unopenable here. */
  readonly deviceKeyId: string;
  /** The passkey that gates it, when one was used */
  readonly credentialId?: string;
}

/** A seed wrapped under a passphrase */
export interface PassphraseWrap extends WrapBase {
  readonly kind: 'passphrase';
  readonly iterations: number;
}

export type SeedWrap = DeviceWrap | PassphraseWrap;

/** The account file at the root of a data folder, in its locked form */
export interface AccountVault {
  readonly version: 2;
  readonly label: string;
  /** The DID the seed derives. Public, and useful for recognising the folder. */
  readonly did: string;
  readonly createdAt: string;
  readonly wraps: ReadonlyArray<SeedWrap>;
}

/** Random bytes as base64url, for salts and nonces. */
function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** A short opaque id for a wrap. */
function wrapId(): string {
  return base64UrlEncode(randomBytes(8));
}

/**
 * Encrypts a seed under a key.
 * @param seed The seed to protect
 * @param key An AES-GCM key
 * @returns The nonce and ciphertext, base64url encoded
 */
async function seal(seed: Uint8Array, key: CryptoKey): Promise<{ iv: string; ciphertext: string }> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    seed as BufferSource,
  );
  return { iv: base64UrlEncode(iv), ciphertext: base64UrlEncode(new Uint8Array(ciphertext)) };
}

/**
 * Decrypts a seed, turning the failure into something a UI can say out loud.
 * @param wrap The wrap to open
 * @param key The key it should be under
 * @returns The seed
 */
async function open(wrap: WrapBase, key: CryptoKey): Promise<Uint8Array> {
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(wrap.iv) as BufferSource },
      key,
      base64UrlDecode(wrap.ciphertext) as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    // AES-GCM authenticates, so this is the wrong key rather than corruption.
    throw protocolError(
      'VAULT_UNLOCK_FAILED',
      'That did not unlock the folder.',
      'Check the passphrase, or use your recovery code instead.',
    );
  }
}

/**
 * Stretches a passphrase into the key that wraps a seed.
 * @param passphrase What the user typed
 * @param salt Per-wrap salt
 * @param iterations PBKDF2 rounds, read from the wrap so old ones stay openable
 * @returns An AES-GCM key
 */
async function passphraseWrappingKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    utf8Encode(passphrase.normalize('NFKC')) as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Wraps a seed under this device's key.
 *
 * The key is random and lives in this origin's storage; the passkey recorded
 * alongside is the gate in front of it, not the source of it. See
 * {@link module:device-key}.
 *
 * @param seed The account seed
 * @param deviceKey The local key, from `createDeviceKey`
 * @param meta Which origin this belongs to, and the passkey gating it
 * @returns A wrap ready to append to the account file
 */
export async function wrapSeedWithDeviceKey(
  seed: Uint8Array,
  deviceKey: { id: string; key: CryptoKey },
  meta: { rpId: string; credentialId?: string; label?: string },
): Promise<DeviceWrap> {
  const sealed = await seal(seed, deviceKey.key);

  return {
    kind: 'device',
    id: wrapId(),
    label: meta.label ?? meta.rpId,
    rpId: meta.rpId,
    deviceKeyId: deviceKey.id,
    ...(meta.credentialId ? { credentialId: meta.credentialId } : {}),
    addedAt: new Date().toISOString(),
    // Nothing is stretched into this key, so there is no salt to record.
    salt: '',
    ...sealed,
  };
}

/**
 * Opens a device wrap.
 * @param wrap The wrap to open
 * @param deviceKey The local key it names
 * @returns The seed
 */
export async function unwrapSeedWithDeviceKey(
  wrap: DeviceWrap,
  deviceKey: CryptoKey,
): Promise<Uint8Array> {
  return open(wrap, deviceKey);
}

/**
 * Wraps a seed under a passphrase — the portable way back in.
 * @param seed The account seed
 * @param passphrase What the user chose
 * @param label What to call this wrap
 * @returns A wrap ready to append to the account file
 */
export async function wrapSeedWithPassphrase(
  seed: Uint8Array,
  passphrase: string,
  label: string = 'Passphrase',
): Promise<PassphraseWrap> {
  const salt = randomBytes(SALT_BYTES);
  const sealed = await seal(seed, await passphraseWrappingKey(passphrase, salt, PASSPHRASE_ITERATIONS));

  return {
    kind: 'passphrase',
    id: wrapId(),
    label,
    addedAt: new Date().toISOString(),
    salt: base64UrlEncode(salt),
    iterations: PASSPHRASE_ITERATIONS,
    ...sealed,
  };
}

/**
 * Opens a passphrase wrap.
 * @param wrap The wrap to open
 * @param passphrase What the user typed
 * @returns The seed
 */
export async function unwrapSeedWithPassphrase(
  wrap: PassphraseWrap,
  passphrase: string,
): Promise<Uint8Array> {
  const key = await passphraseWrappingKey(passphrase, base64UrlDecode(wrap.salt), wrap.iterations);
  return open(wrap, key);
}

/**
 * The vault key as raw bytes.
 *
 * {@link deriveVaultKey} returns a key that cannot be exported, which is right
 * for a page — it should not be able to leak what it was given. A custodian
 * holding the seed elsewhere has to hand the key across somehow, so it derives
 * the bytes directly rather than the protocol relaxing that for everyone.
 *
 * Identical material to `deriveVaultKey`: same input, same info, same length.
 * If those ever drift, a Snap and a page would encrypt the same folder
 * differently and neither could read the other.
 *
 * @param seed The account seed
 * @returns 32 bytes, ready to import as AES-GCM
 */
export async function deriveVaultKeyBytes(seed: Uint8Array): Promise<Uint8Array> {
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    seed as BufferSource,
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );

  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0) as BufferSource,
      info: VAULT_KEY_INFO as BufferSource,
    },
    material,
    256,
  );

  return new Uint8Array(bits);
}

/**
 * Derives the key that encrypts a folder's contents at rest.
 *
 * Separate from the signing key, and from every wrapping key, so that handing
 * one out never implies the others.
 *
 * @param seed The account seed
 * @returns An AES-GCM key for space keys and space records
 */
export async function deriveVaultKey(seed: Uint8Array): Promise<CryptoKey> {
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    seed as BufferSource,
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0) as BufferSource,
      info: VAULT_KEY_INFO as BufferSource,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * The device wraps this origin could actually attempt.
 *
 * The key a wrap names lives in the storage of the origin that made it, so one
 * from another app is not merely likely to fail — it is unreachable from here.
 *
 * @param vault The account file
 * @param rpId This origin's relying-party id, usually its hostname
 * @returns The device wraps belonging to this origin
 */
export function deviceWrapsFor(vault: AccountVault, rpId: string): ReadonlyArray<DeviceWrap> {
  return vault.wraps.filter(
    (wrap): wrap is DeviceWrap => wrap.kind === 'device' && wrap.rpId === rpId,
  );
}

/** Whether a passphrase would get anyone in. */
export function hasPassphraseWrap(vault: AccountVault): boolean {
  return vault.wraps.some((wrap) => wrap.kind === 'passphrase');
}

/**
 * Adds a wrap, replacing any earlier one for the same passkey.
 *
 * Re-registering on an origin should leave one usable wrap rather than a pile of
 * stale ones, and a wrap whose credential is gone is only clutter.
 *
 * @param vault The account file
 * @param wrap The wrap to add
 * @returns The updated account file
 */
export function withWrap(vault: AccountVault, wrap: SeedWrap): AccountVault {
  // One device wrap per origin: re-adding the shortcut should replace it, not
  // leave an older one pointing at a key nobody will use again.
  const superseded = (existing: SeedWrap): boolean =>
    existing.kind === 'device' && wrap.kind === 'device' && existing.rpId === wrap.rpId;

  return { ...vault, wraps: [...vault.wraps.filter((existing) => !superseded(existing)), wrap] };
}

/**
 * Removes a wrap by id.
 *
 * Removing the last one is allowed, and leaves the account in the state a new
 * one starts in: openable by its code and nothing else. The wraps are
 * shortcuts, not the keys to the building.
 *
 * @param vault The account file
 * @param id The wrap to remove
 * @returns The updated account file
 */
export function withoutWrap(vault: AccountVault, id: string): AccountVault {
  return { ...vault, wraps: vault.wraps.filter((wrap) => wrap.id !== id) };
}
