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
import { nameOf, type CollectionRef, type Query, type ResultOf } from '../query/types.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import type { Link, SpaceRole } from '../types.js';
import { publicKeyToDid, P256_MULTICODEC } from '../identity/did.js';
import { delegateCapabilities, parseUCAN, verifyUCAN, type Capability, type UCANToken } from '../identity/ucan.js';
import { isAgentNote } from '../identity/agent-note.js';
import { createSigner } from '../schema/signer.js';
import { createSchemaEngine } from '../schema/schema-engine.js';
import { createSpaceManager, parseSpaceInvite, type SpaceRecord } from '../space/space-manager.js';
import { meshFor, noteCid, openSpaceRuntime, type ActiveSession, type SpaceRuntime } from './space-runtime.js';
import { createServerAuth } from '../network/peer-auth.js';
import { deriveInviteKey } from '../space/space-access.js';
import { base64UrlDecode } from '../utils/encoding.js';
import {
  CARRIER_COLLECTION,
  deriveAccountRegistry,
  MEMBERSHIP_COLLECTION,
  PROFILE_COLLECTION,
  PROFILE_KEY,
  type AccountProfile,
  type Carrier,
  type Membership,
} from '../space/account-registry.js';
import { CARRY_CLOSED_KEY, makePass, PASS_COLLECTION, passKey, type SpacePass } from '../space/pass.js';
import type {
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
  NodeCollections,
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

  // The account's own space list, kept in a space every device of the account
  // derives for itself. Hidden from `list`; everything else treats it as a space.
  const account = config.accountKey ? await deriveAccountRegistry(config.accountKey, config.signer.did, provider) : null;
  const accountSpaceId = account?.space.id ?? null;

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
    if (spaceId === accountSpaceId || agentSession) return;
    const name = await ownName();
    if (name) await open.publishProfile({ name });
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
      open = requireRecord(spaceId).then((record) =>
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
          peopleOnly: spaceId === accountSpaceId || carrySpaces.has(spaceId),
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
        }),
      );
      // A failed open must not be cached, or the space stays broken until restart.
      open.catch(() => runtimes.delete(spaceId));
      void open.then((rt) => publishProfile(spaceId, rt)).catch(() => {});
      // A revoke that arrived on an earlier visit.
      void open.then((rt) => checkRevoked(spaceId, rt)).catch(() => {});
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

  async function remember(spaceId: string): Promise<void> {
    if (!accountSpaceId || agentSession) return;
    const open = await runtime(accountSpaceId);
    if (await open.get<Membership>(membershipKey(spaceId))) return;
    // A view-only invite: what lets the account write is its role in the
    // space, which every device reads there. Invite secrets are never kept.
    const invite = await registry.createInvite(spaceId, config.signer.did);
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
    // The registry too, so a restore can come through the carrier.
    wanted.set(await passKey(account.space.id), await makePass(account));
    for (const membership of await memberships()) {
      if (membership.deleted || !membership.body) continue;
      const spaceId = membership.body.space;
      if (carrySpaces.has(spaceId)) continue;
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
      return (await registry.list()).filter((record) => !carrySpaces.has(record.space.id)).map(summarize);
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
      if (options.write === false) return registry.createInvite(spaceId, config.signer.did);
      const open = await runtime(spaceId);
      const { roles, role: mine } = await open.access();
      // By default the lowest role below your own; with none below you, a view-only invite.
      const role = options.role ?? (mine ? [...roles].reverse().find((candidate) => candidate.rank < mine.rank)?.name : undefined);
      if (!role) {
        if (options.role !== undefined || !mine) throw new Error(mine ? `There is no role "${options.role}"` : 'You hold no role here, so you can only share it to view');
        return registry.createInvite(spaceId, config.signer.did);
      }
      const { secret } = await open.openInvite(role);
      return registry.createInvite(spaceId, config.signer.did, { secret, role });
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

    async join(invite: string) {
      const record = await registry.join(bareInvite(invite));
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
      await forget(spaceId);
      await closeRuntime(spaceId);
      await registry.remove(spaceId);
      emit({ type: 'spaces' });
    },

    async open(spaceId: string) {
      await runtime(spaceId);
    },

    close: closeRuntime,

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
        if (!secret) throw new Error('That invite is view-only — there is nothing to close. To stop someone reading, the space needs a new key.');
        key = (await deriveInviteKey(base64UrlDecode(secret), provider)).did;
      }
      await (await runtime(spaceId)).closeInvite(key);
    },

    async revoke(spaceId: string, token: string) {
      await (await runtime(spaceId)).revoke(token);
    },

    async authenticator(spaceId: string) {
      const record = await findRecord(spaceId);
      if (!record) return null;
      // Every peer proves its own DID; in a private space, readers are also
      // checked against the space's public read key. The welcome is signed by
      // the key this node introduces itself with.
      const readKey = record.space.visibility === 'private' ? (record.space.readKey ?? '') : null;
      return createServerAuth(spaceId, readKey, sessionKeys.privateKey, provider);
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
      return runQuery(
        {
          list: (collection) => space.list({ collection }),
          get: (key) => space.get(key),
          linked: (key, options) => space.linked(key, options),
        },
        query,
      ) as Promise<ResultOf<Q>>;
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
      open: async (spaceId: string) => (inside(spaceId), spaces.open(spaceId)),
      status: async (spaceId: string) => (inside(spaceId), spaces.status(spaceId)),
      profiles: async (spaceId: string) => (inside(spaceId), spaces.profiles(spaceId)),
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
      delegation: () => note,
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
    asAgent,

    delegation: () => current,

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
