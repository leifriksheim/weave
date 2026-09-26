/**
 * @module node
 * A node: one identity, the spaces it holds, and everything needed to read,
 * write and sync them.
 *
 * This is what a browser tab, a command line, an always-on daemon and an agent
 * all have in common. Each of them is a thin layer over the same node — the
 * tab draws it, the CLI prints it, the daemon keeps it running and serves
 * sockets, the agent calls it through MCP or WebMCP.
 *
 * **The root key signs once.** Starting a node generates a session key and asks
 * the root signer for a note saying that key may write for the next hour. The
 * note is renewed before it runs out. Every record is signed by the session
 * key, so the root — a seed in this page, an account home, whatever holds it — is asked
 * for one signature an hour, never one per write.
 */
import { runQuery } from '../query/engine.js';
import { nameOf, plainQuery, type CollectionRef, type Include, type Query, type ResultOf } from '../query/types.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import type { Link, SpaceRole } from '../types.js';
import { publicKeyToDid, P256_MULTICODEC } from '../identity/did.js';
import { delegateCapabilities, parseUCAN, verifyUCAN, type Capability, type UCANToken } from '../identity/ucan.js';
import { isAgentNote } from '../identity/agent-note.js';
import { createSigner } from '../schema/signer.js';
import { createSchemaEngine } from '../schema/schema-engine.js';
import {
  createSpaceManager,
  encodeSpaceInvite,
  parseSpaceInvite,
  type InviteOptions as InviteSecret,
  type SpaceRecord,
} from '../space/space-manager.js';
import { checkRelays, MANAGE, MAX_KEEPERS, MAX_RELAYS, roleHolds, type Keeper } from '../space/roles.js';
import { meshFor, noteCid, openSpaceRuntime, type ActiveSession, type SpaceRuntime } from './space-runtime.js';
import { createServerAuth } from '../network/peer-auth.js';
import { DEFAULT_ICE_SERVERS } from '../network/rtc-transport.js';
import { deriveInviteKey } from '../space/space-access.js';
import { base64UrlDecode, base64UrlEncode } from '../utils/encoding.js';
import { onePerKey } from '../records/rules.js';
import { contactKeyPair, deriveMemberKeyBytes, openSealed, sealFor } from '../identity/contact-key.js';
import { contact as contactSchema, contactRequest as contactRequestSchema, type Contact, type ContactRequestRecord } from '../schemas/contacts.js';
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
  createHostClient,
  describeHost,
  HOSTING_COLLECTION,
  HostError,
  newSubscriptionSeed,
  payLink,
  readStatus,
  subscriptionKey,
  type HostClient,
  type HostDescription,
  type HostStatus,
  type Hosting,
  type SignedStatus,
} from '../session/hosting.js';
import { sha256 } from '../utils/hash.js';
import type {
  ContactRequest,
  ContactView,
  DefineCollection,
  DelegateParams,
  InviteOptions,
  InvitePreview,
  ListOptions,
  NewSpace,
  NodeConfig,
  NodeEvent,
  NodeRecord,
  NodeAccount,
  NodeCarriers,
  NodeHosting,
  HostingView,
  NodeCollections,
  NodeContacts,
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

/** Accepts a bare invite or a whole share link carrying one (`…#invite=…`). */
function bareInvite(invite: string): string {
  return /[#&?]invite=([^&\s]+)/.exec(invite)?.[1] ?? invite.trim();
}

/** Lets a long-lived timer not hold a process open on its own. */
function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Starts a node.
 *
 * @param config Who it acts for, where it keeps data, and how it reaches peers
 * @returns The running node; call `close()` when done
 */
export async function createNode(config: NodeConfig): Promise<P2PNode> {
  const provider = config.provider ?? createP256Provider();
  const signer = createSigner(provider);
  const ttl = config.sessionTtlSeconds ?? DEFAULT_TTL_SECONDS;

  const schemas = createSchemaEngine();
  for (const collection of config.collections ?? []) schemas.registerCollection(collection);

  // ─── Session ───────────────────────────────────────────────────────

  const sessionKeys = config.sessionKey ?? (await provider.generateKeyPair());
  const sessionDid = publicKeyToDid(await provider.exportPublicKey(sessionKeys.publicKey), P256_MULTICODEC);

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

  const session: ActiveSession = { did: sessionDid, key: sessionKeys.privateKey, proof: () => current.encoded };
  const mesh = meshFor(config.network, sessionDid);
  /**
   * A node that writes under an agent's note — an agent on someone's computer
   * running a node of its own. It follows the account, but never writes for
   * it: no list of spaces, no passes, no name. Every peer would ignore those.
   */
  const agentSession = isAgentNote(current.encoded);

  // ─── Events ────────────────────────────────────────────────────────

  const listeners = new Set<(event: NodeEvent) => void>();
  const emit = (event: NodeEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Error in node event listener:', e);
      }
    }
  };

  // ─── Spaces ────────────────────────────────────────────────────────

  const registryStore = await config.stores('registry', { seal: true });
  const registry = createSpaceManager(registryStore, provider);
  const runtimes = new Map<string, Promise<SpaceRuntime>>();
  /**
   * Who is holding each space open. One object per stretch of being held:
   * when the space closes for another reason (leaving it), the object goes,
   * and a release from before does nothing to whoever holds it next.
   */
  const holds = new Map<string, { count: number }>();

  // The account's own space list, kept in a space every device of the account
  // derives for itself. Hidden from `list`; everything else treats it as a space.
  const account = config.accountKey ? await deriveAccountRegistry(config.accountKey, config.signer.did, provider) : null;
  const accountSpaceId = account?.space.id ?? null;

  // The account's contacts, in a space derived the same way — or, for an app
  // given it by its account home, named in the config. Hidden from `list` too.
  const contactsRecord = config.accountKey ? await deriveContactsSpace(config.accountKey, config.signer.did, provider) : null;
  const contactsSpaceId = contactsRecord?.space.id ?? config.contactsSpace ?? null;
  // Kept in the node's own list like a joined space, so it can be shared with an app like one.
  if (contactsRecord && !(await registry.get(contactsRecord.space.id))) {
    await registry.join(await encodeSpaceInvite(contactsRecord, config.signer.did));
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
  async function inviteTo(spaceId: string, options: InviteSecret = {}): Promise<string> {
    const named = (await findRecord(spaceId))?.relays ?? [];
    const own = (config.network?.relays ?? []).filter((url) => checkRelays([url]) === null).slice(0, MAX_RELAYS);
    return registry.createInvite(spaceId, config.signer.did, { ...options, ...(named.length ? {} : own.length ? { relays: own } : {}) });
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
      for (const spaceId of runtimes.keys()) if (spaceId !== accountSpaceId) emit({ type: 'status', space: spaceId });
    }
    if (event.type === 'records') void runtimes.get(event.space)?.then((rt) => checkRevoked(event.space, rt)).catch(() => {});
    // A space joined with an invite whose record had not arrived: perhaps it has now.
    if (event.type === 'records' && event.space !== accountSpaceId) void finishJoining(event.space);
    if (event.type === 'records' && event.space === accountSpaceId) {
      emit({ type: 'account' });
      void reconcile();
      // A rename on another device reaches the spaces open here too.
      void publishProfileToOpenSpaces();
    }
  };

  /** The account's name, from its registry — null without an account key, or before one is set */
  async function ownName(): Promise<string | null> {
    if (!accountSpaceId) return null;
    const profile = await (await runtime(accountSpaceId)).get<AccountProfile>(PROFILE_KEY);
    return profile?.verified && profile.root === config.signer.did && typeof profile.body?.name === 'string' ? profile.body.name : null;
  }

  /**
   * Tells a space who this account is. Done when the space opens and when the
   * name changes — not by opening every space, which would start syncing them
   * all; a space not open now hears on its next open.
   */
  async function publishProfile(spaceId: string, open: SpaceRuntime): Promise<void> {
    if (spaceId === accountSpaceId || spaceId === contactsSpaceId || agentSession) return;
    const name = await ownName();
    if (name) await open.publishProfile({ name, ...(contactKeys ? { contactKey: contactKeys.publicKey } : {}) });
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
          peopleOnly: spaceId === accountSpaceId || spaceId === contactsSpaceId || carrySpaces.has(spaceId),
          // The account's own spaces are always held whole: every device needs all of them.
          ...(config.cache && spaceId !== accountSpaceId && spaceId !== contactsSpaceId && !carrySpaces.has(spaceId) ? { cache: config.cache } : {}),
          watchIntervalMs: config.watchIntervalMs ?? 2000,
          emit: fromRuntime,
          onRole: (role) => {
            if (spaceId === accountSpaceId) return;
            // Holding a role now — perhaps just joined — means the space may hear who this is.
            if (role !== null) void runtimes.get(spaceId)?.then((rt) => publishProfile(spaceId, rt)).catch(() => {});
            if (record.role === role) return;
            void registry.setRole(spaceId, role).then(() => emit({ type: 'spaces' }));
          },
          onJoined: () => {
            if (!record.invite) return;
            void registry.clearInvite(spaceId).then(() => emit({ type: 'spaces' }));
          },
          memberKey: spaceId === accountSpaceId ? null : config.accountKey ? await deriveMemberKeyBytes(config.accountKey, spaceId) : (record.memberKey ?? null),
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
    }
    return open;
  }

  /**
   * Uses a waiting invite, once its record has reached this device. Asked
   * again while it is still working, it runs once more afterwards — the
   * record that makes the difference may be the one that arrived meanwhile.
   */
  const joining = new Map<string, { again: boolean }>();
  async function finishJoining(spaceId: string): Promise<void> {
    const running = joining.get(spaceId);
    if (running) {
      running.again = true;
      return;
    }
    const state = { again: true };
    joining.set(spaceId, state);
    try {
      while (state.again && !closed) {
        state.again = false;
        const record = await registry.get(spaceId);
        if (!record?.invite) break;
        try {
          if (await (await runtime(spaceId)).join(record.invite)) break;
        } catch {
          // Not yet; the next change to the space tries again.
        }
      }
    } finally {
      joining.delete(spaceId);
    }
  }

  async function closeRuntime(spaceId: string): Promise<void> {
    holds.delete(spaceId);
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
    const records = await (await runtime(accountSpaceId)).list<Membership>({ collection: MEMBERSHIP_COLLECTION, includeDeleted: true });
    // Only the account itself may say what it belongs to.
    return records.filter(
      (record) =>
        record.verified &&
        record.root === config.signer.did &&
        (record.deleted || (typeof record.body?.space === 'string' && record.key === membershipKey(record.body.space))),
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
    if (known && (!options.refresh || known.deleted || inviteKeyOf(known.body?.invite) === inviteKeyOf(invite))) return;
    await open.upsertSystem<Membership>(MEMBERSHIP_COLLECTION, membershipKey(spaceId), { space: spaceId, invite });
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
  async function carrierRecords(): Promise<ReadonlyArray<{ readonly record: NodeRecord<Carrier>; readonly space: string }>> {
    if (!accountSpaceId) return [];
    const open = await runtime(accountSpaceId);
    const found: Array<{ record: NodeRecord<Carrier>; space: string }> = [];
    for (const record of await open.list<Carrier>({ collection: CARRIER_COLLECTION, includeDeleted: true })) {
      if (!record.verified || record.root !== config.signer.did) continue;
      if (!record.deleted) {
        if (typeof record.body?.space === 'string' && typeof record.body.invite === 'string') found.push({ record, space: record.body.space });
        continue;
      }
      const before = (await open.history<Carrier>(record.key)).find((version) => typeof version.body?.space === 'string');
      if (before?.body) found.push({ record, space: before.body.space });
    }
    return found;
  }

  /** Every carry space, live or not — kept out of the account's own list */
  let carrySpaces = new Set<string>();

  /** Puts a pass in a carrier's space for each of the account's spaces, and takes away the rest. */
  async function syncPasses(carrier: Carrier): Promise<void> {
    if (!account || agentSession) return;
    const wanted = new Map<string, SpacePass>();
    // The registry and the contacts too, so a restore can come through the carrier.
    wanted.set(await passKey(account.space.id), await makePass(account));
    if (contactsRecord) wanted.set(await passKey(contactsRecord.space.id), await makePass(contactsRecord));
    for (const membership of await memberships()) {
      if (membership.deleted || !membership.body) continue;
      const spaceId = membership.body.space;
      if (hidden(spaceId)) continue;
      const record = await registry.get(spaceId);
      if (!record) continue;
      try {
        wanted.set(await passKey(spaceId), await makePass(record));
      } catch {
        // Held without its key — nothing to pass on until it arrives.
      }
    }

    const carry = await runtime(carrier.space);
    const held = new Map(
      (await carry.list<SpacePass>({ collection: PASS_COLLECTION, includeDeleted: true }))
        .filter((record) => record.verified && record.root === config.signer.did && record.key.startsWith('pass:'))
        .map((record) => [record.key, record]),
    );
    for (const [key, pass] of wanted) {
      const current = held.get(key);
      if (!current || current.deleted || JSON.stringify(current.body) !== JSON.stringify(pass)) {
        await carry.upsertSystem(PASS_COLLECTION, key, pass);
      }
      held.delete(key);
    }
    for (const [key, record] of held) if (!record.deleted) await carry.removeSystem(key);
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
    const active = carriers.filter(({ record }) => !record.deleted && record.body).map(({ record }) => record.body!);
    const gone = new Set<string>();
    for (const { record } of carriers) {
      if (!record.deleted) continue;
      for (const version of await (await runtime(accountSpaceId!)).history<Carrier>(record.key)) if (version.body?.did) gone.add(version.body.did);
    }
    for (const carrier of active) gone.delete(carrier.did);
    const kept = access.keepers.filter((keeper) => !gone.has(keeper.did));
    const added = active.filter((carrier) => !kept.some((keeper) => keeper.did === carrier.did)).map((c) => ({ did: c.did, name: c.name.slice(0, 80) }));
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
        if (!held.has(spaceId) || Date.now() - Date.parse(record.updatedAt) < FORGET_CARRIER_AFTER_MS) continue;
        await closeRuntime(spaceId);
        await registry.remove(spaceId);
        held.delete(spaceId);
      } else if (!held.has(spaceId)) {
        try {
          await registry.join(record.body!.invite);
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
          await registry.join(membership.body!.invite);
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

    if (changed) emit({ type: 'spaces' });
  }

  let reconciling: Promise<void> = Promise.resolve();
  function reconcile(): Promise<void> {
    reconciling = reconciling.then(reconcileOnce).catch((error: unknown) => {
      if (!closed) console.error('Could not reconcile the account registry:', error);
    });
    return reconciling;
  }

  const spaces: NodeSpaces = Object.freeze({
    async list() {
      return (await registry.list()).filter((record) => !hidden(record.space.id)).map(summarize);
    },

    async get(spaceId: string) {
      const record = await findRecord(spaceId);
      return record ? summarize(record) : null;
    },

    async create(params: NewSpace) {
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

    async invite(spaceId: string, options: InviteOptions = {}) {
      if (options.write === false) return inviteTo(spaceId);
      const open = await runtime(spaceId);
      const { roles, role: mine } = await open.access();
      // By default the lowest role below your own; with none below you, a view-only invite.
      const role = options.role ?? (mine ? [...roles].reverse().find((candidate) => candidate.rank < mine.rank)?.name : undefined);
      if (!role) {
        if (options.role !== undefined || !mine) throw new Error(mine ? `There is no role "${options.role}"` : 'You hold no role here, so you can only share it to view');
        return inviteTo(spaceId);
      }
      const { secret } = await open.openInvite(role);
      return inviteTo(spaceId, { secret, role });
    },

    preview(invite: string): InvitePreview {
      const parsed = parseSpaceInvite(bareInvite(invite));
      const { id, name, visibility, creator, createdAt } = parsed.space;
      return {
        space: { id, name, visibility, creator, createdAt },
        invitedBy: parsed.invitedBy,
        carriesKey: typeof parsed.key === 'string',
        carriesWrite: typeof parsed.invite === 'string',
        role: typeof parsed.invite === 'string' ? (parsed.role ?? null) : null,
      };
    },

    async join(invite: string, options: { readonly memberKey?: Uint8Array } = {}) {
      const record = await registry.join(bareInvite(invite));
      if (options.memberKey) await registry.setMemberKey(record.space.id, options.memberKey);
      // A runtime opened before the key arrived would still be unable to read.
      await closeRuntime(record.space.id);
      await remember(record.space.id);
      // Uses the invite now if its record is here already — otherwise when it arrives.
      await finishJoining(record.space.id);
      emit({ type: 'spaces' });
      return summarize((await registry.get(record.space.id)) ?? record);
    },

    async leave(spaceId: string) {
      if (spaceId === accountSpaceId) throw new Error('The account registry cannot be left');
      if (spaceId === contactsSpaceId) throw new Error('The contacts space cannot be left');
      await forget(spaceId);
      await closeRuntime(spaceId);
      await registry.remove(spaceId);
      emit({ type: 'spaces' });
    },

    async hold(spaceId: string) {
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

    async send(spaceId: string, message: unknown, to?: string) {
      await (await runtime(spaceId)).send(message, to);
    },

    async status(spaceId: string) {
      const status = await (await runtime(spaceId)).status();
      if (!accountSpaceId) return { ...status, own: [], carriers: [] };
      // A peer's key does not say whose it is. But only this account's devices
      // and apps can read the account registry, so a peer there is one of ours
      // — except a carrier, which the registry names by its key.
      const carrierKeys = new Set((await carrierRecords()).filter(({ record }) => !record.deleted && record.body).map(({ record }) => record.body!.did));
      const inRegistry = new Set((await (await runtime(accountSpaceId)).status()).peers);
      return {
        ...status,
        own: status.peers.filter((peer) => inRegistry.has(peer) && !carrierKeys.has(peer)),
        carriers: status.peers.filter((peer) => carrierKeys.has(peer)),
      };
    },

    async profiles(spaceId: string) {
      return (await runtime(spaceId)).profiles();
    },

    async access(spaceId: string) {
      return (await runtime(spaceId)).access();
    },

    async setMember(spaceId: string, did: string, role: string | null) {
      await (await runtime(spaceId)).setMember(did, role);
    },

    async putRole(spaceId: string, role: SpaceRole) {
      await (await runtime(spaceId)).putRole(role);
    },

    async removeRole(spaceId: string, name: string) {
      await (await runtime(spaceId)).removeRole(name);
    },

    async closeInvite(spaceId: string, keyOrLink: string) {
      let key = keyOrLink;
      // The link itself will do: its secret names the invite.
      if (!keyOrLink.startsWith('did:key:')) {
        const secret = parseSpaceInvite(bareInvite(keyOrLink)).invite;
        if (!secret) throw new Error('That invite is view-only — there is nothing to close. To stop it working, give the space a new key (changeKey).');
        key = (await deriveInviteKey(base64UrlDecode(secret), provider)).did;
      }
      await (await runtime(spaceId)).closeInvite(key);
    },

    async revoke(spaceId: string, token: string) {
      await (await runtime(spaceId)).revoke(token);
    },

    async changeKey(spaceId: string) {
      await (await runtime(spaceId)).rotateKey();
    },

    async setRelays(spaceId: string, relays: ReadonlyArray<string>) {
      await (await runtime(spaceId)).setRelays(relays);
    },

    async setKeepers(spaceId: string, keepers: ReadonlyArray<Keeper>, copies?: number | null) {
      await (await runtime(spaceId)).setKeepers(keepers, copies ?? null);
    },

    async authenticator(spaceId: string) {
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

  const carriers: NodeCarriers = Object.freeze({
    async list() {
      return (await carrierRecords())
        .filter(({ record }) => !record.deleted && record.body)
        .map(({ record: { body } }) => ({ space: body!.space, did: body!.did, name: body!.name, since: body!.since }));
    },

    async add(carrier: { readonly did: string; readonly name: string }) {
      if (!accountSpaceId) throw new Error('Using a carrier needs the account key');
      const name = carrier.name.trim().slice(0, 80) || 'Carrier';
      // Private, so the passes in it are sealed; the account alone may write there.
      const record = await registry.create({ name: `Carried by ${name}`, visibility: 'private', creator: config.signer.did });
      carrySpaces.add(record.space.id);
      const invite = await registry.createInvite(record.space.id, config.signer.did);
      const body: Carrier = { space: record.space.id, invite, did: carrier.did, name, since: new Date().toISOString() };
      await (await runtime(accountSpaceId)).upsertSystem<Carrier>(CARRIER_COLLECTION, await carrierKey(record.space.id), body);
      await syncPasses(body);
      return { space: record.space.id, invite };
    },

    async remove(spaceId: string) {
      if (!accountSpaceId) throw new Error('Removing a carrier needs the account key');
      const found = (await carrierRecords()).find(({ record, space }) => !record.deleted && space === spaceId)?.record;
      if (!found) return;
      const carry = await runtime(spaceId);
      // Passes gone first, then the word to forget everything, then the carrier's record.
      for (const pass of await carry.list({ collection: PASS_COLLECTION })) {
        if (pass.verified && pass.root === config.signer.did && pass.key.startsWith('pass:')) await carry.removeSystem(pass.key);
      }
      await carry.upsertSystem(PASS_COLLECTION, CARRY_CLOSED_KEY, { v: 1, closed: true });
      await (await runtime(accountSpaceId)).removeSystem(found.key);
    },
  });

  // ─── Hosting ───────────────────────────────────────────────────────
  //
  // A host is a carrier the account pays for. The subscription key lives in
  // the registry (`sys.hosting`), so every device signs as the same
  // subscription, and any of them hands the host the carry space once it is
  // paid — the one that paid, or the next one to notice.

  const hostingKey = async (url: string) =>
    `hosting:${Array.from((await sha256(new TextEncoder().encode(url))).subarray(0, 20), (b) => b.toString(16).padStart(2, '0')).join('')}`;

  /** The hosting records the account wrote, live */
  async function hostingRecords(): Promise<ReadonlyArray<Hosting>> {
    if (!accountSpaceId) return [];
    const records = await (await runtime(accountSpaceId)).list<Hosting>({ collection: HOSTING_COLLECTION });
    return records
      .filter((record) => record.verified && record.root === config.signer.did && typeof record.body?.url === 'string' && typeof record.body.seed === 'string')
      .map((record) => record.body!);
  }

  async function hostClient(hosting: Hosting): Promise<{ client: HostClient; subscription: string }> {
    const key = await subscriptionKey(base64UrlDecode(hosting.seed), provider);
    return { client: createHostClient(hosting.url, hosting.host, key, provider), subscription: key.did };
  }

  /** What the host at a known address says about itself — refused when it's another host now */
  async function describeKnown(hosting: Hosting): Promise<HostDescription> {
    const description = await describeHost(hosting.url);
    if (description.did !== hosting.host) throw new Error("The host at this address has another key now, so it's another host");
    return description;
  }

  /** The carry space shared with a host: the one the account made for it, or a new one */
  async function carryFor(hosting: Hosting): Promise<string> {
    const known = (await carrierRecords()).find(({ record }) => !record.deleted && record.body?.did === hosting.host)?.record.body;
    return known ? known.invite : (await carriers.add({ did: hosting.host, name: new URL(hosting.url).host })).invite;
  }

  /** Last time each host was handed the spaces, or refused them — so asking again waits a while */
  const handedAt = new Map<string, number>();
  const HAND_AGAIN_MS = 60_000;
  /** Handovers under way, by host address: a second look waits for the first rather than reporting what it will change */
  const handing = new Map<string, Promise<{ status: HostStatus; receipt: SignedStatus }>>();

  /**
   * Keeps what the host signed in the registry, so every device shows it and
   * the person holds the host's word — written only when what it says changed.
   */
  async function keepReceipt(hosting: Hosting, kept: HostStatus | null, status: HostStatus, receipt: SignedStatus, name: string): Promise<void> {
    if (agentSession || !accountSpaceId) return;
    const same = kept && kept.state === status.state && kept.paidUntil === status.paidUntil && kept.renews === status.renews && hosting.name === name;
    if (same) return;
    const record: Hosting = { ...hosting, name, receipt };
    await (await runtime(accountSpaceId)).upsertSystem<Hosting>(HOSTING_COLLECTION, await hostingKey(hosting.url), record);
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
      const paid = status.state === 'active' || status.state === 'grace' || (description.free && status.state !== 'lapsed');
      const underWay = handing.get(hosting.url);
      if (underWay) {
        ({ status, receipt } = await underWay);
      } else if (!status.carrying && paid && due && !agentSession) {
        handedAt.set(hosting.url, Date.now());
        const asked = { status, receipt };
        const handover = (async () => {
          try {
            return await client.attach(config.signer.did, await carryFor(hosting));
          } catch (error) {
            // Not paid after all (it lapsed in between): the status says so.
            if (!(error instanceof HostError && error.status === 402)) throw error;
            return asked;
          }
        })();
        handing.set(hosting.url, handover);
        try {
          ({ status, receipt } = await handover);
        } finally {
          handing.delete(hosting.url);
        }
      }
      await keepReceipt(hosting, kept, status, receipt, description.name);
      return {
        ...base,
        name: description.name,
        status,
        live: true,
        pays: description.pay !== undefined,
        ...(description.price ? { price: description.price } : {}),
      };
    } catch (error) {
      return { ...base, name: hosting.name ?? new URL(hosting.url).host, status: kept, live: false, pays: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

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
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error(`${what} is reached over https://`);
    return url;
  }

  const hosting: NodeHosting = Object.freeze({
    async list() {
      return Promise.all((await hostingRecords()).map((known) => viewHosting(known)));
    },

    async use(address: string) {
      if (!accountSpaceId) throw new Error('Using a host needs the account key');
      const base = checkAddress(address, 'A host').origin;
      const known = (await hostingRecords()).find((existing) => existing.url === base);
      if (known) return viewHosting(known, true);
      const description = await describeHost(base);
      const record: Hosting = { url: base, host: description.did, name: description.name, seed: base64UrlEncode(newSubscriptionSeed()), since: new Date().toISOString() };
      await (await runtime(accountSpaceId)).upsertSystem<Hosting>(HOSTING_COLLECTION, await hostingKey(base), record);
      return viewHosting(record, true);
    },

    async payPage(url: string) {
      const known = await requireHosting(url);
      const description = await describeKnown(known);
      if (description.pay === undefined) throw new Error('This host takes no payments');
      const page = checkAddress(new URL(description.pay, `${known.url}/`).toString(), 'A pay page');
      return payLink(page.toString(), known.host, await subscriptionKey(base64UrlDecode(known.seed), provider), provider);
    },

    async stop(url: string) {
      if (!accountSpaceId) throw new Error('Stopping a host needs the account key');
      const known = await requireHosting(url);
      const { client } = await hostClient(known);
      await client.detach().catch(() => {});
      const carrier = (await carrierRecords()).find(({ record }) => !record.deleted && record.body?.did === known.host);
      if (carrier) await carriers.remove(carrier.space);
      await (await runtime(accountSpaceId)).removeSystem(await hostingKey(known.url));
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
  const contactRecordKey = async (did: string) => (await onePerKey(contactSchema.name, contactSchema.rules.onePer, { root: config.signer.did, links: [], body: { did } }))!;
  const requestContext = (spaceId: string, from: string, to: string) => `weave/contact-request|${spaceId}|${from}|${to}`;

  async function contactsRuntime(): Promise<SpaceRuntime> {
    if (!contactsSpaceId) throw new Error('This app was not given your contacts. Connect to your account home again, and allow contacts.');
    return runtime(contactsSpaceId);
  }

  /** Making and joining spaces for two needs a note good for every space — whole-account access. */
  function requireEverywhere(what: string): void {
    if (!current.payload.att.some((capability) => capability.with === '*')) {
      throw new Error(`${what} makes or joins a space, which needs access to your whole account. Connect to your account home again, and ask for it.`);
    }
  }

  /** Defines a collection in a space that has none by that name yet */
  async function ensureDefined(open: SpaceRuntime, definition: DefineCollection): Promise<void> {
    if ((await open.collections()).some((collection) => collection.name === definition.name && collection.version !== null)) return;
    try {
      await open.define(definition);
    } catch {
      throw new Error(`This space has no ${definition.title ?? definition.name} collection yet, and you can't add one here. Ask someone who manages it.`);
    }
  }

  async function contactRecords(): Promise<ReadonlyArray<NodeRecord<Contact>>> {
    if (!contactsSpaceId) return [];
    const found: NodeRecord<Contact>[] = [];
    for (const record of await (await contactsRuntime()).list<Contact>({ collection: contactSchema.name })) {
      // Only the account writes its own list; one record per person, under the key their DID gives.
      if (!record.verified || record.root !== config.signer.did || typeof record.body?.did !== 'string' || typeof record.body.name !== 'string') continue;
      if (record.key !== (await contactRecordKey(record.body.did))) continue;
      found.push(record);
    }
    return found;
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
    if ((await contactRecords()).some((record) => record.body!.did !== did && record.body!.space === spaceId)) return;
    await spaces.leave(spaceId);
  }

  /** A contact request, opened — or null when it isn't one for this account, from the account that wrote it */
  async function openRequest(
    spaceId: string,
    record: NodeRecord<ContactRequestRecord>,
  ): Promise<{ readonly from: string; readonly invite: string; readonly note?: string; readonly pairSpace: string } | null> {
    if (!contactKeys || !record.verified || record.viaAgent || record.collection !== contactRequestSchema.name) return null;
    if (record.body?.to !== config.signer.did || typeof record.body.sealed !== 'string') return null;
    const from = record.root;
    if (!from || record.createdBy !== from || from === config.signer.did) return null;
    const value = (await openSealed(contactKeys.privateKey, record.body.sealed, requestContext(spaceId, from, config.signer.did))) as {
      invite?: unknown;
      note?: unknown;
    } | null;
    if (typeof value?.invite !== 'string') return null;
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

  const contacts: NodeContacts = Object.freeze({
    async space() {
      return contactsSpaceId;
    },

    async list() {
      return (await contactRecords()).map(contactView).sort((a, b) => a.name.localeCompare(b.name) || a.did.localeCompare(b.did));
    },

    async get(did: string) {
      const record = (await contactRecords()).find((found) => found.body!.did === did);
      return record ? contactView(record) : null;
    },

    async put(contact: { readonly did: string; readonly name: string; readonly space?: string | null; readonly note?: string }) {
      if (!contact.did.startsWith('did:')) throw new Error('A contact needs their account DID');
      const name = contact.name.trim().slice(0, 200);
      if (!name) throw new Error('A contact needs a name');
      return writeContact({
        did: contact.did,
        name,
        ...(contact.space ? { space: contact.space } : {}),
        ...(contact.note ? { note: contact.note.slice(0, 2000) } : {}),
      });
    },

    async remove(did: string) {
      const found = await contacts.get(did);
      if (!found) return;
      await leavePairSpace(found.space, did);
      await (await contactsRuntime()).remove(await contactRecordKey(did));
    },

    async block(did: string) {
      const found = await contacts.get(did);
      await leavePairSpace(found?.space ?? null, did);
      await writeContact({ did, name: found?.name ?? did, blocked: true, ...(found?.note ? { note: found.note } : {}) });
    },

    async ask(spaceId: string, did: string, options: { readonly note?: string } = {}) {
      requireEverywhere('Adding a contact');
      if (did === config.signer.did) throw new Error('That is you');
      if (!contactsSpaceId) await contactsRuntime();
      const shared = await runtime(spaceId);
      const profiles = await shared.profiles();
      const theirs = profiles.find((profile) => profile.did === did);
      if (!theirs?.contactKey) {
        throw new Error("They can't be asked here yet: their profile in this space has no contact key. It appears once they open the space in an up-to-date app.");
      }
      await ensureDefined(shared, contactRequestSchema);

      const mine = (await ownName()) ?? profiles.find((profile) => profile.did === config.signer.did)?.name ?? 'Me';
      const pair = await spaces.create({ name: `${mine} & ${theirs.name}`, visibility: 'private', ...team });
      const invite = await spaces.invite(pair.id, { role: 'editor' });
      await writeContact({ did, name: theirs.name, space: pair.id });
      const note = options.note?.trim().slice(0, 2000);
      const sealed = await sealFor(theirs.contactKey, { invite, ...(note ? { note } : {}) }, requestContext(spaceId, config.signer.did, did));
      const request = await shared.put<ContactRequestRecord>(contactRequestSchema.name, { to: did, sealed });
      return { space: pair.id, request: request.key };
    },

    async requests(spaceId: string) {
      if (!contactKeys) throw new Error("This app can't read contact requests. Connect to your account home again, and allow contacts.");
      const shared = await runtime(spaceId);
      const blocked = new Set((await contactRecords()).filter((record) => record.body!.blocked === true).map((record) => record.body!.did));
      const names = new Map((await shared.profiles()).map((profile) => [profile.did, profile.name]));
      const found: ContactRequest[] = [];
      for (const record of await shared.list<ContactRequestRecord>({ collection: contactRequestSchema.name })) {
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

    async accept(spaceId: string, requestKey: string) {
      requireEverywhere('Accepting a contact request');
      if (!contactKeys) throw new Error("This app can't read contact requests. Connect to your account home again, and allow contacts.");
      const shared = await runtime(spaceId);
      const record = await shared.get<ContactRequestRecord>(requestKey);
      const opened = record ? await openRequest(spaceId, record) : null;
      if (!opened) throw new Error('That contact request is gone, or is not for you.');
      await spaces.join(opened.invite);
      const name = (await shared.profiles()).find((profile) => profile.did === opened.from)?.name ?? (await contacts.get(opened.from))?.name ?? opened.from;
      return writeContact({ did: opened.from, name, space: opened.pairSpace });
    },

    async others(did: string) {
      const found = await contacts.get(did);
      if (!found?.space || !(await registry.get(found.space))) return [];
      const open = await runtime(found.space);
      const [{ members }, profiles, status] = await Promise.all([open.access(), open.profiles(), open.status()]);
      const seen = new Set([...members.map((member) => member.did), ...profiles.map((profile) => profile.did), ...Object.values(status.accounts)]);
      return [...seen].filter((account) => account !== config.signer.did && account !== did).sort();
    },
  });

  const collections: NodeCollections = Object.freeze({
    async list(spaceId: string) {
      return (await runtime(spaceId)).collections();
    },
    async define(spaceId: string, definition: DefineCollection) {
      return (await runtime(spaceId)).define(definition);
    },
    async delete(spaceId: string, name: string) {
      return (await runtime(spaceId)).undefine(name);
    },
  });

  const accountApi: NodeAccount = Object.freeze({
    async profile() {
      if (!accountSpaceId) return null;
      // One record, key `profile`: its current version is the name, by the
      // ordering rule — the same on every device, whatever their clocks say.
      const profile = await (await runtime(accountSpaceId)).get<AccountProfile>(PROFILE_KEY);
      if (!profile?.verified || profile.root !== config.signer.did || typeof profile.body?.name !== 'string') return null;
      return { name: profile.body.name, updatedAt: profile.updatedAt };
    },
    async setName(name: string) {
      if (!accountSpaceId) throw new Error('Renaming across devices needs the account key');
      const trimmed = name.trim();
      if (!trimmed) throw new Error('A name cannot be empty');
      const written = await (await runtime(accountSpaceId)).upsertSystem<AccountProfile>(PROFILE_COLLECTION, PROFILE_KEY, { name: trimmed });
      emit({ type: 'account' });
      await publishProfileToOpenSpaces();
      return { name: trimmed, updatedAt: written.updatedAt };
    },
    async revoke(token: string) {
      if (!accountSpaceId) throw new Error('Revoking in the account registry needs the account key');
      await (await runtime(accountSpaceId)).revoke(token);
    },
  });

  const records: NodeRecords = Object.freeze({
    async list<T>(spaceId: string, options?: ListOptions) {
      return (await runtime(spaceId)).list<T>(options);
    },
    async get<T>(spaceId: string, key: string) {
      return (await runtime(spaceId)).get<T>(key);
    },
    async put<T>(spaceId: string, collection: CollectionRef, body: T, options?: { key?: string; links?: ReadonlyArray<Link> }) {
      return (await runtime(spaceId)).put<T>(nameOf(collection), body, options);
    },
    async update<T>(spaceId: string, key: string, body: T, options?: { links?: ReadonlyArray<Link> }) {
      return (await runtime(spaceId)).update<T>(key, body, options);
    },
    async linked<T>(spaceId: string, key: string, options?: { rel?: string; collection?: string }) {
      return (await runtime(spaceId)).linked<T>(key, options);
    },
    async delete(spaceId: string, key: string) {
      await (await runtime(spaceId)).remove(key);
    },
    async history<T>(spaceId: string, key: string) {
      return (await runtime(spaceId)).history<T>(key);
    },
    async can(spaceId: string, action: 'create' | 'edit' | 'delete', target: string) {
      return (await runtime(spaceId)).can(action, target);
    },
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
      return { ...result, complete } as ResultOf<Q>;
    },
    watch<Q extends Query>(spaceId: string, query: Q, onResult: (result: ResultOf<Q>) => void, onError?: (error: Error) => void) {
      // Changes arrive in bursts during sync; one run at a time, and one more
      // after it if anything changed meanwhile — never a queue of stale runs.
      let stopped = false;
      let running = false;
      let again = false;
      const run = async () => {
        if (running) {
          again = true;
          return;
        }
        running = true;
        do {
          again = false;
          try {
            const result = await records.query(spaceId, query);
            if (!stopped) onResult(result);
          } catch (error) {
            if (!stopped) onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        } while (again && !stopped);
        running = false;
      };
      const listener = (event: NodeEvent) => {
        if (event.type === 'records' && event.space === spaceId) void run();
      };
      listeners.add(listener);
      void run();
      return () => {
        stopped = true;
        listeners.delete(listener);
      };
    },
  });

  // ─── Agents ────────────────────────────────────────────────────────

  async function asAgent(agent: { readonly keys: CryptoKeyPair; readonly note: string }): Promise<P2PNode> {
    const agentDid = publicKeyToDid(await provider.exportPublicKey(agent.keys.publicKey), P256_MULTICODEC);
    const checked = await verifyUCAN(agent.note, provider);
    if (!checked.valid) throw new Error(`The agent's note does not check out: ${checked.reason ?? 'invalid'}`);
    if (!isAgentNote(agent.note)) throw new Error('That note is not an agent\'s — ask the account home for one with `agent: true`.');
    const note: UCANToken = { ...parseUCAN(agent.note), encoded: agent.note, cid: await noteCid(agent.note) };
    if (note.payload.aud !== agentDid) throw new Error('That note was made out to a different key.');
    if (note.payload.iss !== config.signer.did) throw new Error('That note is from a different account.');

    const as: ActiveSession = { did: agentDid, key: agent.keys.privateKey, proof: () => note.encoded };
    // The spaces its note names; `*` is every space, which a home never gives an agent but a note could say.
    const all = note.payload.att.some((capability) => capability.with === '*');
    const named = new Set(note.payload.att.filter((c) => c.with.startsWith('space:')).map((c) => c.with.slice('space:'.length)));
    const allowed = (spaceId: string) => all || named.has(spaceId);
    const inside = (spaceId: string) => {
      if (!allowed(spaceId)) throw new Error('The agent was not given this space. The person can give it more in their account home.');
    };
    const person = (what: string) => async (): Promise<never> => {
      throw new Error(`An agent can't ${what}. Ask the person to do it.`);
    };

    const agentSpaces: NodeSpaces = Object.freeze({
      ...spaces,
      list: async () => (await spaces.list()).filter((space) => allowed(space.id)),
      get: async (spaceId: string) => (allowed(spaceId) ? spaces.get(spaceId) : null),
      create: person('make spaces'),
      invite: person('invite anyone'),
      join: person('join spaces'),
      leave: person('leave spaces'),
      setMember: person('change who is in a space'),
      putRole: person('change roles'),
      removeRole: person('change roles'),
      closeInvite: person('close invites'),
      revoke: person('revoke notes'),
      access: async (spaceId: string) => (inside(spaceId), spaces.access(spaceId)),
      hold: async (spaceId: string) => (inside(spaceId), spaces.hold(spaceId)),
      status: async (spaceId: string) => (inside(spaceId), spaces.status(spaceId)),
      profiles: async (spaceId: string) => (inside(spaceId), spaces.profiles(spaceId)),
      // It would arrive as the person: a live message carries no note of its own to say "via agent".
      send: person('send live messages'),
      authenticator: async () => null,
    });

    const agentRecords: NodeRecords = Object.freeze({
      list: async <T>(spaceId: string, options?: ListOptions) => (inside(spaceId), records.list<T>(spaceId, options)),
      get: async <T>(spaceId: string, key: string) => (inside(spaceId), records.get<T>(spaceId, key)),
      put: async <T>(spaceId: string, collection: CollectionRef, body: T, options?: { key?: string; links?: ReadonlyArray<Link> }) => {
        inside(spaceId);
        return (await runtime(spaceId)).put<T>(nameOf(collection), body, { ...options, as });
      },
      update: async <T>(spaceId: string, key: string, body: T, options?: { links?: ReadonlyArray<Link> }) => {
        inside(spaceId);
        return (await runtime(spaceId)).update<T>(key, body, { ...options, as });
      },
      linked: async <T>(spaceId: string, key: string, options?: { rel?: string; collection?: string }) => (inside(spaceId), records.linked<T>(spaceId, key, options)),
      delete: async (spaceId: string, key: string) => {
        inside(spaceId);
        await (await runtime(spaceId)).remove(key, { as });
      },
      history: async <T>(spaceId: string, key: string) => (inside(spaceId), records.history<T>(spaceId, key)),
      can: async (spaceId: string, action: 'create' | 'edit' | 'delete', target: string) => allowed(spaceId) && records.can(spaceId, action, target),
      query: async <Q extends Query>(spaceId: string, query: Q) => (inside(spaceId), records.query(spaceId, query)),
      watch: <Q extends Query>(spaceId: string, query: Q, onResult: (result: ResultOf<Q>) => void, onError?: (error: Error) => void) => {
        if (!allowed(spaceId)) {
          onError?.(new Error('The agent was not given this space.'));
          return () => {};
        }
        return records.watch(spaceId, query, onResult, onError);
      },
    });

    const agentCollections: NodeCollections = Object.freeze({
      list: async (spaceId: string) => (inside(spaceId), collections.list(spaceId)),
      // The runtime refuses these too, and every peer ignores them — said early, with what to do instead.
      define: async () => {
        throw new Error('An agent can\'t add or change collections. Propose an app instead (apps_propose), and a person in the space adds it.');
      },
      delete: async () => {
        throw new Error('An agent can\'t remove collections. Ask the person to do it.');
      },
    });

    return Object.freeze({
      did: config.signer.did,
      sessionDid: agentDid,
      spaces: agentSpaces,
      records: agentRecords,
      collections: agentCollections,
      account: Object.freeze({ profile: accountApi.profile, setName: person('rename the account'), revoke: person('revoke notes') }),
      carriers: Object.freeze({ list: carriers.list, add: person('add a carrier'), remove: person('remove a carrier') }),
      hosting: Object.freeze({
        list: person('look at hosting'),
        use: person('start using a host'),
        payPage: person('pay for hosting'),
        stop: person('stop using a host'),
      }),
      // The list only when the agent was given it; changing it, or asking anyone, is the person's.
      contacts: Object.freeze({
        space: async () => (contactsSpaceId && allowed(contactsSpaceId) ? contactsSpaceId : null),
        list: async () => (contactsSpaceId && allowed(contactsSpaceId) ? contacts.list() : []),
        get: async (did: string) => (contactsSpaceId && allowed(contactsSpaceId) ? contacts.get(did) : null),
        put: person('change contacts'),
        remove: person('change contacts'),
        block: person('block anyone'),
        ask: person('ask anyone to be a contact'),
        requests: person('open contact requests'),
        accept: person('accept contact requests'),
        others: person('look inside a contact\'s space'),
      }),
      delegation: () => note,
      iceServers: node.iceServers,
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
    contacts,
    asAgent,

    delegation: () => current,

    iceServers: async () => (mesh ? mesh.iceServers() : (config.network?.iceServers ?? DEFAULT_ICE_SERVERS)),

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

    subscribe(listener: (event: NodeEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      if (renewTimer) clearTimeout(renewTimer);
      const open = [...runtimes.keys()];
      await Promise.all(open.map((spaceId) => closeRuntime(spaceId)));
      // Let go of the registry too: an open database connection blocks the
      // browser from ever deleting it.
      await registryStore.close();
      listeners.clear();
    },
  });
  return node;
}
