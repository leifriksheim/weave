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
 * A space can also pay for itself: a subscription named `space:<id>` carries
 * that one space, from its pass alone, handed over by any member's device.
 * Anyone may pay into it; what it carries is still only ciphertext.
 *
 * Subscriptions live in the host's own store, next to the carried spaces. The
 * payment side (`packages/cli/src/host/…`) only ever moves a subscription's date.
 */
import type { CryptoProvider, StorageAdapter } from '../types.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { createServerAuth } from '../network/peer-auth.js';
import { utf8Decode, utf8Encode } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';
import { createCarryCore, type CarrierEvent } from './carrier.js';
import type { StoreFactory } from './stores.js';
import type { NodeNetworkConfig } from './types.js';
import type { BlobStore } from '../storage/blob-store.js';
import { deleteMirrored } from '../storage/mirror.js';
import { openPass } from '../space/pass.js';
import { createListeners } from '../utils/events.js';

/** What names a space's own subscription at a host */
const SPACE_SUBSCRIPTION_PREFIX = 'space:';

/** A space's own subscription id: `space:<space id>` */
export const spaceSubscription = (spaceId: string) => `${SPACE_SUBSCRIPTION_PREFIX}${spaceId}`;

/** Someone paying for hosting, as the host knows them */
export interface Subscription {
  /**
   * The subscription key's DID, what every call about it is signed with; or
   * for a space paying for itself, `space:<space id>`
   */
  readonly id: string;
  /** Unix seconds. Past it, the grace period; past that, it is dropped. */
  readonly paidUntil: number;
  /** When it was made, unix seconds */
  readonly since: number;
  /** The account and its carry space, once a device has handed them over */
  readonly carry?: { readonly account: string; readonly space: string; readonly invite: string };
  /** For a space's own subscription: the pass a member's device handed over, once one has */
  readonly pass?: unknown;
  /** The payment provider's reference for whoever pays — nothing else about them is kept */
  readonly customer?: string;
  /** A wallet payment asked for and not yet seen (`packages/cli/src/wallet.ts`) */
  readonly invoice?: Invoice;
}

/** A payment a host asked a wallet for: an exact amount, so the transfer that arrives says whose it is */
export interface Invoice {
  readonly plan: string;
  /** In the token's smallest unit, as a decimal string */
  readonly amount: string;
  /** When it was asked for, unix seconds — a transfer made before it pays nothing */
  readonly at: number;
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
  /**
   * The accounts this host carries for, and no others — someone hosting only
   * themselves and their family. Absent: any account whose subscription is paid.
   */
  readonly allow?: ReadonlyArray<string>;
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
  /**
   * Whether the subscription an account's carry space belongs to may take no
   * more spaces: what it carries stays, and a space its account adds later
   * waits until this says no. The host's storage limit, its own policy.
   */
  readonly full?: (carrySpace: string) => boolean;
}

/** A host, as `createHostNode` starts it */
export type HostNode = Awaited<ReturnType<typeof createHostNode>>;

const SUBSCRIPTION_PREFIX = 'subscription:';

/** The space a subscription is a space's own for, or null for an account's */
const spaceIdOf = (id: string): string | null =>
  id.startsWith(SPACE_SUBSCRIPTION_PREFIX) && id.length > SPACE_SUBSCRIPTION_PREFIX.length && id.length <= 200
    ? id.slice(SPACE_SUBSCRIPTION_PREFIX.length)
    : null;

/** An account this host was not told to carry for */
export class NotAllowedError extends Error {
  constructor() {
    super('This host only carries spaces for the accounts its owner named');
  }
}
/** Where the subscriptions are kept in the bucket */
const BUCKET_PREFIX = 'host/subscriptions/';
const DAY = 24 * 3600;

/** Starts a host */
export async function createHostNode(config: HostConfig) {
  const provider = config.provider ?? createP256Provider();
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const graceSeconds = (config.graceDays ?? 30) * DAY;
  const allowed = (account: string) => !config.allow || config.allow.includes(account);
  const store: StorageAdapter = await config.stores('host');

  const events = createListeners<CarrierEvent>('host');

  const read = async (id: string): Promise<Subscription | null> => {
    const bytes = await store.get(`${SUBSCRIPTION_PREFIX}${id}`);
    // Only `write` below puts anything here; a check would turn a damaged record into a missing one.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- this host's own writes
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
    return (await Promise.all(keys.map((key) => read(key.slice(SUBSCRIPTION_PREFIX.length))))).filter(
      (s): s is Subscription => s !== null,
    );
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
      const subscription: unknown = JSON.parse(utf8Decode(bytes));
      if (isRecord(subscription) && typeof subscription.id === 'string')
        await store.put(`${SUBSCRIPTION_PREFIX}${subscription.id}`, bytes);
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
    emit: events.emit,
    ...(config.full ? { full: config.full } : {}),
    ...(config.mirror
      ? { mirror: config.mirror, onRelease: (spaceId: string) => deleteMirrored(config.mirror!, spaceId) }
      : {}),
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
    if (subscription.pass !== undefined && state(subscription) !== 'lapsed') {
      await core.addPass(subscription.pass).catch((error: unknown) => {
        console.error(`Could not carry for subscription ${subscription.id}:`, error);
      });
      continue;
    }
    // An account taken off the list since is not carried again.
    if (!subscription.carry || state(subscription) === 'lapsed' || !allowed(subscription.carry.account))
      continue;
    await core.addCarry(subscription.carry.account, subscription.carry.invite).catch((error: unknown) => {
      console.error(`Could not carry for subscription ${subscription.id}:`, error);
    });
  }

  /** Whether another subscription still carries this carry space */
  const carriedByOther = async (carrySpace: string, except: string) =>
    (await list()).some((other) => other.id !== except && other.carry?.space === carrySpace);

  /** Makes a subscription if there is none by this id, and returns it */
  const subscribe = async (id: string): Promise<Subscription> => {
    if (!id.startsWith('did:key:') && !spaceIdOf(id))
      throw new Error('A subscription is named by its key, or by the space it is for');
    return (await read(id)) ?? write({ id, paidUntil: 0, since: now() });
  };

  return Object.freeze({
    did: core.did,
    subscribe,
    get: read,
    list,
    /** Whether a subscription is paid, in its grace period, or lapsed */
    state,

    /** Moves a subscription's paid-until date — the one thing payments do */
    async extend(id: string, until: number, customer?: string): Promise<Subscription> {
      const subscription = await subscribe(id);
      const extended = {
        ...subscription,
        paidUntil: Math.max(subscription.paidUntil, until),
        ...(customer ? { customer } : {}),
      };
      await write(extended);
      // Paid again in time: carry again what the grace period had kept.
      if (extended.carry && !core.carries.has(extended.carry.space)) {
        await core.addCarry(extended.carry.account, extended.carry.invite);
      }
      if (extended.pass !== undefined) await core.addPass(extended.pass).catch(() => {});
      return extended;
    },

    /** Sets a paid-until date outright, earlier too: what a fund's estimate says as it is spent */
    async setPaidUntil(id: string, until: number): Promise<Subscription> {
      const subscription = await subscribe(id);
      if (subscription.paidUntil === until) return subscription;
      const set = { ...subscription, paidUntil: until };
      await write(set);
      // Money came back in time: carry again what the grace period had kept.
      if (set.pass !== undefined && state(set) !== 'lapsed') await core.addPass(set.pass).catch(() => {});
      return set;
    },

    /** Keeps a wallet payment asked for, or drops it (null) once it arrived */
    async setInvoice(id: string, invoice: Invoice | null) {
      const { invoice: _before, ...subscription } = await subscribe(id);
      return write(invoice ? { ...subscription, invoice } : subscription);
    },

    /**
     * Starts carrying an account's spaces for a subscription: its carry space,
     * and every space its passes name. Replaces what the subscription carried.
     * @throws When the subscription is lapsed, or the invite is not a carry space's
     */
    async attach(id: string, account: string, invite: string) {
      const subscription = await read(id);
      if (!subscription || state(subscription) === 'lapsed')
        throw new Error('That subscription is not paid for');
      if (!account.startsWith('did:key:')) throw new Error('An account is named by its DID');
      if (!allowed(account)) throw new NotAllowedError();
      const space = await core.addCarry(account, invite);
      const before = subscription.carry;
      const attached = await write({ ...subscription, carry: { account, space, invite } });
      if (before && before.space !== space && !(await carriedByOther(before.space, id)))
        await core.removeCarry(before.space);
      return attached;
    },

    /** Stops carrying for a subscription; the subscription stays */
    async detach(id: string) {
      const subscription = await read(id);
      if (!subscription?.carry) return;
      const { carry, ...rest } = subscription;
      await write(rest);
      if (!(await carriedByOther(carry.space, id))) await core.removeCarry(carry.space);
    },

    /**
     * Carries a space for its own subscription, from a pass. A later pass (the
     * space's key changed) replaces the one before.
     * @throws When the subscription is lapsed, or the pass is not for its space
     */
    async carrySpace(id: string, pass: unknown) {
      const spaceId = spaceIdOf(id);
      if (!spaceId) throw new Error('Only a space’s own subscription carries a space from a pass');
      const subscription = await read(id);
      if (!subscription || state(subscription) === 'lapsed') throw new Error('That space is not paid for');
      const opened = await openPass(pass, provider);
      if (!opened || opened.space.id !== spaceId) throw new Error('That is not a pass for this space');
      await core.addPass(pass);
      return write({ ...subscription, pass });
    },

    /** The read key a space's own subscription carries it with, as a DID: null when public or not carried */
    readKeyOf(id: string) {
      const spaceId = spaceIdOf(id);
      return spaceId ? core.readKeyOf(spaceId) : null;
    },

    /** Drops what lapsed past its grace period. Run now and then. */
    async sweep(): Promise<ReadonlyArray<string>> {
      const dropped: string[] = [];
      for (const subscription of await list()) {
        if (state(subscription) !== 'lapsed') continue;
        await forget(subscription.id);
        const spaceId = spaceIdOf(subscription.id);
        if (spaceId) await core.removePass(spaceId);
        if (subscription.carry && !(await carriedByOther(subscription.carry.space, subscription.id))) {
          await core.removeCarry(subscription.carry.space);
        }
        dropped.push(subscription.id);
      }
      return dropped;
    },

    spaces: core.spaces,
    /** Reads every account's passes again, taking a space that waited for room: after what `full` says changed */
    recheck: () => core.refresh(),

    /** How many spaces a subscription's account asks the host to carry */
    async carriedFor(id: string) {
      const space = (await read(id))?.carry?.space;
      return space ? (core.carries.get(space)?.wants.size ?? 0) : 0;
    },

    /** The spaces a subscription is carried for now: its carry space and those its passes name, or a space's own */
    async spacesOf(id: string): Promise<ReadonlyArray<string>> {
      const subscription = await read(id);
      const own = spaceIdOf(id);
      if (own) return subscription?.pass !== undefined ? [own] : [];
      const space = subscription?.carry?.space;
      return space ? [space, ...(core.carries.get(space)?.wants ?? [])] : [];
    },

    /** For a server taking sockets: checks a connecting peer against the space's history. Null for a space not carried. */
    async authenticator(spaceId: string) {
      const entry = core.carried.get(spaceId);
      if (!entry) return null;
      const read = entry.record.space.visibility === 'private' ? entry.runtime.readAccess() : null;
      return createServerAuth(spaceId, read, config.key.privateKey, provider);
    },

    subscribeEvents: events.subscribe,

    async close() {
      await closing;
      await core.close();
      await store.close();
      events.clear();
    },
  });
}
