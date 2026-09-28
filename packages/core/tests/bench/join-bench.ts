/**
 * Joining a busy canvas: Alice paints N pixels, clears them, paints half
 * again; Bob joins and syncs. Records what Bob's screen would show on every
 * change, and how long it takes to settle.
 *
 *   npx tsx tests/bench/join-bench.ts [N]
 */
import { createNode } from '../../src/node/node.js';
import type { P2PNode } from '../../src/node/types.js';
import { createIdentityManager } from '../../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../src/identity/root-signer.js';
import { generateSeed } from '../../src/identity/recovery-code.js';
import { team } from '../../src/space/presets.js';
import { createFakeHub, type FakeHub } from '../helpers/fake-transport.js';
import { memoryStores } from '../helpers/memory-stores.js';
import { hold } from '../helpers/hold.js';
import { joined } from '../helpers/joined.js';

const N = Number(process.argv[2] ?? 1024);
const hub = createFakeHub({ latencyMs: 1 });

async function person(hub: FakeHub): Promise<P2PNode> {
  const manager = createIdentityManager();
  const signer = createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider());
  return createNode({
    signer,
    stores: memoryStores(),
    watchIntervalMs: 0,
    network: { transports: (s: string, d: string) => [hub.transport(d, s)] },
  });
}

const alice = await person(hub);
const { id: space } = await alice.spaces.create({ name: 'Canvas', ...team, visibility: 'private' });
await hold(alice, space);
await alice.collections.define(space, {
  name: 'app.pixels.cell',
  schema: {
    type: 'object',
    properties: { x: { type: 'integer' }, y: { type: 'integer' }, color: { type: 'string' } },
    required: ['x', 'y', 'color'],
  },
  rules: { create: 'member', edit: 'member', delete: 'member', fixed: ['x', 'y'] },
} as never);
const key = (i: number) => `px.${i % 32}.${Math.floor(i / 32)}`;
const body = (i: number, color: string) => ({ x: i % 32, y: Math.floor(i / 32), color });
for (let i = 0; i < N; i++)
  await alice.records.put(space, 'app.pixels.cell', body(i, '#ff004d'), { key: key(i) });
for (let i = 0; i < N; i++) await alice.records.delete(space, key(i));
for (let i = 0; i < N / 2; i++)
  await alice.records.put(space, 'app.pixels.cell', body(i, '#29adff'), { key: key(i) });
const expected = (await alice.records.list(space, { collection: 'app.pixels.cell' })).length;
console.log(`alice shows ${expected}`);

const bob = await person(hub);
const t = performance.now();
let events = 0;
const seen: number[] = [];
let listing = false;
let again = false;
const look = async () => {
  if (listing) return void (again = true);
  listing = true;
  do {
    again = false;
    seen.push((await bob.records.list(space, { collection: 'app.pixels.cell' })).length);
  } while (again);
  listing = false;
};
bob.subscribe((event) => {
  if (event.type === 'records' && event.space === space) {
    events++;
    void look();
  }
});
await bob.spaces.join(await alice.spaces.invite(space));
await hold(bob, space);
await joined(bob, space, 60_000);
while ((await bob.records.list(space, { collection: 'app.pixels.cell' })).length !== expected || listing) {
  if (performance.now() - t > 300_000) throw new Error('never settled');
  await new Promise((r) => setTimeout(r, 20));
}
const ms = performance.now() - t;
console.log(
  `bob settled at ${expected} in ${ms.toFixed(0)}ms; ${events} change events, ${seen.length} lists; peak shown ${Math.max(...seen)}`,
);
const path = seen.filter((n, i) => i === 0 || n !== seen[i - 1]);
console.log(
  `what bob's screen showed: ${path.length > 40 ? [...path.slice(0, 20), '…', ...path.slice(-20)].join(' → ') : path.join(' → ')}`,
);
await Promise.all([alice.close(), bob.close()]);
process.exit(0);
