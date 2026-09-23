/**
 * Where this app keeps its replica.
 *
 * Every node in the mesh holds a complete, signed copy of the spaces it belongs
 * to — that does not change here. What changes is *where* the copy lives, and
 * that turns out to decide whether two deployments of this app are two views on
 * one set of data or two unrelated accounts.
 *
 * - **folder** — a directory the user picked. Not origin-scoped, so every origin
 *   they point at it sees the same lists, signed by the same key. Chrome, Edge
 *   and Opera on the desktop. The registry is sealed under the vault key, so
 *   someone who copies the folder cannot read the private spaces in it.
 * - **indexeddb** — this origin's own database. Everywhere else. Still a full
 *   peer, still converges over the mesh; it just cannot be shared with another
 *   origin on the same device.
 */
import {
  folderStores,
  indexedDBStores,
  type AccountSummary,
  type DirectoryHandleLike,
  type StoreFactory,
} from '@p2p-web/protocol';

/**
 * The stores for one account.
 *
 * Paths are account-scoped either way, so two accounts in one browser never
 * share a store, the same way two accounts in one folder never share a subtree.
 *
 * @param account Whose data
 * @param folder The unlocked data folder and its vault key, when the account lives in one
 */
export function storesFor(
  account: AccountSummary,
  folder?: { readonly directory: DirectoryHandleLike; readonly vaultKey: CryptoKey },
): StoreFactory {
  return folder
    ? folderStores(folder.directory, { basePath: account.dataPath, vaultKey: folder.vaultKey })
    : indexedDBStores(`p2p-todo:${account.dataPath.replace(/\//g, ':')}`);
}
