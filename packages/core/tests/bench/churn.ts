/**
 * The cost of churn: Alice creates 100 records and edits each E times; Bob
 * joins, and the time until his list matches hers is measured.
 *
 *   npx tsx --conditions=@weaveprotocol/source tests/bench/churn.ts [E]
 */
import { team } from '../../src/space/presets.js';
import { createFakeHub } from '../helpers/fake-transport.js';
import { hold } from '../helpers/hold.js';
import { joined } from '../helpers/joined.js';
import { person, ms } from './common.js';

const E = Number(process.argv[2] ?? 10);
const RECORDS = 100;
const hub = createFakeHub({ latencyMs: 1 });
const alice = await person(hub);
const { id: space } = await alice.spaces.create({ name: 'Board', ...team, visibility: 'private' });
await hold(alice, space);
await alice.collections.define(space, {
  name: 'app.card',
  schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
  rules: { create: 'member', edit: 'member', delete: 'member' },
});
const keys: string[] = [];
for (let i = 0; i < RECORDS; i++) keys.push((await alice.records.put(space, 'app.card', { n: 0 })).key);
for (let e = 1; e <= E; e++) for (const key of keys) await alice.records.update(space, key, { n: e });
/** Every record's edits added up: equal only once each record's newest version is here */
const total = async (node: typeof alice) =>
  (await node.records.list<{ n: number }>(space, { collection: 'app.card' })).reduce(
    (sum, record) => sum + (record.body?.n ?? 0) + 1,
    0,
  );
const expected = await total(alice);

const bob = await person(hub);
const t = performance.now();
await bob.spaces.join(await alice.spaces.invite(space));
await hold(bob, space);
await joined(bob, space, 300_000);
while ((await total(bob)) !== expected) {
  if (performance.now() - t > 300_000) throw new Error('never settled');
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const versions = RECORDS * (E + 1);
console.log(
  `${RECORDS} records × ${E} edits (${versions} versions): settled in ${ms(performance.now() - t)}`,
);
await Promise.all([alice.close(), bob.close()]);
process.exit(0);
