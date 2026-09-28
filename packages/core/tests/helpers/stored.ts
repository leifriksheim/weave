/**
 * What a node's store holds now, looked at directly. Read afresh on every
 * call: the node writes that store through its own copy, and a store another
 * writer changed must be told before it reads right (05 §10.2).
 */
import { createStorageProvider, type StorageProvider } from '../../src/storage/storage-provider.js';
import type { StoreFactory } from '../../src/node/stores.js';

export async function stored(stores: StoreFactory, space: string): Promise<StorageProvider> {
  return createStorageProvider(await stores(`spaces/${space}`));
}
