/**
 * The same private space opened by a node on the page and by one in a worker
 * (`startNodeInWorker`): how long opening and listing it takes, and the
 * longest the page's main thread goes without running meanwhile. Run by
 * `run.mjs` with ENTRY=worker-idb.ts.
 */
import { createNode } from '../../../src/node/node.js';
import type { P2PNode } from '../../../src/node/types.js';
import { startNodeInWorker } from '../../../src/node/worker.js';
import { createIdentityManager } from '../../../src/identity/identity-manager.js';
import { createLocalRootSigner, type RootSigner } from '../../../src/identity/root-signer.js';
import { generateSeed } from '../../../src/identity/recovery-code.js';
import { indexedDBStores } from '../../../src/node/stores.js';
import { team } from '../../../src/space/presets.js';

const N = Number(new URLSearchParams(location.search).get('n') ?? 2048);
const log = (line: string) => console.log(line);

/** The longest the main thread went without a turn, while `run` ran */
async function stalls(run: () => Promise<unknown>): Promise<{ ms: number; longest: number }> {
  let longest = 0;
  let last = performance.now();
  let going = true;
  const tick = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (going) setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  const t = performance.now();
  await run();
  const ms = performance.now() - t;
  going = false;
  return { ms, longest };
}

const open = (where: 'page' | 'worker', signer: RootSigner, prefix: string): Promise<P2PNode> =>
  where === 'page'
    ? createNode({ signer, stores: indexedDBStores(prefix), watchIntervalMs: 0 })
    : startNodeInWorker(new Worker('/node-worker.js', { type: 'module' }), {
        signer,
        stores: { indexedDB: prefix },
      });

async function bench(where: 'page' | 'worker') {
  const manager = createIdentityManager();
  const signer = createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider());
  const prefix = `bench-${where}-${Date.now()}`;
  let node = await open(where, signer, prefix);
  const { id: space } = await node.spaces.create({ name: 'Notes', ...team, visibility: 'private' });
  const writing = await stalls(async () => {
    for (let i = 0; i < N; i += 64)
      await Promise.all(
        Array.from({ length: Math.min(64, N - i) }, (_, j) =>
          node.records.put(space, 'app.note', { text: `note ${i + j}`, n: i + j }),
        ),
      );
  });
  await node.close();

  let count = 0;
  const opening = await stalls(async () => {
    node = await open(where, signer, prefix);
    count = (await node.records.list(space, { collection: 'app.note' })).length;
  });
  await node.close();
  log(
    `${where}: write ${N} ${writing.ms.toFixed(0)}ms (longest stall ${writing.longest.toFixed(0)}ms); ` +
      `open and list ${count} ${opening.ms.toFixed(0)}ms (longest stall ${opening.longest.toFixed(0)}ms)`,
  );
}

try {
  await bench('page');
  await bench('worker');
  log('done');
} catch (error) {
  log(`failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
}

// A module, for the top-level await.
export {};
