/**
 * @module account-registry
 * The account's own list of spaces, kept in a space.
 *
 * Without it, which spaces an account belongs to lives on each device alone: a
 * new phone, a new app or an always-on node has to be handed every invite. With
 * it, joining a space on one device writes a membership record into a private
 * space only the account can find, and every other device and node of the
 * account syncs that record and joins by itself.
 *
 * The registry's key and nonce are derived from the account's vault key, and
 * its id is the hash of its genesis like any space's — so nothing needs to be
 * exchanged to find it, and nobody without the account can. The DID alone is
 * not enough: it appears in everything the account signs, and a room named
 * after it could be found by anyone who had seen its data.
 */
import type { CryptoProvider, Space } from '../types.js';
import type { SpaceRecord } from './space-manager.js';
import type { SpaceKey } from '../privacy/space-encryption.js';
import { base64UrlEncode, utf8Encode } from '../utils/encoding.js';
import { sha256 } from '../utils/hash.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { deriveReadKey, spaceGenesis, spaceIdOf } from './space-access.js';

/** Where membership records live, one per space the account belongs to */
export const MEMBERSHIP_COLLECTION = 'sys.membership';

/**
 * The account's profile — what it is called — so a rename on one device or app
 * reaches the others. The newest record wins.
 */
export const PROFILE_COLLECTION = 'sys.profile';

/** The profile's record key — there is one profile per account */
export const PROFILE_KEY = 'profile';

export interface AccountProfile {
  readonly name: string;
}

/** A membership record's body. The invite carries a private space's key — the registry is encrypted. */
export interface Membership {
  readonly space: string;
  readonly invite: string;
}

async function expand(accountKey: Uint8Array, info: string): Promise<Uint8Array> {
  const material = await globalThis.crypto.subtle.importKey('raw', accountKey as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Encode(info) as BufferSource },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * The account's registry space, derived — the same on every device.
 * @param accountKey The account's vault key bytes (`deriveVaultKeyBytes(seed)`)
 * @param owner The account's DID
 */
export async function deriveAccountRegistry(
  accountKey: Uint8Array,
  owner: string,
  provider: CryptoProvider = createP256Provider(),
): Promise<SpaceRecord> {
  const nonce = base64UrlEncode((await expand(accountKey, 'weave/account-registry/nonce/v1')).subarray(0, 12));
  const keyBytes = await expand(accountKey, 'weave/account-registry/key/v1');
  const cryptoKey = await globalThis.crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const createdAt = new Date(0).toISOString(); // fixed, so every device derives the same record
  const key: SpaceKey = Object.freeze({
    id: base64UrlEncode(await sha256(keyBytes)),
    key: cryptoKey,
    createdAt,
    version: 1,
  });
  const fixed = {
    type: 'personal' as const,
    visibility: 'private' as const,
    owner,
    createdAt,
    nonce,
    readKey: (await deriveReadKey(key, provider)).did,
    encryptionKeyId: key.id,
  };
  const space: Space = Object.freeze({
    id: await spaceIdOf(spaceGenesis(fixed)),
    ...fixed,
    name: 'Account registry',
    members: Object.freeze([owner]),
  });
  return { space, key, writeSecret: null };
}
