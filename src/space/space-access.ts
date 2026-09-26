/**
 * @module space-access
 * What a space is, fixed at creation — and the keys around it that anyone can
 * check without holding a secret.
 *
 * The space's **genesis** names its creator, its visibility, the roles it
 * starts with and which of them the creator holds, and — for a private space —
 * the public half of its read key. The space id is the genesis's hash. A space
 * someone hands you — in an invite, from a host — either hashes to its id or
 * is refused, so nobody can quietly change who started it or with which roles.
 * Everything after that — new roles, members, invites — is records in the
 * space's access history (`space/roles.ts`).
 *
 * A private space's **read key pair** is derived from its AES key, so everyone
 * who can read already has it. A node checks a connecting reader against its
 * public half — without the space key.
 *
 * An **invite link** carries a random secret. Its public half is written into
 * the space as an invite record, for one role. Whoever holds the secret joins
 * by writing their own member record, signed a second time by the secret over
 * the space and their identity — so the signature cannot be moved to anyone
 * else, or another space. Deleting the invite record closes the link.
 */
import type { CryptoProvider, Space } from '../types.js';
import type { SpaceKey } from '../privacy/space-encryption.js';
import { canonicalize } from '../schema/expression.js';
import { cidFromBytes, sha256 } from '../utils/hash.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../utils/encoding.js';
import { publicKeyToDid, didToPublicKey, P256_MULTICODEC } from '../identity/did.js';
import { checkRole } from './roles.js';

const READ_INFO = 'weave/space-read/v1';
const INVITE_INFO = 'weave/space-invite/v1';

/** A key pair belonging to a space, and its public half as a did:key */
export interface SpaceKeyPair {
  readonly did: string;
  readonly privateKey: CryptoKey;
}

/** What a space is, fixed at creation. Its hash is the space id. */
export interface SpaceGenesis {
  readonly v: 2;
  readonly creator: string;
  readonly visibility: Space['visibility'];
  readonly roles: Space['roles'];
  readonly creatorRole: string;
  readonly createdAt: string;
  readonly nonce: string;
  readonly readKey?: string;
  readonly encryptionKeyId?: string;
}

/** A fresh secret for an invite link */
export function generateInviteSecret(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

async function expand(secret: Uint8Array, info: string): Promise<Uint8Array> {
  const material = await globalThis.crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Encode(info) as BufferSource },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * A key pair from a secret, for one purpose. The secret is expanded under its
 * own label first, so no two uses of one secret — nor an account seed that
 * happened to equal it — ever give the same key.
 */
async function derivePair(secret: Uint8Array, info: string, provider: CryptoProvider): Promise<SpaceKeyPair> {
  const pair = await provider.deriveKeyPairFromSeed(await expand(secret, info));
  const did = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  return Object.freeze({ did, privateKey: pair.privateKey });
}

/** The key pair an invite link's secret stands for */
export function deriveInviteKey(secret: Uint8Array, provider: CryptoProvider): Promise<SpaceKeyPair> {
  return derivePair(secret, INVITE_INFO, provider);
}

/** The read key pair of a private space, from its AES key */
export async function deriveReadKey(spaceKey: SpaceKey, provider: CryptoProvider): Promise<SpaceKeyPair> {
  return readKeyFromSeed(await deriveReadSeed(spaceKey), provider);
}

/**
 * What the read key pair is made from — one way from the space key, so
 * holding it proves you may read without letting you decrypt anything. It is
 * what a pass hands a node that carries a space it cannot read (`space/pass.ts`).
 */
export async function deriveReadSeed(spaceKey: SpaceKey): Promise<Uint8Array> {
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', spaceKey.key));
  return expand(raw, READ_INFO);
}

/** The read key pair, from its seed */
export async function readKeyFromSeed(seed: Uint8Array, provider: CryptoProvider): Promise<SpaceKeyPair> {
  const pair = await provider.deriveKeyPairFromSeed(seed);
  const did = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  return Object.freeze({ did, privateKey: pair.privateKey });
}

/** The fields of a space its id is made from */
export function spaceGenesis(space: Omit<Space, 'id' | 'name'>): SpaceGenesis {
  return {
    v: 2,
    creator: space.creator,
    visibility: space.visibility,
    roles: space.roles,
    creatorRole: space.creatorRole,
    createdAt: space.createdAt,
    nonce: space.nonce,
    ...(space.readKey ? { readKey: space.readKey } : {}),
    ...(space.encryptionKeyId ? { encryptionKeyId: space.encryptionKeyId } : {}),
  };
}

/** The id a space with this genesis has */
export function spaceIdOf(genesis: SpaceGenesis): Promise<string> {
  return cidFromBytes(utf8Encode(canonicalize(genesis)));
}

/** Why a set of starting roles cannot found a space, or null */
export function checkStartingRoles(roles: unknown, creatorRole: unknown): string | null {
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > 64) return 'A space starts with 1–64 roles';
  for (const role of roles) {
    const problem = checkRole(role);
    if (problem) return problem;
  }
  if (new Set(roles.map((role: { name: string }) => role.name)).size !== roles.length) return 'Two starting roles share a name';
  if (!roles.some((role: { name: string }) => role.name === creatorRole)) return 'The creator\'s role is not one of the starting roles';
  return null;
}

/**
 * Why a space someone handed over cannot be trusted, or null when it can:
 * its id must be its genesis's hash, and it must have the keys its kind needs.
 */
export async function checkSpace(space: Space): Promise<string | null> {
  if (typeof space?.id !== 'string' || typeof space.nonce !== 'string' || typeof space.creator !== 'string') {
    return 'It is missing what identifies it';
  }
  if (space.visibility !== 'public' && space.visibility !== 'private') return 'Its visibility is not public or private';
  const roles = checkStartingRoles(space.roles, space.creatorRole);
  if (roles) return roles;
  if (space.visibility === 'private' && (!space.readKey || !space.encryptionKeyId)) return 'A private space must name its read key';
  if (space.visibility === 'public' && (space.readKey || space.encryptionKeyId)) return 'A public space has no read key';
  if ((await spaceIdOf(spaceGenesis(space))) !== space.id) return 'Its id does not match what it says about itself';
  return null;
}

// ─── Record keys in the access history ────────────────────────────────
//
// Record keys are lower case; DIDs and CIDs are not. So a key names a hash of
// the thing, and the record's body names the thing itself.

async function hashKey(prefix: string, value: string): Promise<string> {
  const digest = await sha256(utf8Encode(value));
  return `${prefix}:${Array.from(digest.subarray(0, 20), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The key of an account's member record */
export const memberKey = (did: string) => hashKey('member', did);
/** The key of an invite's record, from its public key */
export const inviteKey = (inviteDid: string) => hashKey('invite', inviteDid);
/** The key of the record revoking a note, from the note's CID */
export const revokeKey = (noteCid: string) => hashKey('revoke', noteCid);
/** The key of a role's record */
export const roleKey = (name: string) => `role:${name}`;
/**
 * Where each member says, in the clear, which member key a new space key
 * should be sealed to: `{ key }`, one record per account. In the clear so
 * someone holding only an older key of the space can still write it.
 */
export const MEMBER_KEY_COLLECTION = 'sys.memberkey';
/** The key of an account's member key record */
export const memberKeyRecordKey = (did: string) => hashKey('memberkey', did);
/** Where the sealed copies of a changed space key live, one per member: `{ keyId, to, sealed }` */
export const BOX_COLLECTION = 'sys.box';
/** What the earlier keys a key record carries are bound to */
export const earlierKeysContext = (spaceId: string, keyId: string) => `weave/space-earlier-keys/v1|${spaceId}|${keyId}`;
/** What a reader's note, sealed for a connection, is bound to (`network/peer-auth.ts`) */
export const membershipContext = (spaceId: string) => `weave/space-membership/v1|${spaceId}`;
/** The one record key the space's relay list is a version of */
export const SPACE_RELAYS_RECORD = 'relays:space';
/** The one record key the space's list of keepers is a version of */
export const SPACE_KEEPERS_RECORD = 'keepers:space';
/** The one record key every change of a private space's key is a version of — so two made apart are rivals, and one wins */
export const SPACE_KEY_RECORD = 'key:space';
/** The key of a sealed copy of a space key: one per key, recipient and sender */
export const boxKey = (keyId: string, to: string, from: string) => hashKey('box', `${keyId}|${to}|${from}`);
/** What a box is bound to, so one moved to another space, key or person doesn't open */
export const boxContext = (spaceId: string, keyId: string, to: string) => `weave/space-key-box/v1|${spaceId}|${keyId}|${to}`;

const inviteLabel = (spaceId: string, did: string) => utf8Encode(`${INVITE_INFO}|${spaceId}|${did}`);

/** An invite key's signature, letting `did` join `spaceId` — what a member record carries when it joins by invite */
export async function signInvite(spaceId: string, did: string, invite: SpaceKeyPair, provider: CryptoProvider): Promise<string> {
  return base64UrlEncode(await provider.sign(invite.privateKey, inviteLabel(spaceId, did)));
}

/** Whether an invite key signed for `did` to join `spaceId` */
export async function verifyInvite(spaceId: string, did: string, inviteDid: string, signature: string, provider: CryptoProvider): Promise<boolean> {
  try {
    const publicKey = await provider.importPublicKey(didToPublicKey(inviteDid).publicKeyBytes);
    return await provider.verify(publicKey, base64UrlDecode(signature), inviteLabel(spaceId, did));
  } catch {
    return false;
  }
}
