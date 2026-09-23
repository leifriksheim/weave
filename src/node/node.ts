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
 * key, so the root — a seed in this page, a Snap, whatever holds it — is asked
 * for one signature an hour, never one per write.
 */
import { runQuery } from '../query/engine.js';
import type { Query, QueryResult } from '../query/types.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import type { Link } from '../types.js';
import { publicKeyToDid, P256_MULTICODEC } from '../identity/did.js';
import { delegateCapabilities, type Capability, type UCANToken } from '../identity/ucan.js';
import { createSigner } from '../schema/signer.js';
import { createSchemaEngine } from '../schema/schema-engine.js';
import { createSpaceManager, parseSpaceInvite, type SpaceRecord } from '../space/space-manager.js';
import { openSpaceRuntime, type ActiveSession, type SpaceRuntime } from './space-runtime.js';
import { createPeerAuthenticator } from '../network/peer-auth.js';
import {
  deriveAccountRegistry,
  MEMBERSHIP_COLLECTION,
  PROFILE_COLLECTION,
  PROFILE_KEY,
  type AccountProfile,
  type Membership,
} from '../space/account-registry.js';
import type {
  DefineCollection,
  DelegateParams,
  InvitePreview,
  ListOptions,
  NewSpace,
  NodeConfig,
  NodeEvent,
  NodeRecord,
  NodeAccount,
  NodeCollections,
  NodeRecords,
  NodeSpaces,
  P2PNode,
  SpaceSummary,
} from './types.js';

/** Everything a session key may do, across every space the node holds */
export const SESSION_CAPABILITY: Capability = { with: '*', can: 'expression/*' };

const DEFAULT_TTL_SECONDS = 3600;

function summarize(record: SpaceRecord, did: string): SpaceSummary {
  const { space, key } = record;
  return Object.freeze({
    id: space.id,
    name: space.name,
    type: space.type,
    visibility: space.visibility,
    owner: space.owner,
    members: space.members,
    createdAt: space.createdAt,
    readable: space.visibility === 'public' || key !== null,
    writable: space.type === 'shared' || space.owner === did,
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

  const sessionKeys = await provider.generateKeyPair();
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
  const registry = createSpaceManager(registryStore);
  const runtimes = new Map<string, Promise<SpaceRuntime>>();

  // The account's own space list, kept in a space every device of the account
  // derives for itself. Hidden from `list`; everything else treats it as a space.
  const account = config.accountKey ? await deriveAccountRegistry(config.accountKey, config.signer.did) : null;
  const accountSpaceId = account?.space.id ?? null;

  async function findRecord(spaceId: string): Promise<SpaceRecord | null> {
    return spaceId === accountSpaceId ? account : registry.get(spaceId);
  }

  async function requireRecord(spaceId: string): Promise<SpaceRecord> {
    const record = await findRecord(spaceId);
    if (!record) throw new Error(`Unknown space: ${spaceId}`);
    return record;
  }

  /** Runtime events pass through; a change to the account registry is also acted on. */
  const fromRuntime = (event: NodeEvent) => {
    emit(event);
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
    if (spaceId === accountSpaceId) return;
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
          watchIntervalMs: config.watchIntervalMs ?? 2000,
          emit: fromRuntime,
        }),
      );
      // A failed open must not be cached, or the space stays broken until restart.
      open.catch(() => runtimes.delete(spaceId));
      void open.then((rt) => publishProfile(spaceId, rt)).catch(() => {});
      runtimes.set(spaceId, open);
    }
    return open;
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
    if (!accountSpaceId) return;
    const open = await runtime(accountSpaceId);
    if (await open.get(membershipKey(spaceId))) return;
    const invite = await registry.createInvite(spaceId, config.signer.did);
    await open.upsertSystem<Membership>(MEMBERSHIP_COLLECTION, membershipKey(spaceId), { space: spaceId, invite });
  }

  async function forget(spaceId: string): Promise<void> {
    if (!accountSpaceId) return;
    const open = await runtime(accountSpaceId);
    if (await open.get(membershipKey(spaceId))) await open.removeSystem(membershipKey(spaceId));
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

    for (const membership of await memberships()) {
      const spaceId = membership.key.slice('space:'.length);
      known.add(spaceId);
      if (!membership.deleted && !held.has(spaceId)) {
        try {
          await registry.join(membership.body!.invite, config.signer.did);
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
      return (await registry.list()).map((record) => summarize(record, config.signer.did));
    },

    async get(spaceId: string) {
      const record = await findRecord(spaceId);
      return record ? summarize(record, config.signer.did) : null;
    },

    async create(params: NewSpace) {
      const record = await registry.create({ ...params, owner: config.signer.did });
      await remember(record.space.id);
      emit({ type: 'spaces' });
      return summarize(record, config.signer.did);
    },

    async invite(spaceId: string) {
      return registry.createInvite(spaceId, config.signer.did);
    },

    preview(invite: string): InvitePreview {
      const parsed = parseSpaceInvite(bareInvite(invite));
      const { encryptionKeyId: _keyId, ...space } = parsed.space;
      return { space, invitedBy: parsed.invitedBy, carriesKey: typeof parsed.key === 'string' };
    },

    async join(invite: string) {
      const record = await registry.join(bareInvite(invite), config.signer.did);
      // A runtime opened before the key arrived would still be unable to read.
      await closeRuntime(record.space.id);
      await remember(record.space.id);
      emit({ type: 'spaces' });
      return summarize(record, config.signer.did);
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
      return (await runtime(spaceId)).status();
    },

    async profiles(spaceId: string) {
      return (await runtime(spaceId)).profiles();
    },

    async authenticator(spaceId: string) {
      const record = await findRecord(spaceId);
      if (!record || record.space.visibility !== 'private' || !record.key) return null;
      return createPeerAuthenticator(spaceId, record.key);
    },
  });

  // With an account key, start following the registry at once: it is how this
  // node learns which spaces it belongs to.
  if (accountSpaceId) {
    await runtime(accountSpaceId);
    await reconcile();
  }

  const collections: NodeCollections = Object.freeze({
    async list(spaceId: string) {
      return (await runtime(spaceId)).collections();
    },
    async define(spaceId: string, definition: DefineCollection) {
      return (await runtime(spaceId)).define(definition);
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
  });

  const records: NodeRecords = Object.freeze({
    async list<T>(spaceId: string, options?: ListOptions) {
      return (await runtime(spaceId)).list<T>(options);
    },
    async get<T>(spaceId: string, key: string) {
      return (await runtime(spaceId)).get<T>(key);
    },
    async put<T>(spaceId: string, collection: string, body: T, options?: { key?: string; links?: ReadonlyArray<Link> }) {
      return (await runtime(spaceId)).put<T>(collection, body, options);
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
    async query<T>(spaceId: string, query: Query) {
      const space = await runtime(spaceId);
      return runQuery<T>(
        {
          list: (collection) => space.list({ collection }),
          get: (key) => space.get(key),
          linked: (key, options) => space.linked(key, options),
        },
        query,
      );
    },
    watch<T>(spaceId: string, query: Query, onResult: (result: QueryResult<T>) => void, onError?: (error: Error) => void) {
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
            const result = await records.query<T>(spaceId, query);
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

  return Object.freeze({
    did: config.signer.did,
    sessionDid,
    spaces,
    records,
    collections,
    account: accountApi,

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
  }) satisfies P2PNode;
}
