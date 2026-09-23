/**
 * @module space-manager
 * Spaces — the cryptographic containers everything else lives in.
 *
 * A space is `personal` or `shared` (who writes to it) and independently
 * `public` or `private` (whether bodies are encrypted). Both are fixed at
 * creation and identical for every member: an invite to a personal space lets
 * someone follow it, not write to it. A private one stays readable only to
 * whoever holds its key.
 */

import type { CryptoProvider, Space, SpaceType, SpaceVisibility, StorageAdapter } from '../types.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import {
  base64UrlEncode,
  base64UrlDecode,
  utf8Encode,
  utf8Decode,
} from '../utils/encoding.js';
import { generateSpaceKey, type SpaceKey } from '../privacy/space-encryption.js';
import { checkSpace, deriveReadKey, deriveWriteKey, generateWriteSecret, spaceGenesis, spaceIdOf } from './space-access.js';

/** A space plus the secrets this node holds for it */
export interface SpaceRecord {
  readonly space: Space;
  /** The AES key that reads a private space */
  readonly key: SpaceKey | null;
  /** The secret that lets this node write in a shared space. Null for a personal one, or a view-only invite. */
  readonly writeSecret: Uint8Array | null;
}

export interface CreateSpaceParams {
  readonly name: string;
  readonly type: SpaceType;
  readonly visibility: SpaceVisibility;
  readonly owner: string;
}

/** What an invite carries: enough to join, to read if it is private, and to write if it says so */
export interface SpaceInvite {
  readonly space: Space;
  /** Raw AES key material, base64url — present only for private spaces */
  readonly key?: string;
  /** The write secret, base64url — present in a shared space's full invite, absent in a view-only one */
  readonly write?: string;
  readonly invitedBy: string;
}

export interface InviteOptions {
  /** Include the write secret, when this node has it. Default true; false makes a view-only invite. */
  readonly write?: boolean;
}

export interface SpaceManager {
  create(params: CreateSpaceParams): Promise<SpaceRecord>;
  get(spaceId: string): Promise<SpaceRecord | null>;
  list(): Promise<ReadonlyArray<SpaceRecord>>;
  remove(spaceId: string): Promise<void>;
  /** Adds a member to a shared space, locally */
  addMember(spaceId: string, did: string): Promise<SpaceRecord>;
  /** Encodes a space (and its key, if private, and its write secret, unless asked not to) as a shareable string */
  createInvite(spaceId: string, invitedBy: string, options?: InviteOptions): Promise<string>;
  /**
   * Stores a space received as an invite, so it can be opened and synced.
   * Refuses a space whose id does not match what it says about itself, and
   * keys that do not belong to it. Joining again with more (a full invite
   * after a view-only one) adds it; with less, keeps what is held.
   */
  join(invite: string, joiner: string): Promise<SpaceRecord>;
}

const SPACE_PREFIX = 'space:';
const KEY_PREFIX = 'spacekey:';
const WRITE_PREFIX = 'spacewrite:';

/** Stored form of a space key: raw bytes plus the metadata that travels with it. */
interface StoredKey {
  readonly id: string;
  readonly raw: string;
  readonly createdAt: string;
  readonly version: number;
}

async function exportKey(key: SpaceKey): Promise<StoredKey> {
  const raw = await globalThis.crypto.subtle.exportKey('raw', key.key);
  return {
    id: key.id,
    raw: base64UrlEncode(new Uint8Array(raw)),
    createdAt: key.createdAt,
    version: key.version,
  };
}

async function importKey(stored: StoredKey): Promise<SpaceKey> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    base64UrlDecode(stored.raw) as BufferSource,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  return Object.freeze({ id: stored.id, key, createdAt: stored.createdAt, version: stored.version });
}

/**
 * Creates a space manager backed by a storage adapter.
 * @param adapter Where spaces and their keys are kept
 * @returns The space manager
 */
export function createSpaceManager(adapter: StorageAdapter, provider: CryptoProvider = createP256Provider()): SpaceManager {
  async function readSpace(spaceId: string): Promise<Space | null> {
    const bytes = await adapter.get(`${SPACE_PREFIX}${spaceId}`);
    return bytes ? (JSON.parse(utf8Decode(bytes)) as Space) : null;
  }

  async function writeSpace(space: Space): Promise<void> {
    await adapter.put(`${SPACE_PREFIX}${space.id}`, utf8Encode(JSON.stringify(space)));
  }

  async function readKey(spaceId: string): Promise<SpaceKey | null> {
    const bytes = await adapter.get(`${KEY_PREFIX}${spaceId}`);
    if (!bytes) return null;
    return importKey(JSON.parse(utf8Decode(bytes)) as StoredKey);
  }

  async function writeKey(spaceId: string, key: SpaceKey): Promise<void> {
    const stored = await exportKey(key);
    await adapter.put(`${KEY_PREFIX}${spaceId}`, utf8Encode(JSON.stringify(stored)));
  }

  async function readWriteSecret(spaceId: string): Promise<Uint8Array | null> {
    const bytes = await adapter.get(`${WRITE_PREFIX}${spaceId}`);
    return bytes ? base64UrlDecode(utf8Decode(bytes)) : null;
  }

  async function writeWriteSecret(spaceId: string, secret: Uint8Array): Promise<void> {
    await adapter.put(`${WRITE_PREFIX}${spaceId}`, utf8Encode(base64UrlEncode(secret)));
  }

  async function load(spaceId: string): Promise<SpaceRecord | null> {
    const space = await readSpace(spaceId);
    if (!space) return null;
    return { space, key: await readKey(spaceId), writeSecret: await readWriteSecret(spaceId) };
  }

  return Object.freeze({
    async create(params: CreateSpaceParams): Promise<SpaceRecord> {
      const createdAt = new Date().toISOString();
      // A nonce keeps two spaces made alike from colliding on one id.
      const nonce = base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(12)));

      const key = params.visibility === 'private' ? await generateSpaceKey() : null;
      const writeSecret = params.type === 'shared' ? generateWriteSecret() : null;

      const fixed = {
        type: params.type,
        visibility: params.visibility,
        owner: params.owner,
        createdAt,
        nonce,
        ...(writeSecret ? { writeKey: (await deriveWriteKey(writeSecret, provider)).did } : {}),
        ...(key ? { readKey: (await deriveReadKey(key, provider)).did, encryptionKeyId: key.id } : {}),
      };
      const id = await spaceIdOf(spaceGenesis(fixed));

      const space: Space = Object.freeze({
        id,
        ...fixed,
        name: params.name,
        members: Object.freeze([params.owner]),
      });

      await writeSpace(space);
      if (key) await writeKey(id, key);
      if (writeSecret) await writeWriteSecret(id, writeSecret);

      return { space, key, writeSecret };
    },

    async get(spaceId: string): Promise<SpaceRecord | null> {
      return load(spaceId);
    },

    async list(): Promise<ReadonlyArray<SpaceRecord>> {
      const keys = await adapter.list(SPACE_PREFIX);
      const records = await Promise.all(keys.map((key) => load(key.slice(SPACE_PREFIX.length))));
      return records
        .filter((record): record is SpaceRecord => record !== null)
        .sort((a, b) => a.space.createdAt.localeCompare(b.space.createdAt));
    },

    async remove(spaceId: string): Promise<void> {
      await adapter.delete(`${SPACE_PREFIX}${spaceId}`);
      await adapter.delete(`${KEY_PREFIX}${spaceId}`);
      await adapter.delete(`${WRITE_PREFIX}${spaceId}`);
    },

    async addMember(spaceId: string, did: string): Promise<SpaceRecord> {
      const record = await load(spaceId);
      if (!record) throw new Error(`Unknown space: ${spaceId}`);
      if (record.space.members.includes(did)) return record;

      const space: Space = Object.freeze({
        ...record.space,
        members: Object.freeze([...record.space.members, did]),
      });
      await writeSpace(space);
      return { ...record, space };
    },

    async createInvite(spaceId: string, invitedBy: string, options: InviteOptions = {}): Promise<string> {
      const record = await load(spaceId);
      if (!record) throw new Error(`Unknown space: ${spaceId}`);

      // The key rides along for private spaces — which is why an invite is a
      // secret, and why it belongs in a URL fragment rather than a path.
      const invite: SpaceInvite = {
        space: record.space,
        invitedBy,
        ...(record.key ? { key: (await exportKey(record.key)).raw } : {}),
        ...(record.writeSecret && options.write !== false ? { write: base64UrlEncode(record.writeSecret) } : {}),
      };

      return base64UrlEncode(utf8Encode(JSON.stringify(invite)));
    },

    async join(invite: string, joiner: string): Promise<SpaceRecord> {
      const parsed = parseSpaceInvite(invite);

      // Whoever made the invite could have edited it. The space must hash to
      // its id, and each key must be the one the space names.
      const problem = await checkSpace(parsed.space);
      if (problem) throw new Error(`That invite does not describe a real space: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}.`);
      const key = parsed.key
        ? await importKey({ id: parsed.space.encryptionKeyId ?? '', raw: parsed.key, createdAt: parsed.space.createdAt, version: 1 })
        : null;
      if (key && (await deriveReadKey(key, provider)).did !== parsed.space.readKey) {
        throw new Error('That invite carries a key that does not belong to its space.');
      }
      const writeSecret = parsed.write ? base64UrlDecode(parsed.write) : null;
      if (writeSecret && (await deriveWriteKey(writeSecret, provider)).did !== parsed.space.writeKey) {
        throw new Error('That invite carries a write key that does not belong to its space.');
      }

      const existing = await readSpace(parsed.space.id);
      const members = new Set([...(existing?.members ?? parsed.space.members), joiner]);

      const space: Space = Object.freeze({
        ...parsed.space,
        // The type is part of the space, not of anyone's copy of it. Every
        // member's gate has to agree on who may write, or one copy keeps a
        // record another rejects and the two never converge. Joining a
        // personal space means following it; collaborating needs a shared one.
        members: Object.freeze([...members]),
      });

      await writeSpace(space);
      if (key) await writeKey(space.id, key);
      if (writeSecret) await writeWriteSecret(space.id, writeSecret);

      return (await load(space.id))!;
    },
  });
}

/**
 * Decodes an invite without touching storage.
 * @param invite The encoded invite string
 * @returns The space it describes, and its key when private
 */
export function parseSpaceInvite(invite: string): SpaceInvite {
  try {
    const parsed = JSON.parse(utf8Decode(base64UrlDecode(invite.trim()))) as SpaceInvite;
    if (!parsed?.space?.id || !parsed.space.name) {
      throw new Error('missing space');
    }
    return parsed;
  } catch {
    throw new Error('That invite could not be read — it may be truncated or from another app.');
  }
}
