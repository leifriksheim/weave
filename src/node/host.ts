/**
 * @module node/host
 * A carrier that never sleeps, for many accounts: what a hosting service runs.
 *
 * It is the extension's carrier (`node/carrier.ts`) with more than one carry
 * space. Each **subscription** — someone paying for hosting — is a key the
 * account made, a date it is paid until, and once a device hands it over,
 * the account's carry space. The spaces every carry space's passes name are
 * held once, whoever asks for them, so a space shared by two paying members
 * is one space here, online for all its members.
 *
 * Blind, like any carrier: it holds no seed, no space key and no note, signs
 * nothing, and takes in only what passes the same gates as at any member's
 * node. What it learns: which spaces exist, their size, when they change, and
 * — through the carry spaces — which account asked for which.
 *
 * Subscriptions live in the host's own store, next to the carried spaces. The
 * payment side (`cli/src/host/…`) only ever moves a subscription's date.
 */
import type { CryptoProvider, StorageAdapter } from '../types.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { createServerAuth, type ServerAuth } from '../network/peer-auth.js';
import { utf8Decode, utf8Encode } from '../utils/encoding.js';
import { createCarryCore, type CarriedSpace, type CarrierEvent } from './carrier.js';
import type { StoreFactory } from './stores.js';
import type { NodeNetworkConfig } from './types.js';
import type { BlobStore } from '../storage/blob-store.js';
import { deleteMirrored } from '../storage/mirror.js';

/** Someone paying for hosting, as the host knows them */
export interface Subscription {
  /** The subscription key's DID — what every call about it is signed with */
  readonly id: string;
  /** Unix seconds. Past it, the grace period; past that, it is dropped. */
  readonly paidUntil: number;
  /** When it was made, unix seconds */
  readonly since: number;
  /** The account and its carry space, once a device has handed them over */
  readonly carry?: { readonly account: string; readonly space: string; readonly invite: string };
  /** The payment provider's reference for whoever pays — nothing else about them is kept */
  readonly customer?: string;
}

export type SubscriptionState = 'active' | 'grace' | 'lapsed';

export interface HostConfig {
  /** The host's own key — who it is to peers */
  readonly key: CryptoKeyPair;
  readonly stores: StoreFactory;
  readonly network?: NodeNetworkConfig;
  readonly provider?: CryptoProvider;
  /** Days a lapsed subscription is kept, carried, before it is dropped. Default 30. */
  readonly graceDays?: number;
  /** Every subscription counts as paid — for someone hosting only themselves, and for trying it out */
  readonly free?: boolean;
  /** Unix seconds now; for tests */
  readonly now?: () => number;
  /**
   * The host's bucket (`storage/blob/s3.ts`): every carried space is kept
   * there too, in the mirror layout, and so is the list of subscriptions. The
   * host's disk is then only a cache — lose it, and everything comes back.
   * A space nobody pays for any more is deleted from it.
   */
  readonly mirror?: BlobStore;
  readonly watchIntervalMs?: number;
}

export interface HostNode {
  readonly did: string;
  /** Makes a subscription if there is none by this id, and returns it */
  subscribe(id: string): Promise<Subscription>;
  get(id: string): Promise<Subscription | null>;
  list(): Promise<ReadonlyArray<Subscription>>;
  /** Whether a subscription is paid, in its grace period, or lapsed */
  state(subscription: Subscription): SubscriptionState;
  /** Moves a subscription's paid-until date — the one thing payments do */
  extend(id: string, until: number, customer?: string): Promise<Subscription>;
  /**
   * Starts carrying an account's spaces for a subscription: its carry space,
   * and every space its passes name. Replaces what the subscription carried.
   * @throws When the subscription is lapsed, or the invite is not a carry space's
   */
  attach(id: string, account: string, invite: string): Promise<Subscription>;
  /** Stops carrying for a subscription; the subscription stays */
  detach(id: string): Promise<void>;
  /** Drops what lapsed past its grace period. Run now and then. */
  sweep(): Promise<ReadonlyArray<string>>;
  /** Every space carried, for every subscription */
  spaces(): Promise<ReadonlyArray<CarriedSpace>>;
  /** How many spaces a subscription's account asks the host to carry */
  carriedFor(id: string): Promise<number>;
  /** For a server taking sockets: checks a connecting peer against the space's history. Null for a space not carried. */
  authenticator(spaceId: string): Promise<ServerAuth | null>;
  subscribeEvents(listener: (event: CarrierEvent) => void): () => void;
  close(): Promise<void>;
}

const SUBSCRIPTION_PREFIX = 'subscription:';
/** Where the subscriptions are kept in the bucket */
const BUCKET_PREFIX = 'host/subscriptions/';
const DAY = 24 * 3600;

/** Starts a host */
export async function createHostNode(config: HostConfig): Promise<HostNode> {
  const provider = config.provider ?? createP256Provider();
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const graceSeconds = (config.graceDays ?? 30) * DAY;
  const store: StorageAdapter = await config.stores('host');

  const listeners = new Set<(event: CarrierEvent) => void>();
  const emit = (event: CarrierEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Error in host listener:', error);
      }
    }
  };

  const read = async (id: string): Promise<Subscription | null> => {
    const bytes = await store.get(`${SUBSCRIPTION_PREFIX}${id}`);
    return bytes ? (JSON.parse(utf8Decode(bytes)) as Subscription) : null;
  };
  const bucketKey = (id: string) => `${BUCKET_PREFIX}${encodeURIComponent(id)}.json`;
  const write = async (subscription: Subscription): Promise<Subscription> => {
    const bytes = utf8Encode(JSON.stringify(subscription));
    await store.put(`${SUBSCRIPTION_PREFIX}${subscription.id}`, bytes);
    // The bucket's copy is what a host with a new disk starts from.
    await config.mirror?.put(bucketKey(subscription.id), bytes);
    return subscription;
  };
  const forget = async (id: string) => {
    await store.delete(`${SUBSCRIPTION_PREFIX}${id}`);
    await config.mirror?.delete(bucketKey(id));
  };
  const list = async (): Promise<Subscription[]> => {
    const keys = await store.list(SUBSCRIPTION_PREFIX);
    return (await Promise.all(keys.map((key) => read(key.slice(SUBSCRIPTION_PREFIX.length))))).filter((s): s is Subscription => s !== null);
  };

  const state = (subscription: Subscription): SubscriptionState => {
    if (config.free || subscription.paidUntil >= now()) return 'active';
    return subscription.paidUntil + graceSeconds >= now() ? 'grace' : 'lapsed';
  };

  // A fresh disk: the subscriptions come back from the bucket, and the spaces with them.
  if (config.mirror && (await store.list(SUBSCRIPTION_PREFIX)).length === 0) {
    for (const key of await config.mirror.list(BUCKET_PREFIX)) {
      const bytes = await config.mirror.get(key);
      if (!bytes) continue;
      const subscription = JSON.parse(utf8Decode(bytes)) as Subscription;
      if (typeof subscription.id === 'string') await store.put(`${SUBSCRIPTION_PREFIX}${subscription.id}`, bytes);
    }
  }

  /** The subscription an account's carry space belongs to, when it wrote `carry:closed` */
  let closing: Promise<void> = Promise.resolve();
  const core = await createCarryCore({
    key: config.key,
    stores: config.stores,
    ...(config.network ? { network: config.network } : {}),
    provider,
    ...(config.watchIntervalMs !== undefined ? { watchIntervalMs: config.watchIntervalMs } : {}),
    emit,
    ...(config.mirror ? { mirror: config.mirror, onRelease: (spaceId: string) => deleteMirrored(config.mirror!, spaceId) } : {}),
    onClosed: (carrySpace) => {
      // The account stopped using this host: forget its carry space; the subscription stays paid.
      closing = closing.then(async () => {
        for (const subscription of await list()) {
          if (subscription.carry?.space !== carrySpace) continue;
          const { carry: _gone, ...rest } = subscription;
          await write(rest);
        }
        await core.removeCarry(carrySpace);
      });
    },
  });

  // Carry again what was carried before a restart — the store is only a cache of the spaces, but the list is ours.
  for (const subscription of await list()) {
    if (!subscription.carry || state(subscription) === 'lapsed') continue;
    await core.addCarry(subscription.carry.account, subscription.carry.invite).catch((error: unknown) => {
      console.error(`Could not carry for subscription ${subscription.id}:`, error);
    });
  }

  /** Whether another subscription still carries this carry space */
  const carriedByOther = async (carrySpace: string, except: string) =>
    (await list()).some((other) => other.id !== except && other.carry?.space === carrySpace);

  const host: HostNode = {
    did: core.did,

    async subscribe(id: string) {
      if (!id.startsWith('did:key:')) throw new Error('A subscription is named by its key');
      return (await read(id)) ?? write({ id, paidUntil: 0, since: now() });
    },

    get: read,
    list,
    state,

    async extend(id: string, until: number, customer?: string) {
      const subscription = await host.subscribe(id);
      const extended = { ...subscription, paidUntil: Math.max(subscription.paidUntil, until), ...(customer ? { customer } : {}) };
      await write(extended);
      // Paid again in time: carry again what the grace period had kept.
      if (extended.carry && !core.carries.has(extended.carry.space)) {
        await core.addCarry(extended.carry.account, extended.carry.invite);
      }
      return extended;
    },

    async attach(id: string, account: string, invite: string) {
      const subscription = await read(id);
      if (!subscription || state(subscription) === 'lapsed') throw new Error('That subscription is not paid for');
      if (!account.startsWith('did:key:')) throw new Error('An account is named by its DID');
      const space = await core.addCarry(account, invite);
      const before = subscription.carry;
      const attached = await write({ ...subscription, carry: { account, space, invite } });
      if (before && before.space !== space && !(await carriedByOther(before.space, id))) await core.removeCarry(before.space);
      return attached;
    },

    async detach(id: string) {
      const subscription = await read(id);
      if (!subscription?.carry) return;
      const { carry, ...rest } = subscription;
      await write(rest);
      if (!(await carriedByOther(carry.space, id))) await core.removeCarry(carry.space);
    },

    async sweep() {
      const dropped: string[] = [];
      for (const subscription of await list()) {
        if (state(subscription) !== 'lapsed') continue;
        await forget(subscription.id);
        if (subscription.carry && !(await carriedByOther(subscription.carry.space, subscription.id))) {
          await core.removeCarry(subscription.carry.space);
        }
        dropped.push(subscription.id);
      }
      return dropped;
    },

    spaces: core.spaces,

    async carriedFor(id: string) {
      const space = (await read(id))?.carry?.space;
      return space ? (core.carries.get(space)?.wants.size ?? 0) : 0;
    },

    async authenticator(spaceId: string) {
      const entry = core.carried.get(spaceId);
      if (!entry) return null;
      const read = entry.record.space.visibility === 'private' ? entry.runtime.readAccess() : null;
      return createServerAuth(spaceId, read, config.key.privateKey, provider);
    },

    subscribeEvents(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async close() {
      await closing;
      await core.close();
      await store.close();
      listeners.clear();
    },
  };
  return Object.freeze(host);
}
