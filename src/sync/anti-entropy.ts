import { StorageAdapter } from '../types.js';
import { listMSTKeys } from '../storage/mst.js';

/**
 * Compares two root CIDs to check if they differ.
 * @param localRoot The local root CID.
 * @param remoteRoot The remote root CID.
 * @returns True if they are different, false otherwise.
 */
export function compareRoots(localRoot: string | null, remoteRoot: string | null): boolean {
  return localRoot !== remoteRoot;
}

/**
 * Finds keys present in remoteKeys but missing locally.
 * @param localAdapter The local storage adapter.
 * @param localRoot The local root CID.
 * @param remoteKeys The list of remote keys.
 * @returns A promise resolving to an array of missing keys.
 */
export async function findMissingExpressions(
  localAdapter: StorageAdapter,
  localRoot: string | null,
  remoteKeys: ReadonlyArray<string>
): Promise<ReadonlyArray<string>> {
  const localKeys = await listMSTKeys(localAdapter, localRoot);
  const localKeySet = new Set(localKeys);
  return remoteKeys.filter(key => !localKeySet.has(key));
}

/**
 * Finds keys present locally but missing in remoteKeys.
 * @param localAdapter The local storage adapter.
 * @param localRoot The local root CID.
 * @param remoteKeys The list of remote keys.
 * @returns A promise resolving to an array of keys local only.
 */
export async function findLocalOnlyExpressions(
  localAdapter: StorageAdapter,
  localRoot: string | null,
  remoteKeys: ReadonlyArray<string>
): Promise<ReadonlyArray<string>> {
  const localKeys = await listMSTKeys(localAdapter, localRoot);
  const remoteKeySet = new Set(remoteKeys);
  return localKeys.filter(key => !remoteKeySet.has(key));
}
