/**
 * The pixel canvas, alone on one node: fill a private 32×32 canvas, list it,
 * clear it the way the app does. Counts store calls — in a browser each is an
 * IndexedDB transaction — and can add a delay to each to feel like one.
 *
 *   npx tsx tests/bench/pixel-bench.ts [N] [ms per store call]
 */
import { createNode } from '../../src/node/node.js';
import { createIdentityManager } from '../../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../src/identity/root-signer.js';
import { generateSeed } from '../../src/identity/recovery-code.js';
import { team } from '../../src/space/presets.js';
import type { StorageAdapter } from '../../src/types.js';
import { createFakeHub } from '../helpers/fake-transport.js';
import { memoryStores } from '../helpers/memory-stores.js';

const N = Number(process.argv[2] ?? 1024);
const DELAY = Number(process.argv[3] ?? 0);

let calls = 0;
const byName: Record<string, number> = {};
const inner = memoryStores();
const stores = async (path: string): Promise<StorageAdapter> => {
  const adapter = await inner(path);
  return Object.fromEntries(
    Object.entries(adapter).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        calls++;
        byName[name] = (byName[name] ?? 0) + 1;
        if (DELAY) await new Promise((resolve) => setTimeout(resolve, DELAY));
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as StorageAdapter;
};

const manager = createIdentityManager();
const signer = createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider());
const hub = createFakeHub();
const node = await createNode({
  signer,
  stores,
  watchIntervalMs: 0,
  network: { transports: (spaceId: string, did: string) => [hub.transport(did, spaceId)] },
});
const { id: space } = await node.spaces.create({ name: 'Canvas', ...team, visibility: 'private' });
await node.collections.define(space, {
  name: 'app.pixels.cell',
  schema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, color: { type: 'string' } }, required: ['x', 'y', 'color'] },
  rules: { create: 'member', edit: 'member', delete: 'member', fixed: ['x', 'y'] },
} as never);

async function measure(what: string, run: () => Promise<unknown>, per = N) {
  calls = 0;
  for (const k in byName) delete byName[k];
  const t = performance.now();
  await run();
  const ms = performance.now() - t;
  console.log(`${what}: ${ms.toFixed(0)}ms (${(ms / per).toFixed(2)}ms each), ${calls} store calls (${(calls / per).toFixed(1)} each)`, JSON.stringify(byName));
}

const key = (i: number) => `px.${i % 32}.${Math.floor(i / 32)}`;
const body = (i: number, color: string) => ({ x: i % 32, y: Math.floor(i / 32), color });
const list = () => node.records.list(space, { collection: 'app.pixels.cell' });

await measure('put', async () => {
  for (let i = 0; i < N; i++) await node.records.put(space, 'app.pixels.cell', body(i, '#ff004d'), { key: key(i) });
});
await measure('list', list, 1);
await measure('list again', list, 1);
await measure('delete, 16 at a time', async () => {
  for (let i = 0; i < N; i += 16) await Promise.all(Array.from({ length: Math.min(16, N - i) }, (_, j) => node.records.delete(space, key(i + j))));
});
for (let i = 0; i < N; i++) await node.records.put(space, 'app.pixels.cell', body(i, '#29adff'), { key: key(i) });
await measure('delete with a list per 16, as the app does', async () => {
  for (let i = 0; i < N; i += 16) {
    await Promise.all(Array.from({ length: Math.min(16, N - i) }, (_, j) => node.records.delete(space, key(i + j))));
    await list();
  }
});
await node.close();
process.exit(0);
