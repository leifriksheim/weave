/**
 * @module node/space-runtime
 * One open space: its store, its gatekeeper, its peers, its sync.
 *
 * A space is the unit of storage and of sync — its own Merkle tree, its own
 * rooms and sockets — so two spaces never mix, and a peer you share one space
 * with learns nothing about the others.
 *
 * **Deletes are records.** Removing an expression locally does not delete it
 * anywhere else: the next sync finds it missing and pulls it straight back from
 * a peer. So a delete is a signed tombstone in `sys.tombstone` naming its
 * target. It syncs like anything else, and every node hides the target once it
 * holds a tombstone from someone allowed to write one — the target's own
 * author, or the space's owner. The target itself stays stored; dropping it
 * would only invite it back.
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
import { listMSTKeys } from '../storage/mst.js';
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
import { MEMBERSHIP_COLLECTION } from '../space/account-registry.js';
import type {
  ConnectionState,
  DefineCollection,
  NodeCollection,
  ListOptions,
  NodeEvent,
  NodeNetworkConfig,
  NodeRecord,
  SpaceStatus,
} from './types.js';

/** Where deletes live */
export const TOMBSTONE_COLLECTION = 'sys.tombstone';

/** Collections the node writes itself, through their own calls — never through `put` */
const MANAGED = new Set([TOMBSTONE_COLLECTION, CATALOG_COLLECTION, MEMBERSHIP_COLLECTION]);

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
  get<T>(id: string): Promise<NodeRecord<T> | null>;
  put<T>(collection: string, body: T): Promise<NodeRecord<T>>;
  /** For the node itself: writes one of the collections `put` refuses, like registry memberships */
  putSystem<T>(collection: string, body: T): Promise<NodeRecord<T>>;
  update<T>(id: string, body: T): Promise<NodeRecord<T>>;
  remove(id: string): Promise<void>;
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

/** Total order: time, then id — a content hash, so every node breaks ties the same way. */
function byTime(a: Expression, b: Expression): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export async function openSpaceRuntime(deps: SpaceRuntimeDeps): Promise<SpaceRuntime> {
  const { record, provider, signer, schemas, session, emit } = deps;
  const { space, key } = record;

  const adapter = await deps.stores(`spaces/${space.id}`);
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

  // Records never change — an id is a content hash — so a verdict holds forever.
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

  async function openBody(expression: Expression): Promise<{ body: unknown; encrypted: boolean }> {
    if (!looksEncrypted(expression.body)) return { body: expression.body, encrypted: false };
    if (!key) return { body: null, encrypted: true };
    try {
      const opened = await decryptExpression(expression as EncryptedExpression, key);
      return { body: opened.body, encrypted: true };
    } catch {
      return { body: null, encrypted: true };
    }
  }

  async function view<T>(expression: Expression): Promise<NodeRecord<T>> {
    const [{ body, encrypted }, verdict] = await Promise.all([openBody(expression), judge(expression)]);
    const issues = body === null ? null : await shapeIssues(expression.collection, body);
    return Object.freeze({
      id: expression.id,
      space: space.id,
      collection: expression.collection,
      author: expression.author,
      root: verdict.root,
      createdAt: expression.createdAt,
      body: body as T | null,
      encrypted,
      verified: verdict.verified,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      conforms: issues === null ? null : issues.length === 0,
      ...(issues?.length ? { issues } : {}),
    });
  }

  // ─── The catalogue ─────────────────────────────────────────────────
  //
  // Definitions are records in `sys.collection`. Per name, the latest version
  // wins among those written by the name's first definer or the space owner —
  // so one member cannot redefine another's collection and make their records
  // stop fitting. Every node folds the same records the same way.

  interface CatalogEntry {
    readonly definition: StoredCollection;
    readonly definedBy: string | null;
  }
  let catalogCache: Promise<Map<string, CatalogEntry>> | null = null;
  const catalog = () => (catalogCache ??= loadCatalog());

  async function loadCatalog(): Promise<Map<string, CatalogEntry>> {
    const deleted = await deletedIds();
    const stored = (await storage.queryExpressions(CATALOG_COLLECTION, Number.MAX_SAFE_INTEGER))
      .filter((expression) => !deleted.has(expression.id))
      .sort(byTime);

    const byName = new Map<string, Array<{ expression: Expression; definition: StoredCollection; root: string | null }>>();
    for (const expression of stored) {
      const [opened, verdict] = await Promise.all([openBody(expression), judge(expression)]);
      if (!verdict.verified || checkStoredCollection(opened.body) !== null) continue;
      const definition = opened.body as StoredCollection;
      const list = byName.get(definition.name) ?? [];
      list.push({ expression, definition, root: verdict.root });
      byName.set(definition.name, list);
    }

    const result = new Map<string, CatalogEntry>();
    for (const [name, list] of byName) {
      const definedBy = list[0]!.root; // earliest, by time then id — the same on every node
      const allowed = list.filter((entry) => entry.root === definedBy || entry.root === space.owner);
      const winner = allowed.reduce((best, entry) =>
        entry.definition.version > best.definition.version ||
        (entry.definition.version === best.definition.version && byTime(entry.expression, best.expression) > 0)
          ? entry
          : best,
      );
      result.set(name, { definition: winner.definition, definedBy });
    }
    return result;
  }

  /** Issues with a body against its collection's schema; null when there is no schema to check against. */
  async function shapeIssues(collection: string, body: unknown): Promise<ReadonlyArray<SchemaIssue> | null> {
    if (collection.startsWith('sys.')) return null;
    const described = (await catalog()).get(collection);
    if (described) return validateJsonSchema(described.definition.schema, body);
    if (schemas.getCollection(collection)) {
      const checked = await schemas.validate(collection, body);
      return (checked.issues ?? []).map((issue) => ({ path: '/', message: issue.message }));
    }
    return null;
  }

  function describe(name: string, entry: CatalogEntry | null, records: number): NodeCollection {
    const definition = entry?.definition;
    return Object.freeze({
      name,
      ...(definition?.title !== undefined ? { title: definition.title } : {}),
      ...(definition?.description !== undefined ? { description: definition.description } : {}),
      schema: definition?.schema ?? null,
      version: definition?.version ?? null,
      definedBy: entry?.definedBy ?? null,
      records,
    });
  }

  /** Records changed: the catalogue may have too. */
  const recordsChanged = () => {
    catalogCache = null;
    emit({ type: 'records', space: space.id });
  };

  /** Ids hidden by a tombstone from someone entitled to write it. */
  async function deletedIds(): Promise<Set<string>> {
    const deleted = new Set<string>();
    const stones = await storage.queryExpressions(TOMBSTONE_COLLECTION, Number.MAX_SAFE_INTEGER);
    for (const stone of stones) {
      const [opened, stoneVerdict] = await Promise.all([openBody(stone), judge(stone)]);
      const target = (opened.body as { target?: unknown } | null)?.target;
      if (!stoneVerdict.verified || typeof target !== 'string') continue;

      const targetExpression = await storage.getExpression(target);
      if (!targetExpression) continue; // nothing here to hide yet
      const targetVerdict = await judge(targetExpression);
      if (stoneVerdict.root === targetVerdict.root || stoneVerdict.root === space.owner) {
        deleted.add(target);
      }
    }
    return deleted;
  }

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
      return { valid: verdict.verified, ...(verdict.reason ? { reason: verdict.reason } : {}) };
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
      ? new globalThis.BroadcastChannel(`p2p-node:${deps.rootDid}:${space.id}`)
      : null;
  if (channel) {
    channel.onmessage = () => recordsChanged();
    // In Node a channel holds the process open; it must never be the only thing doing so.
    (channel as { unref?: () => void }).unref?.();
  }

  // ─── Writing ───────────────────────────────────────────────────────

  async function write<T>(collection: string, body: T): Promise<Expression> {
    // Refused here, where the writer can fix it. On arrival a misfit is kept
    // and flagged instead — see `conforms`.
    const issues = await shapeIssues(collection, body);
    if (issues?.length) {
      throw new Error(`Not a valid ${collection}: ${issues.map((i) => (i.path === '/' ? i.message : `${i.path} ${i.message}`)).join('; ')}`);
    }

    // Encrypt *before* signing: peers without the key still verify the
    // signature and relay the record, they just cannot read it.
    let payload: unknown = body;
    if (space.visibility === 'private') {
      if (!key) throw new Error('This private space has no key on this node');
      const sealed = await encryptExpression(
        { id: '', author: '', collection, createdAt: '', body, signature: '' },
        key,
      );
      payload = sealed.body;
    }

    const signed = await signer.sign(
      createExpression({ author: session.did, collection, space: space.id, body: payload, proof: session.proof() }),
      session.key,
    );
    await storage.addExpression(signed);
    channel?.postMessage('changed');
    sync.onLocalChange(signed);
    recordsChanged();
    return signed;
  }

  async function get<T>(id: string): Promise<NodeRecord<T> | null> {
    const expression = await storage.getExpression(id);
    if (!expression || expression.collection === TOMBSTONE_COLLECTION) return null;
    if ((await deletedIds()).has(id)) return null;
    return view<T>(expression);
  }

  async function remove(id: string): Promise<void> {
    const target = await get(id);
    if (!target) throw new Error(`No record ${id} in this space`);
    await write(TOMBSTONE_COLLECTION, { target: id });
  }

  return Object.freeze({
    async list<T>(options: ListOptions = {}): Promise<ReadonlyArray<NodeRecord<T>>> {
      let expressions: Expression[];
      if (options.collection) {
        expressions = await storage.queryExpressions(options.collection, Number.MAX_SAFE_INTEGER);
      } else {
        const ids = await listMSTKeys(adapter, await storage.getRootCid());
        const all = await Promise.all(ids.map((id) => storage.getExpression(id)));
        expressions = all.filter((e): e is Expression => e !== null && !e.collection.startsWith('sys.'));
      }

      const deleted = await deletedIds();
      const kept = (options.includeDeleted ? expressions : expressions.filter((e) => !deleted.has(e.id))).sort(byTime);
      if (options.newestFirst) kept.reverse();
      const page = options.limit === undefined ? kept : kept.slice(0, options.limit);
      return Promise.all(
        page.map(async (expression) => {
          const record = await view<T>(expression);
          return deleted.has(expression.id) ? Object.freeze({ ...record, deleted: true as const }) : record;
        }),
      );
    },

    get,

    async put<T>(collection: string, body: T): Promise<NodeRecord<T>> {
      if (collection === TOMBSTONE_COLLECTION) throw new Error('Use delete to write a tombstone');
      if (MANAGED.has(collection)) throw new Error(`${collection} is written by the node itself`);
      return view<T>(await write(collection, body));
    },

    async putSystem<T>(collection: string, body: T): Promise<NodeRecord<T>> {
      return view<T>(await write(collection, body));
    },

    async collections(): Promise<ReadonlyArray<NodeCollection>> {
      const deleted = await deletedIds();
      const ids = await listMSTKeys(adapter, await storage.getRootCid());
      const counts = new Map<string, number>();
      for (const id of ids) {
        if (deleted.has(id)) continue;
        const expression = await storage.getExpression(id);
        if (!expression || expression.collection.startsWith('sys.')) continue;
        counts.set(expression.collection, (counts.get(expression.collection) ?? 0) + 1);
      }
      const described = await catalog();
      const names = [...new Set([...described.keys(), ...counts.keys()])].sort();
      return names.map((name) => describe(name, described.get(name) ?? null, counts.get(name) ?? 0));
    },

    async define(input: DefineCollection): Promise<NodeCollection> {
      const current = (await catalog()).get(input.name) ?? null;
      const version = input.version ?? (current ? current.definition.version + 1 : 1);
      const definition: StoredCollection = {
        name: input.name,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        schema: input.schema,
        version,
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
      await write(CATALOG_COLLECTION, definition);
      const entry = (await catalog()).get(input.name) ?? null;
      const hidden = await deletedIds();
      const count = (await storage.queryExpressions(input.name, Number.MAX_SAFE_INTEGER)).filter((e) => !hidden.has(e.id)).length;
      return describe(input.name, entry, count);
    },

    async update<T>(id: string, body: T): Promise<NodeRecord<T>> {
      const previous = await get(id);
      if (!previous) throw new Error(`No record ${id} in this space`);
      const next = await write(previous.collection, body);
      await write(TOMBSTONE_COLLECTION, { target: id });
      return view<T>(next);
    },

    remove,

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
