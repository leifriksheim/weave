/**
 * @module sync-engine
 * Keeps one store in step with its peers.
 *
 * Reconciliation is a pull, and both sides do it:
 *
 * 1. A tells B its root. Equal roots mean identical data — one round trip, done.
 * 2. Otherwise each walks the other's tree from the root, asking for nodes in
 *    batches and skipping any subtree that is already part of its own tree.
 * 3. The keys found in the nodes it fetched, less the records it already
 *    holds, are what it is missing. It asks for those, and every one of them
 *    passes the gatekeeper before it is stored.
 *
 * Cost follows the difference, not the size: two trees differing by one entry
 * exchange the few nodes on the path to it.
 */
import type { Expression } from '../types.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { deserializeNode } from '../storage/mst.js';
import { cidFromBytes } from '../utils/hash.js';
import { createEmitter } from '../utils/events.js';
import { parseSyncMessage, SYNC_PROTOCOL_VERSION, type SyncMessage, type SyncMessageBody } from './sync-messages.js';
import { differingEntries, unknownChildren, verifyNode } from './anti-entropy.js';

/** Verdict on an expression that arrived from a peer */
export interface IncomingValidation {
  readonly valid: boolean;
  readonly reason?: string;
  /**
   * Not judged yet, rather than refused: it depends on something that has not
   * arrived — a record's first version, the definition it was written under.
   * It is held and tried again as other records come in, and fetched again on
   * the next round if it is still waiting.
   */
  readonly later?: boolean;
}

/** At most this many records wait for what they depend on; the oldest give way */
const MAX_WAITING = 1000;

/** Collection definitions first, then records by version — what others depend on comes first */
const rank = (e: Expression): number => (e?.collection === 'sys.collection' ? -1 : (e?.seq ?? 0));

export interface SyncEngineConfig {
  readonly storageProvider: StorageProvider;
  readonly sendToPeer: (peerId: string, message: SyncMessage) => void;
  readonly heartbeatInterval?: number;
  /**
   * Gatekeeper for expressions arriving from peers — typically a
   * `ValidationEngine`. Anything it rejects is dropped instead of committed,
   * and surfaces as a `rejected` event.
   *
   * Leaving it out accepts whatever peers send, which is only ever appropriate
   * for a trusted transport or a test.
   */
  readonly validate?: (expression: Expression) => Promise<IncomingValidation>;
}

export type SyncEvent = 'synced' | 'expression-received' | 'rejected' | 'error';
type EventHandler = (...args: any[]) => void;

export interface SyncEngine {
  start(): void;
  stop(): void;
  /** Handles whatever a peer sent; anything that is not a sync message this peer speaks is ignored. */
  handleMessage(peerId: string, message: unknown): Promise<void>;
  notifyPeers(peers: ReadonlyArray<string>): void;
  onLocalChange(expression: Expression): void;
  addPeer(peerId: string): void;
  removePeer(peerId: string): void;
  on(event: SyncEvent, callback: EventHandler): void;
  off(event: SyncEvent, callback: EventHandler): void;
}

/** Nodes asked for in one message. Nodes are small; this keeps round trips few. */
export const MAX_CIDS_PER_REQUEST = 64;
/** Records asked for in one message. */
export const MAX_IDS_PER_REQUEST = 200;
/** A real tree of a billion entries is about seven deep. Anything past this is hostile. */
const MAX_DEPTH = 32;
/** Nodes one walk may fetch before it is abandoned as runaway. */
const MAX_NODES_PER_WALK = 200_000;
/** A walk that has heard nothing for this long is given up on. */
const STALE_WALK_MS = 30_000;

/** One pull of one peer's tree */
interface Walk {
  readonly remoteRoot: string;
  /** The local root when the walk began — what the peer's entries are compared with */
  readonly localRoot: string | null;
  readonly depth: Map<string, number>;
  readonly queue: string[];
  /** Node requests in flight, by request id */
  readonly nodeBatches: Map<number, ReadonlyArray<string>>;
  readonly missing: Set<string>;
  /** Record requests in flight, by request id */
  readonly idBatches: Map<number, ReadonlyArray<string>>;
  fetched: number;
  touchedAt: number;
  /** A newer root the peer announced mid-walk, to pull once this one ends */
  next: string | null;
}

/**
 * Creates a sync engine orchestrator.
 * @param config Sync engine configuration.
 * @returns A sync engine instance.
 */
export function createSyncEngine(config: SyncEngineConfig): SyncEngine {
  const { storageProvider, sendToPeer, heartbeatInterval = 30000, validate } = config;
  const peers = new Set<string>();
  const walks = new Map<string, Walk>();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let nextRequestId = 1;

  const { on, off, emit } = createEmitter<Record<SyncEvent, EventHandler>>();

  const stamp = (msg: SyncMessageBody) => ({ v: SYNC_PROTOCOL_VERSION, ...msg }) as SyncMessage;
  const send = (peerId: string, msg: SyncMessageBody) => sendToPeer(peerId, stamp(msg));
  const broadcast = (msg: SyncMessageBody) => {
    for (const peer of peers) sendToPeer(peer, stamp(msg));
  };

  /**
   * Commits an expression from a peer, but only if the gatekeeper allows it.
   * @returns Whether the expression was accepted
   */
  const admit = async (peerId: string, expression: Expression): Promise<boolean> => {
    if (validate) {
      const verdict = await validate(expression);
      if (!verdict.valid) {
        if (verdict.later) {
          waiting.set(expression.id, { peerId, expression });
          if (waiting.size > MAX_WAITING) waiting.delete(waiting.keys().next().value!);
        } else {
          emit('rejected', peerId, expression, verdict.reason);
        }
        return false;
      }
    }
    waiting.delete(expression.id);
    await storageProvider.addExpression(expression);
    emit('expression-received', expression);
    return true;
  };

  /** Records that could not be judged yet — tried again whenever something new is admitted */
  const waiting = new Map<string, { peerId: string; expression: Expression }>();
  const retryWaiting = async () => {
    let progressed = true;
    while (progressed && waiting.size > 0) {
      progressed = false;
      for (const [id, held] of [...waiting]) {
        waiting.delete(id);
        if (await admit(held.peerId, held.expression)) progressed = true;
      }
    }
  };

  // ─── The walk ──────────────────────────────────────────────────────

  const finish = (peerId: string, walk: Walk) => {
    walks.delete(peerId);
    emit('synced', peerId);
    if (walk.next !== null && walk.next !== walk.remoteRoot) void pull(peerId, walk.next);
  };

  /** Sends whatever is queued, or moves on to records once the tree is done. */
  const advance = (peerId: string, walk: Walk) => {
    walk.touchedAt = Date.now();

    while (walk.queue.length > 0) {
      const batch = walk.queue.splice(0, MAX_CIDS_PER_REQUEST);
      const id = nextRequestId++;
      walk.nodeBatches.set(id, batch);
      send(peerId, { type: 'node-request', id, cids: batch });
    }
    if (walk.nodeBatches.size > 0) return;

    // The tree is walked. Ask for the records it named that are not here.
    if (walk.missing.size > 0 && walk.idBatches.size === 0) {
      const ids = [...walk.missing];
      walk.missing.clear();
      for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
        const batch = ids.slice(i, i + MAX_IDS_PER_REQUEST);
        const id = nextRequestId++;
        walk.idBatches.set(id, batch);
        send(peerId, { type: 'diff-request', id, missingIds: batch });
      }
      return;
    }
    if (walk.idBatches.size === 0) finish(peerId, walk);
  };

  /** Pulls a peer's tree, given its root. */
  const pull = async (peerId: string, remoteRoot: string | null): Promise<void> => {
    const current = walks.get(peerId);
    if (current && Date.now() - current.touchedAt < STALE_WALK_MS) {
      // One walk per peer at a time; a newer root is pulled when this one ends.
      if (current.remoteRoot !== remoteRoot) current.next = remoteRoot;
      return;
    }
    walks.delete(peerId);

    if (remoteRoot === null) {
      emit('synced', peerId);
      return;
    }
    const localRoot = await storageProvider.getRootCid();
    if (await storageProvider.getAdapter().has(remoteRoot)) {
      // A tree this store holds, or has moved past: nothing to pull.
      emit('synced', peerId);
      return;
    }

    const walk: Walk = {
      remoteRoot,
      localRoot,
      depth: new Map([[remoteRoot, 0]]),
      queue: [remoteRoot],
      nodeBatches: new Map(),
      missing: new Set(),
      idBatches: new Map(),
      fetched: 0,
      touchedAt: Date.now(),
      next: null,
    };
    walks.set(peerId, walk);
    advance(peerId, walk);
  };

  const onNodes = async (peerId: string, requestId: number, nodes: ReadonlyArray<{ cid: string; node: unknown }>) => {
    const walk = walks.get(peerId);
    const batch = walk?.nodeBatches.get(requestId);
    if (!walk || !batch) return; // not ours, or already answered
    const asked = new Set(batch);
    const adapter = storageProvider.getAdapter();

    for (const { cid, node: sent } of nodes) {
      if (typeof cid !== 'string' || !asked.has(cid)) continue;
      const node = await verifyNode(cid, sent);
      if (!node) continue; // malformed, or not the node that CID names

      if (++walk.fetched > MAX_NODES_PER_WALK) {
        walks.delete(peerId);
        emit('error', new Error(`Sync with ${peerId} abandoned: more than ${MAX_NODES_PER_WALK} nodes`));
        return;
      }
      for (const id of await differingEntries(adapter, walk.localRoot, node)) walk.missing.add(id);

      const depth = walk.depth.get(cid) ?? 0;
      if (depth >= MAX_DEPTH) continue;
      for (const child of await unknownChildren(adapter, node)) {
        if (walk.depth.has(child)) continue; // already queued — a cycle, or a shared subtree
        walk.depth.set(child, depth + 1);
        walk.queue.push(child);
      }
    }
    // Asked-for nodes the peer did not send are simply not followed: a peer can
    // legitimately have compacted a node away between its root and our request.
    // Marked answered only now, so a reply processed alongside this one cannot
    // decide the tree is finished while this one's children are still unqueued.
    walk.nodeBatches.delete(requestId);
    advance(peerId, walk);
  };

  const onRecords = async (peerId: string, requestId: number, expressions: ReadonlyArray<Expression>) => {
    const walk = walks.get(peerId);
    const asked = walk?.idBatches.get(requestId);
    // Only records this node asked for are considered; anything else was not
    // requested and is not taken on trust as a side effect.
    const wanted = asked ? new Set(asked) : null;
    // Definitions and first versions before what depends on them, so little has to wait.
    const ordered = [...expressions].sort((a, b) => rank(a) - rank(b));
    let admitted = false;
    for (const expression of ordered) {
      if (wanted?.has(expression?.id) && (await admit(peerId, expression))) admitted = true;
    }
    if (admitted) await retryWaiting();
    if (!walk || !asked) return;
    walk.idBatches.delete(requestId);
    advance(peerId, walk);
  };

  // ─── Serving ───────────────────────────────────────────────────────

  const serveNodes = async (peerId: string, requestId: number, cids: ReadonlyArray<string>) => {
    const adapter = storageProvider.getAdapter();
    const nodes: Array<{ cid: string; node: unknown }> = [];
    for (const cid of cids.slice(0, MAX_CIDS_PER_REQUEST)) {
      if (typeof cid !== 'string') continue;
      const bytes = await adapter.get(cid);
      // Only content-addressed tree nodes leave this store — never another key
      // that happens to share the namespace.
      if (bytes && (await cidFromBytes(bytes)) === cid) nodes.push({ cid, node: deserializeNode(bytes) });
    }
    send(peerId, { type: 'node-response', id: requestId, nodes });
  };

  const serveRecords = async (peerId: string, requestId: number, ids: ReadonlyArray<string>) => {
    const expressions: Expression[] = [];
    for (const id of ids.slice(0, MAX_IDS_PER_REQUEST)) {
      const expression = typeof id === 'string' ? await storageProvider.getExpression(id) : null;
      if (expression) expressions.push(expression);
    }
    // Always answered, even empty: the asker counts replies to know it is done.
    send(peerId, { type: 'diff-response', id: requestId, expressions });
  };

  return {
    start() {
      if (intervalId !== null) return;
      intervalId = setInterval(async () => {
        const rootCid = await storageProvider.getRootCid();
        broadcast({ type: 'sync-request', rootCid });
      }, heartbeatInterval);
    },

    stop() {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      walks.clear();
    },

    async handleMessage(peerId: string, message: unknown): Promise<void> {
      try {
        const msg = parseSyncMessage(message);
        if (!msg) return; // malformed, or a protocol version this peer does not speak

        switch (msg.type) {
          case 'sync-request': {
            const localRoot = await storageProvider.getRootCid();
            const differs = localRoot !== msg.rootCid;
            send(peerId, { type: 'sync-response', rootCid: localRoot, hasChanges: differs });
            // They will pull ours from the response; we pull theirs.
            if (differs) await pull(peerId, msg.rootCid);
            break;
          }
          case 'sync-response': {
            if (msg.hasChanges) await pull(peerId, msg.rootCid);
            else emit('synced', peerId);
            break;
          }
          case 'node-request':
            await serveNodes(peerId, msg.id, Array.isArray(msg.cids) ? msg.cids : []);
            break;
          case 'node-response':
            await onNodes(peerId, msg.id, Array.isArray(msg.nodes) ? msg.nodes : []);
            break;
          case 'diff-request':
            await serveRecords(peerId, msg.id, Array.isArray(msg.missingIds) ? msg.missingIds : []);
            break;
          case 'diff-response':
            await onRecords(peerId, msg.id, Array.isArray(msg.expressions) ? msg.expressions : []);
            break;
          case 'push-update':
            await admit(peerId, msg.expression);
            break;
        }
      } catch (err) {
        emit('error', err);
      }
    },

    notifyPeers(peerIds: ReadonlyArray<string>) {
      storageProvider.getRootCid().then(rootCid => {
        for (const peer of peerIds) {
          if (peers.has(peer)) send(peer, { type: 'sync-request', rootCid });
        }
      }).catch(err => emit('error', err));
    },

    onLocalChange(expression: Expression) {
      storageProvider.getRootCid().then(newRootCid => {
        broadcast({ type: 'push-update', expression, newRootCid: newRootCid || '' });
      }).catch(err => emit('error', err));
    },

    addPeer(peerId: string) {
      peers.add(peerId);
    },

    removePeer(peerId: string) {
      peers.delete(peerId);
      // A dropped peer must not leave a half-finished walk holding memory.
      walks.delete(peerId);
    },

    on,
    off,
  };
}
