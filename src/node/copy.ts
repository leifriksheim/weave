/**
 * @module node/copy
 * Moving an account's data from one set of stores to another — out of a
 * browser's own database into a data folder, say.
 *
 * There is no separate "merge". Every record is signed and named by its own
 * content, and a delete is a record too, so combining two copies of the same
 * account is the union of what each holds: nothing can conflict, nothing is
 * duplicated, and whatever either copy deleted stays deleted. Copying into a
 * store that already has some of it is therefore safe, and copying twice does
 * nothing the second time.
 */
import type { StoreFactory } from './stores.js';
import { createSpaceManager } from '../space/space-manager.js';
import { deriveAccountRegistry } from '../space/account-registry.js';
import { createStorageProvider } from '../storage/storage-provider.js';
import { listMSTKeys } from '../storage/mst.js';

export interface CopyAccountParams {
  readonly from: StoreFactory;
  readonly to: StoreFactory;
  /** The account's DID — invites between the two registries are issued as it */
  readonly did: string;
  /** Also copy the account registry space, which neither registry lists */
  readonly accountKey?: Uint8Array;
  /** Called after each space, for a progress display */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface CopyResult {
  /** Spaces the destination did not know about before */
  readonly spacesAdded: number;
  /** Records the destination did not hold before */
  readonly recordsAdded: number;
  /** Every space looked at, including the registry */
  readonly spaces: number;
}

/**
 * Copies every space an account holds, with its key and its records, into
 * another set of stores. Whatever the destination already has is kept.
 */
export async function copyAccountData(params: CopyAccountParams): Promise<CopyResult> {
  const fromRegistryStore = await params.from('registry', { seal: true });
  const toRegistryStore = await params.to('registry', { seal: true });
  const fromRegistry = createSpaceManager(fromRegistryStore);
  const toRegistry = createSpaceManager(toRegistryStore);

  let spacesAdded = 0;
  const spaceIds: string[] = [];
  for (const { space } of await fromRegistry.list()) {
    spaceIds.push(space.id);
    if (await toRegistry.get(space.id)) continue;
    // An invite carries exactly what a registry needs: the space, and its key.
    await toRegistry.join(await fromRegistry.createInvite(space.id, params.did), params.did);
    spacesAdded++;
  }
  if (params.accountKey) spaceIds.push((await deriveAccountRegistry(params.accountKey, params.did)).space.id);

  let recordsAdded = 0;
  for (const [index, spaceId] of spaceIds.entries()) {
    const source = createStorageProvider(await params.from(`spaces/${spaceId}`));
    const target = createStorageProvider(await params.to(`spaces/${spaceId}`));
    try {
      for (const id of await listMSTKeys(source.getAdapter(), await source.getRootCid())) {
        if (await target.getExpression(id)) continue;
        const expression = await source.getExpression(id);
        if (!expression) continue;
        await target.addExpression(expression);
        recordsAdded++;
      }
    } finally {
      await Promise.all([source.close(), target.close()]);
    }
    params.onProgress?.(index + 1, spaceIds.length);
  }

  await Promise.all([fromRegistryStore.close(), toRegistryStore.close()]);
  return { spacesAdded, recordsAdded, spaces: spaceIds.length };
}
