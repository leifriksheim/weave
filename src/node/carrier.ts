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
import { createLocalHub, type LocalHub } from '../network/local-transport.js';
import { meshFor, openSpaceRuntime, type SpaceRuntime } from './space-runtime.js';
import type { StoreFactory } from './stores.js';
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
  | { readonly type: 'closed' };

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
  subscribe(listener: (event: CarrierEvent) => void): () => void;
  close(): Promise<void>;
}

interface Carried {
  readonly record: SpaceRecord;
  readonly hub: LocalHub;
  readonly runtime: SpaceRuntime;
  pod: Promise<SpaceRuntime> | null;
}

/**
 * Starts a carrier.
 * @throws When the carry invite is not a readable invite to a private space
 */
export async function createCarrierNode(config: CarrierConfig): Promise<CarrierNode> {
  const provider = config.provider ?? createP256Provider();
  const signer = createSigner(provider);
  const schemas = createSchemaEngine();
  const did = publicKeyToDid(await provider.exportPublicKey(config.key.publicKey), P256_MULTICODEC);
  // It never writes, so it never needs a note; the session only names it on the wire.
  const session = { did, key: config.key.privateKey, proof: () => '' };
  // The pod copy is a peer of its own on the local link, so it needs a name of its own.
  const podKeys = await provider.generateKeyPair();
  const podDid = publicKeyToDid(await provider.exportPublicKey(podKeys.publicKey), P256_MULTICODEC);
  const podSession = { did: podDid, key: podKeys.privateKey, proof: () => '' };

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

  // The carry space is joined like any space: it is the one key the carrier holds.
  const registryStore = await config.stores('registry');
  const registry = createSpaceManager(registryStore, provider);
  const carrySpace = parseSpaceInvite(config.carry).space.id;
  const carryRecord = (await registry.get(carrySpace)) ?? (await registry.join(config.carry));
  if (carryRecord.space.visibility !== 'private' || !carryRecord.key) throw new Error('That is not an invite to a carry space.');

  let closed = false;
  let podStores: StoreFactory | null = null;
  const carried = new Map<string, Carried>();

  const mesh = meshFor(config.network, did);
  const open = (record: SpaceRecord, stores: StoreFactory, as: typeof session, network: NodeNetworkConfig, onEvent: (event: NodeEvent) => void) =>
    openSpaceRuntime({
      // The carrier's own spaces meet through relays; its copy in the pod only over the local link.
      ...(as === session && mesh ? { mesh } : {}),
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
    const runtime = await open(record, config.stores, session, network, (event) => {
      if (event.type === 'records' || event.type === 'status') emit({ type: 'status', space: spaceId });
      if (event.type === 'records' && spaceId === carrySpace) void refresh();
    });
    if (closed) return void (await runtime.close());
    const entry: Carried = { record, hub, runtime, pod: null };
    carried.set(spaceId, entry);
    if (podStores) entry.pod = openPod(record, hub, podStores);
  }

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
      if (!closed) console.error('Could not read the carry space:', error);
    });
    return refreshing;
  }

  async function refreshOnce(): Promise<void> {
    const carryRuntime = carried.get(carrySpace)?.runtime;
    if (!carryRuntime || closed) return;
    const records = (await carryRuntime.list<unknown>({ collection: PASS_COLLECTION })).filter(
      (record) => record.verified && record.root === config.account,
    );
    if (records.some((record) => record.key === CARRY_CLOSED_KEY)) {
      emit({ type: 'closed' });
      return;
    }
    const wanted = new Map<string, SpaceRecord>();
    for (const record of records) {
      if (!record.key.startsWith('pass:')) continue;
      const pass = await openPass(record.body, provider);
      if (pass && pass.space.id !== carrySpace) wanted.set(pass.space.id, carriedRecord(pass));
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
      if (spaceId === carrySpace || wanted.has(spaceId)) continue;
      await drop(spaceId);
      changed = true;
    }
    if (changed) emit({ type: 'spaces' });
  }

  await carry(carryRecord);
  await refresh();

  return Object.freeze({
    did,
    carrySpace,

    async spaces() {
      const found: CarriedSpace[] = [];
      for (const [spaceId, entry] of carried) {
        const status = await entry.runtime.status();
        found.push({
          id: spaceId,
          name: entry.record.space.name,
          visibility: entry.record.space.visibility,
          carry: spaceId === carrySpace,
          connection: status.connection,
          peers: status.peers.filter((peer) => peer !== podDid).length,
          inPod: entry.pod !== null,
        });
      }
      return found;
    },

    async usePod(stores: StoreFactory | null) {
      podStores = stores;
      for (const entry of carried.values()) {
        const was = entry.pod;
        entry.pod = null;
        await (await was?.catch(() => null))?.close();
        if (stores) entry.pod = openPod(entry.record, entry.hub, stores);
      }
      emit({ type: 'spaces' });
    },

    subscribe(listener: (event: CarrierEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      await refreshing;
      await Promise.all([...carried.keys()].map((spaceId) => drop(spaceId)));
      await registryStore.close();
      listeners.clear();
    },
  });
}
