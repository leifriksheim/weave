/**
 * @module account-vault
 * The lock on a data folder: the seed is never stored, only wrapped copies of
 * it, one per way of unlocking (a device key gated by a passkey, or a
 * passphrase). The recovery code needs no wrap: it is the seed.
 */

import { base64UrlEncode, base64UrlDecode, concatBytes, utf8Encode } from '../utils/encoding.js';
import { protocolError } from '../utils/errors.js';
import { bufferSource, isRecord } from '../utils/guards.js';
import { hkdf, hkdfAesKey } from './hkdf.js';
import { aesOpen, aesSeal, NONCE_BYTES } from './aes.js';

const SALT_BYTES = 16;

/**
 * PBKDF2 rounds for a passphrase wrap.
 *
 * Tuned to roughly a quarter-second in a browser, on the reasoning that this
 * runs once per unlock and the thing it guards is an identity rather than a
 * session.
 */
export const PASSPHRASE_ITERATIONS = 600_000;

const VAULT_KEY_INFO = utf8Encode('weave-vault-key-v1');

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
  /** That passkey's user handle, base64url — what renaming its label needs */
  readonly userHandle?: string;
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

/**
 * Whether parsed JSON is a vault. Loose on purpose: the version and a list of
 * wraps; each wrap is checked when something tries to open it.
 */
export function isAccountVault(value: unknown): value is AccountVault {
  return isRecord(value) && value.version === 2 && Array.isArray(value.wraps);
}

/** Random bytes as base64url, for salts and nonces. */
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** A short opaque id for a wrap. */
function wrapId(): string {
  return base64UrlEncode(randomBytes(8));
}

async function seal(seed: Uint8Array, key: CryptoKey): Promise<{ iv: string; ciphertext: string }> {
  const sealed = await aesSeal(key, seed);
  return {
    iv: base64UrlEncode(sealed.subarray(0, NONCE_BYTES)),
    ciphertext: base64UrlEncode(sealed.subarray(NONCE_BYTES)),
  };
}

async function open(wrap: WrapBase, key: CryptoKey): Promise<Uint8Array> {
  try {
    return await aesOpen(key, concatBytes(base64UrlDecode(wrap.iv), base64UrlDecode(wrap.ciphertext)));
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
 * @param iterations PBKDF2 rounds, read from the wrap so old ones stay openable
 */
async function passphraseWrappingKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    bufferSource(utf8Encode(passphrase.normalize('NFKC'))),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bufferSource(salt), iterations },
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
 */
export async function wrapSeedWithDeviceKey(
  seed: Uint8Array,
  deviceKey: { id: string; key: CryptoKey },
  meta: { rpId: string; credentialId?: string; userHandle?: string; label?: string },
): Promise<DeviceWrap> {
  const sealed = await seal(seed, deviceKey.key);

  return {
    kind: 'device',
    id: wrapId(),
    label: meta.label ?? meta.rpId,
    rpId: meta.rpId,
    deviceKeyId: deviceKey.id,
    ...(meta.credentialId ? { credentialId: meta.credentialId } : {}),
    ...(meta.userHandle ? { userHandle: meta.userHandle } : {}),
    addedAt: new Date().toISOString(),
    // Nothing is stretched into this key, so there is no salt to record.
    salt: '',
    ...sealed,
  };
}

/** Opens a device wrap. */
export async function unwrapSeedWithDeviceKey(wrap: DeviceWrap, deviceKey: CryptoKey): Promise<Uint8Array> {
  return open(wrap, deviceKey);
}

/** Wraps a seed under a passphrase — the portable way back in. */
export async function wrapSeedWithPassphrase(
  seed: Uint8Array,
  passphrase: string,
  label = 'Passphrase',
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

/** Opens a passphrase wrap. */
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
 * for a page — it should not be able to leak what it was given. A node derives
 * the account registry from the key, so it is handed the bytes directly
 * rather than the protocol relaxing that for everyone.
 *
 * Identical material to `deriveVaultKey`: same input, same info, same length.
 * If those ever drift, the registry and the folder would be sealed under two
 * different keys.
 */
export async function deriveVaultKeyBytes(seed: Uint8Array): Promise<Uint8Array> {
  return hkdf(seed, VAULT_KEY_INFO, 32);
}

/**
 * Derives the key that encrypts a folder's contents at rest.
 *
 * Separate from the signing key, and from every wrapping key, so that handing
 * one out never implies the others.
 */
export async function deriveVaultKey(seed: Uint8Array): Promise<CryptoKey> {
  return hkdfAesKey(seed, VAULT_KEY_INFO);
}

/**
 * The device wraps this origin could actually attempt.
 *
 * The key a wrap names lives in the storage of the origin that made it, so one
 * from another app is not merely likely to fail — it is unreachable from here.
 */
export function deviceWrapsFor(vault: AccountVault, rpId: string): ReadonlyArray<DeviceWrap> {
  return vault.wraps.filter((wrap): wrap is DeviceWrap => wrap.kind === 'device' && wrap.rpId === rpId);
}

/**
 * What the CLI labels the passphrase it unlocks with unattended. Kept apart
 * from the account's password, so changing one does not remove the other.
 */
export const CLI_PASSPHRASE_LABEL = 'CLI passphrase';

/**
 * Adds a wrap, replacing any earlier one for the same passkey.
 *
 * Re-registering on an origin should leave one usable wrap rather than a pile of
 * stale ones, and a wrap whose credential is gone is only clutter.
 */
export function withWrap(vault: AccountVault, wrap: SeedWrap): AccountVault {
  // One device wrap per origin: re-adding the shortcut should replace it, not
  // leave an older one pointing at a key nobody will use again.
  const superseded = (existing: SeedWrap): boolean =>
    existing.kind === 'device' && wrap.kind === 'device' && existing.rpId === wrap.rpId;

  return { ...vault, wraps: [...vault.wraps.filter((existing) => !superseded(existing)), wrap] };
}
