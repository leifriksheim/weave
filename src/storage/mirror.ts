/**
 * @module storage/mirror
 * A space kept in a dumb file store, synced like a peer that never runs code.
 *
 * ```
 * <space-id>/
 *   <writer-id>/000001-<hash>.seg     immutable: written once, never changed
 *   <writer-id>/000002-<hash>.seg
 *   <other writer>/…
 * ```
 *
 * A **writer** is one store on one device — a browser's database, a host —
 * with a random id of its own. It only ever creates files in its own folder,
 * so nothing is written twice, nothing is overwritten, and nothing needs a
 * lock. A segment holds versions exactly as they travel; each reader builds
 * its own tree from them. Merging is the protocol's own: the set of versions
 * only grows, and the version rule picks the same current one everywhere.
 *
 * **Push**: versions this store holds that the store is not known to hold go
 * out in a new segment. "Known" is everything this writer uploaded or read,
 * so nobody re-uploads everyone else's records.
 *
 * **Pull**: segments not read yet are fetched once, and every version in them
 * goes through the same gates as one from a peer — the store is untrusted.
 * It can hide things (the mesh fills the gap) but not forge them.
 *
 * **Compaction**: a writer may rewrite its own segments into fewer, keeping
 * only what its store still keeps, then delete the old ones. New first,
 * delete after: a reader in between sees duplicates, which are harmless.
 */
import type { Expression, StorageAdapter } from '../types.js';
import type { BlobStore } from './blob-store.js';
import type { StorageProvider } from './storage-provider.js';
import { packSegment, segmentName, SEGMENT_SUFFIX, unpackSegment, versionSize } from './segment.js';
import { utf8Decode, utf8Encode } from '../utils/encoding.js';

/** What became of a version handed over from the store */
export type Taken = 'stored' | 'later' | 'refused';

export interface MirrorConfig {
  readonly store: BlobStore;
  readonly space: string;
  readonly storage: StorageProvider;
  /** The gates sync uses, and storing what passes: nothing from the store is trusted more than a peer */
  readonly accept: (version: Expression) => Promise<Taken>;
  /** Where this writer keeps its id, what it read and what it knows the store holds */
  readonly state: StorageAdapter;
  /** Pack a segment once this much is waiting. Default 256 KiB. */
  readonly flushBytes?: number;
  /** Or this long after the first change. Default 5 s. */
  readonly flushMs?: number;
  /** Rewrite this writer's segments once it has this many. Default 32. */
  readonly compactAt?: number;
}

export interface Mirror {
  /** Takes in what others left in the store. How many versions were stored. */
  pull(): Promise<{ readonly added: number }>;
  /** Uploads what the store is missing, now */
  flush(): Promise<void>;
  /** Something changed here: flush soon */
  changed(): void;
  /** Rewrites this writer's segments into fewer */
  compact(): Promise<void>;
  /** Flushes, and stops the timer */
  close(): Promise<void>;
}

const WRITER_KEY = 'mirror:writer';
const COUNTER_KEY = 'mirror:counter';
const readKey = (name: string) => `mirror:read:${name}`;
const knownKey = (id: string) => `mirror:known:${id}`;
const MARK = utf8Encode('1');

/** Deletes everything a space keeps in a store — every writer's segments */
export async function deleteMirrored(store: BlobStore, space: string): Promise<void> {
  for (const key of await store.list(`${space}/`)) await store.delete(key);
}

export async function createMirror(config: MirrorConfig): Promise<Mirror> {
  const { store, space, storage, state } = config;
  const flushBytes = config.flushBytes ?? 256 * 1024;
  const flushMs = config.flushMs ?? 5000;
  const compactAt = config.compactAt ?? 32;

  // 128 random bits, never a DID: a folder listing must not say whose device wrote it.
  let writerBytes = await state.get(WRITER_KEY);
  if (!writerBytes) {
    writerBytes = utf8Encode(Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
    await state.put(WRITER_KEY, writerBytes);
  }
  const writer = utf8Decode(writerBytes);
  const mine = `${space}/${writer}/`;

  const counterBytes = await state.get(COUNTER_KEY);
  let counter = counterBytes ? Number(utf8Decode(counterBytes)) : 0;

  const isKnown = async (id: string) => (await state.get(knownKey(id))) !== null;
  const markKnown = (id: string) => state.put(knownKey(id), MARK);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  /** One upload or compaction at a time: two at once would pack the same versions twice */
  let busy: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = busy.then(work, work);
    busy = next.catch(() => {});
    return next;
  };

  async function writeSegment(versions: ReadonlyArray<Expression>): Promise<string> {
    const bytes = packSegment(versions);
    counter += 1;
    const name = `${mine}${await segmentName(counter, bytes)}`;
    await store.put(name, bytes);
    await state.put(COUNTER_KEY, utf8Encode(String(counter)));
    await state.put(readKey(name), MARK);
    return name;
  }

  /** Every version this store keeps: current, first and retained */
  async function held(): Promise<string[]> {
    return [...new Set((await storage.entries()).map((entry) => entry.value))];
  }

  async function flushNow(): Promise<void> {
    const waiting: Expression[] = [];
    for (const id of await held()) {
      if (await isKnown(id)) continue;
      const version = await storage.getExpression(id);
      if (version) waiting.push(version);
    }
    let batch: Expression[] = [];
    let size = 0;
    const send = async () => {
      if (batch.length === 0) return;
      await writeSegment(batch);
      for (const version of batch) await markKnown(version.id);
      batch = [];
      size = 0;
    };
    for (const version of waiting) {
      batch.push(version);
      size += versionSize(version);
      if (size >= flushBytes) await send();
    }
    await send();
    if ((await store.list(mine)).filter((key) => key.endsWith(SEGMENT_SUFFIX)).length >= compactAt) await compactNow();
  }

  async function compactNow(): Promise<void> {
    const old = (await store.list(mine)).filter((key) => key.endsWith(SEGMENT_SUFFIX));
    if (old.length < 2) return;
    const wanted = new Set(await held());
    const keep = new Map<string, Expression>();
    for (const key of old) {
      const bytes = await store.get(key);
      for (const version of bytes ? unpackSegment(bytes) : []) if (wanted.has(version.id)) keep.set(version.id, version);
    }
    // New first, then delete: a reader in between sees each version twice, which is harmless.
    let batch: Expression[] = [];
    let size = 0;
    for (const version of keep.values()) {
      batch.push(version);
      size += versionSize(version);
      if (size >= flushBytes) {
        await writeSegment(batch);
        batch = [];
        size = 0;
      }
    }
    if (batch.length) await writeSegment(batch);
    for (const key of old) await store.delete(key);
  }

  async function pullNow(): Promise<{ added: number }> {
    const fresh: string[] = [];
    for (const key of await store.list(`${space}/`)) {
      // Our own segments hold what we uploaded; a listing that lags is trusted less than our own writes.
      if (!key.endsWith(SEGMENT_SUFFIX) || key.startsWith(mine) || (await state.get(readKey(key)))) continue;
      fresh.push(key);
    }
    let added = 0;
    for (const key of fresh.sort()) {
      const bytes = await store.get(key);
      // Deleted between listing and fetching — compacted by its writer. Its versions are in a newer segment.
      if (!bytes) continue;
      let pending = unpackSegment(bytes);
      // Versions can depend on each other — a record on its first version, on the access changes it saw.
      // Pass over the rest until nothing more goes in.
      for (let progress = true; pending.length > 0 && progress; ) {
        progress = false;
        const later: Expression[] = [];
        for (const version of pending) {
          const taken = await config.accept(version);
          if (taken === 'later') {
            later.push(version);
            continue;
          }
          if (taken === 'stored') added += 1;
          await markKnown(version.id);
          progress = true;
        }
        pending = later;
      }
      // Some still waiting on something no segment here has: read again next time.
      if (pending.length === 0) await state.put(readKey(key), MARK);
    }
    return { added };
  }

  return Object.freeze({
    pull: () => serial(pullNow),
    flush: () => serial(flushNow),
    compact: () => serial(compactNow),

    changed() {
      if (closed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void serial(flushNow).catch(() => {
          // The store is out of reach; the next change tries again, and nothing is lost meanwhile.
        });
      }, flushMs);
      (timer as { unref?: () => void }).unref?.();
    },

    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await serial(flushNow).catch(() => {});
    },
  });
}
