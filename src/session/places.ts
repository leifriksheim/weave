/**
 * @module session/places
 * Where accounts and their data are kept: a pod, or this browser.
 *
 * Two questions a sign-in flow keeps apart:
 *
 * - **Where does my data live?** A folder you picked (a *pod*), or this
 *   browser. That is a place.
 * - **Who am I?** An account in that place. A place can hold several.
 */
import { createBrowserAccountStore, createFolderAccountStore, listFolderAccounts } from '../identity/account-store.js';
import type { AccountStore, AccountSummary } from '../identity/account-store.js';
import {
  forgetDataFolder,
  ensureFolderPermission,
  pickDataFolder,
  recallDataFolder,
  rememberDataFolder,
} from '../storage/directory-access.js';
import { folderStores, indexedDBStores, type StoreFactory } from '../node/stores.js';
import type { DirectoryHandleLike } from '../storage/folder-adapter.js';

/** Where accounts and their data are kept */
export interface Place {
  readonly kind: 'folder' | 'browser';
  readonly store: AccountStore;
  /** The folder, when there is one — for its name, and for opening stores */
  readonly directory: DirectoryHandleLike | null;
}

/** What a pod holds, for deciding what to do before switching to it */
export interface PodContents {
  /** This account's copy in the pod, when it has one */
  readonly account: AccountSummary | null;
  /** Other accounts in the pod — never touched by a move */
  readonly others: number;
  /** It is the pod already in use */
  readonly same: boolean;
}

/** Accounts kept in this browser. Always available; never shared with another site. */
export async function browserPlace(): Promise<Place> {
  return { kind: 'browser', store: await createBrowserAccountStore(), directory: null };
}

/** Wraps a folder as a place. */
export function folderPlace(directory: DirectoryHandleLike): Place {
  return { kind: 'folder', store: createFolderAccountStore(directory), directory };
}

/**
 * Asks for a pod without switching to it — so a signed-in person can be asked
 * what should happen to their data first. Must be called from a click.
 */
export async function pickPod(): Promise<Place> {
  return folderPlace(await pickDataFolder({ id: 'weave-pod' }));
}

/** Remembers a pod as the one this site opens next time. */
export async function rememberPod(pod: Place): Promise<void> {
  if (!pod.directory) throw new Error('That is not a folder.');
  await rememberDataFolder(pod.directory);
}

/**
 * Re-opens the pod this site used last.
 *
 * @param request Whether to prompt for permission. Needs a click when true; use
 *   false on page load to find out whether a button has to be shown.
 * @returns The pod, or null when there is none or access was declined
 */
export async function recallPod(request: boolean): Promise<Place | null> {
  const directory = await recallDataFolder();
  if (!directory) return null;
  if (!(await ensureFolderPermission(directory, { request }))) return null;
  return folderPlace(directory);
}

/** Stops using the pod. Nothing in it is touched. */
export async function forgetPod(): Promise<void> {
  await forgetDataFolder();
}

/** Every account in a place, most recently used first. */
export async function listAccounts(place: Place): Promise<ReadonlyArray<AccountSummary>> {
  return place.directory ? listFolderAccounts(place.directory, place.store) : place.store.list();
}

/** What a pod holds of this account and others, and whether it is the one in use. */
export async function inspectPod(pod: Place, current: Place, did: string): Promise<PodContents> {
  const accounts = await listAccounts(pod);
  const same =
    current.kind === 'folder' &&
    !!current.directory &&
    !!pod.directory &&
    (await (pod.directory as { isSameEntry?: (other: unknown) => Promise<boolean> })
      .isSameEntry?.(current.directory)
      .catch(() => false)) === true;
  return {
    account: accounts.find((account) => account.did === did) ?? null,
    others: accounts.filter((account) => account.did !== did).length,
    same,
  };
}

/**
 * The stores for one account.
 *
 * Paths are account-scoped either way, so two accounts in one browser never
 * share a store, the same way two accounts in one folder never share a subtree.
 * A pod's registry is sealed under the vault key, so someone who copies the
 * folder cannot read the private spaces in it.
 *
 * @param account Whose data
 * @param folder The unlocked pod and its vault key, when the account lives in one
 */
export function storesFor(
  account: AccountSummary,
  folder?: { readonly directory: DirectoryHandleLike; readonly vaultKey: CryptoKey },
): StoreFactory {
  return folder
    ? folderStores(folder.directory, { basePath: account.dataPath, vaultKey: folder.vaultKey })
    : indexedDBStores(`weave:${account.dataPath.replace(/\//g, ':')}`);
}

/** Deletes the IndexedDB databases an account kept in this browser. */
export async function deleteBrowserData(account: AccountSummary): Promise<void> {
  const prefix = `weave:${account.dataPath.replace(/\//g, ':')}`;
  const databases = (await globalThis.indexedDB.databases?.()) ?? [];
  await Promise.all(
    databases
      .map((db) => db.name)
      .filter((name): name is string => typeof name === 'string' && name.startsWith(prefix))
      .map(
        (name) =>
          new Promise<void>((resolve) => {
            const request = globalThis.indexedDB.deleteDatabase(name);
            request.onsuccess = request.onerror = request.onblocked = () => resolve();
          }),
      ),
  );
}
