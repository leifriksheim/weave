/**
 * How long a join takes to finish — from holding the space to holding a role
 * in it — and whether records show before it does.
 *
 *   npx tsx tests/bench/join-time.ts [runs]
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

const runs = Number(process.argv[2] ?? 10);

async function person(hub: FakeHub): Promise<P2PNode> {
  const manager = createIdentityManager();
  const signer = createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider());
  return createNode({ signer, stores: memoryStores(), watchIntervalMs: 0, network: { transports: (s: string, d: string) => [hub.transport(d, s)] } });
}

const times: number[] = [];
let earlier = 0;
for (let run = 0; run < runs; run++) {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.spaces.create({ name: 'Shared', ...team, visibility: 'private' });
  await bob.spaces.join(await alice.spaces.invite(space));
  const made = await alice.records.put(space, 'app.todo.item', { text: 'milk', done: false });
  const t = performance.now();
  await hold(bob, space);
  let seenFirst = false;
  for (;;) {
    const role = (await bob.spaces.access(space)).role;
    if (role !== null) break;
    if (!seenFirst && (await bob.records.get(space, made.key)) !== null) seenFirst = true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  times.push(performance.now() - t);
  if (seenFirst) earlier++;
  await Promise.all([alice.close(), bob.close()]);
}
times.sort((a, b) => a - b);
console.log(`join finished in ${times[0]!.toFixed(0)}–${times.at(-1)!.toFixed(0)}ms, median ${times[Math.floor(times.length / 2)]!.toFixed(0)}ms; record visible before the join finished in ${earlier} of ${runs}`);
process.exit(0);
