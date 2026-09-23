/**
 * @module space-access
 * Who may write in a space, and who may read it — checkable by anyone,
 * without a secret.
 *
 * A shared space has a **write secret**: 32 random bytes, handed out with a
 * full invite. It becomes a key pair, and every record written in the space
 * carries a second signature by it, over the record's id. The public half is
 * part of the space, so any peer, relay, mirror or host can check "the writer
 * was given the write key" while holding nothing secret itself.
 *
 * A private space also has a **read key pair**, derived from its AES key, so
 * everyone who can read already has it. A node checks a connecting reader
 * against its public half — again, without the space key.
 *
 * Both public halves are in the space's **genesis**, and the space id is the
 * genesis's hash. A space someone hands you — in an invite, from a host —
 * either hashes to its id or is refused, so nobody can quietly change who owns
 * it, whether it is shared, or which key writes to it.
 *
 * Two choices worth knowing:
 *
 * - **The write secret is random, not derived from the AES key.** A public
 *   shared space has no AES key, and a view-only invite must carry the AES
 *   key without granting writes.
 * - **Every record is countersigned, rather than each member holding a grant
 *   signed once by the write key.** A grant would save a signature per record,
 *   but adds a new kind of thing to issue, store and carry — and a joiner would
 *   sign their own anyway, holding the key. One signature over the id keeps
 *   the verdict a matter of one record and the space, like every other rule.
 */
import type { CryptoProvider, Expression, Space } from '../types.js';
import type { SpaceKey } from '../privacy/space-encryption.js';
import { canonicalize } from '../schema/expression.js';
import { cidFromBytes } from '../utils/hash.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../utils/encoding.js';
import { publicKeyToDid, didToPublicKey, P256_MULTICODEC } from '../identity/did.js';

const WRITE_INFO = 'weave/space-write/v1';
const READ_INFO = 'weave/space-read/v1';

/** A key pair belonging to a space, and its public half as a did:key */
export interface SpaceKeyPair {
  readonly did: string;
  readonly privateKey: CryptoKey;
}

/** What a space is, fixed at creation. Its hash is the space id. */
export interface SpaceGenesis {
  readonly v: 1;
  readonly owner: string;
  readonly type: Space['type'];
  readonly visibility: Space['visibility'];
  readonly createdAt: string;
  readonly nonce: string;
  readonly writeKey?: string;
  readonly readKey?: string;
  readonly encryptionKeyId?: string;
}

/** A fresh write secret for a new shared space */
export function generateWriteSecret(): Uint8Array {
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

/** The write key pair a write secret stands for */
export function deriveWriteKey(writeSecret: Uint8Array, provider: CryptoProvider): Promise<SpaceKeyPair> {
  return derivePair(writeSecret, WRITE_INFO, provider);
}

/** The read key pair of a private space, from its AES key */
export async function deriveReadKey(spaceKey: SpaceKey, provider: CryptoProvider): Promise<SpaceKeyPair> {
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', spaceKey.key));
  return derivePair(raw, READ_INFO, provider);
}

/** The fields of a space its id is made from */
export function spaceGenesis(space: Omit<Space, 'id' | 'name' | 'members'>): SpaceGenesis {
  return {
    v: 1,
    owner: space.owner,
    type: space.type,
    visibility: space.visibility,
    createdAt: space.createdAt,
    nonce: space.nonce,
    ...(space.writeKey ? { writeKey: space.writeKey } : {}),
    ...(space.readKey ? { readKey: space.readKey } : {}),
    ...(space.encryptionKeyId ? { encryptionKeyId: space.encryptionKeyId } : {}),
  };
}

/** The id a space with this genesis has */
export function spaceIdOf(genesis: SpaceGenesis): Promise<string> {
  return cidFromBytes(utf8Encode(canonicalize(genesis)));
}

/**
 * Why a space someone handed over cannot be trusted, or null when it can:
 * its id must be its genesis's hash, and it must have the keys its kind needs.
 */
export async function checkSpace(space: Space): Promise<string | null> {
  if (typeof space?.id !== 'string' || typeof space.nonce !== 'string' || typeof space.owner !== 'string') {
    return 'It is missing what identifies it';
  }
  if (space.type !== 'personal' && space.type !== 'shared') return 'Its type is not personal or shared';
  if (space.visibility !== 'public' && space.visibility !== 'private') return 'Its visibility is not public or private';
  if (space.type === 'shared' && !space.writeKey) return 'A shared space must name its write key';
  if (space.type === 'personal' && space.writeKey) return 'A personal space has no write key — only its owner writes';
  if (space.visibility === 'private' && (!space.readKey || !space.encryptionKeyId)) return 'A private space must name its read key';
  if (space.visibility === 'public' && (space.readKey || space.encryptionKeyId)) return 'A public space has no read key';
  if ((await spaceIdOf(spaceGenesis(space))) !== space.id) return 'Its id does not match what it says about itself';
  return null;
}

const countersignLabel = (id: string) => utf8Encode(`${WRITE_INFO}|${id}`);

/** The write key's signature over a record's id — what `spaceSignature` holds */
export async function countersign(id: string, writeKey: SpaceKeyPair, provider: CryptoProvider): Promise<string> {
  return base64UrlEncode(await provider.sign(writeKey.privateKey, countersignLabel(id)));
}

/**
 * Whether a record carries a valid signature by the space's write key.
 * @param expression The record; its id is trusted to match its content only once the crypto gate has said so
 * @param writeKey The space's public write key, from its genesis
 */
export async function verifyCountersignature(expression: Expression, writeKey: string, provider: CryptoProvider): Promise<boolean> {
  if (typeof expression.spaceSignature !== 'string') return false;
  try {
    const publicKey = await provider.importPublicKey(didToPublicKey(writeKey).publicKeyBytes);
    return await provider.verify(publicKey, base64UrlDecode(expression.spaceSignature), countersignLabel(expression.id));
  } catch {
    return false;
  }
}
