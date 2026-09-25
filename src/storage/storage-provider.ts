/**
 * @module storage-provider
 * A space's store: record versions, and the Merkle Search Tree that indexes them.
 *
 * The tree maps **record keys to version ids**:
 *
 * ```
 * r/<key>              → the current version          (every record)
 * g/<key>              → the record's first version   (once it has been edited)
 * h/<key>/<seq>/<id>   → a superseded version         (only if marked `retain`)
 * ```
 *
 * A version that arrives is compared with the one at `r/<key>` by the ordering
 * rule (`records/version.ts`). The winner takes `r/<key>`; the loser's body is
 * dropped — unless it is the record's first version, kept as proof of who
 * created it, or its writer marked it `retain`. The same set of versions gives
 * the same tree whatever order they arrive in, which is what lets two peers
 * converge.
 */

import type { StorageAdapter, Expression, BatchOp } from '../types.js';
import { insertIntoMST, deleteFromMST, lookupInMST, listMSTEntries, collectReachableCids } from './mst.js';
import { supersedes } from '../records/version.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';

export interface StorageProvider {
  /**
   * Takes in a version of a record: it becomes current if it supersedes the
   * current one, and is kept or dropped otherwise. Idempotent.
   * @returns The new tree root
   */
  addExpression(expression: Expression): Promise<string | null>;
  /** Drops a version from the tree and the store, wherever it is indexed. */
  removeExpression(id: string): Promise<string | null>;
  /** A version by its id, current or not, if this store holds it. */
  getExpression(id: string): Promise<Expression | null>;
  /** The current version of a record — possibly a delete. */
  getCurrent(key: string): Promise<Expression | null>;
  /** The record's first version, when it has been edited and so is stored apart. */
  getGenesis(key: string): Promise<Expression | null>;
  /** Every version of a record this store keeps: current, first, and retained. Newest first. */
  history(key: string): Promise<Expression[]>;
  /** Current versions of every record, deletes included. */
  listCurrent(): Promise<Expression[]>;
  /** Current versions in one collection, deletes included. */
  queryExpressions(collection: string): Promise<Expression[]>;
  /** Every tree entry, for sync and copying: `r/…`, `g/…`, `h/…` keys and the version ids under them. */
  entries(): Promise<Array<{ key: string; value: string }>>;
  /** Get the current MST root CID. */
  getRootCid(): Promise<string | null>;
  /**
   * Deletes the tree nodes the root no longer reaches. Every change rewrites
   * the path to one entry and leaves the old path behind, so without this a
   * store grows with every edit ever made rather than with its records.
   *
   * Tabs share a browser's store, and a change another tab has in flight may
   * build on nodes this one's root has left. So a node is deleted only once it
   * was already unreachable at a compaction at least `graceMs` earlier —
   * remembered in the store, so it holds across sessions. A store whose other
   * writers can lag by more than that — a folder behind a sync service — must
   * not be compacted at all.
   * @returns How many nodes were deleted
   */
  compact(): Promise<number>;
  /** Get the underlying storage adapter. */
  getAdapter(): StorageAdapter;
  /** Close the storage adapter. */
  close(): Promise<void>;
}

const ROOT_KEY = '__mst_root';
/** Unreachable nodes found by the last compaction, and when */
const CONDEMNED_KEY = '__condemned';
/** A tree node's key in the store: its CID, `b` and 52 base32 characters */
const NODE_KEY = /^b[a-z2-7]{52}$/;

export interface StorageProviderOptions {
  /** Compact on its own after this many changes (see `compact`). Off by default. */
  readonly compactEvery?: number;
  /** How long a node stays unreachable before `compact` deletes it. Default a minute. */
  readonly graceMs?: number;
}

export const CURRENT_PREFIX = 'r/';
export const GENESIS_PREFIX = 'g/';
export const HISTORY_PREFIX = 'h/';

const currentKey = (key: string) => `${CURRENT_PREFIX}${key}`;
const genesisKey = (key: string) => `${GENESIS_PREFIX}${key}`;
/** `seq` padded so a key's history lists in order */
const historyKey = (e: Expression) => `${HISTORY_PREFIX}${e.key}/${String(e.seq).padStart(15, '0')}/${e.id}`;

/**
 * Creates a StorageProvider wrapping an adapter.
 * @param adapter The initialized storage adapter.
 * @returns The StorageProvider orchestrator.
 */
export function createStorageProvider(adapter: StorageAdapter, options: StorageProviderOptions = {}): StorageProvider {
  async function getRootCid(): Promise<string | null> {
    const bytes = await adapter.get(ROOT_KEY);
    return bytes ? utf8Decode(bytes) : null;
  }

  async function setRootCid(cid: string | null): Promise<void> {
    if (cid) {
      await adapter.put(ROOT_KEY, utf8Encode(cid));
    } else {
      await adapter.delete(ROOT_KEY);
    }
  }

  // Every change reads the root, rewrites the path to one entry, and writes a
  // new root. Two of those interleaved would each start from the same root and
  // the second would silently drop the first's entry. So changes take turns.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusively = <T>(change: () => Promise<T>): Promise<T> => {
    const run = tail.then(change, change);
    tail = run.catch(() => {});
    return run;
  };

  const graceMs = options.graceMs ?? 60_000;
  const compact = (): Promise<number> =>
    exclusively(async () => {
      const reachable = await collectReachableCids(adapter, await getRootCid());
      const dead = (await adapter.list('b')).filter((key) => NODE_KEY.test(key) && !reachable.has(key));
      const saved = await adapter.get(CONDEMNED_KEY);
      const earlier = saved ? (JSON.parse(utf8Decode(saved)) as { at: number; cids: string[] }) : null;
      const ripe = graceMs === 0 ? dead : earlier && Date.now() - earlier.at >= graceMs ? earlier.cids : null;
      const condemn = (cids: string[]): BatchOp => ({ type: 'put', key: CONDEMNED_KEY, value: utf8Encode(JSON.stringify({ at: Date.now(), cids })) });
      // Too soon to delete anything: remember what is dead now, unless an earlier list is already waiting.
      if (ripe === null) {
        if (!earlier) await adapter.batch([condemn(dead)]);
        return 0;
      }
      const doomed = new Set(ripe);
      const deleting = dead.filter((key) => doomed.has(key));
      await adapter.batch([...deleting.map((key): BatchOp => ({ type: 'delete', key })), condemn(dead.filter((key) => !doomed.has(key)))]);
      return deleting.length;
    });

  let changes = 0;
  /** Counts a change, and compacts once enough have piled up */
  const changed = () => {
    if (options.compactEvery && ++changes >= options.compactEvery) {
      changes = 0;
      void compact().catch(() => {});
    }
  };

  /**
   * Places a version that is not current: the record's first version if it is
   * the lowest-id one seen, history if retained, otherwise gone.
   */
  async function demote(root: string | null, version: Expression, current: Expression): Promise<string | null> {
    // A first version is kept as proof of who created the record — the one
    // with the lowest id, if several devices each created the same chosen key.
    // Not while the record is still at seq 0: then the current version is it.
    if (version.seq === 0 && current.seq > 0) {
      const heldId = await lookupInMST(adapter, root, genesisKey(version.key));
      if (heldId === version.id) return root;
      if (heldId === null || version.id < heldId) {
        await adapter.putExpression(version);
        root = await insertIntoMST(adapter, root, genesisKey(version.key), version.id);
        const displaced = heldId ? await adapter.getExpression(heldId) : null;
        return displaced ? keepOrDrop(root, displaced) : root;
      }
    }
    return keepOrDrop(root, version);
  }

  async function keepOrDrop(root: string | null, version: Expression): Promise<string | null> {
    if (version.retain) {
      await adapter.putExpression(version);
      return insertIntoMST(adapter, root, historyKey(version), version.id);
    }
    await adapter.deleteExpression(version.id);
    return root;
  }

  async function listCurrent(): Promise<Expression[]> {
    const ids = (await listMSTEntries(adapter, await getRootCid()))
      .filter((e) => e.key.startsWith(CURRENT_PREFIX))
      .map((e) => e.value);
    const versions = await Promise.all(ids.map((id) => adapter.getExpression(id)));
    return versions.filter((v): v is Expression => v !== null);
  }

  async function currentOf(root: string | null, key: string): Promise<Expression | null> {
    const id = await lookupInMST(adapter, root, currentKey(key));
    return id ? adapter.getExpression(id) : null;
  }

  return Object.freeze({
    addExpression(incoming: Expression): Promise<string | null> {
      return exclusively(async () => {
        let root = await getRootCid();
        const current = await currentOf(root, incoming.key);

        if (current?.id === incoming.id) return root;

        if (!current) {
          await adapter.putExpression(incoming);
          root = await insertIntoMST(adapter, root, currentKey(incoming.key), incoming.id);
        } else if (supersedes(incoming, current)) {
          await adapter.putExpression(incoming);
          root = await insertIntoMST(adapter, root, currentKey(incoming.key), incoming.id);
          root = await demote(root, current, incoming);
        } else {
          root = await demote(root, incoming, current);
        }

        await setRootCid(root);
        changed();
        return root;
      });
    },

    removeExpression(id: string): Promise<string | null> {
      return exclusively(async () => {
        let root = await getRootCid();
        for (const entry of await listMSTEntries(adapter, root)) {
          if (entry.value === id) root = await deleteFromMST(adapter, root, entry.key);
        }
        await adapter.deleteExpression(id);
        await setRootCid(root);
        return root;
      });
    },

    async getExpression(id: string): Promise<Expression | null> {
      return adapter.getExpression(id);
    },

    async getCurrent(key: string): Promise<Expression | null> {
      return currentOf(await getRootCid(), key);
    },

    async getGenesis(key: string): Promise<Expression | null> {
      const id = await lookupInMST(adapter, await getRootCid(), genesisKey(key));
      return id ? adapter.getExpression(id) : null;
    },

    async history(key: string): Promise<Expression[]> {
      const root = await getRootCid();
      const ids = (await listMSTEntries(adapter, root))
        .filter((e) => e.key === currentKey(key) || e.key === genesisKey(key) || e.key.startsWith(`${HISTORY_PREFIX}${key}/`))
        .map((e) => e.value);
      const versions = await Promise.all([...new Set(ids)].map((id) => adapter.getExpression(id)));
      return versions
        .filter((v): v is Expression => v !== null)
        .sort((a, b) => (supersedes(a, b) ? -1 : supersedes(b, a) ? 1 : 0));
    },

    listCurrent,

    async queryExpressions(collection: string): Promise<Expression[]> {
      return (await listCurrent()).filter((version) => version.collection === collection);
    },

    async entries() {
      return listMSTEntries(adapter, await getRootCid());
    },

    async getRootCid(): Promise<string | null> {
      return getRootCid();
    },

    compact,

    getAdapter(): StorageAdapter {
      return adapter;
    },

    async close(): Promise<void> {
      await adapter.close();
    }
  });
}
