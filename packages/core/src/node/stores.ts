/**
 * @module node/stores
 * Where a node keeps its data.
 *
 * A node needs two kinds of store: one registry listing the spaces it holds
 * (and their keys), and one store per space. It asks for them by path —
 * `registry`, `spaces/<id>` — and a {@link StoreFactory} decides what a path
 * means: a database in this browser, a directory in a data folder, a directory
 * on a server's disk.
 */
import type { StorageAdapter } from '../types.js';
import { createIndexedDBAdapter } from '../storage/indexeddb-adapter.js';
import { createFolderAdapter, type DirectoryHandleLike } from '../storage/folder-adapter.js';
import { createEncryptedAdapter } from '../storage/encrypted-adapter.js';

export interface StoreOptions {
  /**
   * Encrypt space records and space keys at rest. The node sets it for the
   * registry, the one store whose contents would otherwise hand every private
   * space to whoever copied the files.
   */
  readonly seal?: boolean;
}

/** Opens the store for a `/`-separated path. */
export type StoreFactory = (path: string, options?: StoreOptions) => Promise<StorageAdapter>;

/**
 * Stores in this origin's IndexedDB, one database per path.
 *
 * Not sealed: the browser profile already stands between the data and anyone
 * else, and the threat sealing answers — someone holding the files — does not
 * arise.
 *
 * @param prefix Namespaces the databases, e.g. an app and account id
 */
export function indexedDBStores(prefix: string): StoreFactory {
  return (path) => createIndexedDBAdapter(`${prefix}:${path.replace(/\//g, ':')}`);
}

/**
 * Stores in a directory — a data folder the user picked in a browser, or a
 * directory on disk wrapped to look like one.
 *
 * @param directory The root to write under
 * @param options.basePath Where this account's data starts, e.g. `accounts/<id>/stores`
 * @param options.vaultKey Seals the registry. Without it nothing is sealed.
 */
export function folderStores(
  directory: DirectoryHandleLike,
  options: { readonly basePath?: string; readonly vaultKey?: CryptoKey | null } = {},
): StoreFactory {
  return async (path, storeOptions) => {
    const full = options.basePath ? `${options.basePath}/${path}` : path;
    const adapter = await createFolderAdapter(directory, full);
    return storeOptions?.seal && options.vaultKey ? createEncryptedAdapter(adapter, options.vaultKey) : adapter;
  };
}
