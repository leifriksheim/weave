/**
 * Where the time goes when a space with N records is opened again and
 * listed: a CPU profile of just that, written to $PROF_OUT/open.cpuprofile.
 *
 *   PROF_OUT=<dir> npx tsx tests/bench/open-prof.ts [N]
 */
import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { createNode } from '../../src/node/node.js';
import { createIdentityManager } from '../../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../src/identity/root-signer.js';
import { generateSeed } from '../../src/identity/recovery-code.js';
import { team } from '../../src/space/presets.js';
import { memoryStores } from '../helpers/memory-stores.js';

const N = Number(process.argv[2] ?? 1024);
const manager = createIdentityManager();
const signer = createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider());
const stores = memoryStores();
let node = await createNode({ signer, stores, watchIntervalMs: 0 });
const { id: space } = await node.spaces.create({ name: 'Canvas', ...team, visibility: 'private' });
await node.collections.define(space, {
  name: 'app.pixels.cell',
  schema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, color: { type: 'string' } }, required: ['x', 'y', 'color'] },
  rules: { create: 'member', edit: 'member', delete: 'member', fixed: ['x', 'y'] },
} as never);
for (let i = 0; i < N; i++) {
  await node.records.put(space, 'app.pixels.cell', { x: i % 32, y: Math.floor(i / 32), color: '#ff004d' }, { key: `px.${i % 32}.${Math.floor(i / 32)}` });
}
await node.close();

const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.start');
const t = performance.now();
node = await createNode({ signer, stores, watchIntervalMs: 0 });
await node.records.list(space, { collection: 'app.pixels.cell' });
console.log(`open and list ${N}: ${(performance.now() - t).toFixed(0)}ms`);
const { profile } = await session.post('Profiler.stop');
if (process.env.PROF_OUT) writeFileSync(`${process.env.PROF_OUT}/open.cpuprofile`, JSON.stringify(profile));
await node.close();
process.exit(0);
