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
import { createP256Provider } from '../identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../identity/did.js';
import { delegateCapabilities, type Capability, type UCANToken } from '../identity/ucan.js';
import { createSigner } from '../schema/signer.js';
import { createSchemaEngine } from '../schema/schema-engine.js';
import { createSpaceManager, parseSpaceInvite, type SpaceRecord } from '../space/space-manager.js';
import { openSpaceRuntime, type ActiveSession, type SpaceRuntime } from './space-runtime.js';
import { createPeerAuthenticator } from '../network/peer-auth.js';
import { deriveAccountRegistry, MEMBERSHIP_COLLECTION, type Membership } from '../space/account-registry.js';
import type {
  DelegateParams,
  InvitePreview,
  ListOptions,
  NewSpace,
  NodeConfig,
  NodeEvent,
  NodeRecord,
  NodeRecords,
  NodeSpaces,
  P2PNode,
  SpaceSummary,
} from './types.js';

/** Everything a session key may do, across every space the node holds */
export const SESSION_CAPABILITY: Capability = { with: '*', can: 'expression/*' };

const DEFAULT_TTL_SECONDS = 3600;

function summarize(record: SpaceRecord): SpaceSummary {
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

  const registry = createSpaceManager(await config.stores('registry', { seal: true }));
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
    if (event.type === 'records' && event.space === accountSpaceId) void reconcile();
  };

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
  // One record per space in the registry, holding its invite. A live record
  // means the account belongs to the space; a tombstoned one means it left.
  // Every device converges on the same answer, because it is the same data.

  async function memberships(): Promise<ReadonlyArray<NodeRecord<Membership>>> {
    if (!accountSpaceId) return [];
    const records = await (await runtime(accountSpaceId)).list<Membership>({ collection: MEMBERSHIP_COLLECTION, includeDeleted: true });
    // Only the account itself may say what it belongs to.
    return records.filter((record) => record.verified && record.root === config.signer.did && typeof record.body?.space === 'string');
  }

  async function remember(spaceId: string): Promise<void> {
    if (!accountSpaceId) return;
    if ((await memberships()).some((m) => !m.deleted && m.body!.space === spaceId)) return;
    const invite = await registry.createInvite(spaceId, config.signer.did);
    await (await runtime(accountSpaceId)).put<Membership>(MEMBERSHIP_COLLECTION, { space: spaceId, invite });
  }

  async function forget(spaceId: string): Promise<void> {
    if (!accountSpaceId) return;
    const open = await runtime(accountSpaceId);
    for (const membership of await memberships()) {
      if (!membership.deleted && membership.body!.space === spaceId) await open.remove(membership.id);
    }
  }

  /**
   * Makes this node's spaces match the account's: join what the account
   * belongs to, leave what it left, and record anything held here that the
   * registry has never heard of.
   */
  async function reconcileOnce(): Promise<void> {
    if (!accountSpaceId || closed) return;
    const all = await memberships();
    const held = new Set((await registry.list()).map((record) => record.space.id));
    let changed = false;

    const bySpace = new Map<string, NodeRecord<Membership>[]>();
    for (const membership of all) {
      const list = bySpace.get(membership.body!.space) ?? [];
      list.push(membership);
      bySpace.set(membership.body!.space, list);
    }

    for (const [spaceId, records] of bySpace) {
      const live = records.find((record) => !record.deleted);
      if (live && !held.has(spaceId)) {
        try {
          await registry.join(live.body!.invite, config.signer.did);
          changed = true;
        } catch {
          // An unreadable invite; the next membership written for it will do.
        }
      } else if (!live && held.has(spaceId)) {
        // Every membership for it is tombstoned: the account left, on some device.
        await closeRuntime(spaceId);
        await registry.remove(spaceId);
        changed = true;
      }
    }

    // Held here but never recorded — joined before the registry existed, or on
    // a node without the account key. Recorded now, so other devices follow.
    for (const spaceId of held) {
      if (!bySpace.has(spaceId)) await remember(spaceId);
    }

    if (changed) emit({ type: 'spaces' });
  }

  let reconciling: Promise<void> = Promise.resolve();
  function reconcile(): Promise<void> {
    reconciling = reconciling.then(reconcileOnce).catch((error: unknown) => {
      console.error('Could not reconcile the account registry:', error);
    });
    return reconciling;
  }

  const spaces: NodeSpaces = Object.freeze({
    async list() {
      return (await registry.list()).map(summarize);
    },

    async get(spaceId: string) {
      const record = await findRecord(spaceId);
      return record ? summarize(record) : null;
    },

    async create(params: NewSpace) {
      const record = await registry.create({ ...params, owner: config.signer.did });
      await remember(record.space.id);
      emit({ type: 'spaces' });
      return summarize(record);
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
      return summarize(record);
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

  const records: NodeRecords = Object.freeze({
    async list<T>(spaceId: string, options?: ListOptions) {
      return (await runtime(spaceId)).list<T>(options);
    },
    async get<T>(spaceId: string, id: string) {
      return (await runtime(spaceId)).get<T>(id);
    },
    async put<T>(spaceId: string, collection: string, body: T) {
      return (await runtime(spaceId)).put<T>(collection, body);
    },
    async update<T>(spaceId: string, id: string, body: T) {
      return (await runtime(spaceId)).update<T>(id, body);
    },
    async delete(spaceId: string, id: string) {
      await (await runtime(spaceId)).remove(id);
    },
  });

  return Object.freeze({
    did: config.signer.did,
    sessionDid,
    spaces,
    records,

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
      listeners.clear();
    },
  }) satisfies P2PNode;
}
