/**
 * @module folder-reconcile
 * Making a shared folder converge, without anybody having to take a lock.
 *
 * Two origins — or two devices behind Dropbox, iCloud or Syncthing — can write
 * into one folder at the same time. Almost nothing there can actually conflict:
 * expression files are named by their own content hash, so two writers either
 * produce different files or produce byte-identical ones. The entries saying
 * which version is current can be written by both, and one write can be lost;
 * that costs nothing, because they are derived from the files.
 *
 * So the rule is: **the set of expression files wins.** Reconciling means
 * placing every file that turned up — which also puts right a current-version
 * entry the other writer overwrote — and dropping entries whose file went
 * away. That is the whole concurrency story.
 */

import type { StorageProvider } from './storage-provider.js';
import type { FolderAdapter } from './folder-adapter.js';
import type { Expression } from '../types.js';

/** What a pass over the folder found */
export interface FolderReconciliation {
  /** Expression files that appeared since the last pass — another origin's writes */
  readonly added: ReadonlyArray<string>;
  /** Expression files that are gone */
  readonly removed: ReadonlyArray<string>;
  /**
   * Versions placed or unplaced to match the directory: files another writer
   * added (placed again, which corrects a current entry a race left wrong),
   * files that came back from Dropbox with no entries, and entries whose file
   * is gone.
   */
  readonly repaired: ReadonlyArray<string>;
  /** Whether anything moved at all — worth a re-render when true */
  readonly changed: boolean;
}

/**
 * Re-reads the folder and brings the entries back in line with it.
 *
 * Safe to call as often as you like: with nothing new on disk it is two
 * directory listings and no writes.
 *
 * @param storage The provider whose entries should be brought up to date
 * @param adapter The folder adapter underneath it
 * @param accept Whether a version found on disk may be placed. Anyone who can
 *   write the folder can drop a file in it — another site given the folder, a
 *   sync service — so what turns up there is checked like anything arriving
 *   from a peer. A version refused now stays on disk and is asked about again.
 * @returns What moved
 */
export async function reconcileFolder(
  storage: StorageProvider,
  adapter: FolderAdapter,
  accept: (expression: Expression) => Promise<boolean> = async () => true,
): Promise<FolderReconciliation> {
  const disk = await adapter.reload();
  // Another writer's entries are on disk now too: what sync compares is read again.
  if (disk.added.length > 0 || disk.removed.length > 0) storage.invalidate();
  const onDisk = new Set(await adapter.listExpressionIds());

  // Versions another writer put on disk. Each goes through the ordering rule
  // like anything else: it becomes current, is kept as history, or loses and
  // is dropped — the same decision the other writer reached, so both converge.
  // Files that appeared since the last pass are placed again even if indexed:
  // placing is idempotent, and it corrects a current entry a race left wrong.
  const indexed = new Set(await storage.versionIds());
  const appeared = new Set(disk.added);
  const missing = [...onDisk].filter((id) => !indexed.has(id) || appeared.has(id));
  const placed: string[] = [];
  for (const id of missing) {
    const expression = await adapter.getExpression(id);
    // A file can vanish between the listing and the read — another writer
    // dropping a superseded version. Nothing to add, and the next pass agrees.
    if (expression && (await accept(expression))) {
      await storage.addExpression(expression);
      placed.push(id);
    }
  }

  // Entries whose file is gone: another writer superseded and dropped it, and
  // its replacement was placed above.
  const stale = (await storage.versionIds()).filter((id) => !onDisk.has(id) && !missing.includes(id));
  for (const id of stale) {
    if (!(await adapter.getExpression(id))) await storage.removeExpression(id);
  }

  // A refused file is not a change: it would otherwise redraw every pass.
  const repaired = [...placed, ...stale];
  return {
    added: disk.added,
    removed: disk.removed,
    repaired,
    changed: disk.added.length > 0 || disk.removed.length > 0 || repaired.length > 0,
  };
}
