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

  // Versions another writer put on disk that this tree has not placed. Each
  // goes through the ordering rule like anything else: it becomes current,
  // is kept as history, or loses and is dropped — the same decision the other
  // writer reached, so both converge on the same tree.
  const indexed = new Set((await storage.entries()).map((entry) => entry.value));
  const missing = [...onDisk].filter((id) => !indexed.has(id));
  for (const id of missing) {
    const expression = await adapter.getExpression(id);
    // A file can vanish between the listing and the read — another writer
    // dropping a superseded version. Nothing to add, and the next pass agrees.
    if (expression) await storage.addExpression(expression);
  }

  // Entries whose file is gone: another writer superseded and dropped it, and
  // its replacement was placed above.
  const stale = [...new Set((await storage.entries()).map((entry) => entry.value))].filter((id) => !onDisk.has(id) && !missing.includes(id));
  for (const id of stale) {
    if (!(await adapter.getExpression(id))) await storage.removeExpression(id);
  }

  const repaired = [...missing, ...stale];
  return {
    added: disk.added,
    removed: disk.removed,
    repaired,
    changed: disk.added.length > 0 || disk.removed.length > 0 || repaired.length > 0,
  };
}
