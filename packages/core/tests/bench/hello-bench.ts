/**
 * The cost of a hello between two identical stores of N versions: the first,
 * which builds each store's kept set, and the ones after, which should only
 * read sums kept up as versions land.
 *
 *   npx tsx --conditions=@weaveprotocol/source tests/bench/hello-bench.ts [N]
 */
import { createStorageProvider } from '../../src/storage/storage-provider.js';
import { createSyncEngine, type SyncEngine } from '../../src/sync/sync-engine.js';
import type { Expression } from '../../src/types.js';
import { cidFromBytes } from '../../src/utils/hash.js';
import { createMemoryAdapter } from '../helpers/memory-adapter.js';

const N = Number(process.argv[2] ?? 100_000);

async function fakeExpression(i: number): Promise<Expression> {
  return {
    id: await cidFromBytes(new TextEncoder().encode(`bench:${i}`)),
    author: 'did:key:zBench',
    collection: 'app.bench',
    createdAt: new Date(1_700_000_000_000 + i).toISOString(),
    body: { i },
    signature: 'sig',
    key: `k${i.toString(36)}`,
    seq: 0,
  };
}

const a = createStorageProvider(createMemoryAdapter());
const b = createStorageProvider(createMemoryAdapter());
let t = performance.now();
for (let i = 0; i < N; i++) {
  const expression = await fakeExpression(i);
  await a.addExpression(expression);
  await b.addExpression(expression);
}
console.log(`fill ${N} × 2: ${(performance.now() - t).toFixed(0)}ms`);

let messages = 0;
const queue: Array<() => Promise<void>> = [];
const engine = (storage: typeof a, self: string, other: () => SyncEngine): SyncEngine =>
  createSyncEngine({
    storageProvider: storage,
    self,
    sendToPeer: (_peer, data) => {
      messages++;
      queue.push(() => other().handleMessage(self, data));
    },
  });
const engineA: SyncEngine = engine(a, 'a', () => engineB);
const engineB: SyncEngine = engine(b, 'b', () => engineA);
engineA.addPeer('b');
engineB.addPeer('a');

async function hello(label: string) {
  messages = 0;
  const started = performance.now();
  engineB.notifyPeers(['a']);
  for (let idle = 0; idle < 3;) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (queue.length === 0) idle++;
    else {
      idle = 0;
      await Promise.all(queue.splice(0).map((deliver) => deliver()));
    }
  }
  console.log(`${label}: ${(performance.now() - started).toFixed(1)}ms, ${messages} message(s)`);
}

t = performance.now();
await a.sums();
await b.sums();
console.log(`first sums() on each store: ${(performance.now() - t).toFixed(0)}ms`);
await hello('hello 1');
await hello('hello 2');
await hello('hello 3');
// One more version on each, as a write that both took in: the sums must follow it, not be rebuilt.
const extra = await fakeExpression(N);
await a.addExpression(extra);
await b.addExpression(extra);
await hello('hello after one more version');
process.exit(0);
