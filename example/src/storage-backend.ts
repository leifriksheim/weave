/**
 * Where this app keeps its replica.
 *
 * Every node in the mesh holds a complete, signed copy of the spaces it belongs
 * to — that does not change here. What changes is *where* the copy lives, and
 * that turns out to decide whether two deployments of this app are two views on
 * one set of data or two unrelated accounts.
 *
 * - `folder` — a directory the user picked. Not origin-scoped, so every origin
 *   they point at it sees the same lists, signed by the same key. Chrome, Edge
 *   and Opera on the desktop.
 * - `indexeddb` — this origin's own database. Everywhere else. Still a full
 *   peer, still converges over the mesh; it just cannot be shared with another
 *   origin on the same device.
 */
import {
  createEncryptedAdapter,
  createFolderAdapter,
  createIndexedDBAdapter,
  reconcileFolder,
  type DirectoryHandleLike,
  type FolderAdapter,
  type StorageAdapter,
  type StorageProvider,
} from '@p2p-web/protocol';

export type BackendKind = 'folder' | 'indexeddb';

export interface StorageBackend {
  readonly kind: BackendKind;
  /** The folder, when there is one — for showing its name, and for the account file */
  readonly directory: DirectoryHandleLike | null;
  /**
   * Encrypts the space registry at rest, once the folder has been unlocked.
   *
   * Only a folder gets one. An origin's own database is already behind the
   * browser profile, and the threat this answers — someone who has the folder
   * itself — does not arise there.
   */
  readonly vaultKey: CryptoKey | null;
}

/** Until sign-in picks one, this origin's own database is the assumption. */
let backend: StorageBackend = { kind: 'indexeddb', directory: null, vaultKey: null };

/**
 * Points all subsequent stores at a folder the user chose.
 * @param directory The unlocked folder
 * @param vaultKey Derived from the seed; seals the space registry
 */
export function useFolderBackend(directory: DirectoryHandleLike, vaultKey: CryptoKey): void {
  backend = { kind: 'folder', directory, vaultKey };
}

/** Falls back to this origin's own database. */
export function useLocalBackend(): void {
  backend = { kind: 'indexeddb', directory: null, vaultKey: null };
}

/** Which store the app is currently reading and writing. */
export function getBackend(): StorageBackend {
  return backend;
}

/**
 * The database a path maps to in IndexedDB.
 *
 * Paths are directories in a folder and names here, and they are scoped to an
 * account — so two accounts in one browser never share a store, the same way
 * two accounts in one folder never share a subtree.
 *
 * @param path The account-scoped path
 * @returns The database name to open
 */
function databaseName(path: string): string {
  return `p2p-todo:${path.replace(/\//g, ':')}`;
}

/**
 * Opens a store.
 *
 * @param path A path, `/` separated, from the account's root. It becomes a
 *   subdirectory in a folder and a database name otherwise, so keep it free of
 *   anything a filesystem would object to.
 * @param options.seal Encrypt space records and space keys at rest. Set for the
 *   registry, which is the one store whose contents would otherwise hand the
 *   whole folder to anyone who copied it.
 * @returns An adapter over whichever backend is active
 */
export async function openStore(
  path: string,
  options?: { seal?: boolean },
): Promise<StorageAdapter> {
  if (backend.kind !== 'folder' || !backend.directory) {
    return createIndexedDBAdapter(databaseName(path));
  }

  const adapter = await createFolderAdapter(backend.directory, path);
  return options?.seal && backend.vaultKey
    ? createEncryptedAdapter(adapter, backend.vaultKey)
    : adapter;
}

/** Whether an adapter is folder-backed, and so worth polling for outside writes. */
export function isFolderAdapter(adapter: StorageAdapter): adapter is FolderAdapter {
  return typeof (adapter as FolderAdapter).reload === 'function';
}

/**
 * Watches a folder-backed store for writes made outside this tab.
 *
 * The web has no filesystem change notification, so freshness has to be asked
 * for. Polling covers the other origin writing while this one is open; the
 * focus and visibility hooks cover the common case of switching tabs or
 * windows, where waiting out the interval would feel broken.
 *
 * @param storage The provider to keep up to date
 * @param adapter Its adapter — a no-op unless this is a folder
 * @param onChange Called when something actually moved
 * @param intervalMs How often to look
 * @returns A function that stops watching
 */
export function watchFolder(
  storage: StorageProvider,
  adapter: StorageAdapter,
  onChange: () => void,
  intervalMs: number = 2000,
): () => void {
  if (!isFolderAdapter(adapter)) return () => {};

  let stopped = false;
  let running = false;

  const pass = async () => {
    // A slow pass must not stack up behind itself — a big folder can take
    // longer to walk than the interval.
    if (stopped || running) return;
    running = true;
    try {
      if ((await reconcileFolder(storage, adapter)).changed) onChange();
    } catch {
      // A revoked permission or a folder that went away. The next pass will
      // either recover or keep quiet; either way it is not worth a crash.
    } finally {
      running = false;
    }
  };

  const timer = globalThis.setInterval(() => void pass(), intervalMs);
  const onFocus = () => void pass();
  const onVisible = () => {
    if (globalThis.document.visibilityState === 'visible') void pass();
  };

  globalThis.addEventListener('focus', onFocus);
  globalThis.document.addEventListener('visibilitychange', onVisible);

  return () => {
    stopped = true;
    globalThis.clearInterval(timer);
    globalThis.removeEventListener('focus', onFocus);
    globalThis.document.removeEventListener('visibilitychange', onVisible);
  };
}
