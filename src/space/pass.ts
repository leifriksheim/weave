/**
 * @module space/pass
 * What a node needs to carry a space it cannot read.
 *
 * A carrier — a browser extension keeping your spaces online, later a host —
 * stores a space's records, checks them the way every peer does, and passes
 * them on. For that it needs two things, and must get nothing more:
 *
 * - **the space itself** (its genesis), which hashes to its id, so the carrier
 *   runs the same gates as any member;
 * - **in a private space, the read key pair's seed**, because every peer must
 *   prove it may read before anything moves (`network/peer-auth.ts`). The read
 *   key only signs that proof. It is derived one way from the space key and
 *   decrypts nothing.
 *
 * No space key, no write secret, no note. A stolen pass lets someone download
 * the space's encrypted records and their outer details — author, collection,
 * times — which is what a blind host or a mirror's provider sees anyway.
 *
 * Passes travel in a **carry space**: a private space the account shares with
 * one carrier, holding one pass record per space it should carry. Every node
 * holding the account key keeps those records in step with the account's
 * spaces (`node.ts`), so a space made in an app is carried without the home
 * being opened.
 */
import type { CryptoProvider, Space } from '../types.js';
import type { SpaceRecord } from './space-manager.js';
import { checkSpace, deriveReadSeed, readKeyFromSeed, type SpaceKeyPair } from './space-access.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../utils/encoding.js';
import { sha256 } from '../utils/hash.js';
import { createP256Provider } from '../identity/crypto-p256.js';

/** Where passes live in a carry space */
export const PASS_COLLECTION = 'sys.pass';

/**
 * Written into a carry space when the account stops using the carrier. A
 * carrier that reads it forgets everything it held.
 */
export const CARRY_CLOSED_KEY = 'carry:closed';

/** A pass, as stored */
export interface SpacePass {
  readonly v: 1;
  readonly space: Space;
  /** A private space's read key seed, base64url. Absent for a public space. */
  readonly read?: string;
  /**
   * The public half of that read key, once the space's key has changed since
   * it began. Then the space itself can't vouch for it — the space's history
   * does, and a read key it doesn't name gets the carrier nowhere.
   */
  readonly readKey?: string;
}

/** A pass, checked and ready to open a space with */
export interface OpenedPass {
  readonly space: Space;
  readonly read: SpaceKeyPair | null;
}

/** The record key of a space's pass */
export async function passKey(spaceId: string): Promise<string> {
  const digest = await sha256(utf8Encode(spaceId));
  return `pass:${Array.from(digest.subarray(0, 20), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A pass for a space this node holds with its key.
 * @throws For a private space held without its key: there is nothing to pass on
 */
export async function makePass(record: SpaceRecord): Promise<SpacePass> {
  if (record.space.visibility === 'public') return { v: 1, space: record.space };
  if (!record.key) throw new Error(`"${record.space.name}" is held here without its key, so it cannot be passed on`);
  const seed = await deriveReadSeed(record.key);
  const pass: SpacePass = { v: 1, space: record.space, read: base64UrlEncode(seed) };
  return record.key.id === record.space.encryptionKeyId ? pass : { ...pass, readKey: (await readKeyFromSeed(seed, createP256Provider())).did };
}

/**
 * Checks a pass someone handed over: the space must hash to its id, and the
 * read key must be the one the space names.
 * @returns The space and its read key pair, or null when the pass does not check out
 */
export async function openPass(value: unknown, provider: CryptoProvider): Promise<OpenedPass | null> {
  const pass = value as Partial<SpacePass> | null;
  if (!pass || pass.v !== 1 || !pass.space) return null;
  if ((await checkSpace(pass.space)) !== null) return null;
  if (pass.space.visibility === 'public') return { space: pass.space, read: null };
  if (typeof pass.read !== 'string') return null;
  try {
    const read = await readKeyFromSeed(base64UrlDecode(pass.read), provider);
    return read.did === pass.space.readKey || (pass.readKey !== undefined && read.did === pass.readKey) ? { space: pass.space, read } : null;
  } catch {
    return null;
  }
}

/** A record for opening a space from a pass: no key, no invite, no role */
export function carriedRecord(pass: OpenedPass): SpaceRecord {
  return { space: pass.space, key: null, invite: null, role: null, read: pass.read };
}
