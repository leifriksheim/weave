/**
 * @module node
 * A node: one identity, the spaces it holds, and everything needed to read,
 * write and sync them — what a tab, a CLI, a daemon and an agent share.
 *
 * **The root key signs once.** A node signs with a session key the root
 * delegates to for an hour at a time, renewed before it runs out: one
 * signature an hour, never one per write.
 */
import { runQuery } from '../query/engine.js';
import {
  nameOf,
  plainQuery,
  type CollectionRef,
  type Include,
  type Query,
  type ResultOf,
} from '../query/types.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import type { Link, SpaceRole } from '../types.js';
import { didOf } from '../identity/did.js';
import {
  delegateCapabilities,
  parseUCAN,
  verifyUCAN,
  type Capability,
  type UCANToken,
} from '../identity/ucan.js';
import { isAgentNote } from '../identity/agent-note.js';
import { createSigner } from '../schema/signer.js';
import { createSchemaEngine } from '../schema/schema-engine.js';
import {
  createSpaceManager,
  encodeSpaceInvite,
  parseSpaceInvite,
  bareInvite,
  previewInvite,
  type InviteLinkOptions,
  type SpaceRecord,
} from '../space/space-manager.js';
import { MANAGE, MAX_KEEPERS, MAX_RELAYS, roleHolds, type Keeper } from '../space/roles.js';
import {
  meshFor,
  noteCid,
  usableRelays,
  openSpaceRuntime,
  type ActiveSession,
  type SpaceRuntime,
} from './space-runtime.js';
import { createServerAuth } from '../network/peer-auth.js';
import { DEFAULT_ICE_SERVERS } from '../network/rtc-transport.js';
import { deriveInviteKey } from '../space/space-access.js';
import { base64UrlDecode, base64UrlEncode } from '../utils/encoding.js';
import { isRecord, unref } from '../utils/guards.js';
import { createListeners } from '../utils/events.js';
import { serial } from '../utils/serial.js';
import { buildNamespaces, callMethod, givenFor, type Namespace, type OwnMethods } from './api.js';
import { onePerKey } from '../records/rules.js';
import {
  contactKeyPair,
  contactPublicKey,
  deriveDoorKeyBytes,
  deriveDoorSignKeyBytes,
  deriveMemberKeyBytes,
  openSealed,
  sealFor,
} from '../identity/contact-key.js';
import { direct as directSchema } from '../schemas/library/publishing.js';
import { openDirect, sealDirect, type DirectBody } from '../privacy/direct.js';
import {
  contact as contactSchema,
  contactRequest as contactRequestSchema,
  door as doorSchema,
  knock as knockSchema,
  knockAnswer as knockAnswerSchema,
  type Contact,
  type ContactRequestRecord,
  type Door,
  type Knock,
  type KnockAnswer,
} from '../schemas/contacts.js';
import {
  checkAnswer,
  clip,
  doorTopic,
  encodeDoorCode,
  KNOCK_TTL_SECONDS,
  knockId,
  MAX_DOOR_RELAYS,
  openKnock,
  parseDoorCode,
  sealKnock,
  signAnswer,
  signPurge,
  type OpenedKnock,
} from '../doors/doors.js';
import { createMailboxClient } from '../network/mailbox.js';
import { team } from '../space/presets.js';
import {
  CARRIER_COLLECTION,
  deriveAccountRegistry,
  deriveContactsSpace,
  MEMBERSHIP_COLLECTION,
  PROFILE_COLLECTION,
  PROFILE_KEY,
  type AccountProfile,
  type Carrier,
  type Membership,
} from '../space/account-registry.js';
import { CARRY_CLOSED_KEY, makePass, PASS_COLLECTION, passKey, type SpacePass } from '../space/pass.js';
import {
  carriedFor,
  checkNotify,
  NOTIFY_COLLECTION,
  SUBSCRIPTION_COLLECTION,
  type NotifySpace,
  type NotifyWhen,
} from '../space/notify.js';
import {
  createHostClient,
  createSpaceHostClient,
  describeHost,
  hostPeerAddress,
  HOSTING_COLLECTION,
  HostError,
  newSubscriptionSeed,
  readStatus,
  subscriptionKey,
  type HostClient,
  type HostDescription,
  type HostPlan,
  type HostStatus,
  type Hosting,
  type SignedStatus,
} from '../session/hosting.js';
import { base32Encode, hashedKey } from '../utils/hash.js';
import type {
  ContactRequest,
  ContactView,
  DoorView,
  KnockView,
  NodeDoors,
  DefineCollection,
  DelegateParams,
  ListOptions,
  NodeConfig,
  NodeEvent,
  NodeRecord,
  NodeAccount,
  NodeCarriers,
  NodeNotifications,
  NotifyView,
  NodeHosting,
  HostingView,
  SpaceHostingView,
  NodeCollections,
  NodeContacts,
  NodeDirect,
  DirectMessage,
  NodeRecords,
  NodeSpaces,
  P2PNode,
  SpaceSummary,
} from './types.js';

/** Everything a session key may do, across every space the node holds */
export const SESSION_CAPABILITY: Capability = { with: '*', can: 'expression/*' };

const DEFAULT_TTL_SECONDS = 3600;

/** How long a removed carrier's space is kept open, for the carrier to hear it was removed */
const FORGET_CARRIER_AFTER_MS = 30 * 24 * 3600 * 1000;

function summarize(record: SpaceRecord): SpaceSummary {
  const { space, key } = record;
  return Object.freeze({
    id: space.id,
    name: space.name,
    visibility: space.visibility,
    creator: space.creator,
    createdAt: space.createdAt,
    readable: space.visibility === 'public' || key !== null,
    writable: record.role !== null,
    role: record.role,
    joining: record.invite !== null,
  });
}

/** Every collection a query reads: its own, and each `include … from` */
function collectionsOf(query: Query): string[] {
  const plain = plainQuery(query);
  const found = new Set<string>();
  if (typeof plain.collection === 'string') found.add(plain.collection);
  const walk = (includes: Readonly<Record<string, Include>> | undefined) => {
    for (const include of Object.values(includes ?? {})) {
      if (typeof include?.from === 'string') found.add(include.from);
      walk(include?.include);
    }
  };
  walk(plain.include);
  return [...found];
}

/** What a rejection says: its message when it has one */
function reasonText(reason: unknown): string {
  return String((isRecord(reason) ? reason.message : undefined) ?? reason);
}

/** Starts a node; call `close()` when done */
export async function createNode(config: NodeConfig): Promise<P2PNode> {
  const provider = config.provider ?? createP256Provider();
  const signer = createSigner(provider);
  const ttl = config.sessionTtlSeconds ?? DEFAULT_TTL_SECONDS;

  const schemas = createSchemaEngine();
  for (const collection of config.collections ?? []) schemas.registerCollection(collection);

  // ─── Session ───────────────────────────────────────────────────────

  const sessionKeys = config.sessionKey ?? (await provider.generateKeyPair());
  const sessionDid = await didOf(sessionKeys.publicKey, provider);

  const delegate = () =>
    config.signer.delegate({
      audience: sessionDid,
      capabilities: [SESSION_CAPABILITY],
      expiration: Math.floor(Date.now() / 1000) + ttl,
    });

  let current: UCANToken = await delegate();
  let closed = false;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRenewal = (inSeconds: number) => {
    renewTimer = setTimeout(() => {
      delegate()
        .then((token) => {
          current = token;
          scheduleRenewal(ttl * 0.75);
        })
        .catch(() => {
          // The signer said no or was unreachable. Keep the delegation we have
          // and ask again soon; writes fail validation once it expires.
          if (!closed) scheduleRenewal(Math.min(60, ttl / 4));
        });
    }, inSeconds * 1000);
    unref(renewTimer);
  };
  scheduleRenewal(ttl * 0.75);

  const session: ActiveSession = {
    did: sessionDid,
    key: sessionKeys.privateKey,
    proof: () => current.encoded,
  };
  const mesh = meshFor(config.network, sessionDid);
  /**
   * A node that writes under an agent's note — an agent on someone's computer
   * running a node of its own. It follows the account, but never writes for
   * it: no list of spaces, no passes, no name. Every peer would ignore those.
   */
  const agentSession = isAgentNote(current.encoded);

  // ─── Events ────────────────────────────────────────────────────────

  const events = createListeners<NodeEvent>('node event');
  const { emit } = events;

  const stopWatchingNetwork = mesh?.subscribe(() => emit({ type: 'network' }));

  // ─── Spaces ────────────────────────────────────────────────────────

  const registryStore = await config.stores('registry', { seal: true });
  const registry = createSpaceManager(registryStore, provider);
  const runtimes = new Map<string, Promise<SpaceRuntime>>();
  /** Spaces with no invite waiting: every change to them would otherwise read the registry to find that out */
  const noInviteWaiting = new Set<string>();
  /**
   * Who is holding each space open. One object per stretch of being held:
   * when the space closes for another reason (leaving it), the object goes,
   * and a release from before does nothing to whoever holds it next.
   */
  const holds = new Map<string, { count: number }>();

  // The account's own space list, kept in a space every device of the account
  // derives for itself. Hidden from `list`; everything else treats it as a space.
  const account = config.accountKey
    ? await deriveAccountRegistry(config.accountKey, config.signer.did, provider)
    : null;
  const accountSpaceId = account?.space.id ?? null;

  // The account's contacts, in a space derived the same way — or, for an app
  // given it by its account home, named in the config. Hidden from `list` too.
  const contactsRecord = config.accountKey
    ? await deriveContactsSpace(config.accountKey, config.signer.did, provider)
    : null;
  const contactsSpaceId = contactsRecord?.space.id ?? config.contactsSpace ?? null;
  // Kept in the node's own list like a joined space, so it can be shared with an app like one.
  if (contactsRecord && !(await registry.get(contactsRecord.space.id))) {
    await joinRegistry(await encodeSpaceInvite(contactsRecord, config.signer.did));
  }
  /** Whether a space is the account's own machinery, not one it uses */
  const hidden = (spaceId: string) => carrySpaces.has(spaceId) || spaceId === contactsSpaceId;

  /** The contact key, for a node allowed to open contact requests */
  const contactKeys = config.contactKey ? await contactKeyPair(config.contactKey) : null;

  /**
   * An invite to a space, naming where its members meet: the relays the space
   * names, or before it names any, this node's — so the joiner finds the
   * inviter even when their app uses other relays.
   */
  async function inviteTo(spaceId: string, options: InviteLinkOptions = {}): Promise<string> {
    const named = (await findRecord(spaceId))?.relays ?? [];
    const own = usableRelays(config.network).slice(0, MAX_RELAYS);
    return registry.createInvite(spaceId, config.signer.did, {
      ...options,
      ...(named.length ? {} : own.length ? { relays: own } : {}),
    });
  }

  async function findRecord(spaceId: string): Promise<SpaceRecord | null> {
    return spaceId === accountSpaceId ? account : registry.get(spaceId);
  }

  async function requireRecord(spaceId: string): Promise<SpaceRecord> {
    const record = await findRecord(spaceId);
    if (!record) throw new Error(`Unknown space: ${spaceId}`);
    return record;
  }

  // Said once per space: the note this node writes under was revoked there.
  const revokedIn = new Set<string>();
  async function checkRevoked(spaceId: string, open: SpaceRuntime): Promise<void> {
    if (revokedIn.has(spaceId) || !(await open.isRevoked(session.proof()))) return;
    revokedIn.add(spaceId);
    emit({ type: 'revoked', space: spaceId });
  }

  /** Runtime events pass through; a change to the account registry is also acted on. */
  const fromRuntime = (event: NodeEvent) => {
    emit(event);
    // Which peers are the account's own is read off the registry's peers, so
    // a device coming or going there changes every open space's status too.
    if (event.type === 'status' && event.space === accountSpaceId) {
      for (const spaceId of runtimes.keys())
        if (spaceId !== accountSpaceId) emit({ type: 'status', space: spaceId });
    }
    if (event.type === 'records')
      void runtimes
        .get(event.space)
        ?.then((rt) => checkRevoked(event.space, rt))
        .catch(() => {});
    if (event.type === 'records' && event.space !== accountSpaceId)
      void keepSpaceHosts(event.space).catch(() => {});
    // A space joined with an invite whose record had not arrived: perhaps it has now.
    if (event.type === 'records' && event.space !== accountSpaceId) void finishJoining(event.space);
    if (event.type === 'records' && event.space === accountSpaceId) {
      emit({ type: 'account' });
      void reconcile();
      // A rename on another device reaches the spaces open here too.
      void publishProfileToOpenSpaces();
    }
  };

  /** The account registry, or why `what` can't be done without it */
  function requireAccount(what: string): Promise<SpaceRuntime> {
    if (!accountSpaceId) return Promise.reject(new Error(`${what} needs the account key`));
    return runtime(accountSpaceId);
  }

  /** What this account wrote in a collection that `check` takes: only it writes its own lists */
  async function ownRecords<T>(
    rt: SpaceRuntime,
    options: ListOptions,
    check: (record: NodeRecord<T>) => boolean = () => true,
  ): Promise<NodeRecord<T>[]> {
    return (await rt.list<T>(options)).filter(
      (record) => record.verified && record.root === config.signer.did && check(record),
    );
  }

  /**
   * The account's profile, from its registry — null without an account key,
   * or before one is set. One record: its current version is the name, by the
   * ordering rule, the same on every device whatever their clocks say.
   */
  async function ownProfile(): Promise<{ name: string; updatedAt: string } | null> {
    if (!accountSpaceId) return null;
    const profile = await (await runtime(accountSpaceId)).get<AccountProfile>(PROFILE_KEY);
    return profile?.verified && profile.root === config.signer.did && typeof profile.body?.name === 'string'
      ? { name: profile.body.name, updatedAt: profile.updatedAt }
      : null;
  }
  const ownName = async () => (await ownProfile())?.name ?? null;

  /** Whether a space is the account's own machinery: its registry, its contacts, a carry space */
  const ownSpace = (spaceId: string) => spaceId === accountSpaceId || hidden(spaceId);

  /**
   * Tells a space who this account is. Done when the space opens and when the
   * name changes — not by opening every space, which would start syncing them
   * all; a space not open now hears on its next open.
   */
  async function publishProfile(spaceId: string, open: SpaceRuntime): Promise<void> {
    if (spaceId === accountSpaceId || spaceId === contactsSpaceId || agentSession) return;
    const name = await ownName();
    if (name)
      await open.publishProfile({ name, ...(contactKeys ? { contactKey: contactKeys.publicKey } : {}) });
  }

  async function publishProfileToOpenSpaces(): Promise<void> {
    for (const [spaceId, open] of runtimes) {
      await open.then((rt) => publishProfile(spaceId, rt)).catch(() => {});
    }
  }

  function runtime(spaceId: string): Promise<SpaceRuntime> {
    if (closed) return Promise.reject(new Error('Node is closed'));
    let open = runtimes.get(spaceId);
    if (!open) {
      open = requireRecord(spaceId).then(async (record) =>
        openSpaceRuntime({
          record,
          stores: config.stores,
          provider,
          signer,
          schemas,
          session,
          rootDid: config.signer.did,
          ...(config.network ? { network: config.network } : {}),
          ...(mesh ? { mesh } : {}),
          peopleOnly: ownSpace(spaceId),
          // The account's own spaces are always held whole: every device needs all of them.
          ...(config.cache && !ownSpace(spaceId) ? { cache: config.cache } : {}),
          watchIntervalMs: config.watchIntervalMs ?? 2000,
          emit: fromRuntime,
          onRole: (role) => {
            if (spaceId === accountSpaceId) return;
            // Holding a role now — perhaps just joined — means the space may hear who this is.
            if (role !== null)
              void runtimes
                .get(spaceId)
                ?.then((rt) => publishProfile(spaceId, rt))
                .catch(() => {});
            if (role !== null) void keepSpaceHosts(spaceId).catch(() => {});
            if (record.role === role) return;
            void registry.setRole(spaceId, role).then(() => emit({ type: 'spaces' }));
          },
          onJoined: () => {
            if (!record.invite) return;
            void registry.clearInvite(spaceId).then(() => emit({ type: 'spaces' }));
          },
          memberKey:
            spaceId === accountSpaceId
              ? null
              : config.accountKey
                ? await deriveMemberKeyBytes(config.accountKey, spaceId)
                : (record.memberKey ?? null),
          onRelays: async (relays) => {
            if (spaceId !== accountSpaceId) await registry.setRelays(spaceId, relays);
          },
          onKeys: async (keys, current) => {
            if (spaceId === accountSpaceId) return;
            await registry.addKeys(spaceId, keys, current);
            // The account's other devices, and its carriers, follow the new key.
            await remember(spaceId, { refresh: true });
            void reconcile();
          },
        }),
      );
      // A failed open must not be cached, or the space stays broken until restart.
      open.catch(() => runtimes.delete(spaceId));
      void open.then((rt) => publishProfile(spaceId, rt)).catch(() => {});
      // A revoke that arrived on an earlier visit.
      void open.then((rt) => checkRevoked(spaceId, rt)).catch(() => {});
      // Carriers added since this space was last open.
      void open.then((rt) => nameKeepers(spaceId, rt)).catch(() => {});
      runtimes.set(spaceId, open);
      // The hosts the account or the space uses, reached over their sockets.
      void open.then(() => reachHosts(spaceId)).catch(() => {});
    }
    return open;
  }

  /** A method that opens the space its first argument names, and asks its runtime */
  const perSpace =
    <A extends unknown[], R>(call: (rt: SpaceRuntime, ...args: A) => R | Promise<R>) =>
    async (spaceId: string, ...args: A): Promise<R> =>
      call(await runtime(spaceId), ...args);

  /**
   * Uses a waiting invite, once its record has reached this device. Asked
   * again while it is still working, it runs once more afterwards — the
   * record that makes the difference may be the one that arrived meanwhile.
   */
  const joining = new Map<string, () => Promise<void>>();
  /** Takes in an invite; the space it is for may now have one waiting */
  async function joinRegistry(invite: string): Promise<SpaceRecord> {
    const record = await registry.join(invite);
    noInviteWaiting.delete(record.space.id);
    return record;
  }
  function finishJoining(spaceId: string): Promise<void> {
    if (noInviteWaiting.has(spaceId)) return Promise.resolve();
    let run = joining.get(spaceId);
    if (!run) joining.set(spaceId, (run = serial(() => joinOnce(spaceId))));
    return run();
  }
  async function joinOnce(spaceId: string): Promise<void> {
    if (closed) return;
    const record = await registry.get(spaceId);
    if (!record?.invite) return void noInviteWaiting.add(spaceId);
    const { invite } = record;
    // Not yet, perhaps; the next change to the space tries again.
    await runtime(spaceId)
      .then((rt) => rt.join(invite))
      .catch(() => {});
  }

  async function closeRuntime(spaceId: string): Promise<void> {
    holds.delete(spaceId);
    reaching.delete(spaceId);
    const open = runtimes.get(spaceId);
    if (!open) return;
    runtimes.delete(spaceId);
    await (await open).close();
  }

  // ─── Memberships ───────────────────────────────────────────────────
  //
  // One record per space in the registry, key `space:<id>`, holding its
  // invite. Current and live: the account belongs to the space. Current and
  // deleted: it left — and rejoining is simply the next version. Every device
  // converges on the same answer, because it is the same record.

  const membershipKey = (spaceId: string) => `space:${spaceId}`;

  /** The space key an invite carries, if it can be read */
  const inviteKeyOf = (invite: unknown) => {
    try {
      return typeof invite === 'string' ? parseSpaceInvite(invite).key : undefined;
    } catch {
      return undefined;
    }
  };

  async function memberships(): Promise<ReadonlyArray<NodeRecord<Membership>>> {
    if (!accountSpaceId) return [];
    return ownRecords<Membership>(
      await runtime(accountSpaceId),
      { collection: MEMBERSHIP_COLLECTION, includeDeleted: true },
      (record) =>
        record.deleted ||
        (typeof record.body?.space === 'string' && record.key === membershipKey(record.body.space)),
    );
  }

  /**
   * Records in the registry that the account belongs to a space. With
   * `refresh`, rewrites the record if the space's key changed since, so a
   * new device joins with the key in use now.
   */
  async function remember(spaceId: string, options: { refresh?: boolean } = {}): Promise<void> {
    if (!accountSpaceId || agentSession) return;
    const open = await runtime(accountSpaceId);
    const known = await open.get<Membership>(membershipKey(spaceId));
    // A view-only invite: what lets the account write is its role in the
    // space, which every device reads there. Invite secrets are never kept.
    const invite = await inviteTo(spaceId);
    if (
      known &&
      (!options.refresh || known.deleted || inviteKeyOf(known.body?.invite) === inviteKeyOf(invite))
    )
      return;
    await open.upsertSystem<Membership>(MEMBERSHIP_COLLECTION, membershipKey(spaceId), {
      space: spaceId,
      invite,
    });
  }

  async function forget(spaceId: string): Promise<void> {
    if (!accountSpaceId) return;
    const open = await runtime(accountSpaceId);
    if (await open.get(membershipKey(spaceId))) await open.removeSystem(membershipKey(spaceId));
  }

  // ─── Carriers ──────────────────────────────────────────────────────
  //
  // One record per carrier in the registry, naming the carry space shared with
  // it. Every device of the account opens that space and keeps a pass in it
  // for each of the account's spaces (`space/pass.ts`) — so a space joined in
  // any app is carried, with nothing to do in the home.

  const carrierKey = async (spaceId: string) => (await passKey(spaceId)).replace(/^pass:/, 'carrier:');

  /**
   * Carrier records the account wrote, live and removed, each with its carry
   * space — for a removed one, as its last version with a body said.
   */
  async function carrierRecords(): Promise<
    ReadonlyArray<{ readonly record: NodeRecord<Carrier>; readonly space: string }>
  > {
    if (!accountSpaceId) return [];
    const open = await runtime(accountSpaceId);
    const found: Array<{ record: NodeRecord<Carrier>; space: string }> = [];
    for (const record of await ownRecords<Carrier>(open, {
      collection: CARRIER_COLLECTION,
      includeDeleted: true,
    })) {
      if (!record.deleted) {
        if (typeof record.body?.space === 'string' && typeof record.body.invite === 'string')
          found.push({ record, space: record.body.space });
        continue;
      }
      const before = (await open.history<Carrier>(record.key)).find(
        (version) => typeof version.body?.space === 'string',
      );
      if (before?.body) found.push({ record, space: before.body.space });
    }
    return found;
  }

  /** Every carry space, live or not — kept out of the account's own list */
  let carrySpaces = new Set<string>();

  /**
   * Puts a pass in a carrier's space for each of the account's spaces, and
   * takes away the rest; and its subscriptions, with each value replaced by
   * the space's tag: the carrier matches, never learns.
   */
  async function syncPasses(carrier: Carrier): Promise<void> {
    if (!account || agentSession) return;
    const passes = new Map<string, SpacePass>();
    const spaces: NotifySpace[] = [];
    // The registry and the contacts too, so a restore can come through the carrier.
    passes.set(await passKey(account.space.id), await makePass(account));
    if (contactsRecord) passes.set(await passKey(contactsRecord.space.id), await makePass(contactsRecord));
    for (const membership of await memberships()) {
      if (membership.deleted || !membership.body || hidden(membership.body.space)) continue;
      const record = await registry.get(membership.body.space);
      if (!record) continue;
      spaces.push({ id: record.space.id, key: record.key, visibility: record.space.visibility });
      try {
        passes.set(await passKey(record.space.id), await makePass(record));
      } catch {
        // Held without its key — nothing to pass on until it arrives.
      }
    }
    const carry = await runtime(carrier.space);
    await writeExactly(carry, PASS_COLLECTION, passes, (key) => key.startsWith('pass:'));
    const subscriptions = new Map<string, unknown>();
    for (const view of await notifyRecords()) subscriptions.set(view.id, await carriedFor(view, spaces));
    await writeExactly(carry, SUBSCRIPTION_COLLECTION, subscriptions, () => true);
  }

  /** Makes what this account wrote in a collection, among the keys `mine` takes, say exactly `wanted` */
  async function writeExactly(
    rt: SpaceRuntime,
    collection: string,
    wanted: ReadonlyMap<string, unknown>,
    mine: (key: string) => boolean,
  ): Promise<void> {
    const held = new Map(
      (await ownRecords(rt, { collection, includeDeleted: true }, (record) => mine(record.key))).map(
        (record) => [record.key, record],
      ),
    );
    for (const [key, body] of wanted) {
      const current = held.get(key);
      if (!current || current.deleted || JSON.stringify(current.body) !== JSON.stringify(body))
        await rt.upsertSystem(collection, key, body);
      held.delete(key);
    }
    for (const [key, record] of held) if (!record.deleted) await rt.removeSystem(key);
  }

  /** The account's subscriptions, as it made them */
  async function notifyRecords(): Promise<ReadonlyArray<NotifyView>> {
    if (!accountSpaceId) return [];
    const found = await ownRecords<NotifyWhen>(
      await runtime(accountSpaceId),
      { collection: NOTIFY_COLLECTION },
      (record) => record.key.startsWith('notify:') && checkNotify(record.body) === null,
    );
    return found
      .map((record) => ({ ...record.body!, id: record.key }))
      .sort((a, b) => a.since.localeCompare(b.since));
  }

  /** The carriers the account uses now */
  const liveCarriers = async (): Promise<Carrier[]> =>
    (await carrierRecords()).flatMap(({ record }) => (!record.deleted && record.body ? [record.body] : []));

  /** Every carrier gets the subscriptions as they are now */
  async function passSubscriptionsOn(): Promise<void> {
    for (const carrier of await liveCarriers()) await syncPasses(carrier).catch(() => {});
  }

  /**
   * Names the account's carriers — its extensions, its hosts — as keepers of
   * a space it manages, and stops naming ones it removed, so apps there hold
   * only what they use. Other keepers the space names stay. Done as each space
   * opens and whenever the carriers change; a space this account doesn't
   * manage is left to whoever does.
   */
  async function nameKeepers(spaceId: string, rt: SpaceRuntime): Promise<void> {
    if (!account || agentSession || spaceId === accountSpaceId || hidden(spaceId)) return;
    const access = await rt.access();
    if (!roleHolds(access.role, MANAGE)) return;
    const carriers = await carrierRecords();
    const active = await liveCarriers();
    const gone = new Set<string>();
    for (const { record } of carriers) {
      if (!record.deleted) continue;
      for (const version of await (await runtime(accountSpaceId!)).history<Carrier>(record.key))
        if (version.body?.did) gone.add(version.body.did);
    }
    for (const carrier of active) gone.delete(carrier.did);
    const kept = access.keepers.filter((keeper) => !gone.has(keeper.did));
    const added = active
      .filter((carrier) => !kept.some((keeper) => keeper.did === carrier.did))
      .map((c) => ({ did: c.did, name: c.name.slice(0, 80) }));
    if (added.length === 0 && kept.length === access.keepers.length) return;
    await rt.setKeepers([...kept, ...added].slice(0, MAX_KEEPERS), access.copies);
  }

  /**
   * Makes this node's spaces match the account's: join what the account
   * belongs to, leave what it left, and record anything held here that the
   * registry has never heard of.
   */
  async function reconcileOnce(): Promise<void> {
    if (!accountSpaceId || closed) return;
    const held = new Set((await registry.list()).map((record) => record.space.id));
    const known = new Set<string>();
    let changed = false;

    // Carry spaces first: they are the account's, but not spaces it uses.
    const carriers = await carrierRecords();
    carrySpaces = new Set([...carrySpaces, ...carriers.map(({ space }) => space)]);
    for (const { record, space: spaceId } of carriers) {
      if (record.deleted) {
        // Removed on some device. Its carry space stays open a while, so the
        // carrier — perhaps offline now — still hears that it should forget.
        if (!held.has(spaceId) || Date.now() - Date.parse(record.updatedAt) < FORGET_CARRIER_AFTER_MS)
          continue;
        await closeRuntime(spaceId);
        await registry.remove(spaceId);
        held.delete(spaceId);
      } else if (!held.has(spaceId)) {
        try {
          await joinRegistry(record.body!.invite);
          held.add(spaceId);
        } catch {
          // An unreadable invite; the next version written for it will do.
        }
      }
    }
    for (const spaceId of carrySpaces) known.add(spaceId);
    // Derived on every device: nothing to record.
    if (contactsSpaceId) known.add(contactsSpaceId);

    for (const membership of await memberships()) {
      const spaceId = membership.key.slice('space:'.length);
      known.add(spaceId);
      if (!membership.deleted && !held.has(spaceId)) {
        try {
          await joinRegistry(membership.body!.invite);
          changed = true;
        } catch {
          // An unreadable invite; the next version written for it will do.
        }
      } else if (membership.deleted && held.has(spaceId)) {
        // The account left it, on some device.
        await closeRuntime(spaceId);
        await registry.remove(spaceId);
        changed = true;
      }
    }

    // Held here but never recorded — joined before the registry existed, or on
    // a node without the account key. Recorded now, so other devices follow.
    for (const spaceId of held) {
      if (!known.has(spaceId)) await remember(spaceId);
    }

    for (const { record, space: spaceId } of carriers) {
      if (record.deleted || !record.body || !held.has(spaceId)) continue;
      // Only a device that may write in the carry space can do this; others leave it to one that can.
      await syncPasses(record.body).catch(() => {});
    }
    // Carriers came or went: the open spaces this account manages say so.
    for (const [spaceId, open] of runtimes) void open.then((rt) => nameKeepers(spaceId, rt)).catch(() => {});
    // Not awaited: a host that is slow to answer must not hold up the rest.
    void keepHosted().catch(() => {});
    // Hosts came or went: every open space holds a socket to those the account uses now.
    for (const spaceId of runtimes.keys()) void reachHosts(spaceId).catch(() => {});

    if (changed) emit({ type: 'spaces' });
  }

  const reconcile = serial(() =>
    reconcileOnce().catch((error: unknown) => {
      if (!closed) console.error('Could not reconcile the account registry:', error);
    }),
  );

  const spaces = Object.freeze<NodeSpaces>({
    async list() {
      return (await registry.list()).filter((record) => !hidden(record.space.id)).map(summarize);
    },

    async get(spaceId) {
      const record = await findRecord(spaceId);
      return record ? summarize(record) : null;
    },

    async create(params) {
      const record = await registry.create({
        name: params.name,
        visibility: params.visibility,
        creator: config.signer.did,
        ...(params.roles ? { roles: params.roles } : {}),
        ...(params.creatorRole ? { creatorRole: params.creatorRole } : {}),
      });
      await remember(record.space.id);
      emit({ type: 'spaces' });
      return summarize(record);
    },

    async invite(spaceId, options = {}) {
      if (options.write === false) return inviteTo(spaceId);
      const open = await runtime(spaceId);
      const { roles, role: mine } = await open.access();
      // By default the lowest role below your own; with none below you, a view-only invite.
      const role =
        options.role ??
        (mine ? [...roles].reverse().find((candidate) => candidate.rank < mine.rank)?.name : undefined);
      if (!role) {
        if (options.role !== undefined || !mine)
          throw new Error(
            mine
              ? `There is no role "${options.role}"`
              : 'You hold no role here, so you can only share it to view',
          );
        return inviteTo(spaceId);
      }
      const { secret } = await open.openInvite(role);
      return inviteTo(spaceId, { secret, role });
    },

    preview: previewInvite,

    async join(invite, options = {}) {
      const record = await joinRegistry(bareInvite(invite));
      if (options.memberKey) await registry.setMemberKey(record.space.id, options.memberKey);
      // A runtime opened before the key arrived would still be unable to read.
      await closeRuntime(record.space.id);
      await remember(record.space.id);
      // Uses the invite now if its record is here already — otherwise when it arrives.
      await finishJoining(record.space.id);
      emit({ type: 'spaces' });
      return summarize((await registry.get(record.space.id)) ?? record);
    },

    async leave(spaceId) {
      if (spaceId === accountSpaceId) throw new Error('The account registry cannot be left');
      if (spaceId === contactsSpaceId) throw new Error('The contacts space cannot be left');
      await forget(spaceId);
      await closeRuntime(spaceId);
      await registry.remove(spaceId);
      emit({ type: 'spaces' });
    },

    async hold(spaceId) {
      const held = holds.get(spaceId) ?? holds.set(spaceId, { count: 0 }).get(spaceId)!;
      held.count += 1;
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        if (holds.get(spaceId) !== held) return;
        held.count -= 1;
        if (held.count === 0) await closeRuntime(spaceId);
      };
      try {
        await runtime(spaceId);
      } catch (error) {
        await release();
        throw error;
      }
      return release;
    },

    send: perSpace((rt, message: unknown, to?: string) => rt.send(message, to)),

    async status(spaceId) {
      const status = await (await runtime(spaceId)).status();
      if (!accountSpaceId) return { ...status, own: [], carriers: [] };
      // A peer's key does not say whose it is. But only this account's devices
      // and apps can read the account registry, so a peer there is one of ours
      // — except a carrier, which the registry names by its key.
      const carrierKeys = new Set((await liveCarriers()).map((carrier) => carrier.did));
      const inRegistry = new Set((await (await runtime(accountSpaceId)).status()).peers);
      return {
        ...status,
        own: status.peers.filter((peer) => inRegistry.has(peer) && !carrierKeys.has(peer)),
        carriers: status.peers.filter((peer) => carrierKeys.has(peer)),
      };
    },

    profiles: perSpace((rt) => rt.profiles()),
    access: perSpace((rt) => rt.access()),
    setMember: perSpace((rt, did: string, role: string | null) => rt.setMember(did, role)),
    putRole: perSpace((rt, role: SpaceRole) => rt.putRole(role)),
    removeRole: perSpace((rt, name: string) => rt.removeRole(name)),

    async closeInvite(spaceId, keyOrLink) {
      let key = keyOrLink;
      // The link itself will do: its secret names the invite.
      if (!keyOrLink.startsWith('did:key:')) {
        const secret = parseSpaceInvite(bareInvite(keyOrLink)).invite;
        if (!secret)
          throw new Error(
            'That invite is view-only — there is nothing to close. To stop it working, give the space a new key (changeKey).',
          );
        key = (await deriveInviteKey(base64UrlDecode(secret), provider)).did;
      }
      await (await runtime(spaceId)).closeInvite(key);
    },

    revoke: perSpace((rt, token: string) => rt.revoke(token)),
    changeKey: perSpace((rt) => rt.rotateKey()),
    setRelays: perSpace((rt, relays: ReadonlyArray<string>) => rt.setRelays(relays)),
    setKeepers: perSpace((rt, keepers: ReadonlyArray<Keeper>, copies?: number | null) =>
      rt.setKeepers(keepers, copies ?? null),
    ),

    async authenticator(spaceId) {
      const record = await findRecord(spaceId);
      if (!record) return null;
      // Every peer proves its own DID; in a private space, readers are also
      // checked against the read key the space's history names now. The
      // welcome is signed by the key this node introduces itself with.
      const read = record.space.visibility === 'private' ? (await runtime(spaceId)).readAccess() : null;
      return createServerAuth(spaceId, read, sessionKeys.privateKey, provider);
    },
  });

  // With an account key, start following the registry at once: it is how this
  // node learns which spaces it belongs to.
  if (accountSpaceId) {
    await runtime(accountSpaceId);
    await reconcile();
  }

  /** Writes a subscription, checked, and hands every carrier the subscriptions as they are now */
  async function writeNotify(id: string, body: NotifyWhen): Promise<NotifyView> {
    const registryRt = await requireAccount('Subscribing');
    const problem = checkNotify(body);
    if (problem) throw new Error(problem);
    await registryRt.upsertSystem<NotifyWhen>(NOTIFY_COLLECTION, id, body);
    await passSubscriptionsOn();
    return { ...body, id };
  }

  const notifications = Object.freeze<NodeNotifications>({
    list: notifyRecords,

    add: (when) =>
      writeNotify(`notify:${base32Encode(globalThis.crypto.getRandomValues(new Uint8Array(10)))}`, {
        ...when,
        label: when.label.trim(),
        since: when.since ?? new Date().toISOString(),
      }),

    async update(id, changes) {
      await requireAccount('Subscribing');
      const current = (await notifyRecords()).find((view) => view.id === id);
      if (!current) throw new Error('There is no such subscription');
      const { id: _id, ...was } = current;
      return writeNotify(id, {
        ...was,
        ...(changes.label !== undefined ? { label: changes.label.trim() } : {}),
        ...(changes.paused !== undefined ? { paused: changes.paused } : {}),
      });
    },

    async remove(id) {
      const registryRt = await requireAccount('Subscribing');
      if (!(await notifyRecords()).some((view) => view.id === id)) return;
      await registryRt.removeSystem(id);
      await passSubscriptionsOn();
    },

    async versions(ids) {
      if (!accountSpaceId) return [];
      const keys = ids.filter((id) => id.startsWith('notify:'));
      return (await (await runtime(accountSpaceId)).versionsOf(keys)).filter(
        (version) => version.collection === NOTIFY_COLLECTION,
      );
    },

    async take(versions) {
      if (!accountSpaceId) return 0;
      // Subscriptions only: whatever else rides along waits for sync.
      const mine = versions.filter(
        (version) =>
          typeof version === 'object' &&
          version !== null &&
          version.collection === NOTIFY_COLLECTION &&
          version.space === accountSpaceId,
      );
      if (mine.length === 0) return 0;
      const taken = await (await runtime(accountSpaceId)).take(mine);
      if (taken > 0) await passSubscriptionsOn();
      return taken;
    },
  });

  const carriers = Object.freeze<NodeCarriers>({
    list: async () =>
      (await liveCarriers()).map(({ space, did, name, since }) => ({ space, did, name, since })),

    async add(carrier) {
      const registryRt = await requireAccount('Using a carrier');
      const name = carrier.name.trim().slice(0, 80) || 'Carrier';
      // Private, so the passes in it are sealed; the account alone may write there.
      const record = await registry.create({
        name: `Carried by ${name}`,
        visibility: 'private',
        creator: config.signer.did,
      });
      carrySpaces.add(record.space.id);
      const invite = await registry.createInvite(record.space.id, config.signer.did);
      const body: Carrier = {
        space: record.space.id,
        invite,
        did: carrier.did,
        name,
        since: new Date().toISOString(),
      };
      await registryRt.upsertSystem<Carrier>(CARRIER_COLLECTION, await carrierKey(record.space.id), body);
      await syncPasses(body);
      return { space: record.space.id, invite };
    },

    async remove(spaceId) {
      const registryRt = await requireAccount('Removing a carrier');
      const found = (await carrierRecords()).find(
        ({ record, space }) => !record.deleted && space === spaceId,
      )?.record;
      if (!found) return;
      const carry = await runtime(spaceId);
      // Passes gone first, then the word to forget everything, then the carrier's record.
      for (const pass of await ownRecords(carry, { collection: PASS_COLLECTION }, (r) =>
        r.key.startsWith('pass:'),
      ))
        await carry.removeSystem(pass.key);
      await carry.upsertSystem(PASS_COLLECTION, CARRY_CLOSED_KEY, { v: 1, closed: true });
      await registryRt.removeSystem(found.key);
    },
  });

  // ─── Hosting ───────────────────────────────────────────────────────
  //
  // A host is a carrier the account pays for. The subscription key lives in
  // the registry (`sys.hosting`), so every device signs as the same
  // subscription, and any of them hands the host the carry space once it is
  // paid — the one that paid, or the next one to notice.

  const hostingKey = (url: string) => hashedKey('hosting', url);

  /** The hosting records the account wrote, live */
  async function hostingRecords(): Promise<ReadonlyArray<Hosting>> {
    if (!accountSpaceId) return [];
    const records = await ownRecords<Hosting>(
      await runtime(accountSpaceId),
      { collection: HOSTING_COLLECTION },
      (record) => typeof record.body?.url === 'string' && typeof record.body.seed === 'string',
    );
    return records.map((record) => record.body!);
  }

  async function hostClient(hosting: Hosting): Promise<{ client: HostClient; subscription: string }> {
    const key = await subscriptionKey(base64UrlDecode(hosting.seed), provider);
    return { client: createHostClient(hosting.url, hosting.host, key, provider), subscription: key.did };
  }

  /** What the host at a known address says about itself — refused when it's another host now */
  async function describeKnown(hosting: Hosting): Promise<HostDescription> {
    const description = await describeHost(hosting.url);
    if (description.did !== hosting.host)
      throw new Error("The host at this address has another key now, so it's another host");
    return description;
  }

  /** The carry space shared with a host: the one the account made for it, or a new one */
  async function carryFor(hosting: Hosting): Promise<string> {
    const known = (await liveCarriers()).find((carrier) => carrier.did === hosting.host);
    return known
      ? known.invite
      : (await carriers.add({ did: hosting.host, name: new URL(hosting.url).host })).invite;
  }

  /** Last time each host was handed the spaces, or refused them — so asking again waits a while */
  const handedAt = new Map<string, number>();
  const HAND_AGAIN_MS = 60_000;
  /** Handovers under way, so a second look waits for the first instead of reporting the spaces not carried */
  const handing = new Map<string, Promise<{ status: HostStatus; receipt: SignedStatus }>>();

  /**
   * Keeps what the host signed in the registry, so every device shows it and
   * the person holds the host's word — written only when what it says changed.
   */
  async function keepReceipt(
    hosting: Hosting,
    kept: HostStatus | null,
    status: HostStatus,
    receipt: SignedStatus,
    description: HostDescription,
  ): Promise<void> {
    if (agentSession || !accountSpaceId) return;
    const { name } = description;
    const peer = hostPeerAddress(hosting.url, description) ?? undefined;
    const same =
      kept &&
      kept.state === status.state &&
      kept.paidUntil === status.paidUntil &&
      kept.renews === status.renews &&
      hosting.name === name &&
      hosting.peer === peer;
    if (same) return;
    const { peer: _before, ...rest } = hosting;
    const record: Hosting = { ...rest, name, receipt, ...(peer ? { peer } : {}) };
    await (
      await runtime(accountSpaceId)
    ).upsertSystem<Hosting>(HOSTING_COLLECTION, await hostingKey(hosting.url), record);
  }

  /** Asks a host how it stands, and hands it the spaces if it is paid for but not carrying them */
  async function viewHosting(hosting: Hosting, force = false): Promise<HostingView> {
    const { client, subscription } = await hostClient(hosting);
    const kept = hosting.receipt ? await readStatus(hosting.receipt, hosting.host, provider) : null;
    const base = { url: hosting.url, host: hosting.host, subscription, since: hosting.since };
    try {
      const description = await describeKnown(hosting);
      let { status, receipt } = await client.status();
      const due = force || Date.now() - (handedAt.get(hosting.url) ?? 0) > HAND_AGAIN_MS;
      const paid =
        status.state === 'active' ||
        status.state === 'grace' ||
        (description.free && status.state !== 'lapsed');
      const inFlight = handing.get(hosting.url);
      if (!status.carrying && inFlight) {
        // Another look is handing the spaces over right now: wait for it,
        // rather than answer "not carrying" while they're on their way.
        const handed = await inFlight.catch(() => null);
        if (handed) ({ status, receipt } = handed);
      } else if (!status.carrying && paid && due && !agentSession) {
        handedAt.set(hosting.url, Date.now());
        const attaching = carryFor(hosting).then((invite) => client.attach(config.signer.did, invite));
        handing.set(hosting.url, attaching);
        try {
          ({ status, receipt } = await attaching);
        } catch (error) {
          // Not paid after all (it lapsed in between): the status says so.
          if (!(error instanceof HostError && error.status === 402)) throw error;
        } finally {
          handing.delete(hosting.url);
        }
      }
      await keepReceipt(hosting, kept, status, receipt, description);
      return {
        ...base,
        name: description.name,
        status,
        live: true,
        plans: plansFor(description, 'account'),
        reminds: description.remind === true,
      };
    } catch (error) {
      return {
        ...base,
        name: hosting.name ?? new URL(hosting.url).host,
        status: kept,
        live: false,
        plans: [],
        reminds: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** The plans a host describes for an account's subscription, or a space's own */
  const plansFor = (description: HostDescription, who: 'account'): ReadonlyArray<HostPlan> =>
    (description.plans ?? []).filter((plan) => Array.isArray(plan.for) && plan.for.includes(who));

  /** Every device keeps its hosts carrying: after the registry changes, ask each once more */
  async function keepHosted(): Promise<void> {
    if (agentSession) return;
    for (const hosting of await hostingRecords()) await viewHosting(hosting).catch(() => {});
  }

  async function requireHosting(url: string): Promise<Hosting> {
    const found = (await hostingRecords()).find((hosting) => hosting.url === url);
    if (!found) throw new Error(`This account doesn't use the host at ${url}`);
    return found;
  }

  /** An address a device may reach: https://, or http:// on this machine */
  function checkAddress(address: string, what: string): URL {
    const url = new URL(address);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
      throw new Error(`${what} is reached over https://`);
    return url;
  }

  // ─── A space paying for itself ─────────────────────────────────────
  //
  // A space names the hosts it pays in `std.host` records, which only those
  // who may manage it write. Any member's device holding the space key hands
  // such a host the space's pass once someone has paid there, and again when
  // the space's key changes, so the host carries it without reading it.

  /** When each space last asked its hosts, and what it named then: asked again after a while, or when that changed */
  const spaceHostsAsked = new Map<string, { at: number; named: string }>();
  const SPACE_HOSTS_EVERY_MS = 10 * 60_000;

  async function namedHosts(
    spaceId: string,
  ): Promise<ReadonlyArray<{ url: string; did?: string; name?: string }>> {
    const rt = await runtime(spaceId);
    // Only where the space keeps hosts: listing a collection makes a space held in part hold it.
    if (!(await rt.collections()).some((c) => c.name === 'std.host' && c.version !== null)) return [];
    const records = await rt.list<unknown>({ collection: 'std.host' });
    return records.flatMap((record) => {
      const body = record.body;
      if (!record.verified || record.deleted || !isRecord(body) || typeof body.url !== 'string') return [];
      let url: string;
      try {
        url = checkAddress(body.url, 'A host').origin;
      } catch {
        return [];
      }
      return [
        {
          url,
          ...(typeof body.did === 'string' ? { did: body.did } : {}),
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
        },
      ];
    });
  }

  /** The read key a space is carried with now, as a DID: what a host should hold */
  const currentReadKey = (pass: SpacePass): string | undefined => pass.readKey ?? pass.space.readKey;

  async function askSpaceHost(
    spaceId: string,
    named: { url: string; did?: string; name?: string },
    hand: boolean,
  ): Promise<SpaceHostingView> {
    try {
      const description = await describeHost(named.url);
      // A host whose key changed since the space chose it is not the host it chose.
      if (named.did && named.did !== description.did) throw new Error('The host’s key changed');
      const client = createSpaceHostClient(named.url, description.did, provider);
      let { status } = await client.status(spaceId);
      // Paid, or a free host that hasn't let it lapse, as for an account's subscription.
      const paid =
        status.state === 'active' ||
        status.state === 'grace' ||
        (description.free && status.state !== 'lapsed');
      const record = hand && paid ? await findRecord(spaceId) : null;
      if (record && (record.space.visibility === 'public' || record.key)) {
        const pass = await makePass(record);
        if (!status.carrying || (pass.read && status.readKey !== currentReadKey(pass)))
          ({ status } = await client.hand(spaceId, pass));
      }
      return {
        url: named.url,
        name: named.name ?? description.name,
        host: description.did,
        status,
        free: description.free === true,
        fund: description.free ? null : (description.fund ?? null),
        reminds: description.remind === true,
        runsBots: description.bots === true,
        bots: status.bots ?? [],
      };
    } catch (error) {
      return {
        url: named.url,
        name: named.name ?? new URL(named.url).hostname,
        host: null,
        status: null,
        free: false,
        fund: null,
        reminds: false,
        runsBots: false,
        bots: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** A client for a host a space names, checked to be the host it chose */
  async function spaceHostClient(spaceId: string, url: string) {
    const named = (await namedHosts(spaceId)).find((known) => known.url === url);
    if (!named) throw new Error('This space doesn’t use the host at that address');
    const description = await describeHost(named.url);
    if (named.did && named.did !== description.did) throw new Error('The host’s key changed');
    return createSpaceHostClient(named.url, description.did, provider);
  }

  /** Hands the hosts a space names its pass, when they were paid and don't carry it with its key yet */
  async function keepSpaceHosts(spaceId: string): Promise<void> {
    if (ownSpace(spaceId)) return;
    const hosts = await namedHosts(spaceId);
    await reachHosts(spaceId, hosts);
    if (agentSession) return;
    const named = hosts.map((h) => h.url).join(' ');
    const asked = spaceHostsAsked.get(spaceId);
    if (!hosts.length || (asked?.named === named && Date.now() - asked.at < SPACE_HOSTS_EVERY_MS)) return;
    spaceHostsAsked.set(spaceId, { at: Date.now(), named });
    for (const known of hosts) await askSpaceHost(spaceId, known, true);
  }

  // ─── Reaching hosts ────────────────────────────────────────────────
  //
  // A host is reached over its socket, at the address its description names
  // (`peer`). Every space holds one to each host the account uses, as the
  // account's carry space names them all; a space also holds one to each host
  // it pays itself (`std.host`). The account registry also tries the hosts
  // the node was built with (`network.hosts`), so a new device with only the
  // recovery code finds its registry there, and every space from it.

  /** Each host's socket address, as its description said: asked once, and again after a failure */
  const describedPeers = new Map<string, Promise<string | null>>();
  function describedPeer(url: string): Promise<string | null> {
    let found = describedPeers.get(url);
    if (!found) {
      found = describeHost(url).then(
        (description) => hostPeerAddress(url, description),
        () => {
          describedPeers.delete(url);
          return null;
        },
      );
      describedPeers.set(url, found);
    }
    return found;
  }
  /** A host's socket address: the one written down with it, or its description's */
  const peerOf = async (host: { url: string; peer?: string }): Promise<string | null> =>
    (host.peer ? hostPeerAddress(host.url, { peer: host.peer }) : null) ?? describedPeer(host.url);

  /** What each space was last told to reach, so nothing reconnects when nothing changed */
  const reaching = new Map<string, string>();

  /** Gives a space's runtime the hosts to hold sockets to: the account's, and those it pays itself */
  async function reachHosts(
    spaceId: string,
    spaceHosts?: ReadonlyArray<{ url: string; peer?: string }>,
  ): Promise<void> {
    if (!config.network) return;
    const open = runtimes.get(spaceId);
    if (!open) return;
    const hosts: Array<{ url: string; peer?: string }> = [...(await hostingRecords())];
    if (spaceId === accountSpaceId) hosts.push(...(config.network.hosts ?? []).map((url) => ({ url })));
    if (!ownSpace(spaceId)) hosts.push(...(spaceHosts ?? (await namedHosts(spaceId))));
    const peers = [
      ...new Set((await Promise.all(hosts.map(peerOf))).filter((peer): peer is string => peer !== null)),
    ].sort();
    const said = peers.join(' ');
    if (reaching.get(spaceId) === said || runtimes.get(spaceId) !== open) return;
    reaching.set(spaceId, said);
    (await open).useNodes(peers);
  }

  const hosting = Object.freeze<NodeHosting>({
    async space(spaceId) {
      const hand = !agentSession;
      const views = await Promise.all(
        (await namedHosts(spaceId)).map((known) => askSpaceHost(spaceId, known, hand)),
      );
      if (hand) spaceHostsAsked.set(spaceId, { at: Date.now(), named: views.map((v) => v.url).join(' ') });
      return views;
    },

    async list() {
      return Promise.all((await hostingRecords()).map((known) => viewHosting(known)));
    },

    async use(address) {
      const registryRt = await requireAccount('Using a host');
      const base = checkAddress(address, 'A host').origin;
      const known = (await hostingRecords()).find((existing) => existing.url === base);
      if (known) return viewHosting(known, true);
      const description = await describeHost(base);
      const peer = hostPeerAddress(base, description);
      const record: Hosting = {
        url: base,
        host: description.did,
        name: description.name,
        ...(peer ? { peer } : {}),
        seed: base64UrlEncode(newSubscriptionSeed()),
        since: new Date().toISOString(),
      };
      await registryRt.upsertSystem<Hosting>(HOSTING_COLLECTION, await hostingKey(base), record);
      return viewHosting(record, true);
    },

    async pay(url, plan) {
      return (await hostClient(await requireHosting(url))).client.pay(plan);
    },

    async manage(url) {
      return (await hostClient(await requireHosting(url))).client.manage();
    },

    async remind(url, email) {
      await (await hostClient(await requireHosting(url))).client.remind(email);
    },

    async payForSpace(spaceId, url, payment) {
      return (await spaceHostClient(spaceId, url)).pay(spaceId, payment);
    },

    async remindForSpace(spaceId, url, email) {
      await (await spaceHostClient(spaceId, url)).remind(spaceId, email);
    },

    async stopForSpace(spaceId, url) {
      const named = (await namedHosts(spaceId)).find((known) => known.url === url);
      if (!named) throw new Error('This space doesn’t use the host at that address');
      // Which bots are the host's is its own word, signed: asked before it is let go.
      const view = await askSpaceHost(spaceId, named, false);
      // Un-named first, so no device hands it the key that follows.
      const rt = await runtime(spaceId);
      for (const record of await rt.list<unknown>({ collection: 'std.host' })) {
        const body = record.body;
        if (record.deleted || !isRecord(body) || typeof body.url !== 'string') continue;
        let origin: string;
        try {
          origin = new URL(body.url).origin;
        } catch {
          continue;
        }
        if (origin === url) await rt.remove(record.key);
      }
      const access = await spaces.access(spaceId);
      if (!roleHolds(access.role, MANAGE)) return { bots: [], newKey: false };
      const members = new Set(access.members.map((member) => member.did));
      const bots = view.bots.map((bot) => bot.bot).filter((did) => members.has(did));
      for (const bot of bots) await spaces.setMember(spaceId, bot, null);
      // A host that can't say whether it holds a pass is taken to hold one.
      const handed = view.status ? view.status.carrying : true;
      const newKey = access.key !== null && (bots.length > 0 || handed);
      // Removing a member changes the key by itself; with none removed it is changed here.
      if (newKey && bots.length === 0) await spaces.changeKey(spaceId);
      return { bots, newKey };
    },

    async startBot(spaceId, url, bot) {
      const client = await spaceHostClient(spaceId, url);
      const invite = await spaces.invite(spaceId, bot.role ? { role: bot.role } : {});
      const { bot: did, status } = await client.startBot(spaceId, bot.name, invite);
      return { bot: did, status };
    },

    async stop(url) {
      const registryRt = await requireAccount('Stopping a host');
      const known = await requireHosting(url);
      const { client } = await hostClient(known);
      await client.detach().catch(() => {});
      const carrier = (await liveCarriers()).find((found) => found.did === known.host);
      if (carrier) await carriers.remove(carrier.space);
      await registryRt.removeSystem(await hostingKey(known.url));
    },
  });

  // ─── Contacts ──────────────────────────────────────────────────────
  //
  // One `std.contact` per person in the contacts space, keyed by their DID, so
  // there is one per person on every device. Asking someone is a
  // `std.contact-request` in a space you share: the invite to a new space for
  // two, sealed with their contact key, bound to the space it was posted in and
  // to who asked whom — so it opens only for them, only there, and only as
  // coming from the account that wrote it.

  // The key `onePer: ['did']` derives, so the record for someone is the same one on every device.
  const contactRecordKey = async (did: string) =>
    (await onePerKey(contactSchema.name, contactSchema.rules.onePer, {
      root: config.signer.did,
      links: [],
      body: { did },
    }))!;
  const requestContext = (spaceId: string, from: string, to: string) =>
    `weave/contact-request|${spaceId}|${from}|${to}`;

  async function contactsRuntime(): Promise<SpaceRuntime> {
    if (!contactsSpaceId)
      throw new Error(
        'This app was not given your contacts. Connect to your account home again, and allow contacts.',
      );
    return runtime(contactsSpaceId);
  }

  /** Making and joining spaces for two needs a note good for every space — whole-account access. */
  function requireEverywhere(what: string): void {
    if (!current.payload.att.some((capability) => capability.with === '*')) {
      throw new Error(
        `${what} makes or joins a space, which needs access to your whole account. Connect to your account home again, and ask for it.`,
      );
    }
  }

  /** Defines a collection in a space that has none by that name yet */
  async function ensureDefined(open: SpaceRuntime, definition: DefineCollection): Promise<void> {
    if (
      (await open.collections()).some(
        (collection) => collection.name === definition.name && collection.version !== null,
      )
    )
      return;
    try {
      await open.define(definition);
    } catch {
      throw new Error(
        `This space has no ${definition.title ?? definition.name} collection yet, and you can't add one here. Ask someone who manages it.`,
      );
    }
  }

  async function contactRecords(): Promise<ReadonlyArray<NodeRecord<Contact>>> {
    if (!contactsSpaceId) return [];
    const found: NodeRecord<Contact>[] = [];
    const listed = await ownRecords<Contact>(
      await contactsRuntime(),
      { collection: contactSchema.name },
      (record) => typeof record.body?.did === 'string' && typeof record.body.name === 'string',
    );
    // One record per person, under the key their DID gives.
    for (const record of listed)
      if (record.key === (await contactRecordKey(record.body!.did))) found.push(record);
    return found;
  }

  /** Whoever the account blocked */
  const blockedDids = async () =>
    new Set((await contactRecords()).flatMap(({ body }) => (body!.blocked === true ? [body!.did] : [])));

  function requireContactKeys(): void {
    if (!contactKeys)
      throw new Error(
        "This app can't read contact requests. Connect to your account home again, and allow contacts.",
      );
  }

  function contactView(record: NodeRecord<Contact>): ContactView {
    const body = record.body!;
    return Object.freeze({
      did: body.did,
      name: body.name,
      space: typeof body.space === 'string' ? body.space : null,
      ...(typeof body.note === 'string' ? { note: body.note } : {}),
      blocked: body.blocked === true,
      updatedAt: record.updatedAt,
    });
  }

  async function writeContact(body: Contact): Promise<ContactView> {
    const open = await contactsRuntime();
    await ensureDefined(open, contactSchema);
    // One per person: writing again is the next version of their record.
    return contactView(await open.put<Contact>(contactSchema.name, body));
  }

  /** Leaves a space for two, unless another contact still names it */
  async function leavePairSpace(spaceId: string | null, did: string): Promise<void> {
    if (!spaceId || !(await registry.get(spaceId))) return;
    if ((await contactRecords()).some((record) => record.body!.did !== did && record.body!.space === spaceId))
      return;
    await spaces.leave(spaceId);
  }

  /** A contact request, opened — or null when it isn't one for this account, from the account that wrote it */
  async function openRequest(
    spaceId: string,
    record: NodeRecord<ContactRequestRecord>,
  ): Promise<{
    readonly from: string;
    readonly invite: string;
    readonly note?: string;
    readonly pairSpace: string;
  } | null> {
    if (
      !contactKeys ||
      !record.verified ||
      record.viaAgent ||
      record.collection !== contactRequestSchema.name
    )
      return null;
    if (record.body?.to !== config.signer.did || typeof record.body.sealed !== 'string') return null;
    const from = record.root;
    if (!from || record.createdBy !== from || from === config.signer.did) return null;
    const value = await openSealed(
      contactKeys.privateKey,
      record.body.sealed,
      requestContext(spaceId, from, config.signer.did),
    );
    if (!isRecord(value) || typeof value.invite !== 'string') return null;
    let invited;
    try {
      invited = parseSpaceInvite(value.invite);
    } catch {
      return null;
    }
    // A private space the asker made, and the key to it: anything else isn't a space for two from them.
    if (invited.space.creator !== from || invited.space.visibility !== 'private' || !invited.key) return null;
    return {
      from,
      invite: value.invite,
      ...(typeof value.note === 'string' && value.note ? { note: value.note.slice(0, 2000) } : {}),
      pairSpace: invited.space.id,
    };
  }

  const contacts: NodeContacts = Object.freeze<NodeContacts>({
    async space() {
      return contactsSpaceId;
    },

    async list() {
      return (await contactRecords())
        .map(contactView)
        .sort((a, b) => a.name.localeCompare(b.name) || a.did.localeCompare(b.did));
    },

    async get(did) {
      const record = (await contactRecords()).find((found) => found.body!.did === did);
      return record ? contactView(record) : null;
    },

    async put(contact: {
      readonly did: string;
      readonly name: string;
      readonly space?: string | null;
      readonly note?: string;
    }) {
      if (!contact.did.startsWith('did:')) throw new Error('A contact needs their account DID');
      const name = contact.name.trim().slice(0, 200);
      if (!name) throw new Error('A contact needs a name');
      // An answer to their knock still to be written stays to be written.
      const pending = (await contactRecords()).find((record) => record.body!.did === contact.did)?.body?.door;
      return writeContact({
        did: contact.did,
        name,
        ...(contact.space ? { space: contact.space } : {}),
        ...(contact.note ? { note: contact.note.slice(0, 2000) } : {}),
        ...(pending ? { door: pending } : {}),
      });
    },

    async remove(did) {
      const found = await contacts.get(did);
      if (!found) return;
      await leavePairSpace(found.space, did);
      await (await contactsRuntime()).remove(await contactRecordKey(did));
    },

    async block(did) {
      const found = await contacts.get(did);
      await leavePairSpace(found?.space ?? null, did);
      await writeContact({
        did,
        name: found?.name ?? did,
        blocked: true,
        ...(found?.note ? { note: found.note } : {}),
      });
    },

    async ask(spaceId, did, options = {}) {
      requireEverywhere('Adding a contact');
      if (did === config.signer.did) throw new Error('That is you');
      if (!contactsSpaceId) await contactsRuntime();
      const shared = await runtime(spaceId);
      const profiles = await shared.profiles();
      const theirs = profiles.find((profile) => profile.did === did);
      if (!theirs?.contactKey) {
        throw new Error(
          "They can't be asked here yet: their profile in this space has no contact key. It appears once they open the space in an up-to-date app.",
        );
      }
      await ensureDefined(shared, contactRequestSchema);

      const mine =
        (await ownName()) ?? profiles.find((profile) => profile.did === config.signer.did)?.name ?? 'Me';
      const pair = await spaces.create({ name: `${mine} & ${theirs.name}`, visibility: 'private', ...team });
      const invite = await spaces.invite(pair.id, { role: 'editor' });
      await writeContact({ did, name: theirs.name, space: pair.id });
      const note = options.note?.trim().slice(0, 2000);
      const sealed = await sealFor(
        theirs.contactKey,
        { invite, ...(note ? { note } : {}) },
        requestContext(spaceId, config.signer.did, did),
      );
      const request = await shared.put<ContactRequestRecord>(contactRequestSchema.name, { to: did, sealed });
      return { space: pair.id, request: request.key };
    },

    async requests(spaceId) {
      requireContactKeys();
      const shared = await runtime(spaceId);
      const blocked = await blockedDids();
      const names = new Map((await shared.profiles()).map((profile) => [profile.did, profile.name]));
      const found: ContactRequest[] = [];
      for (const record of await shared.list<ContactRequestRecord>({
        collection: contactRequestSchema.name,
      })) {
        const opened = await openRequest(spaceId, record);
        if (!opened || blocked.has(opened.from)) continue;
        // Already accepted, here or on another device.
        if (await registry.get(opened.pairSpace)) continue;
        found.push({
          space: spaceId,
          key: record.key,
          from: opened.from,
          name: names.get(opened.from) ?? null,
          ...(opened.note ? { note: opened.note } : {}),
          pairSpace: opened.pairSpace,
          createdAt: record.createdAt,
        });
      }
      return found;
    },

    async accept(spaceId, requestKey) {
      requireEverywhere('Accepting a contact request');
      requireContactKeys();
      const shared = await runtime(spaceId);
      const record = await shared.get<ContactRequestRecord>(requestKey);
      const opened = record ? await openRequest(spaceId, record) : null;
      if (!opened) throw new Error('That contact request is gone, or is not for you.');
      await spaces.join(opened.invite);
      const name =
        (await shared.profiles()).find((profile) => profile.did === opened.from)?.name ??
        (await contacts.get(opened.from))?.name ??
        opened.from;
      return writeContact({ did: opened.from, name, space: opened.pairSpace });
    },

    async others(did) {
      const found = await contacts.get(did);
      if (!found?.space || !(await registry.get(found.space))) return [];
      const open = await runtime(found.space);
      const [{ members }, profiles, status] = await Promise.all([
        open.access(),
        open.profiles(),
        open.status(),
      ]);
      const seen = new Set([
        ...members.map((member) => member.did),
        ...profiles.map((profile) => profile.did),
        ...Object.values(status.accounts),
      ]);
      return [...seen].filter((account) => account !== config.signer.did && account !== did).sort();
    },
  });

  // ─── Doors ─────────────────────────────────────────────────────────
  //
  // A door is a `std.door` in the contacts space; its keys are derived from
  // the contact key and its id, so every device with the contact key opens the
  // same doors. Knocks wait in the mailboxes of the relays a door names.
  //
  // A knock you left is a `std.knock` until the person behind the door
  // answers in the space for two — a `std.knock-answer` signed with the
  // door's signing key — when it becomes a contact and the invite is closed.
  // Accepting a knock writes that answer as soon as this account's membership
  // there has landed; until then the contact carries the door's id.
  // See `packages/core/src/doors/doors.ts`.

  const mailbox = config.mailbox ?? createMailboxClient();
  /** Knocks seen at this node's doors, by id: opened (null when they didn't check out), and until when to keep them */
  const knockCache = new Map<
    string,
    { readonly opened: OpenedKnock | null; readonly door: string; readonly until: number }
  >();
  const DAY_MS = 24 * 3600 * 1000;

  function requireContactKey(what: string): Uint8Array {
    // Agents never open doors or knock, even one a home gave the contact key.
    if (agentSession) throw new Error(`An agent can't use doors. ${what} is the person's to do.`);
    if (!config.contactKey)
      throw new Error(
        `${what} needs your contact key. Connect to your account home again, and allow contacts.`,
      );
    return config.contactKey;
  }

  /** A door's keys, from the contact key and its id */
  async function doorKeys(id: string) {
    const contactKey = requireContactKey('A door');
    const key = await deriveDoorKeyBytes(contactKey, id);
    const sign = await deriveDoorSignKeyBytes(contactKey, id);
    const signPublic = contactPublicKey(sign);
    return { key, sign, publicKey: contactPublicKey(key), signPublic, topic: await doorTopic(signPublic) };
  }

  async function doorRecords(): Promise<ReadonlyArray<NodeRecord<Door>>> {
    if (!contactsSpaceId) return [];
    return ownRecords<Door>(
      await contactsRuntime(),
      { collection: doorSchema.name },
      (record) => typeof record.body?.id === 'string' && Array.isArray(record.body.relays),
    );
  }

  const doorById = async (id: string) => (await doorRecords()).find((record) => record.body!.id === id);
  const forgetKnocksAt = (door: string) => {
    for (const [knock, cached] of knockCache) if (cached.door === door) knockCache.delete(knock);
  };

  async function doorView(record: NodeRecord<Door>): Promise<DoorView> {
    const body = record.body!;
    const keys = await doorKeys(body.id);
    return Object.freeze({
      id: body.id,
      ...(body.label ? { label: body.label } : {}),
      ...(body.name ? { name: body.name } : {}),
      key: keys.publicKey,
      sign: keys.signPublic,
      relays: Object.freeze([...body.relays]),
      code: encodeDoorCode({
        key: keys.publicKey,
        sign: keys.signPublic,
        relays: body.relays,
        ...(body.name ? { name: body.name } : {}),
      }),
      createdAt: record.createdAt,
    });
  }

  /** Clears knocks from every relay a door names, as its owner; how many relays did */
  async function purgeDoor(door: Door, ids: ReadonlyArray<string> | null): Promise<number> {
    const keys = await doorKeys(door.id);
    const done = await Promise.allSettled(
      door.relays.map((relay) =>
        mailbox.purge(relay, keys.topic, keys.signPublic, ids, (nonce) =>
          signPurge(keys.sign, keys.topic, nonce, ids),
        ),
      ),
    );
    return done.filter((result) => result.status === 'fulfilled').length;
  }

  async function sentRecords(): Promise<ReadonlyArray<NodeRecord<Knock>>> {
    if (!contactsSpaceId) return [];
    return ownRecords<Knock>(
      await contactsRuntime(),
      { collection: knockSchema.name },
      (record) =>
        typeof record.body?.space === 'string' &&
        typeof record.body.sign === 'string' &&
        typeof record.body.invite === 'string',
    );
  }

  /**
   * Knocks of yours: answered ones become contacts, and the invite is closed;
   * ones nobody answered within the knock's life are let go, space and all.
   */
  async function settleSent(): Promise<void> {
    for (const record of await sentRecords()) {
      const { space, name, sign, invite } = record.body!;
      if (!(await registry.get(space))) {
        await (await contactsRuntime()).remove(record.key);
        continue;
      }
      const open = await runtime(space);
      const { members } = await open.access();
      let answered: string | null = null;
      for (const answer of await open.list<KnockAnswer>({ collection: knockAnswerSchema.name })) {
        const did = answer.root;
        if (
          !answer.verified ||
          !did ||
          did === config.signer.did ||
          answer.createdBy !== did ||
          typeof answer.body?.sig !== 'string'
        )
          continue;
        if (!members.some((member) => member.did === did)) continue;
        if (await checkAnswer(sign, space, did, answer.body.sig)) {
          answered = did;
          break;
        }
      }
      if (answered) {
        // Whoever else the invite reached, nobody more joins with it.
        await spaces.closeInvite(space, invite).catch(() => {});
        const given = (await open.profiles()).find((profile) => profile.did === answered)?.name;
        await writeContact({ did: answered, name: given ?? name, space });
        await (await contactsRuntime()).remove(record.key);
      } else if (Date.now() - Date.parse(record.createdAt) > KNOCK_TTL_SECONDS * 1000 + DAY_MS) {
        await spaces.leave(space).catch(() => {});
        await (await contactsRuntime()).remove(record.key);
      }
    }
  }

  /** Writes the answer to knocks this account accepted, once it can write in the space for two */
  async function answerAccepted(): Promise<void> {
    for (const record of await contactRecords()) {
      const { did, space, door } = record.body!;
      if (typeof door !== 'string' || typeof space !== 'string') continue;
      if (!(await registry.get(space))) continue;
      const open = await runtime(space);
      if ((await open.access()).role === null) continue;
      const { sign } = await doorKeys(door);
      try {
        await open.put<KnockAnswer>(knockAnswerSchema.name, {
          sig: await signAnswer(sign, space, config.signer.did),
        });
      } catch {
        continue; // The space's definition of answers hasn't arrived yet.
      }
      const { door: _answered, ...rest } = record.body!;
      await writeContact({ ...rest, did });
    }
  }

  /** What the mailboxes of this node's doors hold now, opened and cached */
  async function readDoors(): Promise<
    ReadonlyArray<{ readonly id: string; readonly door: string; readonly opened: OpenedKnock }>
  > {
    const now = Date.now();
    for (const [id, cached] of knockCache) if (cached.until <= now) knockCache.delete(id);
    const found: { id: string; door: string; opened: OpenedKnock }[] = [];
    for (const record of await doorRecords()) {
      const { id: doorId, relays } = record.body!;
      const keys = await doorKeys(doorId);
      // Every relay, in full: a door holds 64 knocks at most, and a knock
      // cleared from another device should go from here too. What was opened
      // once is not opened again.
      const held = new Map<string, { blob: string; at: number }>();
      for (const result of await Promise.allSettled(
        relays.map((relay) => mailbox.fetch(relay, keys.topic)),
      )) {
        if (result.status !== 'fulfilled') continue;
        for (const item of result.value) {
          // A relay's id is only its word: file the knock under the hash of what it is.
          const id = await knockId(item.blob);
          const seen = held.get(id);
          if (!seen || item.at < seen.at) held.set(id, { blob: item.blob, at: item.at });
        }
      }
      for (const [id, item] of held) {
        let cached = knockCache.get(id);
        if (!cached) {
          cached = {
            opened: await openKnock(keys.key, item.blob, item.at, provider),
            door: doorId,
            until: item.at + KNOCK_TTL_SECONDS * 1000,
          };
          knockCache.set(id, cached);
        }
        if (cached.opened) found.push({ id, door: doorId, opened: cached.opened });
      }
    }
    return found;
  }

  /** A direct message as this account reads it — null when it is neither by nor for this account */
  async function directView(
    spaceId: string,
    open: SpaceRuntime,
    record: NodeRecord<DirectBody>,
  ): Promise<DirectMessage | null> {
    // Who wrote it is whoever created it: the context binds that account, so a copy posted by anyone else opens nothing.
    const from = record.createdBy;
    if (!record.verified || record.collection !== directSchema.name || !from || record.root !== from)
      return null;
    const to = Array.isArray(record.body?.to) ? record.body.to.filter((did) => typeof did === 'string') : [];
    const me = config.signer.did;
    if (from !== me && !to.includes(me)) return null;
    const pair = open.ownMemberKey();
    const opened = pair ? await openDirect(spaceId, from, record.body, me, pair.privateKey) : null;
    return Object.freeze({
      key: record.key,
      from,
      to: [...to].sort(),
      text: opened?.text ?? null,
      createdAt: record.createdAt,
      ...(record.viaAgent ? { viaAgent: true as const } : {}),
    });
  }

  const direct = Object.freeze<NodeDirect>({
    async reachable(spaceId) {
      const open = await runtime(spaceId);
      const { members } = await open.access();
      const keys = await open.memberKeys();
      return members
        .map((member) => member.did)
        .filter((did) => did !== config.signer.did && keys.has(did))
        .sort();
    },

    async send(spaceId, to, text) {
      const open = await runtime(spaceId);
      const pair = open.ownMemberKey();
      if (!pair)
        throw new Error(
          "This node can't seal direct messages here: it wasn't given your member key for this space.",
        );
      const trimmed = text.trim();
      if (!trimmed) throw new Error('A direct message needs some text');
      // Your own key as this node holds it, so your other devices read what you sent even before it is published.
      const keys = new Map(await open.memberKeys());
      keys.set(config.signer.did, pair.publicKey);
      const body = await sealDirect(spaceId, config.signer.did, to, { text: trimmed }, keys);
      await ensureDefined(open, directSchema);
      const record = await open.put<DirectBody>(directSchema.name, body);
      const view = await directView(spaceId, open, record);
      if (!view) throw new Error('The direct message was written, but could not be read back');
      return view;
    },

    async list(spaceId) {
      const open = await runtime(spaceId);
      const found: DirectMessage[] = [];
      for (const record of await open.list<DirectBody>({ collection: directSchema.name })) {
        const view = await directView(spaceId, open, record);
        if (view) found.push(view);
      }
      return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
    },
  });

  const doors = Object.freeze<NodeDoors>({
    async list() {
      if (!config.contactKey || agentSession) return [];
      return Promise.all((await doorRecords()).map(doorView));
    },

    async open(options = {}) {
      requireContactKey('Opening a door');
      if (!contactsSpaceId) await contactsRuntime();
      const relays = [...(options.relays ?? usableRelays(config.network))].slice(0, MAX_DOOR_RELAYS);
      if (relays.length === 0)
        throw new Error('A door needs a relay to hold its knocks, and this node has none.');
      const name = clip((options.name ?? (await ownName()) ?? '').trim(), 64);
      const label = options.label ? clip(options.label.trim(), 64) : '';
      const id = base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
      // Checks the relays and name the way a knocker will.
      const keys = await doorKeys(id);
      encodeDoorCode({ key: keys.publicKey, sign: keys.signPublic, relays, ...(name ? { name } : {}) });
      const open = await contactsRuntime();
      await ensureDefined(open, doorSchema);
      return doorView(
        await open.put<Door>(doorSchema.name, {
          id,
          relays,
          ...(name ? { name } : {}),
          ...(label ? { label } : {}),
        }),
      );
    },

    async close(id) {
      const found = await doorById(id);
      if (found) await (await contactsRuntime()).remove(found.key);
      forgetKnocksAt(id);
    },

    async clear(id) {
      requireContactKey('Clearing a door');
      const found = await doorById(id);
      if (!found) throw new Error('There is no such door');
      if ((await purgeDoor(found.body!, null)) === 0)
        throw new Error("None of the door's relays could be reached to clear it.");
      forgetKnocksAt(id);
    },

    async knock(code, options = {}) {
      requireContactKey('Knocking on a door');
      requireEverywhere('Knocking on a door');
      const door = parseDoorCode(code);
      for (const mine of await doors.list())
        if (mine.key === door.key) throw new Error('That is one of your own doors');
      if (!contactsSpaceId) await contactsRuntime();
      const mine = (await ownName()) ?? 'Someone';
      const theirs = door.name ?? 'Contact';
      const pair = await spaces.create({
        name: `${clip(mine, 64)} & ${theirs}`,
        visibility: 'private',
        ...team,
      });
      let invite: string;
      try {
        // Defined now, by the one who may: the answer is written by someone who joins as an editor.
        await ensureDefined(await runtime(pair.id), knockAnswerSchema);
        invite = await spaces.invite(pair.id, { role: 'editor' });
        const blob = await sealKnock(
          door.key,
          { from: config.signer.did, name: mine, invite, ...(options.note ? { note: options.note } : {}) },
          { did: session.did, key: session.key, proof: session.proof() },
          provider,
        );
        const topic = await doorTopic(door.sign);
        const left = await Promise.allSettled(
          door.relays.map((relay) => mailbox.drop(relay, topic, blob, KNOCK_TTL_SECONDS)),
        );
        if (!left.some((result) => result.status === 'fulfilled')) {
          const reasons = left
            .map((result) => (result.status === 'rejected' ? reasonText(result.reason) : ''))
            .filter(Boolean);
          throw new Error(`None of their door's relays took the knock. ${reasons.join('; ')}`);
        }
      } catch (error) {
        await spaces.leave(pair.id).catch(() => {});
        throw error;
      }
      const open = await contactsRuntime();
      await ensureDefined(open, knockSchema);
      await open.put<Knock>(knockSchema.name, {
        space: pair.id,
        name: theirs,
        door: door.key,
        sign: door.sign,
        invite,
      });
      return { space: pair.id };
    },

    async knocks() {
      requireContactKey('Reading knocks');
      await settleSent().catch(() => {});
      await answerAccepted().catch(() => {});
      const blocked = await blockedDids();
      const found: KnockView[] = [];
      for (const { id, door, opened } of await readDoors()) {
        if (opened.from === config.signer.did || blocked.has(opened.from)) continue;
        // Already accepted, here or on another device.
        if (await registry.get(opened.pairSpace)) continue;
        found.push(
          Object.freeze({
            id,
            door,
            from: opened.from,
            name: opened.name,
            ...(opened.note ? { note: opened.note } : {}),
            pairSpace: opened.pairSpace,
            at: new Date(opened.at).toISOString(),
          }),
        );
      }
      return found.sort((a, b) => b.at.localeCompare(a.at));
    },

    async sent() {
      await settleSent().catch(() => {});
      return (await sentRecords()).map((record) =>
        Object.freeze({ space: record.body!.space, name: record.body!.name, at: record.createdAt }),
      );
    },

    async accept(id) {
      requireContactKey('Opening the door to someone');
      requireEverywhere('Opening the door to someone');
      if (!knockCache.get(id)?.opened) await readDoors();
      const cached = knockCache.get(id);
      const knocked = cached?.opened;
      if (!cached || !knocked)
        throw new Error('That knock is gone: it expired, or the door was closed or cleared.');
      await spaces.join(knocked.invite);
      const known = await contacts.get(knocked.from);
      const contact = await writeContact({
        did: knocked.from,
        name: known?.name ?? knocked.name,
        space: knocked.pairSpace,
        door: cached.door,
      });
      await answerAccepted().catch(() => {});
      // Done with: nobody needs it in the mailboxes any more.
      const door = await doorById(cached.door);
      if (door) await purgeDoor(door.body!, [id]).catch(() => 0);
      knockCache.delete(id);
      return contact;
    },

    async dismiss(id) {
      requireContactKey('Dismissing a knock');
      if (!knockCache.has(id)) await readDoors();
      const cached = knockCache.get(id);
      if (!cached) return;
      const door = await doorById(cached.door);
      if (door) await purgeDoor(door.body!, [id]);
      knockCache.delete(id);
    },
  });

  const collections = Object.freeze<NodeCollections>({
    list: perSpace((rt) => rt.collections()),
    define: perSpace((rt, definition: DefineCollection) => rt.define(definition)),
    delete: perSpace((rt, name: string) => rt.undefine(name)),
    tag: perSpace((rt, collection: string, field: string, value: string | number | boolean) =>
      rt.topicTag(collection, field, value),
    ),
  });

  const accountApi = Object.freeze<NodeAccount>({
    profile: ownProfile,
    async setName(name) {
      const registryRt = await requireAccount('Renaming across devices');
      const trimmed = name.trim();
      if (!trimmed) throw new Error('A name cannot be empty');
      const written = await registryRt.upsertSystem<AccountProfile>(PROFILE_COLLECTION, PROFILE_KEY, {
        name: trimmed,
      });
      emit({ type: 'account' });
      await publishProfileToOpenSpaces();
      return { name: trimmed, updatedAt: written.updatedAt };
    },
    revoke: async (token) => (await requireAccount('Revoking in the account registry')).revoke(token),
  });

  /** The records namespace, writing as `as` when given: an agent's key and note */
  function makeRecords(as?: ActiveSession): NodeRecords {
    const self: NodeRecords = Object.freeze({
      list: async <T>(spaceId: string, options?: ListOptions) => (await runtime(spaceId)).list<T>(options),
      get: async <T>(spaceId: string, key: string) => (await runtime(spaceId)).get<T>(key),
      put: async <T>(
        spaceId: string,
        collection: CollectionRef,
        body: T,
        options?: { key?: string; links?: ReadonlyArray<Link> },
      ) => (await runtime(spaceId)).put<T>(nameOf(collection), body, as ? { ...options, as } : options),
      update: async <T>(spaceId: string, key: string, body: T, options?: { links?: ReadonlyArray<Link> }) =>
        (await runtime(spaceId)).update<T>(key, body, as ? { ...options, as } : options),
      linked: async <T>(spaceId: string, key: string, options?: { rel?: string; collection?: string }) =>
        (await runtime(spaceId)).linked<T>(key, options),
      delete: async (spaceId: string, key: string) =>
        (await runtime(spaceId)).remove(key, as ? { as } : undefined),
      history: async <T>(spaceId: string, key: string) => (await runtime(spaceId)).history<T>(key),
      can: perSpace((rt, action: 'create' | 'edit' | 'delete', target: string) => rt.can(action, target)),
      async query<Q extends Query>(spaceId: string, query: Q): Promise<ResultOf<Q>> {
        const space = await runtime(spaceId);
        // Asked before running, so a node holding part of the space starts fetching what it lacks.
        const complete = space.use(collectionsOf(query));
        const result = await runQuery(
          {
            list: (collection) => space.list({ collection }),
            get: (key) => space.get(key),
            linked: (key, options) => space.linked(key, options),
          },
          query,
        );
        // The query's type says what it finds; running it can't prove that.
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typed from the query
        return { ...result, complete } as ResultOf<Q>;
      },
      watch<Q extends Query>(
        spaceId: string,
        query: Q,
        onResult: (result: ResultOf<Q>) => void,
        onError?: (error: Error) => void,
      ) {
        let stopped = false;
        // Changes arrive in bursts during sync: one run at a time, never a queue of stale runs.
        const run = serial(async () => {
          if (stopped) return;
          try {
            const result = await self.query(spaceId, query);
            if (!stopped) onResult(result);
          } catch (error) {
            if (!stopped) onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        });
        const unsubscribe = events.subscribe((event) => {
          if (event.type === 'records' && event.space === spaceId) void run();
        });
        void run();
        return () => {
          stopped = true;
          unsubscribe();
        };
      },
    });
    return self;
  }
  const records = makeRecords();

  // ─── Agents ────────────────────────────────────────────────────────

  async function asAgent(agent: { readonly keys: CryptoKeyPair; readonly note: string }): Promise<P2PNode> {
    const agentDid = await didOf(agent.keys.publicKey, provider);
    const checked = await verifyUCAN(agent.note, provider);
    if (!checked.valid)
      throw new Error(`The agent's note does not check out: ${checked.reason ?? 'invalid'}`);
    if (!isAgentNote(agent.note))
      throw new Error("That note is not an agent's — ask the account home for one with `agent: true`.");
    const note: UCANToken = { ...parseUCAN(agent.note), encoded: agent.note, cid: await noteCid(agent.note) };
    if (note.payload.aud !== agentDid) throw new Error('That note was made out to a different key.');
    if (note.payload.iss !== config.signer.did) throw new Error('That note is from a different account.');

    // The spaces its note names; `*` is every space, which a home never gives an agent but a note could say.
    const all = note.payload.att.some((capability) => capability.with === '*');
    const named = new Set(
      note.payload.att.filter((c) => c.with.startsWith('space:')).map((c) => c.with.slice('space:'.length)),
    );
    const allowed = (spaceId: unknown) => all || (typeof spaceId === 'string' && named.has(spaceId));
    const contactsGiven = () => contactsSpaceId !== null && allowed(contactsSpaceId);
    // Written with the agent's key, under its note.
    const writes = makeRecords({ did: agentDid, key: agent.keys.privateKey, proof: () => note.encoded });

    // What the table in `node/api.ts` marks `own`; the rest it decides there.
    const own: { readonly [N in Namespace as keyof OwnMethods<N> extends never ? never : N]: OwnMethods<N> } =
      {
        spaces: {
          list: async () => (await spaces.list()).filter((space) => allowed(space.id)),
          get: async (spaceId) => (allowed(spaceId) ? spaces.get(spaceId) : null),
          authenticator: async () => null,
        },
        records: {
          can: async (spaceId, action, target) => allowed(spaceId) && records.can(spaceId, action, target),
          watch: (spaceId, query, onResult, onError) => {
            if (allowed(spaceId)) return records.watch(spaceId, query, onResult, onError);
            onError?.(new Error('The agent was not given this space.'));
            return () => {};
          },
        },
        // The runtime refuses this too, and every peer ignores it — said early, with what to do instead.
        collections: {
          define: async () => {
            throw new Error(
              "An agent can't add or change collections. Propose an app instead (apps_propose), and a person in the space adds it.",
            );
          },
        },
        hosting: {
          space: async (spaceId) => {
            if (!allowed(spaceId)) throw new Error('That space was not given to this agent');
            return hosting.space(spaceId);
          },
        },
        contacts: {
          space: async () => (contactsGiven() ? contactsSpaceId : null),
          list: async () => (contactsGiven() ? contacts.list() : []),
          get: async (did) => (contactsGiven() ? contacts.get(did) : null),
        },
        direct: { reachable: async (spaceId) => (allowed(spaceId) ? direct.reachable(spaceId) : []) },
        doors: { list: async () => [] },
      };
    const person = (what: string) => async (): Promise<never> => {
      throw new Error(`An agent can't ${what}. Ask the person to do it.`);
    };

    return Object.freeze({
      did: config.signer.did,
      sessionDid: agentDid,
      ...buildNamespaces((namespace, name, policy) => {
        if (policy === 'own') return givenFor(own, namespace, name);
        const source: unknown = namespace === 'records' ? writes : Reflect.get(node, namespace);
        if (!isRecord(source)) throw new Error(`A node has no ${namespace}`);
        if (policy === 'pass') return (...args: unknown[]) => callMethod(source, name, args);
        if (policy !== 'scoped') return person(policy);
        return async (...args: unknown[]) => {
          if (!allowed(args[0]))
            throw new Error(
              'The agent was not given this space. The person can give it more in their account home.',
            );
          return callMethod(source, name, args);
        };
      }),
      delegation: () => note,
      iceServers: () => node.iceServers(),
      delegate: person('pass its access on'),
      asAgent: person('start another agent'),
      subscribe: (listener: (event: NodeEvent) => void) =>
        node.subscribe((event) => {
          if (!('space' in event) || allowed(event.space)) listener(event);
        }),
      // The agent stops; the node it acts through keeps running.
      close: async () => {},
    }) satisfies P2PNode;
  }

  const node: P2PNode = Object.freeze({
    did: config.signer.did,
    sessionDid,
    spaces,
    records,
    collections,
    account: accountApi,
    carriers,
    hosting,
    notifications,
    contacts,
    direct,
    doors,
    asAgent,

    delegation: () => current,

    iceServers: async () => (mesh ? mesh.iceServers() : (config.network?.iceServers ?? DEFAULT_ICE_SERVERS)),

    network: Object.freeze({
      status: () => mesh?.status() ?? { relays: [], links: [], connecting: [], turn: false },
      reconnect: () => mesh?.reconnect(),
    }),

    async delegate(params: DelegateParams) {
      const token = await delegateCapabilities(
        {
          parent: current,
          issuer: { did: sessionDid, privateKey: sessionKeys.privateKey },
          audience: params.audience,
          capabilities: params.capabilities,
          ...(params.expiration !== undefined ? { expiration: params.expiration } : {}),
        },
        provider,
      );
      return { token, proofs: [current.encoded] };
    },

    subscribe: events.subscribe,

    async close() {
      if (closed) return;
      closed = true;
      stopWatchingNetwork?.();
      if (renewTimer) clearTimeout(renewTimer);
      const open = [...runtimes.keys()];
      await Promise.all(open.map((spaceId) => closeRuntime(spaceId)));
      // Let go of the registry too: an open database connection blocks the
      // browser from ever deleting it.
      await registryStore.close();
      events.clear();
    },
  });
  return node;
}
