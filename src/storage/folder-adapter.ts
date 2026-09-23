/**
 * @module folder-adapter
 * A StorageAdapter over a directory the user picked on their own disk.
 *
 * This is the store that escapes the origin sandbox. IndexedDB, localStorage and
 * OPFS ("Origin Private File System" — the name is the specification) are all
 * keyed by origin, so two deployments of the same app can never see each other's
 * data. A directory handle is not: each origin asks the user for permission once
 * and both end up reading the same files. That is what makes an app a *view* on
 * the user's data rather than an owner of a private copy of it.
 *
 * The layout is meant to be legible, because the point is that the folder
 * belongs to the user:
 *
 * ```
 * <folder>/
 *   accounts.json                    who has an account here
 *   accounts/<id>/account.json       that account's keys, locked
 *   accounts/<id>/stores/<name>/
 *     kv/<key>                       MST nodes, the root pointer, space records
 *     expressions/<cid>.json
 * ```
 *
 * **Expressions are the truth; the MST is an index over them.** That inversion
 * is what lets two origins share one folder with no locking. Every expression
 * file is immutable and named by its own content hash, so concurrent writers can
 * only ever add files that agree — the one genuinely mutable thing, the MST root
 * pointer, is derived state that either side can rebuild. {@link reconcileFolder}
 * is what rebuilds it.
 */

import type { StorageAdapter, BatchOp, Expression } from '../types.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';

// ─── The slice of the File System Access API this module relies on ─────
//
// Declared structurally rather than taken from `lib.dom`, for two reasons: the
// async iterator methods live in the separate `DOM.AsyncIterable` lib that this
// project does not pull in, and writing the contract out makes it obvious what a
// test double has to provide.

export interface WritableFileLike {
  write(data: Uint8Array | string): Promise<void>;
  close(): Promise<void>;
}

export interface FileHandleLike {
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<WritableFileLike>;
}

export interface DirectoryHandleLike {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterableIterator<string>;
}

/** What changed on disk since the last pass */
export interface FolderReload {
  /** Expression ids that appeared — written by another origin, or another device */
  readonly added: ReadonlyArray<string>;
  /** Expression ids whose files are gone */
  readonly removed: ReadonlyArray<string>;
}

export interface FolderAdapter extends StorageAdapter {
  /** Where inside the folder this adapter keeps its files */
  readonly namespace: string;
  /**
   * Re-reads the directory, picking up writes made by another origin or device.
   *
   * There is no filesystem change notification on the web, so freshness is
   * something the caller asks for — on an interval, on focus, or after a sync
   * round. Pair it with {@link reconcileFolder} to fold what turns up into the
   * local tree.
   */
  reload(): Promise<FolderReload>;
  /** Every expression id currently on disk, whatever the MST believes */
  listExpressionIds(): Promise<ReadonlyArray<string>>;
}

const EXPRESSION_SUFFIX = '.json';

/**
 * Percent-encodes a storage key into a filename.
 *
 * Only lowercase is left unescaped, which looks excessive until you remember
 * that macOS and Windows filesystems are case-insensitive by default: without
 * this, the keys `space:Abc` and `space:abc` would quietly become one file and
 * one of the two values would be lost.
 *
 * @param key A storage key
 * @returns A filename safe on every filesystem, and reversible
 */
function encodeKey(key: string): string {
  let out = '';
  for (const byte of utf8Encode(key)) {
    const char = String.fromCharCode(byte);
    out += /[a-z0-9._-]/.test(char) ? char : `%${byte.toString(16).padStart(2, '0').toUpperCase()}`;
  }
  return out;
}

/**
 * Reverses {@link encodeKey}.
 * @param name A filename written by this adapter
 * @returns The storage key it stands for
 */
function decodeKey(name: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '%') {
      bytes.push(Number.parseInt(name.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(name.charCodeAt(i));
    }
  }
  return utf8Decode(new Uint8Array(bytes));
}

/** Whether a rejection means "that file isn't there", which is usually not an error. */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFoundError';
}

/**
 * Walks — and creates — a chain of subdirectories.
 * @param root The directory to start from
 * @param segments Path segments, already safe for a filename
 * @returns The directory at the end of the path
 */
async function resolvePath(
  root: DirectoryHandleLike,
  segments: ReadonlyArray<string>,
): Promise<DirectoryHandleLike> {
  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

/**
 * Reads a file, treating absence as null rather than as a failure.
 * @param dir The directory holding it
 * @param name The filename
 * @returns Its bytes, or null when there is no such file
 */
export async function readFolderFile(dir: DirectoryHandleLike, name: string): Promise<Uint8Array | null> {
  try {
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Writes a file, replacing whatever was there.
 * @param dir The directory to write into
 * @param name The filename
 * @param bytes The contents
 */
export async function writeFolderFile(dir: DirectoryHandleLike, name: string, bytes: Uint8Array): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

/**
 * Deletes a file, ignoring one that is already gone.
 * @param dir The directory holding it
 * @param name The filename
 */
async function removeFile(dir: DirectoryHandleLike, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/**
 * Opens a storage adapter backed by a directory on the user's disk.
 *
 * Expressions are held in memory as well as on disk — a query would otherwise
 * mean one file read per record, and the example app re-lists on every render.
 * The cost is that the working set has to fit in memory; the packed-storage work
 * is where that stops being true.
 *
 * @param root The directory the user picked
 * @param path Where to keep these files inside it, `/` separating
 *   subdirectories. The full path from the folder root, so that several
 *   accounts can each have a subtree of their own.
 * @returns An adapter over that directory, already populated
 */
export async function createFolderAdapter(
  root: DirectoryHandleLike,
  path: string,
): Promise<FolderAdapter> {
  const segments = path.split('/').filter(Boolean).map(encodeKey);
  if (segments.length === 0) {
    throw new Error('A folder adapter needs a path to live in.');
  }
  const base = await resolvePath(root, segments);
  const kvDir = await base.getDirectoryHandle('kv', { create: true });
  const expressionsDir = await base.getDirectoryHandle('expressions', { create: true });

  const expressions = new Map<string, Expression>();

  // Content-addressed nodes never change, so caching them is free. The root
  // pointer does change, which is why `reload` throws the whole cache away
  // rather than trying to be clever about which entries are still good.
  const kvCache = new Map<string, Uint8Array | null>();

  async function readExpressionFile(name: string): Promise<Expression | null> {
    const bytes = await readFolderFile(expressionsDir, name);
    if (!bytes) return null;
    try {
      return JSON.parse(utf8Decode(bytes)) as Expression;
    } catch {
      // A half-written file from a writer that died mid-flush. It will either be
      // rewritten or stay unreadable; either way it is not ours to repair.
      return null;
    }
  }

  async function reload(): Promise<FolderReload> {
    const seen = new Set<string>();
    const added: string[] = [];

    for await (const name of expressionsDir.keys()) {
      if (!name.endsWith(EXPRESSION_SUFFIX)) continue;
      const id = decodeKey(name.slice(0, -EXPRESSION_SUFFIX.length));
      seen.add(id);
      if (expressions.has(id)) continue;

      const expression = await readExpressionFile(name);
      if (!expression) continue;
      expressions.set(id, expression);
      added.push(id);
    }

    const removed = [...expressions.keys()].filter((id) => !seen.has(id));
    for (const id of removed) expressions.delete(id);

    kvCache.clear();
    return { added, removed };
  }

  await reload();

  return Object.freeze({
    namespace: path,
    reload,

    async listExpressionIds(): Promise<ReadonlyArray<string>> {
      return [...expressions.keys()];
    },

    async get(key: string): Promise<Uint8Array | null> {
      const cached = kvCache.get(key);
      if (cached !== undefined) return cached;

      const bytes = await readFolderFile(kvDir, encodeKey(key));
      kvCache.set(key, bytes);
      return bytes;
    },

    async put(key: string, value: Uint8Array): Promise<void> {
      await writeFolderFile(kvDir, encodeKey(key), value);
      kvCache.set(key, value);
    },

    async delete(key: string): Promise<void> {
      await removeFile(kvDir, encodeKey(key));
      kvCache.set(key, null);
    },

    async has(key: string): Promise<boolean> {
      const cached = kvCache.get(key);
      if (cached !== undefined) return cached !== null;
      return (await readFolderFile(kvDir, encodeKey(key))) !== null;
    },

    async list(prefix: string = ''): Promise<string[]> {
      const keys: string[] = [];
      for await (const name of kvDir.keys()) {
        const key = decodeKey(name);
        if (!key.startsWith(prefix)) continue;
        keys.push(key);
        // Another writer created it after this process looked and found
        // nothing. The file is on disk now, so the remembered miss is stale.
        if (kvCache.get(key) === null) kvCache.delete(key);
      }
      return keys;
    },

    async queryExpressions(collection: string, limit: number = 50, cursor?: string): Promise<Expression[]> {
      // Ordered so a cursor means the same thing on every device, which a
      // directory listing on its own would not guarantee.
      const ordered = [...expressions.values()]
        .filter((expression) => expression.collection === collection)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

      const start = cursor ? ordered.findIndex((expression) => expression.id === cursor) + 1 : 0;
      return ordered.slice(start, start + limit);
    },

    async putExpression(expression: Expression): Promise<void> {
      await writeFolderFile(
        expressionsDir,
        encodeKey(expression.id) + EXPRESSION_SUFFIX,
        utf8Encode(JSON.stringify(expression)),
      );
      expressions.set(expression.id, expression);
    },

    async getExpression(id: string): Promise<Expression | null> {
      const known = expressions.get(id);
      if (known) return known;

      // Not in memory: another origin may have written it since the last reload.
      const expression = await readExpressionFile(encodeKey(id) + EXPRESSION_SUFFIX);
      if (expression) expressions.set(id, expression);
      return expression;
    },

    async deleteExpression(id: string): Promise<void> {
      await removeFile(expressionsDir, encodeKey(id) + EXPRESSION_SUFFIX);
      expressions.delete(id);
    },

    async batch(ops: ReadonlyArray<BatchOp>): Promise<void> {
      for (const op of ops) {
        if (op.type === 'put') {
          await writeFolderFile(kvDir, encodeKey(op.key), op.value);
          kvCache.set(op.key, op.value);
        } else {
          await removeFile(kvDir, encodeKey(op.key));
          kvCache.set(op.key, null);
        }
      }
    },

    async close(): Promise<void> {
      expressions.clear();
      kvCache.clear();
    },
  });
}
