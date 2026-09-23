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
import type { Capability } from '../identity/ucan.js';
import { createSigner } from '../schema/signer.js';
import { createSchemaEngine } from '../schema/schema-engine.js';
import { createSpaceManager, parseSpaceInvite, type SpaceRecord } from '../space/space-manager.js';
import { openSpaceRuntime, type ActiveSession, type SpaceRuntime } from './space-runtime.js';
import type {
  InvitePreview,
  ListOptions,
  NewSpace,
  NodeConfig,
  NodeEvent,
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

  let proof = (await delegate()).encoded;
  let closed = false;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRenewal = (inSeconds: number) => {
    renewTimer = setTimeout(() => {
      delegate()
        .then((token) => {
          proof = token.encoded;
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

  const session: ActiveSession = { did: sessionDid, key: sessionKeys.privateKey, proof: () => proof };

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

  async function requireRecord(spaceId: string): Promise<SpaceRecord> {
    const record = await registry.get(spaceId);
    if (!record) throw new Error(`Unknown space: ${spaceId}`);
    return record;
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
          ...(config.network ? { network: config.network } : {}),
          watchIntervalMs: config.watchIntervalMs ?? 2000,
          emit,
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

  const spaces: NodeSpaces = Object.freeze({
    async list() {
      return (await registry.list()).map(summarize);
    },

    async get(spaceId: string) {
      const record = await registry.get(spaceId);
      return record ? summarize(record) : null;
    },

    async create(params: NewSpace) {
      const record = await registry.create({ ...params, owner: config.signer.did });
      emit({ type: 'spaces' });
      return summarize(record);
    },

    async invite(spaceId: string) {
      return registry.createInvite(spaceId, config.signer.did);
    },

    preview(invite: string): InvitePreview {
      const parsed = parseSpaceInvite(invite);
      const { encryptionKeyId: _keyId, ...space } = parsed.space;
      return { space, invitedBy: parsed.invitedBy, carriesKey: typeof parsed.key === 'string' };
    },

    async join(invite: string) {
      const record = await registry.join(invite, config.signer.did);
      // A runtime opened before the key arrived would still be unable to read.
      await closeRuntime(record.space.id);
      emit({ type: 'spaces' });
      return summarize(record);
    },

    async leave(spaceId: string) {
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
  });

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
