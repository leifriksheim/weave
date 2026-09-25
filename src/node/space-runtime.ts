/**
 * @module node/space-runtime
 * One open space: its store, its gatekeeper, its peers, its sync.
 *
 * A space is the unit of storage and of sync — its own Merkle tree, its own
 * rooms and sockets — so two spaces never mix, and a peer you share one space
 * with learns nothing about the others.
 *
 * **A record keeps its key; changes are versions.** Editing a record writes its
 * next version — same key, `seq` one higher, `prev` naming the one replaced —
 * and deleting it writes a version marked deleted. Which version is current is
 * decided by `seq` and id alone (`records/version.ts`), never by a clock, so
 * every node agrees and nothing replayed can roll a record back.
 *
 * **Who may write is the space's access history** (`space/roles.ts`): roles,
 * members, invites, revoked notes and collection definitions, as records every
 * version points into with `seen`. A version stands when its author held what
 * its collection's rules ask, as of what it saw, and nothing it had not seen
 * took that away. A version that stops standing — its author was removed, and
 * the remover never saw it — is passed over when reading, and the version
 * before it counts again, where the store still has one.
 */
import type { Expression, CryptoProvider, StorageAdapter } from '../types.js';
import type { Signer } from '../schema/signer.js';
import { createSchemaEngine, type SchemaEngine } from '../schema/schema-engine.js';
import type { SpaceRecord } from '../space/space-manager.js';
import type { Capability } from '../identity/ucan.js';
import { parseUCAN, resolveDelegationRoot } from '../identity/ucan.js';
import { isAgentNote } from '../identity/agent-note.js';
import { didToPublicKey } from '../identity/did.js';
import { createExpression } from '../schema/expression.js';
import { createStorageProvider, type StorageProvider } from '../storage/storage-provider.js';
import { newRecordKey, nextVersion, RECORD_KEY_PATTERN } from '../records/version.js';
import { checkLinks } from '../records/links.js';
import { allows, changedFixedField, describeWho, onePerKey, permissionName, type CollectionRules } from '../records/rules.js';
import type { Link } from '../types.js';
import { reconcileFolder } from '../storage/folder-reconcile.js';
import type { FolderAdapter } from '../storage/folder-adapter.js';
import { createCryptoGate } from '../validation/crypto-gate.js';
import { createStructuralGate } from '../validation/structural-gate.js';
import { createStatefulGate } from '../validation/stateful-gate.js';
import { createCapabilityGate } from '../validation/capability-gate.js';
import { createValidationEngine } from '../validation/validation-engine.js';
import { encryptExpression, decryptExpression, type EncryptedExpression } from '../privacy/space-encryption.js';
import { createNetworkManager, type NetworkManager } from '../network/network-manager.js';
import { createWebSocketTransport } from '../network/ws-transport.js';
import { createClientAuth, createMeshAuth } from '../network/peer-auth.js';
import {
  deriveInviteKey,
  deriveReadKey,
  generateInviteSecret,
  inviteKey as inviteRecordKey,
  memberKey,
  revokeKey,
  roleKey,
  signInvite,
  verifyInvite,
} from '../space/space-access.js';
import {
  ACCESS_COLLECTIONS,
  DEFINITION_COLLECTION,
  INVITE_COLLECTION,
  MEMBER_COLLECTION,
  REVOKE_COLLECTION,
  ROLE_COLLECTION,
  checkRole,
  replayAccess,
  roleHolds,
  standing,
  type AccessEvent,
  type AccessGenesis,
  type AccessHistory,
  type AccessState,
  type Role,
} from '../space/roles.js';
import { createSyncEngine } from '../sync/sync-engine.js';
import type { NetworkMessage, PeerInfo } from '../types.js';
import type { StoreFactory } from './stores.js';
import {
  CATALOG_COLLECTION,
  checkStoredCollection,
  toJsonSchema,
  validateJsonSchema,
  type SchemaIssue,
  type StoredCollection,
} from '../schema/collection-def.js';
import { CARRIER_COLLECTION, MEMBERSHIP_COLLECTION, PROFILE_COLLECTION } from '../space/account-registry.js';
import { PASS_COLLECTION } from '../space/pass.js';
import { base32Encode, cidFromBytes, sha256 } from '../utils/hash.js';
import { utf8Encode } from '../utils/encoding.js';
import type {
  ConnectionState,
  DefineCollection,
  NodeCollection,
  ListOptions,
  NodeEvent,
  NodeNetworkConfig,
  NodeRecord,
  SpaceAccess,
  SpaceProfile,
  SpaceStatus,
} from './types.js';

/** Collections the node writes itself, through their own calls — never through `put` */
const MANAGED = new Set([MEMBERSHIP_COLLECTION, PROFILE_COLLECTION, CARRIER_COLLECTION, PASS_COLLECTION, ...ACCESS_COLLECTIONS]);

/**
 * Access records a peer without the space key must still be able to judge:
 * who holds which role decides every write. Kept in the clear, even in a
 * private space. Collection definitions stay sealed — a peer that cannot
 * read the records has no use for their rules.
 */
const IN_THE_CLEAR = new Set([ROLE_COLLECTION, MEMBER_COLLECTION, INVITE_COLLECTION, REVOKE_COLLECTION]);

/** Which collection each access record key belongs to */
const ACCESS_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['role:', ROLE_COLLECTION],
  ['member:', MEMBER_COLLECTION],
  ['invite:', INVITE_COLLECTION],
  ['revoke:', REVOKE_COLLECTION],
  ['collection:', DEFINITION_COLLECTION],
];

/** How many records a keep list may name */
const MAX_KEEP = 10_000;

/**
 * The key of a person's profile record in a space: one per identity, named by
 * a hash of it (record keys are lower case; a did:key is not).
 */
export async function profileKey(did: string): Promise<string> {
  const digest = await sha256(new TextEncoder().encode(did));
  return `profile:${Array.from(digest.subarray(0, 20), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The room a space's peers meet in on a relay. A hash of the space's id, so a
 * relay learns which connections belong together but not which space they are
 * — it cannot match the room to an invite, or to the same space elsewhere.
 */
export async function relayRoom(spaceId: string): Promise<string> {
  return base32Encode((await sha256(new TextEncoder().encode(`weave-room/v1|${spaceId}`))).subarray(0, 20));
}

/** The capability a record in a space requires */
export const writeCapability = (spaceId: string): Capability => ({
  with: `space:${spaceId}`,
  can: 'expression/write',
});

/** The CID a note is known by — what a revoke names */
export const noteCid = (encoded: string) => cidFromBytes(utf8Encode(encoded));

/** The key that signs, and the delegation that lets it */
export interface ActiveSession {
  readonly did: string;
  readonly key: CryptoKey;
  /** The current delegation — it is renewed, so always read it fresh */
  readonly proof: () => string;
}

export interface SpaceRuntimeDeps {
  readonly record: SpaceRecord;
  readonly stores: StoreFactory;
  readonly provider: CryptoProvider;
  readonly signer: Signer;
  readonly schemas: SchemaEngine;
  readonly session: ActiveSession;
  /** The identity the node acts for — names the cross-tab channel */
  readonly rootDid: string;
  readonly network?: NodeNetworkConfig;
  readonly watchIntervalMs: number;
  readonly emit: (event: NodeEvent) => void;
  /** Told the role this account holds whenever the access history says something new */
  readonly onRole?: (role: string | null) => void;
  /** Told once an invite's secret has been used, and can be forgotten */
  readonly onJoined?: () => void;
  /**
   * Nothing an agent signs counts here — for the account's own spaces (its
   * list of spaces, a carrier's passes), where a note for "every space" would
   * otherwise let an agent join the account to a space or leave one.
   */
  readonly peopleOnly?: boolean;
}

export interface SpaceRuntime {
  list<T>(options?: ListOptions): Promise<ReadonlyArray<NodeRecord<T>>>;
  get<T>(key: string): Promise<NodeRecord<T> | null>;
  put<T>(collection: string, body: T, options?: { key?: string; links?: ReadonlyArray<Link>; as?: ActiveSession }): Promise<NodeRecord<T>>;
  update<T>(key: string, body: T, options?: { links?: ReadonlyArray<Link>; as?: ActiveSession }): Promise<NodeRecord<T>>;
  linked<T>(key: string, options?: { rel?: string; collection?: string }): Promise<ReadonlyArray<NodeRecord<T>>>;
  remove(key: string, options?: { as?: ActiveSession }): Promise<void>;
  history<T>(key: string): Promise<ReadonlyArray<NodeRecord<T>>>;
  /** For the node itself: writes the next version of a record in a collection `put` refuses, like the profile */
  upsertSystem<T>(collection: string, key: string, body: T): Promise<NodeRecord<T>>;
  /** For the node itself: deletes a record in a managed collection */
  removeSystem(key: string): Promise<void>;
  /** Whether this account may create in a collection (`target` = its name), or edit or delete a record (`target` = its key) */
  can(action: 'create' | 'edit' | 'delete', target: string): Promise<boolean>;
  /** The name each person in the space gave, by identity */
  profiles(): Promise<ReadonlyArray<SpaceProfile>>;
  /** For the node itself: says who this account is, here — when that changed and the space takes its writes */
  publishProfile(profile: { name: string }): Promise<void>;
  collections(): Promise<ReadonlyArray<NodeCollection>>;
  define(definition: DefineCollection): Promise<NodeCollection>;
  /** Takes a definition out of the space — only once nothing is left in it */
  undefine(name: string): Promise<void>;
  /** Roles, members and invites as the access history says now, and this account's own role */
  access(): Promise<SpaceAccess>;
  /** Gives someone a role, changes it, or — with null — takes it away */
  setMember(did: string, role: string | null): Promise<void>;
  /** Adds or changes a role */
  putRole(role: Role): Promise<void>;
  /** Removes a role; whoever held it holds nothing */
  removeRole(name: string): Promise<void>;
  /** Opens an invite for a role. The secret goes in the link, and nowhere else. */
  openInvite(role: string): Promise<{ readonly secret: Uint8Array; readonly key: string }>;
  /** Closes an invite; who joined with it and was seen joining stays */
  closeInvite(inviteDid: string): Promise<void>;
  /** Revokes a note this account signed: nothing written under it counts from now, except what was seen */
  revoke(token: string): Promise<void>;
  /** Whether a note has been revoked here */
  isRevoked(token: string): Promise<boolean>;
  /** Uses an invite's secret, once its record has arrived. True when this account is a member. */
  join(secret: Uint8Array): Promise<boolean>;
  /** Who is connected, as this space alone can tell — which of them are the account's own, the node works out */
  status(): Promise<Omit<SpaceStatus, 'own' | 'carriers'>>;
  close(): Promise<void>;
}

interface Verdict {
  readonly verified: boolean;
  readonly root: string | null;
  readonly reason?: string;
}

type Standing = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly later?: boolean };
const STANDS: Standing = { ok: true };

function looksEncrypted(body: unknown): boolean {
  const envelope = body as Record<string, unknown> | null;
  return typeof envelope?.ciphertext === 'string' && typeof envelope?.iv === 'string';
}

function isFolderAdapter(adapter: StorageAdapter): adapter is FolderAdapter {
  return typeof (adapter as FolderAdapter).reload === 'function';
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

export async function openSpaceRuntime(deps: SpaceRuntimeDeps): Promise<SpaceRuntime> {
  const { record, provider, signer, schemas, session, emit } = deps;
  const { space, key } = record;
  /** An invite waiting to be used — forgotten here once it is, whatever the stored record still says */
  let waitingInvite = record.invite !== null;

  const adapter = await deps.stores(`spaces/${space.id}`);
  // Tabs sharing this browser's store are covered by compaction's grace period.
  // A folder's other writers — a sync service bringing another device's tree
  // back hours later — are not, so a folder keeps its old nodes.
  const shared = isFolderAdapter(adapter);
  const storage: StorageProvider = createStorageProvider(adapter, shared ? {} : { compactEvery: 256 });
  if (!shared) void storage.compact().catch(() => {});

  const resolvePublicKey = async (did: string) => provider.importPublicKey(didToPublicKey(did).publicKeyBytes);

  const validation = createValidationEngine({
    cryptoGate: createCryptoGate(provider),
    // Shape is not a reason to refuse a record on arrival. Whether it fits can
    // depend on which definition, or which app's schema, a node happens to have;
    // refusing would leave nodes that disagree forever. Shape is checked when a
    // record is written here, and reported as `conforms` when it is read.
    structuralGate: createStructuralGate(createSchemaEngine(), { allowUnknownCollections: true }),
    statefulGate: createStatefulGate(),
    // The note behind a key must cover this space. Whether its account may
    // write here is the access history's question, asked below.
    capabilityGate: createCapabilityGate({ provider, requiredCapability: () => writeCapability(space.id) }),
    resolvePublicKey,
    getExpression: (id) => storage.getExpression(id),
  });

  // A signature never changes, so a verdict on one holds forever. Keyed on the
  // id *and* the signature: the id does not cover it, so a copy with a broken
  // signature shares the genuine one's id. Only passes are kept — a failure
  // remembered by id would let anyone who sends a mangled copy first get the
  // real record refused; and failures are what a stranger can mint for free.
  const verdicts = new Map<string, Verdict>();
  const verdictKey = (e: Expression) => `${e.id}|${e.signature}`;

  /** Whether a version is signed, and by a key whose note covers this space — and which account that is */
  async function judge(expression: Expression): Promise<Verdict> {
    const cached = verdicts.get(verdictKey(expression));
    if (cached) return cached;

    const result = await validation.validate(expression);
    let verdict: Verdict;
    if (!result.valid) {
      const failed = result.gates.find((gate) => !gate.passed);
      verdict = { verified: false, root: null, ...(failed?.reason ? { reason: failed.reason } : {}) };
    } else {
      const at = Math.floor(Date.parse(expression.createdAt) / 1000);
      const chain = expression.proof ? await resolveDelegationRoot(expression.proof, () => null, provider, { at }) : null;
      verdict = { verified: true, root: chain?.valid ? chain.rootDid : expression.author };
      verdicts.set(verdictKey(expression), verdict);
    }
    return verdict;
  }

  /**
   * A version's content: its body and its links. In a private space both are
   * sealed together, so a relay learns neither what a record says nor what it
   * points at.
   */
  async function openBody(expression: Expression): Promise<{ body: unknown; links: ReadonlyArray<Link>; encrypted: boolean }> {
    if (!looksEncrypted(expression.body)) return { body: expression.body, links: expression.links ?? [], encrypted: false };
    if (!key) return { body: null, links: [], encrypted: true };
    try {
      const opened = (await decryptExpression(expression as EncryptedExpression, key)).body as { body?: unknown; links?: unknown };
      const links = checkLinks(opened?.links ?? []) === null ? ((opened?.links as ReadonlyArray<Link> | undefined) ?? []) : [];
      return { body: opened?.body ?? null, links, encrypted: true };
    } catch {
      return { body: null, links: [], encrypted: true };
    }
  }

  /**
   * Whether `first` can be the first version of the record `version` belongs
   * to. A later version names its first version itself, and a check that took
   * that on trust would let anyone point at a record with no rules — or in
   * another collection — and be judged by that instead.
   */
  const firstOf = (version: Expression, first: Expression | null): first is Expression =>
    !!first && first.seq === 0 && first.key === version.key && first.collection === version.collection;

  /** A record's first version: the version itself at seq 0, else the one kept apart. */
  async function genesisOf(version: Expression): Promise<Expression | null> {
    return version.seq === 0 ? version : storage.getGenesis(version.key);
  }

  /**
   * Whether a version is one this node should show. A version whose collection
   * differs from its record's first version is someone reusing a key: it is
   * ignored on read, the same way on every node once they hold the same data.
   */
  async function consistent(version: Expression): Promise<boolean> {
    if (version.seq === 0) return true;
    const genesis = await storage.getGenesis(version.key);
    return !genesis || genesis.collection === version.collection;
  }

  // ─── The access history ────────────────────────────────────────────
  //
  // Every version in the access collections, kept whole (`retain`), turned
  // into plain events and replayed. Rebuilt when records change; everything
  // about who may do what is read from the replay.

  const accessGenesis: AccessGenesis = {
    id: space.id,
    creator: space.creator,
    roles: space.roles,
    creatorRole: space.creatorRole,
  };

  /** Events, by version id — building one checks signatures and invites, so they are kept */
  const events = new Map<string, AccessEvent | null>();

  async function toEvent(version: Expression): Promise<AccessEvent | null> {
    const cacheKey = `${version.id}|${version.signature}`;
    if (events.has(cacheKey)) return events.get(cacheKey)!;
    const event = await buildEvent(version);
    // A failed signature is what a stranger can mint for free; only settled answers from a valid one are kept.
    if (event || (await judge(version)).verified) events.set(cacheKey, event);
    return event;
  }

  async function buildEvent(version: Expression): Promise<AccessEvent | null> {
    if (!ACCESS_COLLECTIONS.has(version.collection) || !version.retain) return null;
    // An agent never changes the space's collections or who may do what: a person does.
    if (isAgentNote(version.proof)) return null;
    const verdict = await judge(version);
    if (!verdict.verified || !verdict.root) return null;
    const seen = version.seen ?? [];
    const base = { id: version.id, key: version.key, root: verdict.root, seen };

    if (version.collection === DEFINITION_COLLECTION) {
      if (!version.key.startsWith('collection:')) return null;
      return { ...base, keep: [], kind: 'definition', name: version.key.slice('collection:'.length), deleted: !!version.deleted };
    }
    // Everything else in the history is taken away by a change, never deleted: a delete has no body to carry a keep list.
    if (version.deleted || looksEncrypted(version.body)) return null;
    const body = version.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return null;
    const keep = isStringList(body.keep) ? body.keep.slice(0, MAX_KEEP) : [];

    switch (version.collection) {
      case ROLE_COLLECTION: {
        const name = typeof body.name === 'string' ? body.name : '';
        if (version.key !== roleKey(name)) return null;
        if (body.removed === true) return { ...base, keep, kind: 'role', name, role: null };
        const role: Role = {
          name,
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          rank: body.rank as number,
          permissions: body.permissions as string[],
        };
        return checkRole(role) ? null : { ...base, keep, kind: 'role', name, role };
      }
      case MEMBER_COLLECTION: {
        const did = body.did;
        const role = body.role;
        if (typeof did !== 'string' || !(role === null || typeof role === 'string')) return null;
        if (version.key !== (await memberKey(did))) return null;
        const invite = body.invite as { key?: unknown; signature?: unknown } | undefined;
        let viaInvite: string | undefined;
        if (invite !== undefined) {
          if (typeof invite?.key !== 'string' || typeof invite.signature !== 'string') return null;
          if (!(await verifyInvite(space.id, did, invite.key, invite.signature, provider))) return null;
          viaInvite = invite.key;
        }
        return { ...base, keep, kind: 'member', did, role, ...(viaInvite !== undefined ? { viaInvite } : {}) };
      }
      case INVITE_COLLECTION: {
        const inviteDid = body.key;
        if (typeof inviteDid !== 'string' || typeof body.role !== 'string' || typeof body.open !== 'boolean') return null;
        if (version.key !== (await inviteRecordKey(inviteDid))) return null;
        return { ...base, keep, kind: 'invite', inviteKey: inviteDid, role: body.role, open: body.open };
      }
      case REVOKE_COLLECTION: {
        if (typeof body.note !== 'string') return null;
        let issuer: string;
        try {
          issuer = parseUCAN(body.note).payload.iss;
        } catch {
          return null;
        }
        const note = await noteCid(body.note);
        if (version.key !== (await revokeKey(note))) return null;
        return { ...base, keep, kind: 'revoke', note, issuer };
      }
    }
    return null;
  }

  interface Access {
    readonly history: AccessHistory;
    readonly events: ReadonlyArray<AccessEvent>;
  }
  let accessCache: Promise<Access> | null = null;
  const access = () => (accessCache ??= loadAccess());

  async function loadAccess(): Promise<Access> {
    const found: AccessEvent[] = [];
    // By key, not by the current version's collection: whatever sits on top
    // may be anyone's, and every version of the history counts.
    for (const version of await storage.listCurrent()) {
      const kind = ACCESS_KEYS.find(([prefix]) => version.key.startsWith(prefix));
      if (!kind) continue;
      for (const held of await storage.history(version.key)) {
        if (held.collection !== kind[1]) continue;
        const event = await toEvent(held);
        if (event) found.push(event);
      }
    }
    const history = replayAccess(accessGenesis, found);
    reportRole(history.current);
    return { history, events: found };
  }

  let reportedRole: string | null | undefined;
  function reportRole(state: AccessState): void {
    const role = standing(state, deps.rootDid)?.name ?? null;
    if (role === reportedRole) return;
    reportedRole = role;
    deps.onRole?.(role);
  }

  /** The note a version was written under, when it was delegated */
  const noteOf = async (expression: Expression) => (expression.proof ? noteCid(expression.proof) : undefined);

  // ─── Rules ─────────────────────────────────────────────────────────
  //
  // A version is judged by the definition in force as of the access changes
  // it saw — the same on every peer, since everyone replays the same history.
  // A definition a peer cannot read (a private space, no key) cannot be
  // judged by; members judge instead.

  type Definition = { readonly definition: StoredCollection } | 'missing' | 'unreadable' | 'invalid';
  const definitions = new Map<string, Promise<Definition>>();

  /** The definition held in one version of `sys.collection` */
  function definitionIn(id: string): Promise<Definition> {
    let found = definitions.get(id);
    if (!found) {
      found = (async (): Promise<Definition> => {
        const version = await storage.getExpression(id);
        if (!version) return 'missing';
        if (version.collection !== CATALOG_COLLECTION || version.deleted) return 'invalid';
        const opened = await openBody(version);
        if (opened.body === null) return 'unreadable';
        const definition = opened.body as StoredCollection;
        if (checkStoredCollection(definition) !== null || version.key !== `collection:${definition.name}`) return 'invalid';
        return { definition };
      })();
      definitions.set(id, found);
      // Something missing may turn up; only settled answers are worth keeping.
      void found.then((answer) => answer === 'missing' && definitions.delete(id));
    }
    return found;
  }

  /** The rules in force for a collection in one state of the history — null when there are none to judge by */
  async function rulesAt(state: AccessState, collection: string): Promise<{ rules: CollectionRules } | null> {
    if (collection.startsWith('sys.')) return null;
    const entry = state.definitions.get(collection);
    if (!entry) return null;
    const found = await definitionIn(entry.event);
    return typeof found === 'string' ? null : { rules: found.definition.rules ?? {} };
  }

  const standings = new Map<string, Promise<Standing>>();

  /**
   * Whether a version stands: signed, in this space, consistent with its first
   * version, and — by the access history — written by someone allowed to.
   * The same verdict for a version from a peer, from a folder, or written
   * here, and for one read back later.
   */
  function standingOf(expression: Expression): Promise<Standing> {
    const cacheKey = verdictKey(expression);
    let found = standings.get(cacheKey);
    if (!found) {
      found = judgeStanding(expression);
      standings.set(cacheKey, found);
    }
    return found;
  }

  async function judgeStanding(expression: Expression): Promise<Standing> {
    // A version may only claim the space it actually sits in.
    if (expression.space !== space.id) return { ok: false, reason: 'It belongs to a different space' };
    const verdict = await judge(expression);
    if (!verdict.verified || !verdict.root) return { ok: false, reason: verdict.reason ?? 'Its signature does not check out' };
    if (deps.peopleOnly && isAgentNote(expression.proof)) return { ok: false, reason: 'Only the account itself writes here, not an agent' };
    const { history } = await access();

    if (ACCESS_COLLECTIONS.has(expression.collection)) {
      const event = await toEvent(expression);
      if (!event) return { ok: false, reason: 'It is not a well-formed change to who may do what' };
      const status = history.status(event.id);
      if (!status || status.status === 'waiting') return { ok: false, reason: 'Access changes it depends on have not arrived yet', later: true };
      return status.status === 'applied' ? STANDS : { ok: false, reason: status.reason };
    }

    const first = expression.seq === 0 ? expression : expression.genesis ? await storage.getExpression(expression.genesis) : null;
    if (!first) return { ok: false, reason: 'Its first version has not arrived yet', later: true };
    if (!firstOf(expression, first)) return { ok: false, reason: 'The first version it names is not this record\'s' };

    const seen = expression.seen ?? [];
    const state = history.at(seen);
    if (!state) return { ok: false, reason: 'Access changes it depends on have not arrived yet', later: true };

    const root = verdict.root;
    const found = await rulesAt(state, expression.collection);
    const rules = found?.rules;
    const action = expression.seq === 0 ? 'create' : expression.deleted ? 'delete' : 'edit';
    const who = !rules ? undefined : action === 'create' ? rules.create : action === 'delete' ? (rules.delete ?? rules.edit) : rules.edit;
    const creator = action !== 'create' && (await judge(first)).root === root;
    const needs = (role: Role | null) =>
      role !== null &&
      (!rules || allows(who, { member: true, creator, can: (permission) => roleHolds(role, permissionName(expression.collection, permission)) }));

    // The two refusals worth telling apart: not a member at all, and not allowed by the rules.
    const role = standing(state, root);
    if (!role) return { ok: false, reason: 'Its author was not a member of this space, as of what it had seen' };
    if (!needs(role)) {
      return {
        ok: false,
        reason:
          action === 'create'
            ? `Only ${describeWho(who)} can create ${expression.collection} records`
            : `Only ${describeWho(who)} can ${action} this ${expression.collection} record`,
      };
    }
    const judged = history.judge({ id: expression.id, root, seen, note: await noteOf(expression) }, needs);
    if (!judged.ok) return judged;

    if (!rules || expression.deleted) return STANDS;
    if (expression.seq === 0 && rules.onePer) {
      const opened = await openBody(expression);
      if (opened.body === null && opened.encrypted) return STANDS;
      const expected = await onePerKey(expression.collection, rules.onePer, { root, links: opened.links, body: opened.body });
      if (expected !== expression.key) {
        return { ok: false, reason: `${expression.collection} allows one per ${rules.onePer.join(' + ')} — its key must be derived from them` };
      }
    }
    if (expression.seq > 0 && rules.fixed?.length) {
      const [now, then] = await Promise.all([openBody(expression), openBody(first)]);
      if (now.body !== null && then.body !== null) {
        const field = changedFixedField(rules.fixed, then.body, now.body);
        if (field) return { ok: false, reason: `"${field}" is fixed once a ${expression.collection} record is created` };
      }
    }
    return STANDS;
  }

  /**
   * Whether a change to the access history may be stored. Not whether it
   * counts — that can change as other changes arrive, so every well-formed one
   * is kept and the replay decides. Only what never changes is asked: that
   * what it saw is here, and that its author is someone the history has heard
   * of, or holds an invite it has.
   */
  async function admissible(expression: Expression): Promise<Standing> {
    if (expression.space !== space.id) return { ok: false, reason: 'It belongs to a different space' };
    if (!expression.retain) return { ok: false, reason: 'A change to who may do what must be kept' };
    const event = await toEvent(expression);
    if (!event) return { ok: false, reason: (await judge(expression)).reason ?? 'It is not a well-formed change to who may do what' };
    const { history } = await access();
    if (!history.at(event.seen)) return { ok: false, reason: 'Access changes it depends on have not arrived yet', later: true };
    const known =
      history.named(event.root) ||
      (event.kind === 'member' && event.viaInvite !== undefined && history.knownInvite(event.viaInvite)) ||
      (event.kind === 'revoke' && history.named(event.issuer));
    return known ? STANDS : { ok: false, reason: 'Its author has never been a member of this space' };
  }

  /** Whether a version from outside — a peer, a folder — may be stored */
  const admit = (expression: Expression) => (ACCESS_COLLECTIONS.has(expression.collection) ? admissible(expression) : standingOf(expression));

  /**
   * The version of a record that counts: the current one, unless it no longer
   * stands — then the newest one before it that does, if the store kept one.
   */
  async function currentOf(recordKey: string): Promise<Expression | null> {
    const current = await storage.getCurrent(recordKey);
    if (!current || !(await consistent(current))) return null;
    if ((await standingOf(current)).ok) return current;
    for (const version of await storage.history(recordKey)) {
      if (version.id === current.id || !(await consistent(version))) continue;
      if ((await standingOf(version)).ok) return version;
    }
    return null;
  }

  /** Every record that counts, current version each — deletes included */
  async function everyCurrent(collection?: string): Promise<Expression[]> {
    const current = collection ? await storage.queryExpressions(collection) : await storage.listCurrent();
    const shown: Expression[] = [];
    for (const version of current) {
      const counted = (await standingOf(version)).ok && (await consistent(version)) ? version : await currentOf(version.key);
      if (counted && (!collection || counted.collection === collection)) shown.push(counted);
    }
    return shown;
  }

  async function view<T>(expression: Expression): Promise<NodeRecord<T>> {
    const [{ body, links, encrypted }, verdict, genesis, stands] = await Promise.all([
      openBody(expression),
      judge(expression),
      genesisOf(expression),
      standingOf(expression),
    ]);
    const creator = genesis ? await judge(genesis) : null;
    const issues = body === null || expression.deleted ? null : await contentIssues(expression.collection, body, links);
    const reason = !verdict.verified ? verdict.reason : !stands.ok ? stands.reason : undefined;
    return Object.freeze({
      key: expression.key,
      version: expression.id,
      seq: expression.seq,
      space: space.id,
      collection: expression.collection,
      author: expression.author,
      root: verdict.root,
      createdBy: creator?.verified ? creator.root : null,
      createdAt: genesis?.createdAt ?? expression.createdAt,
      updatedAt: expression.createdAt,
      body: body as T | null,
      links,
      encrypted,
      verified: verdict.verified && stands.ok,
      ...(isAgentNote(expression.proof) ? { viaAgent: true as const } : {}),
      ...(reason ? { reason } : {}),
      ...(expression.deleted ? { deleted: true as const } : {}),
      conforms: issues === null ? null : issues.length === 0,
      ...(issues?.length ? { issues } : {}),
    });
  }

  // ─── The catalogue ─────────────────────────────────────────────────
  //
  // Which definition is in force for each collection is the access history's
  // answer: the latest change to `collection:<name>` that counted.

  interface CatalogEntry {
    readonly definition: StoredCollection;
    readonly definedBy: string;
    /** The id of the version that holds this definition */
    readonly version: string;
  }
  let catalogCache: Promise<Map<string, CatalogEntry>> | null = null;
  const catalog = () => (catalogCache ??= loadCatalog());

  async function loadCatalog(): Promise<Map<string, CatalogEntry>> {
    const result = new Map<string, CatalogEntry>();
    const { history } = await access();
    for (const [name, entry] of history.current.definitions) {
      const found = await definitionIn(entry.event);
      if (typeof found === 'string') continue;
      if (found.definition.name !== name) continue;
      result.set(name, { definition: found.definition, definedBy: entry.definedBy, version: entry.event });
    }
    return result;
  }

  /** A collection's definition: what the space says. The protocol knows no kinds of record of its own. */
  async function definitionOf(collection: string): Promise<StoredCollection | null> {
    return (await catalog()).get(collection)?.definition ?? null;
  }

  /** Issues with a body against its collection's schema; null when there is no schema to check against. */
  async function shapeIssues(collection: string, body: unknown): Promise<ReadonlyArray<SchemaIssue> | null> {
    // The protocol's own bookkeeping — definitions, profiles, roles — has no user-facing schema.
    if (collection.startsWith('sys.')) return null;
    const described = await definitionOf(collection);
    if (described) return validateJsonSchema(described.schema, body);
    if (schemas.getCollection(collection)) {
      const checked = await schemas.validate(collection, body);
      return (checked.issues ?? []).map((issue) => ({ path: '/', message: issue.message }));
    }
    return null;
  }

  /**
   * Issues with a record's links against its collection's declaration. Only
   * what can be judged from what is held: a link to a record not here yet is
   * fine — you routinely hold a reaction before its post.
   */
  async function linkIssues(collection: string, links: ReadonlyArray<Link>): Promise<SchemaIssue[]> {
    const malformed = checkLinks(links);
    if (malformed) return [{ path: '/links', message: malformed }];
    if (links.length === 0) return [];
    const declared = (await definitionOf(collection))?.links;
    // An undescribed collection says nothing about its links, so nothing is wrong.
    if (!declared) return (await definitionOf(collection)) ? [{ path: '/links', message: `${collection} declares no links` }] : [];

    const issues: SchemaIssue[] = [];
    const perRole = new Map<string, number>();
    for (const [index, link] of links.entries()) {
      const declaration = declared[link.rel];
      if (!declaration) {
        issues.push({ path: `/links/${index}`, message: `${collection} has no "${link.rel}" link (it has: ${Object.keys(declared).join(', ')})` });
        continue;
      }
      perRole.set(link.rel, (perRole.get(link.rel) ?? 0) + 1);
      if (declaration.to === '*') continue;
      const target = await currentOf(link.to);
      if (target && !target.deleted && !declaration.to.includes(target.collection)) {
        issues.push({ path: `/links/${index}`, message: `"${link.rel}" must point at ${declaration.to.join(' or ')}, not ${target.collection}` });
      }
    }
    for (const [rel, count] of perRole) {
      if (declared[rel]?.cardinality === 'one' && count > 1) issues.push({ path: '/links', message: `At most one "${rel}" link` });
    }
    return issues;
  }

  /** Shape and link issues together; null when neither has anything to check against. */
  async function contentIssues(collection: string, body: unknown, links: ReadonlyArray<Link>): Promise<ReadonlyArray<SchemaIssue> | null> {
    const shape = await shapeIssues(collection, body);
    const linked = await linkIssues(collection, links);
    if (shape === null && linked.length === 0 && !(await definitionOf(collection))) return null;
    return [...(shape ?? []), ...linked];
  }

  function describe(name: string, entry: CatalogEntry | null, records: number): NodeCollection {
    const definition = entry?.definition;
    return Object.freeze({
      name,
      ...(definition?.title !== undefined ? { title: definition.title } : {}),
      ...(definition?.description !== undefined ? { description: definition.description } : {}),
      schema: definition?.schema ?? null,
      version: definition?.version ?? null,
      history: definition?.history ?? 'latest',
      links: definition?.links ?? {},
      definedBy: entry?.definedBy ?? null,
      permissions: definition?.permissions ?? [],
      rules: definition?.rules ?? {},
      ...(definition?.screen !== undefined ? { screen: definition.screen } : {}),
      records,
    });
  }

  // ─── What points where ─────────────────────────────────────────────
  //
  // Derived from the records held, rebuilt when they change, never synced: any
  // node holding the records can build it, and derived data travelling between
  // peers would only be one more thing to disagree about.

  let linkIndexCache: Promise<Map<string, Array<{ rel: string; from: string }>>> | null = null;
  const linkIndex = () => (linkIndexCache ??= buildLinkIndex());

  async function buildLinkIndex(): Promise<Map<string, Array<{ rel: string; from: string }>>> {
    const index = new Map<string, Array<{ rel: string; from: string }>>();
    for (const version of await everyCurrent()) {
      if (version.deleted) continue;
      const { links } = await openBody(version);
      for (const link of links) {
        const list = index.get(link.to) ?? [];
        list.push({ rel: link.rel, from: version.key });
        index.set(link.to, list);
      }
    }
    return index;
  }

  // ─── Profiles ──────────────────────────────────────────────────────
  //
  // Each person says who they are in a space with one record, keyed by their
  // identity (`profileKey`), whose versions are always retained. The fold
  // takes the newest version signed by the identity the key names, so nobody
  // can rename anyone else: a version written by someone else under your key
  // is simply never the answer, and it cannot push yours out, because yours
  // are kept.

  let profilesCache: Promise<Map<string, SpaceProfile>> | null = null;
  const profileMap = () => (profilesCache ??= loadProfiles());

  async function loadProfiles(): Promise<Map<string, SpaceProfile>> {
    const result = new Map<string, SpaceProfile>();
    // By key: the current version may be anyone's.
    const keys = (await storage.listCurrent()).map((v) => v.key).filter((k) => k.startsWith('profile:'));
    for (const key of keys) {
      for (const version of await storage.history(key)) {
        if (version.collection !== PROFILE_COLLECTION) continue;
        const verdict = await judge(version);
        if (!verdict.verified || !verdict.root || (await profileKey(verdict.root)) !== key) continue;
        if (!(await standingOf(version)).ok) continue;
        if (version.deleted) break; // they took it down
        const name = ((await openBody(version)).body as { name?: unknown } | null)?.name;
        if (typeof name === 'string' && name.trim()) {
          result.set(verdict.root, { did: verdict.root, name: name.trim().slice(0, 64), updatedAt: version.createdAt });
        }
        break;
      }
    }
    return result;
  }

  /** Records changed: everything derived from them may have too. */
  const recordsChanged = () => {
    linkIndexCache = null;
    catalogCache = null;
    profilesCache = null;
    accessCache = null;
    standings.clear();
    emit({ type: 'records', space: space.id });
  };

  // ─── Peers ─────────────────────────────────────────────────────────

  let connection: ConnectionState = 'offline';
  let rejected = 0;
  const networks: NetworkManager[] = [];
  /** Which network a peer was met on, so replies go back the same way */
  const routes = new Map<string, NetworkManager>();

  const sync = createSyncEngine({
    storageProvider: storage,
    sendToPeer: (peerId, message) => {
      routes.get(peerId)?.send(peerId, { type: 'sync', from: session.did, payload: message });
    },
    validate: async (expression) => {
      const verdict = await admit(expression);
      return verdict.ok ? { valid: true } : { valid: false, reason: verdict.reason, ...(verdict.later ? { later: true } : {}) };
    },
  });

  /**
   * Tells every connected peer this node's root, soon after it took in
   * something new — from a peer or from a folder. Without it, a record passed
   * along waits for the next heartbeat at every hop: a carrier would sit on a
   * friend's write for half a minute before the pod, or your phone, heard of
   * it. A peer already level answers and nothing moves.
   */
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  const announceSoon = () => {
    if (announceTimer) return;
    announceTimer = setTimeout(() => {
      announceTimer = null;
      sync.notifyPeers(connectedPeers());
    }, 100);
  };

  sync.on('expression-received', () => {
    recordsChanged();
    announceSoon();
  });
  sync.on('rejected', (peer: string, _expression: Expression, reason: string) => {
    rejected += 1;
    emit({ type: 'rejected', space: space.id, peer, reason });
  });

  const net = deps.network;
  if (net) {
    const room = encodeURIComponent(space.id);
    // A carrier holds the read key pair without the key it comes from: it may be served the space, and cannot open it.
    const readKey = space.visibility === 'private' ? (key ? await deriveReadKey(key, provider) : (record.read ?? null)) : null;
    if (net.relays?.length) {
      const hashedRoom = await relayRoom(space.id);
      networks.push(
        createNetworkManager({
          did: session.did,
          signalingUrls: net.relays.map((relay) => `${relay}?room=${hashedRoom}`),
          ...(net.iceServers ? { iceServers: net.iceServers } : {}),
          // Every peer met through a relay proves who it is, and in a private space that it may read.
          auth: createMeshAuth(
            space.id,
            session,
            space.visibility === 'private' ? { key: readKey, publicDid: space.readKey ?? '' } : null,
            provider,
          ),
        }),
      );
    }
    // Both sides of a socket to a node prove who they are; in a private space the client also proves it may read.
    const authenticator = net.nodes?.length ? createClientAuth(space.id, session, readKey, provider) : null;
    for (const node of net.nodes ?? []) {
      const url = `${node}${node.includes('?') ? '&' : '?'}space=${room}`;
      networks.push(
        createNetworkManager({
          did: session.did,
          createTransport: () => createWebSocketTransport({ url, did: session.did, authenticator }),
        }),
      );
    }
    for (const transport of net.transports?.(space.id, session.did) ?? []) {
      networks.push(createNetworkManager({ did: session.did, createTransport: () => transport }));
    }
  }

  const connectedPeers = () => [...new Set(networks.flatMap((network) => network.getPeers().map((peer) => peer.did)))];

  for (const network of networks) {
    network.on('message', (message: NetworkMessage) => {
      if (message.type === 'sync') void sync.handleMessage(message.from, message.payload);
    });
    network.on('peer-connected', (info: PeerInfo) => {
      routes.set(info.did, network);
      sync.addPeer(info.did);
      // Reconcile at once rather than waiting for the heartbeat.
      sync.notifyPeers([info.did]);
      emit({ type: 'status', space: space.id });
    });
    network.on('peer-disconnected', (info: PeerInfo) => {
      if (routes.get(info.did) === network) {
        routes.delete(info.did);
        sync.removePeer(info.did);
      }
      emit({ type: 'status', space: space.id });
    });
    network.on('error', () => {
      if (!networks.some((n) => n.isConnected())) connection = 'error';
      emit({ type: 'status', space: space.id });
    });
  }

  if (networks.length > 0) {
    connection = 'connecting';
    void Promise.allSettled(networks.map((network) => network.connect())).then((results) => {
      connection = results.some((result) => result.status === 'fulfilled') ? 'connected' : 'error';
      emit({ type: 'status', space: space.id });
    });
    sync.start();
  }

  // ─── Writers outside this process ──────────────────────────────────
  //
  // A folder can be written by another origin, or by another device behind
  // whatever syncs the folder. Nothing announces it, so it is looked for.

  let watchTimer: ReturnType<typeof setInterval> | null = null;
  if (deps.watchIntervalMs > 0 && isFolderAdapter(adapter)) {
    let running = false;
    watchTimer = setInterval(() => {
      if (running) return;
      running = true;
      // The same verdict as for a version from a peer.
      reconcileFolder(storage, adapter, async (expression) => (await admit(expression)).ok)
        .then((result) => {
          if (!result.changed) return;
          recordsChanged();
          announceSoon();
        })
        .catch(() => {
          // A revoked permission or a folder that went away; the next pass will tell.
        })
        .finally(() => {
          running = false;
        });
    }, deps.watchIntervalMs);
  }

  // Tabs of one browser share one IndexedDB but not memory, so a write in one
  // is invisible to the other until it is told. A nudge is enough: the store
  // already holds the data.
  const channel =
    typeof globalThis.BroadcastChannel === 'function'
      ? new globalThis.BroadcastChannel(`weave-node:${deps.rootDid}:${space.id}`)
      : null;
  if (channel) {
    channel.onmessage = () => recordsChanged();
    // In Node a channel holds the process open; it must never be the only thing doing so.
    (channel as { unref?: () => void }).unref?.();
  }

  // ─── Writing ───────────────────────────────────────────────────────

  interface VersionFields {
    readonly key: string;
    readonly seq: number;
    readonly prev?: string;
    readonly genesis?: string;
  }

  /** Why this account cannot write here at all, or null when it can */
  async function cannotWrite(): Promise<string | null> {
    const { history } = await access();
    if (standing(history.current, deps.rootDid)) return null;
    return waitingInvite
      ? `You've joined "${space.name}", but its invite hasn't reached this device yet — connect to someone in the space first`
      : `"${space.name}" was shared with you to view — you can't change it`;
  }

  /** Signs and stores one version. A delete carries no body. */
  async function write<T>(
    collection: string,
    body: T | null,
    version: VersionFields,
    deleted = false,
    links: ReadonlyArray<Link> = [],
    options: { joining?: boolean; as?: ActiveSession } = {},
  ): Promise<Expression> {
    const writer = options.as ?? session;
    if (deps.peopleOnly && isAgentNote(writer.proof())) throw new Error('An agent can\'t change the account itself. Ask the person to do it.');
    // Every peer would ignore it (see buildEvent); say why here instead.
    if (ACCESS_COLLECTIONS.has(collection) && isAgentNote(writer.proof())) {
      throw new Error(
        collection === CATALOG_COLLECTION
          ? 'An agent can\'t add or change collections. Propose an app instead (apps_propose), and a person in the space adds it.'
          : 'An agent can\'t change who may do what in a space. Ask the person to do it.',
      );
    }
    // Every other copy would refuse it, so refuse it here rather than show a
    // change that exists on this device alone.
    if (!options.joining) {
      const problem = await cannotWrite();
      if (problem) throw new Error(problem);
    }

    let payload: unknown = null;
    if (!deleted) {
      // Refused here, where the writer can fix it. On arrival a misfit is kept
      // and flagged instead — see `conforms`.
      const issues = await contentIssues(collection, body, links);
      if (issues?.length) {
        throw new Error(`Not a valid ${collection}: ${issues.map((i) => (i.path === '/' ? i.message : `${i.path} ${i.message}`)).join('; ')}`);
      }

      // Encrypt *before* signing: peers without the key still verify the
      // signature and relay the record, they just cannot read it.
      payload = body;
      if (space.visibility === 'private' && !IN_THE_CLEAR.has(collection)) {
        if (!key) throw new Error('This private space has no key on this node');
        // Body and links sealed together: a relay learns neither.
        const content = links.length ? { body, links } : { body };
        const sealed = await encryptExpression(
          { id: '', author: '', collection, createdAt: '', body: content, signature: '', key: version.key, seq: version.seq },
          key,
        );
        payload = sealed.body;
      }
    }

    // Whether superseded versions are kept is the writer's decision, carried
    // on the version — never each reader's, or nodes that had seen different
    // definitions would store different things and never converge. The access
    // history keeps everything: it is replayed whole.
    const retain =
      ACCESS_COLLECTIONS.has(collection) ||
      collection === PROFILE_COLLECTION ||
      (await catalog()).get(collection)?.definition.history === 'all';

    const { history, events: held } = await access();
    const signed = await signer.sign(
      createExpression({
        author: writer.did,
        collection,
        space: space.id,
        body: payload,
        proof: writer.proof(),
        version,
        retain,
        deleted,
        seen: history.heads(),
        // In the clear only where the body is: a private space sealed them above.
        ...(space.visibility === 'public' && !deleted && links.length ? { links } : {}),
      }),
      writer.key,
    );

    // The same verdict every other peer will reach: refused here, with the reason, rather than there.
    const judged = await judge(signed);
    if (!judged.verified) throw new Error(judged.reason ?? 'This key may not write here.');
    if (ACCESS_COLLECTIONS.has(collection)) {
      const event = await toEvent(signed);
      if (!event) throw new Error('That is not a well-formed change to who may do what');
      const status = replayAccess(accessGenesis, [...held, event]).status(event.id);
      if (status?.status !== 'applied') throw new Error(status?.status === 'dropped' ? status.reason : 'That change could not be made');
    } else {
      const stands = await standingOf(signed);
      if (!stands.ok) throw new Error(stands.reason);
    }
    await storage.addExpression(signed);
    channel?.postMessage('changed');
    sync.onLocalChange(signed);
    recordsChanged();
    return signed;
  }

  async function get<T>(recordKey: string): Promise<NodeRecord<T> | null> {
    const current = await currentOf(recordKey);
    return current && !current.deleted ? view<T>(current) : null;
  }

  /** The live current version of a record, or a clear error. */
  async function requireLive(recordKey: string): Promise<Expression> {
    const current = await currentOf(recordKey);
    if (!current || current.deleted) throw new Error(`No record ${recordKey} in this space`);
    return current;
  }

  /** The fields for writing a key again: the version after whatever the store holds, counted or not */
  async function after(recordKey: string): Promise<VersionFields> {
    const held = await storage.getCurrent(recordKey);
    return held ? nextVersion(held) : { key: recordKey, seq: 0 };
  }

  async function writeFirst<T>(collection: string, body: T, recordKey: string, links: ReadonlyArray<Link>, as?: ActiveSession): Promise<Expression> {
    const current = await currentOf(recordKey);
    if (current && !current.deleted) throw new Error(`A record ${recordKey} already exists — update it instead`);
    // Writing a key that was deleted brings it back: the next version after the delete.
    return write(collection, body, await after(recordKey), false, links, as ? { as } : {});
  }

  async function upsert<T>(collection: string, recordKey: string, body: T, options: { joining?: boolean } = {}): Promise<NodeRecord<T>> {
    return view<T>(await write(collection, body, await after(recordKey), false, [], options));
  }

  async function removeKey(recordKey: string, as?: ActiveSession): Promise<void> {
    const current = await requireLive(recordKey);
    await write(current.collection, null, await after(current.key), true, [], as ? { as } : {});
  }

  const guard = (collection: string) => {
    if (MANAGED.has(collection)) throw new Error(`${collection} is written by the node itself`);
  };

  /** Display order: when a record was created, then its key. It decides nothing. */
  const createdAtOf = async (version: Expression) => (await genesisOf(version))?.createdAt ?? version.createdAt;

  /**
   * What a change taking power from these people keeps: every record of
   * theirs that counts now — what this node has seen them write.
   */
  async function keepFrom(dids: ReadonlySet<string>): Promise<string[]> {
    const keep: string[] = [];
    for (const version of await everyCurrent()) {
      if (ACCESS_COLLECTIONS.has(version.collection)) continue;
      const root = (await judge(version)).root;
      if (root && dids.has(root)) keep.push(version.id);
    }
    return keep.slice(0, MAX_KEEP);
  }

  /** The rules and standing that decide whether this account may do something now */
  async function mayNow(collection: string, action: 'create' | 'edit' | 'delete', first: Expression | null): Promise<boolean> {
    const { history } = await access();
    const role = standing(history.current, deps.rootDid);
    if (!role) return false;
    const found = await rulesAt(history.current, collection);
    if (!found) return true;
    const who = action === 'create' ? found.rules.create : action === 'delete' ? (found.rules.delete ?? found.rules.edit) : found.rules.edit;
    const creator = !!first && (await judge(first)).root === deps.rootDid;
    return allows(who, { member: true, creator, can: (permission) => roleHolds(role, permissionName(collection, permission)) });
  }

  return Object.freeze({
    async list<T>(options: ListOptions = {}): Promise<ReadonlyArray<NodeRecord<T>>> {
      const current = (await everyCurrent(options.collection)).filter((e) => options.collection || !e.collection.startsWith('sys.'));

      const shown: Array<{ version: Expression; createdAt: string }> = [];
      for (const version of current) {
        if (version.deleted && !options.includeDeleted) continue;
        shown.push({ version, createdAt: await createdAtOf(version) });
      }
      shown.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.version.key.localeCompare(b.version.key));
      if (options.newestFirst) shown.reverse();
      const page = options.limit === undefined ? shown : shown.slice(0, options.limit);
      return Promise.all(page.map(({ version }) => view<T>(version)));
    },

    get,

    async put<T>(collection: string, body: T, options: { key?: string; links?: ReadonlyArray<Link>; as?: ActiveSession } = {}): Promise<NodeRecord<T>> {
      guard(collection);
      if (options.key !== undefined && !RECORD_KEY_PATTERN.test(options.key)) {
        throw new Error('A record key is 1–128 characters of a–z, 0–9 and : . _ -');
      }
      const links = options.links ?? [];
      // One per something: the key is derived from it, so writing again is the next version of the same record.
      const onePer = (await catalog()).get(collection)?.definition.rules?.onePer;
      if (onePer && options.key === undefined) {
        const derived = await onePerKey(collection, onePer, { root: deps.rootDid, links, body });
        if (!derived) throw new Error(`${collection} is one per ${onePer.join(' + ')} — give it every one of those`);
        return view<T>(await write(collection, body, await after(derived), false, links, options.as ? { as: options.as } : {}));
      }
      return view<T>(await writeFirst(collection, body, options.key ?? newRecordKey(), links, options.as));
    },

    async can(action: 'create' | 'edit' | 'delete', target: string): Promise<boolean> {
      if (action === 'create') return mayNow(target, 'create', null);
      const current = await currentOf(target);
      if (!current || current.deleted) return false;
      return mayNow(current.collection, action, await genesisOf(current));
    },

    upsertSystem: <T>(collection: string, recordKey: string, body: T) => upsert<T>(collection, recordKey, body),

    async profiles() {
      return [...(await profileMap()).values()].sort((a, b) => a.name.localeCompare(b.name) || a.did.localeCompare(b.did));
    },

    async publishProfile(profile: { name: string }) {
      // Someone following a space without a role in it cannot write there, and says nothing.
      if (await cannotWrite()) return;
      const name = profile.name.trim().slice(0, 64);
      if (!name || (await profileMap()).get(deps.rootDid)?.name === name) return;
      await upsert(PROFILE_COLLECTION, await profileKey(deps.rootDid), { name });
    },

    async update<T>(recordKey: string, body: T, options: { links?: ReadonlyArray<Link>; as?: ActiveSession } = {}): Promise<NodeRecord<T>> {
      const current = await requireLive(recordKey);
      guard(current.collection);
      // Links carry over unless replaced: ticking a todo should not unhook it from anything.
      const links = options.links ?? (await openBody(current)).links;
      return view<T>(await write(current.collection, body, await after(recordKey), false, links, options.as ? { as: options.as } : {}));
    },

    async linked<T>(recordKey: string, options: { rel?: string; collection?: string } = {}): Promise<ReadonlyArray<NodeRecord<T>>> {
      const pointing = (await linkIndex()).get(recordKey) ?? [];
      const keys = [...new Set(pointing.filter((p) => !options.rel || p.rel === options.rel).map((p) => p.from))];
      const found: NodeRecord<T>[] = [];
      for (const from of keys) {
        const current = await currentOf(from);
        if (!current || current.deleted) continue;
        if (options.collection && current.collection !== options.collection) continue;
        found.push(await view<T>(current));
      }
      return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
    },

    async remove(recordKey: string, options: { as?: ActiveSession } = {}): Promise<void> {
      guard((await requireLive(recordKey)).collection);
      await removeKey(recordKey, options.as);
    },

    removeSystem: removeKey,

    async history<T>(recordKey: string): Promise<ReadonlyArray<NodeRecord<T>>> {
      const versions = await storage.history(recordKey);
      return Promise.all(versions.map((version) => view<T>(version)));
    },

    async collections(): Promise<ReadonlyArray<NodeCollection>> {
      const counts = new Map<string, number>();
      for (const version of await everyCurrent()) {
        if (version.deleted) continue;
        // The protocol's own bookkeeping is not one of the space's kinds of thing.
        if (version.collection.startsWith('sys.')) continue;
        counts.set(version.collection, (counts.get(version.collection) ?? 0) + 1);
      }
      const described = await catalog();
      const names = [...new Set([...described.keys(), ...counts.keys()])].sort();
      return names.map((name) => describe(name, described.get(name) ?? null, counts.get(name) ?? 0));
    },

    async define(input: DefineCollection): Promise<NodeCollection> {
      const recordKey = `collection:${input.name}`;
      const current = (await catalog()).get(input.name) ?? null;
      const version = input.version ?? (current ? current.definition.version + 1 : 1);
      const definition: StoredCollection = {
        name: input.name,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        schema: toJsonSchema(input.schema),
        version,
        ...(input.history !== undefined ? { history: input.history } : {}),
        ...(input.links !== undefined ? { links: input.links } : {}),
        ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
        ...(input.rules !== undefined ? { rules: input.rules } : {}),
        ...(input.screen !== undefined ? { screen: input.screen } : {}),
      };
      const problem = checkStoredCollection(definition);
      if (problem) throw new Error(problem);
      if (current && version <= current.definition.version) {
        throw new Error(`${input.name} is at version ${current.definition.version}; a new definition needs a higher one`);
      }
      await upsert(CATALOG_COLLECTION, recordKey, definition);
      const entry = (await catalog()).get(input.name) ?? null;
      const count = (await everyCurrent(input.name)).filter((e) => !e.deleted).length;
      return describe(input.name, entry, count);
    },

    async undefine(name: string): Promise<void> {
      if (!(await catalog()).has(name)) throw new Error(`${name} is not defined in this space`);
      // Records left behind would lose their shape and their rules, so they go first.
      const left = (await everyCurrent(name)).filter((e) => !e.deleted).length;
      if (left) throw new Error(`${name} still has ${left} record${left === 1 ? '' : 's'}; delete them first`);
      await removeKey(`collection:${name}`);
    },

    async access(): Promise<SpaceAccess> {
      const { history } = await access();
      const state = history.current;
      const role = standing(state, deps.rootDid);
      return Object.freeze({
        roles: [...state.roles.values()].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name)),
        members: [...state.members]
          .map(([did, name]) => ({ did, role: name }))
          .sort((a, b) => (state.roles.get(b.role)?.rank ?? -1) - (state.roles.get(a.role)?.rank ?? -1) || a.did.localeCompare(b.did)),
        invites: [...state.invites].map(([inviteDid, invite]) => ({ key: inviteDid, role: invite.role, open: invite.open })),
        role,
        heads: history.heads(),
      });
    },

    async setMember(did: string, role: string | null) {
      const { history } = await access();
      const was = standing(history.current, did);
      const next = role === null ? null : history.current.roles.get(role);
      if (role !== null && !next) throw new Error(`There is no role "${role}" in "${space.name}"`);
      // Taking power away keeps what this node has seen them write.
      const lowers = was && (!next || next.rank < was.rank || was.permissions.some((p) => !next.permissions.includes(p)));
      const keep = lowers ? await keepFrom(new Set([did])) : [];
      await upsert(MEMBER_COLLECTION, await memberKey(did), { did, role, ...(keep.length ? { keep } : {}) });
    },

    async putRole(role: Role) {
      const problem = checkRole(role);
      if (problem) throw new Error(problem);
      const { history } = await access();
      const was = history.current.roles.get(role.name);
      const lowers = was && (role.rank < was.rank || was.permissions.some((p) => !role.permissions.includes(p)));
      const holders = new Set([...history.current.members].filter(([, name]) => name === role.name).map(([did]) => did));
      const keep = lowers && holders.size ? await keepFrom(holders) : [];
      await upsert(ROLE_COLLECTION, roleKey(role.name), {
        name: role.name,
        ...(role.title !== undefined ? { title: role.title } : {}),
        rank: role.rank,
        permissions: [...role.permissions],
        ...(keep.length ? { keep } : {}),
      });
    },

    async removeRole(name: string) {
      const { history } = await access();
      if (!history.current.roles.has(name)) throw new Error(`There is no role "${name}" in "${space.name}"`);
      const holders = new Set([...history.current.members].filter(([, held]) => held === name).map(([did]) => did));
      const keep = holders.size ? await keepFrom(holders) : [];
      await upsert(ROLE_COLLECTION, roleKey(name), { name, removed: true, ...(keep.length ? { keep } : {}) });
    },

    async openInvite(role: string) {
      const secret = generateInviteSecret();
      const pair = await deriveInviteKey(secret, provider);
      await upsert(INVITE_COLLECTION, await inviteRecordKey(pair.did), { key: pair.did, role, open: true });
      return { secret, key: pair.did };
    },

    async closeInvite(inviteDid: string) {
      const { history } = await access();
      const invite = history.current.invites.get(inviteDid);
      if (!invite) throw new Error('There is no such invite in this space');
      // Who joined with it before this node closed it stays: the close names what it saw, and the replay does the rest.
      await upsert(INVITE_COLLECTION, await inviteRecordKey(inviteDid), { key: inviteDid, role: invite.role, open: false });
    },

    async revoke(token: string) {
      const cid = await noteCid(token);
      const keep: string[] = [];
      for (const version of await everyCurrent()) {
        if (version.proof && (await noteCid(version.proof)) === cid) keep.push(version.id);
      }
      await upsert(REVOKE_COLLECTION, await revokeKey(cid), { note: token, ...(keep.length ? { keep: keep.slice(0, MAX_KEEP) } : {}) });
    },

    async isRevoked(token: string) {
      return (await access()).history.revoked(await noteCid(token)) !== null;
    },

    async join(secret: Uint8Array) {
      const { history } = await access();
      if (standing(history.current, deps.rootDid)) {
        waitingInvite = false;
        deps.onJoined?.();
        return true;
      }
      const pair = await deriveInviteKey(secret, provider);
      const invite = history.current.invites.get(pair.did);
      if (!invite?.open) return false;
      await upsert(
        MEMBER_COLLECTION,
        await memberKey(deps.rootDid),
        { did: deps.rootDid, role: invite.role, invite: { key: pair.did, signature: await signInvite(space.id, deps.rootDid, pair, provider) } },
        { joining: true },
      );
      waitingInvite = false;
      deps.onJoined?.();
      return true;
    },

    async status() {
      return {
        space: space.id,
        connection,
        peers: connectedPeers(),
        root: await storage.getRootCid(),
        rejected,
      };
    },

    async close(): Promise<void> {
      if (watchTimer) clearInterval(watchTimer);
      if (announceTimer) clearTimeout(announceTimer);
      channel?.close();
      sync.stop();
      for (const network of networks) network.disconnect();
      await storage.close();
    },
  });
}
