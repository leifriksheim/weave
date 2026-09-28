/**
 * The pixel bench in a browser, over IndexedDB: what each operation costs in
 * store calls (each an IndexedDB transaction) and time, and how long a space
 * takes to open again. Run by `run.mjs`.
 */
import { createNode } from '../../../src/node/node.js';
import type { P2PNode } from '../../../src/node/types.js';
import { createIdentityManager } from '../../../src/identity/identity-manager.js';
import { createLocalRootSigner, type RootSigner } from '../../../src/identity/root-signer.js';
import { generateSeed } from '../../../src/identity/recovery-code.js';
import { indexedDBStores } from '../../../src/node/stores.js';
import { team } from '../../../src/space/presets.js';
import type { StorageAdapter } from '../../../src/types.js';

const params = new URLSearchParams(location.search);
const N = Number(params.get('n') ?? 1024);
const log = (line: string) => console.log(line);

let calls = 0;
const byName: Record<string, number> = {};
/** Time spent waiting on each store method, ms */
const inStore: Record<string, number> = {};
const inner = indexedDBStores(`bench-${Date.now()}`);
const stores = async (path: string): Promise<StorageAdapter> => {
  const adapter = await inner(path);
  return Object.fromEntries(
    Object.entries(adapter).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        calls++;
        byName[name] = (byName[name] ?? 0) + 1;
        const t = performance.now();
        try {
          return await (fn as (...a: unknown[]) => unknown)(...args);
        } finally {
          inStore[name] = (inStore[name] ?? 0) + performance.now() - t;
        }
      },
    ]),
  ) as unknown as StorageAdapter;
};

async function measure(what: string, run: () => Promise<unknown>, per = N) {
  calls = 0;
  for (const k in byName) delete byName[k];
  for (const k in inStore) delete inStore[k];
  const t = performance.now();
  await run();
  const ms = performance.now() - t;
  log(`${what}: ${ms.toFixed(0)}ms (${(ms / per).toFixed(2)}ms each), ${calls} store calls ${JSON.stringify(byName)}, waiting ${JSON.stringify(Object.fromEntries(Object.entries(inStore).map(([k, v]) => [k, Math.round(v)])))}ms`);
}

const open = (signer: RootSigner): Promise<P2PNode> => createNode({ signer, stores, watchIntervalMs: 0 });

async function main() {
  const manager = createIdentityManager();
  const signer = createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider());
  let node = await open(signer);
  const { id: space } = await node.spaces.create({ name: 'Canvas', ...team, visibility: 'private' });
  await node.collections.define(space, {
    name: 'app.pixels.cell',
    schema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, color: { type: 'string' } }, required: ['x', 'y', 'color'] },
    rules: { create: 'member', edit: 'member', delete: 'member', fixed: ['x', 'y'] },
  } as never);
  const key = (i: number) => `px.${i % 32}.${Math.floor(i / 32)}`;
  const body = (i: number, color: string) => ({ x: i % 32, y: Math.floor(i / 32), color });
  const list = () => node.records.list(space, { collection: 'app.pixels.cell' });

  await measure('put, one at a time', async () => {
    for (let i = 0; i < N; i++) await node.records.put(space, 'app.pixels.cell', body(i, '#ff004d'), { key: key(i) });
  });
  await measure('list', list, 1);
  await measure('list again', list, 1);

  await node.close();
  node = await open(signer);
  await measure('list, after opening again', list, 1);

  await measure('delete, 16 at a time', async () => {
    for (let i = 0; i < N; i += 16) {
      await Promise.all(Array.from({ length: Math.min(16, N - i) }, (_, j) => node.records.delete(space, key(i + j))));
    }
  });
  for (let i = 0; i < N; i++) await node.records.put(space, 'app.pixels.cell', body(i, '#29adff'), { key: key(i) });
  await measure('list of a full canvas, warm', list, 1);
  await measure('delete, 16 at a time, a list after each 16', async () => {
    for (let i = 0; i < N; i += 16) {
      await Promise.all(Array.from({ length: Math.min(16, N - i) }, (_, j) => node.records.delete(space, key(i + j))));
      await list();
    }
  });
  await node.close();
  log('done');
}

main().catch((error) => log(`failed: ${error?.stack ?? error}`));
