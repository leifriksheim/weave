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
 * every node agrees and nothing replayed can roll a record back. Who may write a
 * version is the space's rule: its owner in a personal space, anyone invited in
 * a shared one — so members of a shared list tick and remove each other's items.
 */
import type { Expression, CryptoProvider, StorageAdapter } from '../types.js';
import type { Signer } from '../schema/signer.js';
import { createSchemaEngine, type SchemaEngine } from '../schema/schema-engine.js';
import type { SpaceRecord } from '../space/space-manager.js';
import type { Capability } from '../identity/ucan.js';
import { resolveDelegationRoot } from '../identity/ucan.js';
import { didToPublicKey } from '../identity/did.js';
import { createExpression } from '../schema/expression.js';
import { createStorageProvider, type StorageProvider } from '../storage/storage-provider.js';
import { newRecordKey, nextVersion, RECORD_KEY_PATTERN } from '../records/version.js';
import { checkLinks } from '../records/links.js';
import { allows, changedFixedField, describeWho, onePerKey, type CollectionRules } from '../records/rules.js';
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
import { createPeerAuthenticator } from '../network/peer-auth.js';
import { createSyncEngine } from '../sync/sync-engine.js';
import type { NetworkMessage, PeerInfo } from '../types.js';
import type { StoreFactory } from './stores.js';
import {
  CATALOG_COLLECTION,
  checkStoredCollection,
  validateJsonSchema,
  type SchemaIssue,
  type StoredCollection,
} from '../schema/collection-def.js';
import { MEMBERSHIP_COLLECTION, PROFILE_COLLECTION } from '../space/account-registry.js';
import { sha256 } from '../utils/hash.js';
import type {
  ConnectionState,
  DefineCollection,
  NodeCollection,
  ListOptions,
  NodeEvent,
  NodeNetworkConfig,
  NodeRecord,
  SpaceProfile,
  SpaceStatus,
} from './types.js';

/** Collections the node writes itself, through their own calls — never through `put` */
const MANAGED = new Set([CATALOG_COLLECTION, MEMBERSHIP_COLLECTION, PROFILE_COLLECTION]);

/**
 * The key of a person's profile record in a space: one per identity, named by
 * a hash of it (record keys are lower case; a did:key is not).
 */
export async function profileKey(did: string): Promise<string> {
  const digest = await sha256(new TextEncoder().encode(did));
  return `profile:${Array.from(digest.subarray(0, 20), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The capability a record in a space requires */
export const writeCapability = (spaceId: string): Capability => ({
  with: `space:${spaceId}`,
  can: 'expression/write',
});

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
}

export interface SpaceRuntime {
  list<T>(options?: ListOptions): Promise<ReadonlyArray<NodeRecord<T>>>;
  get<T>(key: string): Promise<NodeRecord<T> | null>;
  put<T>(collection: string, body: T, options?: { key?: string; links?: ReadonlyArray<Link> }): Promise<NodeRecord<T>>;
  update<T>(key: string, body: T, options?: { links?: ReadonlyArray<Link> }): Promise<NodeRecord<T>>;
  linked<T>(key: string, options?: { rel?: string; collection?: string }): Promise<ReadonlyArray<NodeRecord<T>>>;
  remove(key: string): Promise<void>;
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
  status(): Promise<SpaceStatus>;
  close(): Promise<void>;
}

interface Verdict {
  readonly verified: boolean;
  readonly root: string | null;
  readonly reason?: string;
}

function looksEncrypted(body: unknown): boolean {
  const envelope = body as Record<string, unknown> | null;
  return typeof envelope?.ciphertext === 'string' && typeof envelope?.iv === 'string';
}

function isFolderAdapter(adapter: StorageAdapter): adapter is FolderAdapter {
  return typeof (adapter as FolderAdapter).reload === 'function';
}

export async function openSpaceRuntime(deps: SpaceRuntimeDeps): Promise<SpaceRuntime> {
  const { record, provider, signer, schemas, session, emit } = deps;
  const { space, key } = record;

  const adapter = await deps.stores(`spaces/${space.id}`);
  /** A personal space takes writes from its owner alone; a shared one from anyone in it. */
  const writable = space.type === 'shared' || deps.rootDid === space.owner;
  const storage: StorageProvider = createStorageProvider(adapter);

  const resolvePublicKey = async (did: string) => provider.importPublicKey(didToPublicKey(did).publicKeyBytes);

  const validation = createValidationEngine({
    cryptoGate: createCryptoGate(provider),
    // Shape is not a reason to refuse a record on arrival. Whether it fits can
    // depend on which definition, or which app's schema, a node happens to have;
    // refusing would leave nodes that disagree forever. Shape is checked when a
    // record is written here, and reported as `conforms` when it is read.
    structuralGate: createStructuralGate(createSchemaEngine(), { allowUnknownCollections: true }),
    statefulGate: createStatefulGate(),
    capabilityGate: createCapabilityGate({
      provider,
      requiredCapability: () => writeCapability(space.id),
      // A personal space takes writes from its owner alone. A shared one
      // accepts anyone holding an invite — for a private space, the key too.
      ...(space.type === 'personal' ? { isTrustedRoot: (root: string) => root === space.owner } : {}),
    }),
    resolvePublicKey,
    getExpression: (id) => storage.getExpression(id),
  });

  // Versions never change — an id is a content hash — so a verdict holds forever.
  const verdicts = new Map<string, Verdict>();

  async function judge(expression: Expression): Promise<Verdict> {
    const cached = verdicts.get(expression.id);
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
    }
    verdicts.set(expression.id, verdict);
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

  async function view<T>(expression: Expression): Promise<NodeRecord<T>> {
    const [{ body, links, encrypted }, verdict, genesis] = await Promise.all([
      openBody(expression),
      judge(expression),
      genesisOf(expression),
    ]);
    const creator = genesis ? await judge(genesis) : null;
    const content = body === null || expression.deleted ? null : await contentIssues(expression.collection, body, links);
    const issues =
      content !== null && !expression.deleted && (await withoutRules(expression))
        ? [...content, { path: '/', message: 'Written without this collection\'s rules, so never judged by them' }]
        : content;
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
      verified: verdict.verified,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(expression.deleted ? { deleted: true as const } : {}),
      conforms: issues === null ? null : issues.length === 0,
      ...(issues?.length ? { issues } : {}),
    });
  }

  // ─── The catalogue ─────────────────────────────────────────────────
  //
  // A definition is a record with key `collection:<name>`, and its versions
  // are always retained. So the fold can judge each one by who wrote it: the
  // newest version written by the record's creator or the space owner wins,
  // and one member cannot redefine another's collection. Every node folds the
  // same versions the same way.

  interface CatalogEntry {
    readonly definition: StoredCollection;
    readonly definedBy: string | null;
    /** The id of the version that holds this definition — what a new record pins */
    readonly version: string;
  }
  let catalogCache: Promise<Map<string, CatalogEntry>> | null = null;
  const catalog = () => (catalogCache ??= loadCatalog());

  async function loadCatalog(): Promise<Map<string, CatalogEntry>> {
    const result = new Map<string, CatalogEntry>();
    for (const current of await storage.queryExpressions(CATALOG_COLLECTION)) {
      if (current.deleted) continue;
      const versions = await storage.history(current.key); // newest first
      const genesis = versions.find((v) => v.seq === 0) ?? null;
      const definedBy = genesis ? (await judge(genesis)).root : null;

      for (const version of versions) {
        const [opened, verdict] = await Promise.all([openBody(version), judge(version)]);
        if (!verdict.verified || version.deleted || checkStoredCollection(opened.body) !== null) continue;
        if (verdict.root !== definedBy && verdict.root !== space.owner) continue;
        const definition = opened.body as StoredCollection;
        if (`collection:${definition.name}` !== version.key) continue;
        result.set(definition.name, { definition, definedBy, version: version.id });
        break;
      }
    }
    return result;
  }

  /** A collection's definition: what the space says. The protocol knows no kinds of record of its own. */
  async function definitionOf(collection: string): Promise<StoredCollection | null> {
    return (await catalog()).get(collection)?.definition ?? null;
  }

  /** Issues with a body against its collection's schema; null when there is no schema to check against. */
  async function shapeIssues(collection: string, body: unknown): Promise<ReadonlyArray<SchemaIssue> | null> {
    // The protocol's own bookkeeping — definitions, profiles, memberships — has no user-facing schema.
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
      rules: definition?.rules ?? {},
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
    for (const version of await storage.listCurrent()) {
      if (version.deleted || !(await consistent(version))) continue;
      const { links } = await openBody(version);
      for (const link of links) {
        const list = index.get(link.to) ?? [];
        list.push({ rel: link.rel, from: version.key });
        index.set(link.to, list);
      }
    }
    return index;
  }

  // ─── Rules ─────────────────────────────────────────────────────────
  //
  // A record's first version names the definition version it was written
  // under (`def`); its rules are the ones it is judged by, on every peer, for
  // good. Everything a verdict needs is the record, its first version, that
  // definition and the space's owner — all immutable, all of which a peer
  // either has or will get. So a record that breaks a rule can be refused
  // during sync, and one whose first version or definition has not arrived
  // yet waits instead of being guessed about.

  type Pinned = { readonly name: string; readonly rules: CollectionRules } | 'missing' | 'unreadable' | 'invalid';
  const pinned = new Map<string, Promise<Pinned>>();

  /** The rules in one definition version, if it is a genuine one */
  function definitionAt(id: string): Promise<Pinned> {
    let found = pinned.get(id);
    if (!found) {
      found = (async (): Promise<Pinned> => {
        const version = await storage.getExpression(id);
        if (!version) return 'missing';
        if (version.collection !== CATALOG_COLLECTION || version.deleted) return 'invalid';
        const verdict = await judge(version);
        if (!verdict.verified) return 'invalid';
        // Written by whoever first defined the collection, or the space owner — as the catalogue requires.
        const first = version.seq === 0 ? version : await storage.getExpression(version.genesis!);
        if (!first) return 'missing';
        const definer = (await judge(first)).root;
        if (verdict.root !== definer && verdict.root !== space.owner) return 'invalid';
        const opened = await openBody(version);
        if (opened.body === null) return 'unreadable';
        const definition = opened.body as StoredCollection;
        if (checkStoredCollection(definition) !== null || version.key !== `collection:${definition.name}`) return 'invalid';
        return { name: definition.name, rules: definition.rules ?? {} };
      })();
      pinned.set(id, found);
      // Something missing may turn up; only settled answers are worth keeping.
      void found.then((answer) => answer === 'missing' && pinned.delete(id));
    }
    return found;
  }

  type RuleVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly later?: boolean };
  const OK: RuleVerdict = { ok: true };

  /** Whether a version keeps the rules its record was created under */
  async function ruleVerdict(expression: Expression): Promise<RuleVerdict> {
    if (expression.collection.startsWith('sys.')) return OK;
    const first = expression.seq === 0 ? expression : expression.genesis ? await storage.getExpression(expression.genesis) : null;
    if (!first) return { ok: false, reason: 'Its first version has not arrived yet', later: true };
    if (!first.def) return OK; // written with no rules — see `withoutRules`
    const definition = await definitionAt(first.def);
    if (definition === 'missing') return { ok: false, reason: 'The definition it was written under has not arrived yet', later: true };
    // A peer without the space key cannot read the rules, or the body they talk about; members judge.
    if (definition === 'unreadable') return OK;
    if (definition === 'invalid' || definition.name !== expression.collection) return { ok: false, reason: 'It names a definition that is not this collection\'s' };
    const { rules } = definition;
    const root = (await judge(expression)).root;
    const creator = (await judge(first)).root;

    if (expression.seq === 0) {
      if (!allows(rules.create, root, { owner: space.owner, creator: null })) {
        return { ok: false, reason: `Only ${describeWho(rules.create)} can create ${expression.collection} records` };
      }
      if (rules.onePer) {
        const opened = await openBody(expression);
        if (opened.body === null && opened.encrypted) return OK;
        const expected = await onePerKey(expression.collection, rules.onePer, { root: root ?? '', links: opened.links, body: opened.body });
        if (expected !== expression.key) {
          return { ok: false, reason: `${expression.collection} allows one per ${rules.onePer.join(' + ')} — its key must be derived from them` };
        }
      }
      return OK;
    }

    const action = expression.deleted ? 'delete' : 'edit';
    const who = action === 'delete' ? (rules.delete ?? rules.edit) : rules.edit;
    if (!allows(who, root, { owner: space.owner, creator })) {
      return { ok: false, reason: `Only ${describeWho(who)} can ${action} this ${expression.collection} record` };
    }
    if (!expression.deleted && rules.fixed?.length) {
      const [now, then] = await Promise.all([openBody(expression), openBody(first)]);
      if (now.body !== null && then.body !== null) {
        const field = changedFixedField(rules.fixed, then.body, now.body);
        if (field) return { ok: false, reason: `"${field}" is fixed once a ${expression.collection} record is created` };
      }
    }
    return OK;
  }

  /**
   * Written with no definition pinned, in a collection that now has rules — so
   * never judged by them. Kept (it may predate them), and flagged when read.
   */
  async function withoutRules(version: Expression): Promise<boolean> {
    const rules = (await catalog()).get(version.collection)?.definition.rules;
    if (!rules || Object.keys(rules).length === 0) return false;
    const first = await genesisOf(version);
    return !!first && !first.def;
  }

  // ─── Profiles ──────────────────────────────────────────────────────
  //
  // Each person says who they are in a space with one record, keyed by their
  // identity (`profileKey`), whose versions are always retained — the same
  // trick as the catalogue. The fold takes the newest version signed by the
  // identity the key names, so nobody can rename anyone else: a version
  // written by someone else under your key is simply never the answer, and it
  // cannot push yours out, because yours are kept.

  let profilesCache: Promise<Map<string, SpaceProfile>> | null = null;
  const profileMap = () => (profilesCache ??= loadProfiles());

  async function loadProfiles(): Promise<Map<string, SpaceProfile>> {
    const result = new Map<string, SpaceProfile>();
    for (const current of await storage.queryExpressions(PROFILE_COLLECTION)) {
      if (!current.key.startsWith('profile:')) continue;
      for (const version of await storage.history(current.key)) {
        const verdict = await judge(version);
        if (!verdict.verified || !verdict.root || (await profileKey(verdict.root)) !== current.key) continue;
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

  /** Records changed: the catalogue and the link index may have too. */
  const recordsChanged = () => {
    linkIndexCache = null;
    catalogCache = null;
    profilesCache = null;
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
    sendToPeer: (peerId, data) => {
      routes.get(peerId)?.send(peerId, { type: 'sync', from: session.did, payload: Array.from(data) });
    },
    validate: async (expression) => {
      // An expression may only claim the space it actually arrived in.
      if (expression.space !== space.id) return { valid: false, reason: 'Expression belongs to a different space' };
      const verdict = await judge(expression);
      if (!verdict.verified) return { valid: false, ...(verdict.reason ? { reason: verdict.reason } : {}) };
      const ruled = await ruleVerdict(expression);
      return ruled.ok ? { valid: true } : { valid: false, reason: ruled.reason, ...(ruled.later ? { later: true } : {}) };
    },
  });

  sync.on('expression-received', () => recordsChanged());
  sync.on('rejected', (peer: string, _expression: Expression, reason: string) => {
    rejected += 1;
    emit({ type: 'rejected', space: space.id, peer, reason });
  });

  const net = deps.network;
  if (net) {
    const room = encodeURIComponent(space.id);
    if (net.relays?.length) {
      networks.push(
        createNetworkManager({
          did: session.did,
          signalingUrls: net.relays.map((relay) => `${relay}?room=${room}`),
          ...(net.iceServers ? { iceServers: net.iceServers } : {}),
        }),
      );
    }
    // A private space proves membership to the node before anything moves.
    const authenticator = net.nodes?.length && space.visibility === 'private' && key
      ? await createPeerAuthenticator(space.id, key)
      : null;
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
      if (message.type !== 'sync' || !Array.isArray(message.payload)) return;
      void sync.handleMessage(message.from, new Uint8Array(message.payload as number[]));
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
      reconcileFolder(storage, adapter)
        .then((result) => {
          if (result.changed) recordsChanged();
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

  /** Signs and stores one version. A delete carries no body. */
  async function write<T>(
    collection: string,
    body: T | null,
    version: VersionFields,
    deleted = false,
    links: ReadonlyArray<Link> = [],
  ): Promise<Expression> {
    // Every other copy would reject it, so refuse it here rather than show a
    // change that exists on this device alone.
    if (!writable) throw new Error(`"${space.name}" is a personal space — only its owner can change it`);

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
      if (space.visibility === 'private') {
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
    // definitions would store different things and never converge.
    // A first version pins the definition it is written under — its rules are the record's, for good.
    const def = version.seq === 0 && !collection.startsWith('sys.') ? (await catalog()).get(collection)?.version : undefined;

    const retain =
      collection === CATALOG_COLLECTION ||
      collection === PROFILE_COLLECTION ||
      (await catalog()).get(collection)?.definition.history === 'all';

    const signed = await signer.sign(
      createExpression({
        author: session.did,
        collection,
        space: space.id,
        body: payload,
        proof: session.proof(),
        version,
        retain,
        deleted,
        ...(def ? { def } : {}),
        // In the clear only where the body is: a private space sealed them above.
        ...(space.visibility === 'public' && !deleted && links.length ? { links } : {}),
      }),
      session.key,
    );
    // The same verdict every other peer will reach: refused here, with the reason, rather than there.
    const ruled = await ruleVerdict(signed);
    if (!ruled.ok) throw new Error(ruled.reason);
    await storage.addExpression(signed);
    channel?.postMessage('changed');
    sync.onLocalChange(signed);
    recordsChanged();
    return signed;
  }

  /** The current version of a record this node shows — deletes included, key reuse not. */
  async function currentOf(recordKey: string): Promise<Expression | null> {
    const current = await storage.getCurrent(recordKey);
    return current && (await consistent(current)) ? current : null;
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

  async function writeFirst<T>(collection: string, body: T, recordKey: string, links: ReadonlyArray<Link>): Promise<Expression> {
    const current = await currentOf(recordKey);
    if (current && !current.deleted) throw new Error(`A record ${recordKey} already exists — update it instead`);
    // Writing a key that was deleted brings it back: the next version after the delete.
    return write(collection, body, current ? nextVersion(current) : { key: recordKey, seq: 0 }, false, links);
  }

  async function upsert<T>(collection: string, recordKey: string, body: T): Promise<NodeRecord<T>> {
    const current = await currentOf(recordKey);
    return view<T>(await write(collection, body, current ? nextVersion(current) : { key: recordKey, seq: 0 }));
  }

  async function removeKey(recordKey: string): Promise<void> {
    const current = await requireLive(recordKey);
    await write(current.collection, null, nextVersion(current), true);
  }

  const guard = (collection: string) => {
    if (MANAGED.has(collection)) throw new Error(`${collection} is written by the node itself`);
  };

  /** Display order: when a record was created, then its key. It decides nothing. */
  const createdAtOf = async (version: Expression) => (await genesisOf(version))?.createdAt ?? version.createdAt;

  return Object.freeze({
    async list<T>(options: ListOptions = {}): Promise<ReadonlyArray<NodeRecord<T>>> {
      const current = options.collection
        ? await storage.queryExpressions(options.collection)
        : (await storage.listCurrent()).filter((e) => !e.collection.startsWith('sys.'));

      const shown: Array<{ version: Expression; createdAt: string }> = [];
      for (const version of current) {
        if (version.deleted && !options.includeDeleted) continue;
        if (!(await consistent(version))) continue;
        shown.push({ version, createdAt: await createdAtOf(version) });
      }
      shown.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.version.key.localeCompare(b.version.key));
      if (options.newestFirst) shown.reverse();
      const page = options.limit === undefined ? shown : shown.slice(0, options.limit);
      return Promise.all(page.map(({ version }) => view<T>(version)));
    },

    get,

    async put<T>(collection: string, body: T, options: { key?: string; links?: ReadonlyArray<Link> } = {}): Promise<NodeRecord<T>> {
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
        const current = await currentOf(derived);
        return view<T>(await write(collection, body, current ? nextVersion(current) : { key: derived, seq: 0 }, false, links));
      }
      return view<T>(await writeFirst(collection, body, options.key ?? newRecordKey(), links));
    },

    async can(action: 'create' | 'edit' | 'delete', target: string): Promise<boolean> {
      if (!writable) return false;
      if (action === 'create') {
        return allows((await catalog()).get(target)?.definition.rules?.create, deps.rootDid, { owner: space.owner, creator: null });
      }
      const current = await currentOf(target);
      if (!current || current.deleted) return false;
      const first = await genesisOf(current);
      const definition = first?.def ? await definitionAt(first.def) : null;
      if (!first || !definition || typeof definition === 'string') return true;
      const creator = (await judge(first)).root;
      const who = action === 'delete' ? (definition.rules.delete ?? definition.rules.edit) : definition.rules.edit;
      return allows(who, deps.rootDid, { owner: space.owner, creator });
    },

    upsertSystem: upsert,

    async profiles() {
      return [...(await profileMap()).values()].sort((a, b) => a.name.localeCompare(b.name) || a.did.localeCompare(b.did));
    },

    async publishProfile(profile: { name: string }) {
      // Someone following a personal space cannot write in it, and says nothing.
      if (!writable) return;
      const name = profile.name.trim().slice(0, 64);
      if (!name || (await profileMap()).get(deps.rootDid)?.name === name) return;
      await upsert(PROFILE_COLLECTION, await profileKey(deps.rootDid), { name });
    },

    async update<T>(recordKey: string, body: T, options: { links?: ReadonlyArray<Link> } = {}): Promise<NodeRecord<T>> {
      const current = await requireLive(recordKey);
      guard(current.collection);
      // Links carry over unless replaced: ticking a todo should not unhook it from anything.
      const links = options.links ?? (await openBody(current)).links;
      return view<T>(await write(current.collection, body, nextVersion(current), false, links));
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

    async remove(recordKey: string): Promise<void> {
      guard((await requireLive(recordKey)).collection);
      await removeKey(recordKey);
    },

    removeSystem: removeKey,

    async history<T>(recordKey: string): Promise<ReadonlyArray<NodeRecord<T>>> {
      const versions = await storage.history(recordKey);
      return Promise.all(versions.map((version) => view<T>(version)));
    },

    async collections(): Promise<ReadonlyArray<NodeCollection>> {
      const counts = new Map<string, number>();
      for (const version of await storage.listCurrent()) {
        if (version.deleted || !(await consistent(version))) continue;
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
        schema: input.schema,
        version,
        ...(input.history !== undefined ? { history: input.history } : {}),
        ...(input.links !== undefined ? { links: input.links } : {}),
        ...(input.rules !== undefined ? { rules: input.rules } : {}),
      };
      const problem = checkStoredCollection(definition);
      if (problem) throw new Error(problem);
      if (current) {
        if (deps.rootDid !== current.definedBy && deps.rootDid !== space.owner) {
          throw new Error(`${input.name} was defined by ${current.definedBy}; only they or the space owner can change it`);
        }
        if (version <= current.definition.version) {
          throw new Error(`${input.name} is at version ${current.definition.version}; a new definition needs a higher one`);
        }
      }
      await upsert(CATALOG_COLLECTION, recordKey, definition);
      const entry = (await catalog()).get(input.name) ?? null;
      const count = (await storage.queryExpressions(input.name)).filter((e) => !e.deleted).length;
      return describe(input.name, entry, count);
    },

    async status(): Promise<SpaceStatus> {
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
      channel?.close();
      sync.stop();
      for (const network of networks) network.disconnect();
      await storage.close();
    },
  });
}
