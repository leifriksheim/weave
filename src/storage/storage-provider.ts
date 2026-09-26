/**
 * @module storage-provider
 * A space's store: record versions, and plain entries saying which is which.
 *
 * ```
 * r/<key>                      → the current version          (every record)
 * g/<key>                      → the record's first version   (once it has been edited)
 * h/<key>/<seq>/<id>           → a superseded version         (only if marked `retain`)
 * i/<collection>/<time>/<id>   → every version kept, by collection — what sync compares
 * ```
 *
 * A version that arrives is compared with the one at `r/<key>` by the ordering
 * rule (`records/version.ts`). The winner takes `r/<key>`; the loser's body is
 * dropped — unless it is the record's first version, kept as proof of who
 * created it, or its writer marked it `retain`. The same set of versions gives
 * the same entries whatever order they arrive in, which is what lets two
 * peers converge.
 *
 * Sync compares the `i/` entries: the set of versions kept, one collection at
 * a time (`sync/negentropy.ts`). Nothing else is stored for it. The sets are
 * read once and kept in memory, updated by every change made here; a change
 * made by another writer of the same store (a tab, a folder's other device)
 * reaches them through {@link StorageProvider.invalidate}.
 */

import type { StorageAdapter, Expression, BatchOp } from '../types.js';
import { byVersion, supersedes } from '../records/version.js';
import { utf8Encode, utf8Decode, bytesToHex } from '../utils/encoding.js';
import { cidDigest } from '../utils/hash.js';
import { addToSum, combineSums, EMPTY_SUM, fingerprintOf, ItemSet, removeFromSum, type Item, type Sum } from '../sync/negentropy.js';

export interface StorageProvider {
  /**
   * Takes in a version of a record: it becomes current if it supersedes the
   * current one, and is kept or dropped otherwise. Idempotent.
   */
  addExpression(expression: Expression): Promise<void>;
  /** Drops a version from the store and wherever it is indexed. */
  removeExpression(id: string): Promise<void>;
  /** A version by its id, current or not, if this store holds it. */
  getExpression(id: string): Promise<Expression | null>;
  /** The current version of a record — possibly a delete. */
  getCurrent(key: string): Promise<Expression | null>;
  /** The record's first version, when it has been edited and so is stored apart. */
  getGenesis(key: string): Promise<Expression | null>;
  /** Every version of a record this store keeps: current, first, and retained. Newest first. */
  history(key: string): Promise<Expression[]>;
  /** {@link history} for every record whose key starts with `prefix`, reading only those entries. */
  histories(prefix: string): Promise<Map<string, Expression[]>>;
  /** Current versions of every record, deletes included. */
  listCurrent(): Promise<Expression[]>;
  /** Current versions in one collection, deletes included — found through the store's collection index. */
  queryExpressions(collection: string): Promise<Expression[]>;
  /** The id of every version this store keeps — current, first and retained. */
  versionIds(): Promise<string[]>;
  /** The versions kept in one collection, as sync compares them: sorted, with sums. */
  items(collection: string): Promise<ItemSet>;
  /** Every collection this store keeps anything in, and the sum of its version ids. */
  sums(): Promise<ReadonlyMap<string, Sum>>;
  /**
   * One fingerprint of everything kept, hex. Equal fingerprints mean the
   * same versions kept — for status, and for tests.
   */
  fingerprint(): Promise<string>;
  /** Forgets what was read into memory: another writer changed the store underneath. */
  invalidate(): void;
  /** Get the underlying storage adapter. */
  getAdapter(): StorageAdapter;
  /** Close the storage adapter. */
  close(): Promise<void>;
}

export const CURRENT_PREFIX = 'r/';
export const GENESIS_PREFIX = 'g/';
export const HISTORY_PREFIX = 'h/';
export const ITEM_PREFIX = 'i/';

const currentKey = (key: string) => `${CURRENT_PREFIX}${key}`;
const genesisKey = (key: string) => `${GENESIS_PREFIX}${key}`;
/** `seq` padded so a key's history lists in order */
const historyKey = (e: Expression) => `${HISTORY_PREFIX}${e.key}/${String(e.seq).padStart(15, '0')}/${e.id}`;

/**
 * Where a version sorts for sync: its own time, in whole seconds. Only an
 * order — a wrong clock makes a version slower to find, never lost.
 */
export function syncTime(version: Pick<Expression, 'createdAt'>): number {
  const ms = Date.parse(version.createdAt);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
}

/** Collection names may hold anything; the entry needs them free of `/`. */
const itemKey = (e: Expression) => `${ITEM_PREFIX}${encodeURIComponent(e.collection)}/${syncTime(e)}/${e.id}`;

/** Reads an `i/` entry back: null for anything malformed, or an id that is not a content id */
function parseItemKey(key: string): { collection: string; id: string; item: Item } | null {
  const [, collection, time, id, extra] = key.split('/');
  if (collection === undefined || time === undefined || id === undefined || extra !== undefined) return null;
  const digest = cidDigest(id);
  const timestamp = Number(time);
  if (!digest || !Number.isSafeInteger(timestamp) || timestamp < 0) return null;
  try {
    return { collection: decodeURIComponent(collection), id, item: { timestamp, id: digest } };
  } catch {
    return null;
  }
}

/** What one change reads and writes, held until it lands */
interface Entries {
  get(key: string): Promise<string | null>;
  set(key: string, id: string): void;
  unset(key: string): void;
  /** Stores a version and indexes it for sync */
  keep(version: Expression): Promise<void>;
  /** Unindexes a version; its body is deleted once the change has landed */
  drop(version: Expression): void;
}

/**
 * Creates a StorageProvider wrapping an adapter.
 * @param adapter The initialized storage adapter.
 */
export function createStorageProvider(adapter: StorageAdapter): StorageProvider {
  // Every change reads the current version, then writes. Two of those
  // interleaved would each decide against the same current version, and one
  // would lose its place. So changes take turns.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusively = <T>(change: () => Promise<T>): Promise<T> => {
    const run = tail.then(change, change);
    tail = run.catch(() => {});
    return run;
  };

  // ─── What sync compares, in memory ─────────────────────────────────

  /** Versions kept, by collection, then by id. Null until first needed. */
  let kept: Map<string, Map<string, Item>> | null = null;
  /** Sorted sets, built when a reconciliation asks for one and dropped when their collection changes */
  const sets = new Map<string, ItemSet>();
  /** The sum of each collection's ids, kept up to date on every change: a hello needs no sorting */
  let totals: Map<string, Sum> | null = null;

  /** Read in turn with changes, so none lands between the listing and the sets being kept up to date */
  const loadKept = async (): Promise<Map<string, Map<string, Item>>> =>
    kept ??
    exclusively(async () => {
      if (kept) return kept;
      const loaded = new Map<string, Map<string, Item>>();
      for (const key of await adapter.list(ITEM_PREFIX)) {
        const parsed = parseItemKey(key);
        if (!parsed) continue;
        (loaded.get(parsed.collection) ?? loaded.set(parsed.collection, new Map()).get(parsed.collection)!).set(parsed.id, parsed.item);
      }
      kept = loaded;
      totals = new Map();
      for (const [collection, byId] of loaded) {
        let sum = EMPTY_SUM;
        for (const item of byId.values()) sum = addToSum(sum, item.id);
        totals.set(collection, sum);
      }
      return loaded;
    });

  /** Keeps the in-memory sets in step with a change just written */
  const track = (added: ReadonlyArray<Expression>, removed: ReadonlyArray<Expression>) => {
    for (const e of [...added, ...removed]) sets.delete(e.collection);
    if (!kept || !totals) return;
    for (const e of removed) {
      const item = kept.get(e.collection)?.get(e.id);
      if (!item) continue;
      kept.get(e.collection)!.delete(e.id);
      totals.set(e.collection, removeFromSum(totals.get(e.collection) ?? EMPTY_SUM, item.id));
    }
    for (const e of added) {
      const digest = cidDigest(e.id);
      const byId = kept.get(e.collection) ?? kept.set(e.collection, new Map()).get(e.collection)!;
      if (!digest || byId.has(e.id)) continue;
      byId.set(e.id, { timestamp: syncTime(e), id: digest });
      totals.set(e.collection, addToSum(totals.get(e.collection) ?? EMPTY_SUM, digest));
    }
  };

  // ─── Changes ───────────────────────────────────────────────────────

  /**
   * Runs one change. Its entry writes are held and made in one batch, so a
   * change lands whole or not at all. Versions it drops are deleted only
   * after, so no entry ever names a record that is gone.
   */
  const change = (run: (entries: Entries) => Promise<void>) =>
    exclusively(async () => {
      const writes = new Map<string, Uint8Array | null>();
      const added = new Map<string, Expression>();
      const dropped = new Map<string, Expression>();
      const entries: Entries = {
        get: async (key) => {
          const bytes = writes.has(key) ? writes.get(key)! : await adapter.get(key);
          return bytes ? utf8Decode(bytes) : null;
        },
        set: (key, id) => void writes.set(key, utf8Encode(id)),
        unset: (key) => void writes.set(key, null),
        keep: async (version) => {
          await adapter.putExpression(version);
          writes.set(itemKey(version), utf8Encode(version.id));
          added.set(version.id, version);
          dropped.delete(version.id);
        },
        drop: (version) => {
          writes.set(itemKey(version), null);
          dropped.set(version.id, version);
          added.delete(version.id);
        },
      };
      await run(entries);
      if (writes.size === 0 && dropped.size === 0) return;
      await adapter.batch([...writes].map(([key, value]): BatchOp => (value ? { type: 'put', key, value } : { type: 'delete', key })));
      for (const id of dropped.keys()) await adapter.deleteExpression(id);
      track([...added.values()], [...dropped.values()]);
    });

  /**
   * Places a version that is not current: the record's first version if it is
   * the lowest-id one seen, history if retained, otherwise gone.
   */
  async function demote(entries: Entries, version: Expression, current: Expression): Promise<void> {
    // A first version is kept as proof of who created the record — the one
    // with the lowest id, if several devices each created the same chosen key.
    // Not while the record is still at seq 0: then the current version is it.
    if (version.seq === 0 && current.seq > 0) {
      const heldId = await entries.get(genesisKey(version.key));
      if (heldId === version.id) return;
      if (heldId === null || version.id < heldId) {
        await entries.keep(version);
        entries.set(genesisKey(version.key), version.id);
        const displaced = heldId ? await adapter.getExpression(heldId) : null;
        if (displaced) await keepOrDrop(entries, displaced);
        return;
      }
    }
    await keepOrDrop(entries, version);
  }

  async function keepOrDrop(entries: Entries, version: Expression): Promise<void> {
    if (version.retain) {
      await entries.keep(version);
      entries.set(historyKey(version), version.id);
      return;
    }
    entries.drop(version);
  }

  const load = async (ids: Iterable<string>): Promise<Expression[]> =>
    (await Promise.all([...ids].map((id) => adapter.getExpression(id)))).filter((v): v is Expression => v !== null);

  const readId = async (key: string): Promise<string | null> => {
    const bytes = await adapter.get(key);
    return bytes ? utf8Decode(bytes) : null;
  };

  async function histories(prefix: string): Promise<Map<string, Expression[]>> {
    const ids = new Map<string, Set<string>>();
    const add = (key: string, id: string) => (ids.get(key) ?? ids.set(key, new Set()).get(key)!).add(id);
    for (const entry of [CURRENT_PREFIX, GENESIS_PREFIX]) {
      for (const name of await adapter.list(`${entry}${prefix}`)) {
        const id = await readId(name);
        if (id) add(name.slice(entry.length), id);
      }
    }
    // `h/<key>/<seq>/<id>` — a record key holds no `/`, and the id is in the entry's name.
    for (const name of await adapter.list(`${HISTORY_PREFIX}${prefix}`)) {
      const [, key, , id] = name.split('/');
      if (key && id) add(key, id);
    }
    const result = new Map<string, Expression[]>();
    for (const [key, held] of ids) result.set(key, (await load(held)).sort(byVersion));
    return result;
  }

  async function items(collection: string): Promise<ItemSet> {
    const cached = sets.get(collection);
    if (cached) return cached;
    const set = new ItemSet((await loadKept()).get(collection)?.values() ?? []);
    sets.set(collection, set);
    return set;
  }

  async function sums(): Promise<Map<string, Sum>> {
    await loadKept();
    return new Map([...(totals ?? [])].filter(([, sum]) => sum.count > 0));
  }

  return Object.freeze({
    addExpression(incoming: Expression): Promise<void> {
      return change(async (entries) => {
        const currentId = await entries.get(currentKey(incoming.key));
        if (currentId === incoming.id) return;
        const current = currentId ? await adapter.getExpression(currentId) : null;
        if (current && !supersedes(incoming, current)) return demote(entries, incoming, current);

        await entries.keep(incoming);
        entries.set(currentKey(incoming.key), incoming.id);
        if (current) await demote(entries, current, incoming);
      });
    },

    removeExpression(id: string): Promise<void> {
      return change(async (entries) => {
        const version = await adapter.getExpression(id);
        if (!version) return;
        for (const key of [currentKey(version.key), genesisKey(version.key)]) {
          if ((await entries.get(key)) === id) entries.unset(key);
        }
        entries.unset(historyKey(version));
        entries.drop(version);
      });
    },

    async getExpression(id: string): Promise<Expression | null> {
      return adapter.getExpression(id);
    },

    async getCurrent(key: string): Promise<Expression | null> {
      const id = await readId(currentKey(key));
      return id ? adapter.getExpression(id) : null;
    },

    async getGenesis(key: string): Promise<Expression | null> {
      const id = await readId(genesisKey(key));
      return id ? adapter.getExpression(id) : null;
    },

    async history(key: string): Promise<Expression[]> {
      return (await histories(key)).get(key) ?? [];
    },

    histories,

    async listCurrent(): Promise<Expression[]> {
      const ids = await Promise.all((await adapter.list(CURRENT_PREFIX)).map(readId));
      return load(ids.filter((id): id is string => id !== null));
    },

    async queryExpressions(collection: string): Promise<Expression[]> {
      // The index holds every version kept, not only current ones; the entries say which is current.
      const held = await adapter.queryExpressions(collection, Infinity);
      const current = await Promise.all(held.map(async (v) => (await readId(currentKey(v.key))) === v.id));
      return held.filter((_, i) => current[i]);
    },

    async versionIds(): Promise<string[]> {
      return [...(await loadKept()).values()].flatMap((byId) => [...byId.keys()]);
    },

    items,
    sums,

    async fingerprint(): Promise<string> {
      let total = EMPTY_SUM;
      for (const sum of (await sums()).values()) total = combineSums(total, sum);
      return bytesToHex(await fingerprintOf(total));
    },

    invalidate() {
      kept = null;
      totals = null;
      sets.clear();
    },

    getAdapter(): StorageAdapter {
      return adapter;
    },

    async close(): Promise<void> {
      await adapter.close();
    },
  });
}
