/**
 * @module space-manager
 * Spaces — the cryptographic containers everything else lives in — as this
 * node holds them: the space, its key if it is private, and anything waiting
 * to be done with it.
 *
 * A space is `public` or `private` (whether bodies are encrypted), fixed at
 * creation. Who may write is not a property of the space but of its access
 * history: roles and members, as records in it (`space/roles.ts`).
 */

import type { CryptoProvider, Space, SpaceRole, SpaceVisibility, StorageAdapter } from '../types.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { base64UrlEncode, base64UrlDecode, utf8Encode, utf8Decode } from '../utils/encoding.js';
import { generateSpaceKey, spaceKeyFromRaw, type SpaceKey } from '../privacy/space-encryption.js';
import { checkSpace, checkStartingRoles, deriveInviteKey, deriveReadKey, spaceGenesis, spaceIdOf, type SpaceKeyPair } from './space-access.js';
import { solo } from './presets.js';
import { checkRelays } from './roles.js';

/** A space plus the secrets this node holds for it */
export interface SpaceRecord {
  readonly space: Space;
  /** The AES key this node reads and writes a private space with: the newest it holds */
  readonly key: SpaceKey | null;
  /**
   * Every key of the space this node holds, the current one included. A
   * private space's key changes when someone is removed (`sys.key`); records
   * written before keep the key they were written with.
   */
  readonly keys?: ReadonlyArray<SpaceKey>;
  /**
   * This account's member key for the space, for a node given it without the
   * account key (`deriveMemberKeyBytes`) — what a new space key is sealed to.
   */
  readonly memberKey?: Uint8Array | null;
  /**
   * Where the space's members meet, as this node last heard: from the invite
   * that brought it here, then from the space itself (`sys.relays`).
   */
  readonly relays?: ReadonlyArray<string>;
  /**
   * An invite link's secret, held until this account's member record is
   * written with it — which needs the invite's own record to have arrived.
   * Null once joined, or for a view-only invite.
   */
  readonly invite: Uint8Array | null;
  /** The role this account last held here, as the space's access history said — a hint for listing, not a gate */
  readonly role: string | null;
  /**
   * The read key pair, for a node that carries a private space without its
   * key (`space/pass.ts`). With the key it is derived from that instead.
   */
  readonly read?: SpaceKeyPair | null;
}

export interface CreateSpaceParams {
  readonly name: string;
  readonly visibility: SpaceVisibility;
  readonly creator: string;
  /** The roles it starts with. Default: the creator alone, holding everything (`presets.solo`). */
  readonly roles?: ReadonlyArray<SpaceRole>;
  readonly creatorRole?: string;
}

/** What an invite carries: enough to find the space, to read it if it is private, and to join it if it says so */
export interface SpaceInvite {
  readonly space: Space;
  /** Raw AES key material, base64url — present only for private spaces */
  readonly key?: string;
  /** The invite link's secret, base64url — absent in a view-only invite */
  readonly invite?: string;
  /** The role the invite is for, for showing before joining. The space's own record is what counts. */
  readonly role?: string;
  readonly invitedBy: string;
  /** Where the space's members meet — a hint for reaching it before its own list has synced */
  readonly relays?: ReadonlyArray<string>;
}

export interface InviteOptions {
  /** The secret behind an invite record already written for a role. Absent: a view-only invite. */
  readonly secret?: Uint8Array;
  readonly role?: string;
  /** Relays to name in it. Default: the ones this node holds for the space. */
  readonly relays?: ReadonlyArray<string>;
}

export interface SpaceManager {
  create(params: CreateSpaceParams): Promise<SpaceRecord>;
  get(spaceId: string): Promise<SpaceRecord | null>;
  list(): Promise<ReadonlyArray<SpaceRecord>>;
  remove(spaceId: string): Promise<void>;
  /** Encodes a space, its key if private, and an invite's secret if given, as a shareable string */
  createInvite(spaceId: string, invitedBy: string, options?: InviteOptions): Promise<string>;
  /**
   * Stores a space received as an invite, so it can be opened and synced.
   * Refuses a space whose id does not match what it says about itself, and
   * a key that does not belong to it. An invite's secret is held until it is used.
   */
  join(invite: string): Promise<SpaceRecord>;
  /** Forgets an invite's secret once it has been used */
  clearInvite(spaceId: string): Promise<void>;
  /** Remembers the role this account holds, for listing */
  setRole(spaceId: string, role: string | null): Promise<void>;
  /**
   * Adds keys of a space to what this node holds, and makes `current` the
   * one it writes with. Keys already held are kept.
   */
  addKeys(spaceId: string, keys: ReadonlyArray<SpaceKey>, current: string): Promise<void>;
  /** Keeps this account's member key for a space (`SpaceRecord.memberKey`) */
  setMemberKey(spaceId: string, memberKey: Uint8Array): Promise<void>;
  /** Keeps where the space's members meet (`SpaceRecord.relays`) */
  setRelays(spaceId: string, relays: ReadonlyArray<string>): Promise<void>;
}

const SPACE_PREFIX = 'space:';
const KEY_PREFIX = 'spacekey:';
const INVITE_PREFIX = 'spaceinvite:';
const ROLE_PREFIX = 'spacerole:';
const MEMBER_KEY_PREFIX = 'spacememberkey:';
const RELAYS_PREFIX = 'spacerelays:';

/** How a space's keys are kept: every one held, and which is current */
interface StoredKeyring {
  readonly keys: ReadonlyArray<StoredKey>;
  readonly current: string;
}

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

  async function readKeyring(spaceId: string): Promise<{ key: SpaceKey | null; keys: SpaceKey[] }> {
    const bytes = await adapter.get(`${KEY_PREFIX}${spaceId}`);
    if (!bytes) return { key: null, keys: [] };
    const stored = JSON.parse(utf8Decode(bytes)) as StoredKeyring;
    const keys = await Promise.all(stored.keys.map(importKey));
    return { key: keys.find((key) => key.id === stored.current) ?? keys.at(-1) ?? null, keys };
  }

  async function writeKeyring(spaceId: string, keys: ReadonlyArray<SpaceKey>, current: string): Promise<void> {
    const stored: StoredKeyring = { keys: await Promise.all(keys.map(exportKey)), current };
    await adapter.put(`${KEY_PREFIX}${spaceId}`, utf8Encode(JSON.stringify(stored)));
  }

  async function writeKey(spaceId: string, key: SpaceKey): Promise<void> {
    const { keys } = await readKeyring(spaceId);
    await writeKeyring(spaceId, [...keys.filter((held) => held.id !== key.id), key], key.id);
  }

  async function readText(prefix: string, spaceId: string): Promise<string | null> {
    const bytes = await adapter.get(`${prefix}${spaceId}`);
    return bytes ? utf8Decode(bytes) : null;
  }

  async function load(spaceId: string): Promise<SpaceRecord | null> {
    const space = await readSpace(spaceId);
    if (!space) return null;
    const invite = await readText(INVITE_PREFIX, spaceId);
    const memberKey = await readText(MEMBER_KEY_PREFIX, spaceId);
    const relays = await readText(RELAYS_PREFIX, spaceId);
    const { key, keys } = await readKeyring(spaceId);
    return {
      space,
      key,
      keys,
      invite: invite ? base64UrlDecode(invite) : null,
      role: await readText(ROLE_PREFIX, spaceId),
      ...(memberKey ? { memberKey: base64UrlDecode(memberKey) } : {}),
      ...(relays ? { relays: JSON.parse(relays) as string[] } : {}),
    };
  }

  return Object.freeze({
    async create(params: CreateSpaceParams): Promise<SpaceRecord> {
      const createdAt = new Date().toISOString();
      // A nonce keeps two spaces made alike from colliding on one id.
      const nonce = base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(12)));
      const roles = params.roles ?? solo.roles;
      const creatorRole = params.creatorRole ?? (params.roles ? [...roles].sort((a, b) => b.rank - a.rank)[0]?.name : solo.creatorRole) ?? '';
      const problem = checkStartingRoles(roles, creatorRole);
      if (problem) throw new Error(problem);

      const key = params.visibility === 'private' ? await generateSpaceKey() : null;
      const fixed = {
        visibility: params.visibility,
        creator: params.creator,
        roles: roles.map((role) => Object.freeze({ ...role, permissions: Object.freeze([...role.permissions]) })),
        creatorRole,
        createdAt,
        nonce,
        ...(key ? { readKey: (await deriveReadKey(key, provider)).did, encryptionKeyId: key.id } : {}),
      };
      const id = await spaceIdOf(spaceGenesis(fixed));
      const space: Space = Object.freeze({ id, ...fixed, name: params.name });

      await writeSpace(space);
      if (key) await writeKey(id, key);
      await adapter.put(`${ROLE_PREFIX}${id}`, utf8Encode(creatorRole));
      return { space, key, keys: key ? [key] : [], invite: null, role: creatorRole };
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
      for (const prefix of [SPACE_PREFIX, KEY_PREFIX, INVITE_PREFIX, ROLE_PREFIX, MEMBER_KEY_PREFIX, RELAYS_PREFIX]) await adapter.delete(`${prefix}${spaceId}`);
    },

    async createInvite(spaceId: string, invitedBy: string, options: InviteOptions = {}): Promise<string> {
      const record = await load(spaceId);
      if (!record) throw new Error(`Unknown space: ${spaceId}`);
      return encodeSpaceInvite(record, invitedBy, options);
    },

    async join(invite: string): Promise<SpaceRecord> {
      const parsed = parseSpaceInvite(invite);

      // Whoever made the invite could have edited it. The space must hash to
      // its id, and its key must be the one the space names.
      const problem = await checkSpace(parsed.space);
      if (problem) throw new Error(`That invite does not describe a real space: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}.`);
      if (parsed.key && parsed.space.visibility !== 'private') throw new Error('That invite carries a key for a space that has none.');
      // The key may be the space's first or a later one — the space's key
      // changed since. Its id is its hash, so it is only ever the key the
      // history names or one that opens nothing.
      const key = parsed.key ? await spaceKeyFromRaw(base64UrlDecode(parsed.key), parsed.space.createdAt) : null;
      const secret = parsed.invite ? base64UrlDecode(parsed.invite) : null;
      // A secret of the wrong length cannot be an invite's; refuse it here rather than wait on it forever.
      if (secret && secret.length !== 32) throw new Error('That invite carries a secret that is not an invite\'s.');
      if (secret) await deriveInviteKey(secret, provider);

      const space: Space = Object.freeze({ ...parsed.space });
      await writeSpace(space);
      if (key) await writeKey(space.id, key);
      // Joining again with a secret while one is waiting keeps the newer one.
      if (secret) await adapter.put(`${INVITE_PREFIX}${space.id}`, utf8Encode(base64UrlEncode(secret)));
      // Only a hint, but a checked one: a relay list the space itself could not hold is dropped.
      if (parsed.relays && checkRelays(parsed.relays) === null && parsed.relays.length > 0 && !(await readText(RELAYS_PREFIX, space.id))) {
        await adapter.put(`${RELAYS_PREFIX}${space.id}`, utf8Encode(JSON.stringify(parsed.relays)));
      }

      return (await load(space.id))!;
    },

    async clearInvite(spaceId: string): Promise<void> {
      await adapter.delete(`${INVITE_PREFIX}${spaceId}`);
    },

    async addKeys(spaceId: string, keys: ReadonlyArray<SpaceKey>, current: string): Promise<void> {
      if (!(await readSpace(spaceId))) return;
      const held = (await readKeyring(spaceId)).keys;
      const known = new Set(held.map((key) => key.id));
      const all = [...held, ...keys.filter((key) => !known.has(key.id) && (known.add(key.id), true))];
      if (!all.some((key) => key.id === current)) throw new Error('The current key must be one of the keys held');
      await writeKeyring(spaceId, all, current);
    },

    async setRelays(spaceId: string, relays: ReadonlyArray<string>): Promise<void> {
      if (!(await readSpace(spaceId)) || checkRelays(relays) !== null) return;
      await adapter.put(`${RELAYS_PREFIX}${spaceId}`, utf8Encode(JSON.stringify(relays)));
    },

    async setMemberKey(spaceId: string, memberKey: Uint8Array): Promise<void> {
      if (!(await readSpace(spaceId))) return;
      await adapter.put(`${MEMBER_KEY_PREFIX}${spaceId}`, utf8Encode(base64UrlEncode(memberKey)));
    },

    async setRole(spaceId: string, role: string | null): Promise<void> {
      if (!(await readSpace(spaceId))) return;
      if (role === null) await adapter.delete(`${ROLE_PREFIX}${spaceId}`);
      else await adapter.put(`${ROLE_PREFIX}${spaceId}`, utf8Encode(role));
    },
  });
}

/**
 * Encodes a space, its key if private, and an invite's secret if given, as a
 * shareable string — for a space this node holds, or one it derived.
 */
export async function encodeSpaceInvite(record: SpaceRecord, invitedBy: string, options: InviteOptions = {}): Promise<string> {
  // The key rides along for private spaces — which is why an invite is a
  // secret, and why it belongs in a URL fragment rather than a path.
  const invite: SpaceInvite = {
    space: record.space,
    invitedBy,
    ...(record.key ? { key: (await exportKey(record.key)).raw } : {}),
    ...(options.secret ? { invite: base64UrlEncode(options.secret) } : {}),
    ...(options.secret && options.role ? { role: options.role } : {}),
    ...((options.relays ?? record.relays)?.length ? { relays: [...(options.relays ?? record.relays)!] } : {}),
  };
  return base64UrlEncode(utf8Encode(JSON.stringify(invite)));
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
