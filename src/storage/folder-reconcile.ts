/**
 * @module folder-reconcile
 * Making a shared folder converge, without anybody having to take a lock.
 *
 * Two origins — or two devices behind Dropbox, iCloud or Syncthing — can write
 * into one folder at the same time. Almost nothing there can actually conflict:
 * expression files are named by their own content hash, so two writers either
 * produce different files or produce byte-identical ones. The single mutable
 * thing is the MST root pointer, and a lost write to it costs nothing, because
 * the tree is derived state.
 *
 * So the rule is: **the set of expression files wins.** Reconciling means
 * rebuilding the tree until it agrees with the directory — adding what turned up
 * and dropping what went away. That is the whole concurrency story.
 */

import type { StorageProvider } from './storage-provider.js';
import type { FolderAdapter } from './folder-adapter.js';
import { listMSTKeys } from './mst.js';

/** What a pass over the folder found */
export interface FolderReconciliation {
  /** Expression files that appeared since the last pass — another origin's writes */
  readonly added: ReadonlyArray<string>;
  /** Expression files that are gone */
  readonly removed: ReadonlyArray<string>;
  /**
   * Tree entries that had to be fixed to match the directory.
   *
   * Usually empty, and that is the expected case rather than a lucky one: both
   * origins read and write the same root pointer, so the tree one of them built
   * is normally already right for the other. This fills in when a pointer write
   * was lost — two writers racing, or a folder that came back from Dropbox with
   * files the pointer never saw.
   */
  readonly repaired: ReadonlyArray<string>;
  /** Whether anything moved at all — worth a re-render when true */
  readonly changed: boolean;
}

/**
 * Re-reads the folder and brings the Merkle tree back in line with it.
 *
 * Safe to call as often as you like: with nothing new on disk it is two
 * directory listings and no writes.
 *
 * @param storage The provider whose tree should be brought up to date
 * @param adapter The folder adapter underneath it
 * @returns What moved
 */
export async function reconcileFolder(
  storage: StorageProvider,
  adapter: FolderAdapter,
): Promise<FolderReconciliation> {
  const disk = await adapter.reload();

  const onDisk = new Set(await adapter.listExpressionIds());
  const inTree = new Set(await listMSTKeys(adapter, await storage.getRootCid()));

  const missing = [...onDisk].filter((id) => !inTree.has(id));
  const stale = [...inTree].filter((id) => !onDisk.has(id));

  for (const id of missing) {
    const expression = await adapter.getExpression(id);
    // A file can vanish between the listing and the read — another writer
    // deleting it. Nothing to add, and the next pass will agree.
    if (expression) await storage.addExpression(expression);
  }

  for (const id of stale) {
    await storage.removeExpression(id);
  }

  const repaired = [...missing, ...stale];
  return {
    added: disk.added,
    removed: disk.removed,
    repaired,
    changed: disk.added.length > 0 || disk.removed.length > 0 || repaired.length > 0,
  };
}
