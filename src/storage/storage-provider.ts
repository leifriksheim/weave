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
import { byVersion, supersedes } from '../records/version.js';
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
  /** {@link history} for every record whose key starts with `prefix`, reading only that part of the tree. */
  histories(prefix: string): Promise<Map<string, Expression[]>>;
  /** Current versions of every record, deletes included. */
  listCurrent(): Promise<Expression[]>;
  /** Current versions in one collection, deletes included — found through the store's collection index. */
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
  async function getRootCid(store: StorageAdapter = adapter): Promise<string | null> {
    const bytes = await store.get(ROOT_KEY);
    return bytes ? utf8Decode(bytes) : null;
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

  /**
   * Runs one change of the tree. Its node writes are held and made in one
   * batch with the new root, so a change lands whole or not at all, in one
   * transaction rather than one per node. Versions it drops are deleted only
   * after, so the tree never names a record that is gone.
   */
  const change = (run: (tree: StorageAdapter, root: string | null, drop: (id: string) => void) => Promise<string | null>) =>
    exclusively(async () => {
      const writes = new Map<string, Uint8Array | null>();
      const tree: StorageAdapter = {
        ...adapter,
        get: async (key) => (writes.has(key) ? writes.get(key)! : adapter.get(key)),
        has: async (key) => (writes.has(key) ? writes.get(key) !== null : adapter.has(key)),
        put: async (key, value) => void writes.set(key, value),
        delete: async (key) => void writes.set(key, null),
      };
      const dropped: string[] = [];
      const before = await getRootCid();
      const root = await run(tree, before, (id) => dropped.push(id));
      if (root === before && writes.size === 0 && dropped.length === 0) return root;
      writes.set(ROOT_KEY, root ? utf8Encode(root) : null);
      await adapter.batch([...writes].map(([key, value]): BatchOp => (value ? { type: 'put', key, value } : { type: 'delete', key })));
      for (const id of dropped) await adapter.deleteExpression(id);
      changed();
      return root;
    });

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
  async function demote(tree: StorageAdapter, root: string | null, version: Expression, current: Expression, drop: (id: string) => void): Promise<string | null> {
    // A first version is kept as proof of who created the record — the one
    // with the lowest id, if several devices each created the same chosen key.
    // Not while the record is still at seq 0: then the current version is it.
    if (version.seq === 0 && current.seq > 0) {
      const heldId = await lookupInMST(tree, root, genesisKey(version.key));
      if (heldId === version.id) return root;
      if (heldId === null || version.id < heldId) {
        await adapter.putExpression(version);
        root = await insertIntoMST(tree, root, genesisKey(version.key), version.id);
        const displaced = heldId ? await adapter.getExpression(heldId) : null;
        return displaced ? keepOrDrop(tree, root, displaced, drop) : root;
      }
    }
    return keepOrDrop(tree, root, version, drop);
  }

  async function keepOrDrop(tree: StorageAdapter, root: string | null, version: Expression, drop: (id: string) => void): Promise<string | null> {
    if (version.retain) {
      await adapter.putExpression(version);
      return insertIntoMST(tree, root, historyKey(version), version.id);
    }
    drop(version.id);
    return root;
  }

  const load = async (ids: Iterable<string>): Promise<Expression[]> =>
    (await Promise.all([...ids].map((id) => adapter.getExpression(id)))).filter((v): v is Expression => v !== null);

  async function histories(prefix: string): Promise<Map<string, Expression[]>> {
    const root = await getRootCid();
    const ids = new Map<string, Set<string>>();
    for (const tree of [CURRENT_PREFIX, GENESIS_PREFIX, HISTORY_PREFIX]) {
      for (const entry of await listMSTEntries(adapter, root, `${tree}${prefix}`)) {
        // `r/<key>`, `g/<key>`, `h/<key>/<seq>/<id>` — a record key holds no `/`.
        const key = entry.key.split('/')[1]!;
        (ids.get(key) ?? ids.set(key, new Set()).get(key)!).add(entry.value);
      }
    }
    const result = new Map<string, Expression[]>();
    for (const [key, held] of ids) result.set(key, (await load(held)).sort(byVersion));
    return result;
  }

  async function currentOf(tree: StorageAdapter, root: string | null, key: string): Promise<Expression | null> {
    const id = await lookupInMST(tree, root, currentKey(key));
    return id ? adapter.getExpression(id) : null;
  }

  return Object.freeze({
    addExpression(incoming: Expression): Promise<string | null> {
      return change(async (tree, root, drop) => {
        const current = await currentOf(tree, root, incoming.key);
        if (current?.id === incoming.id) return root;
        if (current && !supersedes(incoming, current)) return demote(tree, root, incoming, current, drop);

        await adapter.putExpression(incoming);
        root = await insertIntoMST(tree, root, currentKey(incoming.key), incoming.id);
        return current ? demote(tree, root, current, incoming, drop) : root;
      });
    },

    removeExpression(id: string): Promise<string | null> {
      return change(async (tree, root, drop) => {
        const version = await adapter.getExpression(id);
        for (const key of version ? [currentKey(version.key), genesisKey(version.key), historyKey(version)] : []) {
          if ((await lookupInMST(tree, root, key)) === id) root = await deleteFromMST(tree, root, key);
        }
        drop(id);
        return root;
      });
    },

    async getExpression(id: string): Promise<Expression | null> {
      return adapter.getExpression(id);
    },

    async getCurrent(key: string): Promise<Expression | null> {
      return currentOf(adapter, await getRootCid(), key);
    },

    async getGenesis(key: string): Promise<Expression | null> {
      const id = await lookupInMST(adapter, await getRootCid(), genesisKey(key));
      return id ? adapter.getExpression(id) : null;
    },

    async history(key: string): Promise<Expression[]> {
      return (await histories(key)).get(key) ?? [];
    },

    histories,

    async listCurrent(): Promise<Expression[]> {
      return load((await listMSTEntries(adapter, await getRootCid(), CURRENT_PREFIX)).map((e) => e.value));
    },

    async queryExpressions(collection: string): Promise<Expression[]> {
      // The index holds every version kept, not only current ones; the tree says which is current.
      const root = await getRootCid();
      const held = await adapter.queryExpressions(collection, Infinity);
      const current = await Promise.all(held.map(async (v) => (await lookupInMST(adapter, root, currentKey(v.key))) === v.id));
      return held.filter((_, i) => current[i]);
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
