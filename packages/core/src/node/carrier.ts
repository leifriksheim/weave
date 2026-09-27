/**
 * @module node/carrier
 * A node that keeps an account's spaces online without being able to read them.
 *
 * It runs in a browser extension, for as long as the browser does: it holds
 * every space the account gave it a pass for (`space/pass.ts`), takes part in
 * each space's gossip, and — when it can reach the person's pod — writes
 * everything into it, so the pod is current even with no app open.
 *
 * What it holds: its own key, the key of its carry space (which holds nothing
 * but passes), and records exactly as they travel — private bodies still
 * encrypted. It has no seed, no space key, no write secret and no note, so it
 * signs nothing and writes nothing. Every record it takes in passes the same
 * gates as at any member's node.
 *
 * **Two copies, two peers.** Each space is kept in the carrier's own database,
 * and — while a pod is attached — in the pod as well, as a second runtime on a
 * local link (`network/local-transport.ts`). Sync keeps them level both ways:
 * the pod catches up on whatever arrived while it was out of reach, and writes
 * another site made to the folder reach the database, and from there the mesh.
 * The pod only ever sees `spaces/<id>`: the account file and its sealed
 * registry are never opened.
 */
import type { CryptoProvider } from '../types.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../identity/did.js';
import { createSigner } from '../schema/signer.js';
import { createSchemaEngine } from '../schema/schema-engine.js';
import { createSpaceManager, parseSpaceInvite, type SpaceRecord } from '../space/space-manager.js';
import { carriedRecord, CARRY_CLOSED_KEY, openPass, PASS_COLLECTION } from '../space/pass.js';
import { matchesSubscription, readCarried, SUBSCRIPTION_COLLECTION, type CarriedSubscription } from '../space/notify.js';
import type { Expression } from '../types.js';
import { createLocalHub, type LocalHub } from '../network/local-transport.js';
import { meshFor, openSpaceRuntime, type SpaceRuntime } from './space-runtime.js';
import type { StoreFactory } from './stores.js';
import type { BlobStore } from '../storage/blob-store.js';
import type { ConnectionState, NodeEvent, NodeNetworkConfig } from './types.js';

export interface CarrierConfig {
  /** Its own key — who it is to peers. Never the account's. */
  readonly key: CryptoKeyPair;
  /** The account it carries for: only passes the account wrote count */
  readonly account: string;
  /** The view-only invite to its carry space */
  readonly carry: string;
  /** Its own copy of every carried space */
  readonly stores: StoreFactory;
  readonly network?: NodeNetworkConfig;
  readonly provider?: CryptoProvider;
  /** How often to look for writes another site made to the pod. Default 2000. */
  readonly watchIntervalMs?: number;
}

/** A space the carrier holds, and how it is doing */
export interface CarriedSpace {
  readonly id: string;
  readonly name: string;
  readonly visibility: 'public' | 'private';
  /** True for the carry space itself, which holds the passes */
  readonly carry: boolean;
  readonly connection: ConnectionState;
  readonly peers: number;
  /** Whether it is being written into the pod now */
  readonly inPod: boolean;
}

export type CarrierEvent =
  /** The set of carried spaces changed */
  | { readonly type: 'spaces' }
  /** Records arrived, or peers came and went, in a space */
  | { readonly type: 'status'; readonly space: string }
  /** The account stopped using this carrier: forget everything */
  | { readonly type: 'closed' }
  /**
   * A record arrived that one of the account's subscriptions asks about. Only
   * what the carrier can see: which subscription, which space, which record.
   */
  | {
      readonly type: 'notify';
      readonly subscription: CarriedSubscriptionView;
      readonly space: { readonly id: string; readonly name: string };
      readonly record: { readonly key: string; readonly collection: string; readonly createdAt: string };
    };

/** A subscription as the carrier holds it: the person's label, what it looks at, where a click goes */
export interface CarriedSubscriptionView {
  readonly id: string;
  readonly label: string;
  readonly collection: string;
  /** The spaces it looks at, by name; empty for every space */
  readonly spaces: ReadonlyArray<string>;
  readonly open?: string;
  readonly paused: boolean;
}

export interface CarrierNode {
  readonly did: string;
  /** The carry space's id */
  readonly carrySpace: string;
  spaces(): Promise<ReadonlyArray<CarriedSpace>>;
  /**
   * Also keeps every carried space in a pod — stores rooted at the account's
   * data path in it. Null stops writing there; the carrier's own copy goes on.
   */
  usePod(stores: StoreFactory | null): Promise<void>;
  /** The account's subscriptions, as this carrier holds them */
  subscriptions(): Promise<ReadonlyArray<CarriedSubscriptionView>>;
  subscribe(listener: (event: CarrierEvent) => void): () => void;
  close(): Promise<void>;
}

interface Carried {
  readonly record: SpaceRecord;
  readonly hub: LocalHub;
  readonly runtime: SpaceRuntime;
  pod: Promise<SpaceRuntime> | null;
}

/** An account's carry space, as a carrying node holds it */
interface Carry {
  readonly account: string;
  /** The spaces its passes named last time they were read */
  wants: ReadonlySet<string>;
  /** Its subscriptions, by key, as last read */
  subscriptions: ReadonlyMap<string, CarriedSubscription>;
}

export interface CarryCoreConfig {
  readonly key: CryptoKeyPair;
  readonly stores: StoreFactory;
  readonly network?: NodeNetworkConfig;
  readonly provider?: CryptoProvider;
  readonly watchIntervalMs?: number;
  readonly emit: (event: CarrierEvent) => void;
  /** An account wrote `carry:closed` into its carry space: it stopped using this node */
  readonly onClosed: (carrySpace: string) => void;
  /** A file store every carried space is also kept in — a host's bucket */
  readonly mirror?: BlobStore;
  /** A space nobody asks for any more was let go — not one opened again after a key change */
  readonly onRelease?: (spaceId: string) => Promise<void>;
}

/**
 * What a carrier and a host share: carry spaces — one per account it carries
 * for — and every space their passes name, each held once however many
 * accounts ask for it.
 */
export async function createCarryCore(config: CarryCoreConfig) {
  const provider = config.provider ?? createP256Provider();
  const signer = createSigner(provider);
  const schemas = createSchemaEngine();
  const { emit } = config;
  const did = publicKeyToDid(await provider.exportPublicKey(config.key.publicKey), P256_MULTICODEC);
  // It never writes, so it never needs a note; the session only names it on the wire.
  const session = { did, key: config.key.privateKey, proof: () => '' };
  // The pod copy is a peer of its own on the local link, so it needs a name of its own.
  const podKeys = await provider.generateKeyPair();
  const podDid = publicKeyToDid(await provider.exportPublicKey(podKeys.publicKey), P256_MULTICODEC);
  const podSession = { did: podDid, key: podKeys.privateKey, proof: () => '' };

  // Carry spaces are joined like any space: their keys are the only ones a carrier holds.
  const registryStore = await config.stores('registry');
  const registry = createSpaceManager(registryStore, provider);

  let closed = false;
  let podStores: StoreFactory | null = null;
  const carries = new Map<string, Carry>();
  const carried = new Map<string, Carried>();

  const mesh = meshFor(config.network, did);
  const open = (
    record: SpaceRecord,
    stores: StoreFactory,
    as: typeof session,
    network: NodeNetworkConfig,
    onEvent: (event: NodeEvent) => void,
    onArrived?: (version: Expression) => void,
  ) =>
    openSpaceRuntime({
      ...(onArrived ? { onArrived } : {}),
      // Carried spaces meet through relays; the copy in the pod only over the local link.
      ...(as === session && mesh ? { mesh } : {}),
      ...(as === session && config.mirror ? { mirrors: [config.mirror] } : {}),
      record,
      stores,
      provider,
      signer,
      schemas,
      session: as,
      rootDid: as.did,
      network,
      watchIntervalMs: config.watchIntervalMs ?? 2000,
      emit: onEvent,
    });

  function openPod(record: SpaceRecord, hub: LocalHub, stores: StoreFactory): Promise<SpaceRuntime> {
    const opening = open(record, stores, podSession, { transports: () => [hub.transport(podDid)] }, () => {});
    opening.catch(() => {
      // A folder that went away, or lost its permission; the carrier's own copy goes on.
      const held = carried.get(record.space.id);
      if (held?.pod === opening) held.pod = null;
      emit({ type: 'status', space: record.space.id });
    });
    return opening;
  }

  async function carry(record: SpaceRecord): Promise<void> {
    const spaceId = record.space.id;
    if (carried.has(spaceId) || closed) return;
    const hub = createLocalHub();
    const network: NodeNetworkConfig = {
      ...config.network,
      transports: (space, sessionDid) => [...(config.network?.transports?.(space, sessionDid) ?? []), hub.transport(did)],
    };
    const runtime = await open(
      record,
      config.stores,
      session,
      network,
      (event) => {
        if (event.type === 'records' || event.type === 'status') emit({ type: 'status', space: spaceId });
        if (event.type === 'records' && carries.has(spaceId)) void refresh();
      },
      (version) => arrived(record, version),
    );
    if (closed) return void (await runtime.close());
    const entry: Carried = { record, hub, runtime, pod: null };
    carried.set(spaceId, entry);
    if (podStores) entry.pod = openPod(record, hub, podStores);
  }

  /** Records already said something about — one can arrive twice, from a peer and from the pod */
  const noticed = new Set<string>();

  /** A record arrived in a space: does any subscription of an account carrying it ask about it? */
  function arrived(record: SpaceRecord, version: Expression): void {
    const spaceId = record.space.id;
    if (noticed.has(version.id) || carries.has(spaceId)) return;
    for (const entry of carries.values()) {
      if (!entry.wants.has(spaceId)) continue;
      for (const [id, sub] of entry.subscriptions) {
        if (!matchesSubscription(sub, spaceId, version, entry.account)) continue;
        noticed.add(version.id);
        if (noticed.size > 1000) noticed.delete(noticed.values().next().value!);
        emit({
          type: 'notify',
          subscription: view(id, sub),
          space: { id: spaceId, name: record.space.name },
          record: { key: version.key, collection: version.collection, createdAt: version.createdAt },
        });
      }
    }
  }

  const view = (id: string, sub: CarriedSubscription): CarriedSubscriptionView => ({
    id,
    label: sub.label,
    collection: sub.collection,
    spaces: sub.spaces === 'all' ? [] : sub.spaces.map((space) => carried.get(space)?.record.space.name ?? 'a space'),
    ...(sub.open ? { open: sub.open } : {}),
    paused: sub.paused,
  });

  async function drop(spaceId: string): Promise<void> {
    const entry = carried.get(spaceId);
    if (!entry) return;
    carried.delete(spaceId);
    await (await entry.pod?.catch(() => null))?.close();
    await entry.runtime.close();
  }

  /** Carries what the passes say, and nothing else. */
  let refreshing: Promise<void> = Promise.resolve();
  function refresh(): Promise<void> {
    refreshing = refreshing.then(refreshOnce).catch((error: unknown) => {
      if (!closed) console.error('Could not read a carry space:', error);
    });
    return refreshing;
  }

  async function refreshOnce(): Promise<void> {
    if (closed) return;
    const wanted = new Map<string, SpaceRecord>();
    for (const [carrySpace, entry] of carries) {
      const carryRuntime = carried.get(carrySpace)?.runtime;
      if (!carryRuntime) continue;
      const records = (await carryRuntime.list<unknown>({ collection: PASS_COLLECTION })).filter(
        (record) => record.verified && record.root === entry.account,
      );
      if (records.some((record) => record.key === CARRY_CLOSED_KEY)) {
        entry.wants = new Set();
        config.onClosed(carrySpace);
        continue;
      }
      const subscriptions = new Map<string, CarriedSubscription>();
      for (const record of await carryRuntime.list<unknown>({ collection: SUBSCRIPTION_COLLECTION })) {
        if (!record.verified || record.root !== entry.account) continue;
        const sub = readCarried(record.body);
        if (sub) subscriptions.set(record.key, sub);
      }
      entry.subscriptions = subscriptions;
      const wants = new Set<string>();
      for (const record of records) {
        if (!record.key.startsWith('pass:')) continue;
        const pass = await openPass(record.body, provider);
        if (!pass || carries.has(pass.space.id)) continue;
        wants.add(pass.space.id);
        // Two accounts naming one space: a pass for a later key beats one for the space's first,
        // since an account whose pass is behind just hasn't caught up yet.
        const known = wanted.get(pass.space.id);
        const later = (read: SpaceRecord['read']) => !!read && read.did !== pass.space.readKey;
        if (!known || (!later(known.read) && later(pass.read))) wanted.set(pass.space.id, carriedRecord(pass));
      }
      entry.wants = wants;
    }
    let changed = false;
    for (const [spaceId, record] of wanted) {
      const held = carried.get(spaceId);
      if (held && held.record.read?.did === record.read?.did) continue;
      // The space's key changed: carried again, proving the new read key.
      if (held) await drop(spaceId);
      await carry(record);
      changed = true;
    }
    for (const spaceId of [...carried.keys()]) {
      if (carries.has(spaceId) || wanted.has(spaceId)) continue;
      await drop(spaceId);
      await config.onRelease?.(spaceId).catch(() => {});
      changed = true;
    }
    if (changed) emit({ type: 'spaces' });
  }

  return {
    did,
    podDid,
    carried: carried as ReadonlyMap<string, Carried>,
    carries: carries as ReadonlyMap<string, Carry>,

    /**
     * Starts carrying for an account: joins its carry space and every space
     * its passes name.
     * @returns The carry space's id
     * @throws When the invite is not a readable invite to a private space
     */
    async addCarry(account: string, invite: string): Promise<string> {
      const carrySpace = parseSpaceInvite(invite).space.id;
      const record = (await registry.get(carrySpace)) ?? (await registry.join(invite));
      if (record.space.visibility !== 'private' || !record.key) {
        await registry.remove(carrySpace);
        throw new Error('That is not an invite to a carry space.');
      }
      if (!carries.has(carrySpace)) carries.set(carrySpace, { account, wants: new Set(), subscriptions: new Map() });
      await carry(record);
      await refresh();
      return carrySpace;
    },

    /** Stops carrying for an account: its carry space, and every space nobody else still asks for */
    async removeCarry(carrySpace: string): Promise<void> {
      if (!carries.delete(carrySpace)) return;
      await drop(carrySpace);
      await registry.remove(carrySpace);
      await config.onRelease?.(carrySpace).catch(() => {});
      await refresh();
    },

    async setPod(stores: StoreFactory | null) {
      podStores = stores;
      for (const entry of carried.values()) {
        const was = entry.pod;
        entry.pod = null;
        await (await was?.catch(() => null))?.close();
        if (stores) entry.pod = openPod(entry.record, entry.hub, stores);
      }
      emit({ type: 'spaces' });
    },

    async subscriptions(): Promise<ReadonlyArray<CarriedSubscriptionView>> {
      await refreshing;
      return [...carries.values()].flatMap((entry) => [...entry.subscriptions].map(([id, sub]) => view(id, sub)));
    },

    async spaces(): Promise<ReadonlyArray<CarriedSpace>> {
      const found: CarriedSpace[] = [];
      for (const [spaceId, entry] of carried) {
        const status = await entry.runtime.status();
        found.push({
          id: spaceId,
          name: entry.record.space.name,
          visibility: entry.record.space.visibility,
          carry: carries.has(spaceId),
          connection: status.connection,
          peers: status.peers.filter((peer) => peer !== podDid).length,
          inPod: entry.pod !== null,
        });
      }
      return found;
    },

    async close() {
      if (closed) return;
      closed = true;
      await refreshing;
      await Promise.all([...carried.keys()].map((spaceId) => drop(spaceId)));
      await registryStore.close();
    },
  };
}

/**
 * Starts a carrier.
 * @throws When the carry invite is not a readable invite to a private space
 */
export async function createCarrierNode(config: CarrierConfig): Promise<CarrierNode> {
  const listeners = new Set<(event: CarrierEvent) => void>();
  const emit = (event: CarrierEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Error in carrier listener:', error);
      }
    }
  };
  const core = await createCarryCore({
    key: config.key,
    stores: config.stores,
    ...(config.network ? { network: config.network } : {}),
    ...(config.provider ? { provider: config.provider } : {}),
    ...(config.watchIntervalMs !== undefined ? { watchIntervalMs: config.watchIntervalMs } : {}),
    emit,
    onClosed: () => emit({ type: 'closed' }),
  });
  const carrySpace = await core.addCarry(config.account, config.carry);

  return Object.freeze({
    did: core.did,
    carrySpace,
    spaces: core.spaces,
    usePod: core.setPod,
    subscriptions: core.subscriptions,

    subscribe(listener: (event: CarrierEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async close() {
      await core.close();
      listeners.clear();
    },
  });
}
