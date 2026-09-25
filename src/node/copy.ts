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
 * nothing the second time. Where both hold a version of the same record, the
 * ordering rule picks the same one sync would.
 */
import type { StoreFactory } from './stores.js';
import { createSpaceManager } from '../space/space-manager.js';
import { deriveAccountRegistry, deriveContactsSpace } from '../space/account-registry.js';
import { createStorageProvider } from '../storage/storage-provider.js';

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

  // The contacts space is copied like any other, but it is not one the person counts as theirs.
  const contacts = params.accountKey ? (await deriveContactsSpace(params.accountKey, params.did)).space.id : null;
  let spacesAdded = 0;
  const spaceIds: string[] = [];
  for (const { space } of await fromRegistry.list()) {
    spaceIds.push(space.id);
    if (await toRegistry.get(space.id)) continue;
    // An invite carries exactly what a registry needs: the space, and its key.
    await toRegistry.join(await fromRegistry.createInvite(space.id, params.did));
    if (space.id !== contacts) spacesAdded++;
  }
  if (params.accountKey) spaceIds.push((await deriveAccountRegistry(params.accountKey, params.did)).space.id);

  let recordsAdded = 0;
  for (const [index, spaceId] of spaceIds.entries()) {
    const source = createStorageProvider(await params.from(`spaces/${spaceId}`));
    const target = createStorageProvider(await params.to(`spaces/${spaceId}`));
    try {
      // Every version the source keeps — current, first, retained — goes
      // through the ordering rule on arrival, so the target ends up with what
      // it would have reached by syncing with the source.
      const ids = new Set((await source.entries()).map((entry) => entry.value));
      for (const id of ids) {
        const held = await target.getExpression(id);
        const expression = await source.getExpression(id);
        if (!expression) continue;
        await target.addExpression(expression);
        // Counted only if it stayed: a version the target's own one supersedes is dropped again.
        if (!held && (await target.getExpression(id))) recordsAdded++;
      }
    } finally {
      await Promise.all([source.close(), target.close()]);
    }
    params.onProgress?.(index + 1, spaceIds.length);
  }

  await Promise.all([fromRegistryStore.close(), toRegistryStore.close()]);
  return { spacesAdded, recordsAdded, spaces: spaceIds.length };
}
