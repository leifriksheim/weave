/**
 * The cost of a growing access history: adds M members one by one to a
 * private space, and at checkpoints times adding one more and an ordinary
 * write.
 *
 *   npx tsx --conditions=@weaveprotocol/source tests/bench/access.ts [M]
 */
import { community } from '../../src/space/presets.js';
import { person, someone, time, ms } from './common.js';

const M = Number(process.argv[2] ?? 400);
const checkpoints = new Set([10, 25, 50, 100, 200, 400, 800, 1600].filter((n) => n <= M));

const alice = await person();
const { id: space } = await alice.spaces.create({ name: 'Club', ...community, visibility: 'private' });
await alice.collections.define(space, {
  name: 'app.note',
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  rules: { create: 'member', edit: 'member', delete: 'member' },
});
const dids = await Promise.all(Array.from({ length: M + 1 }, () => someone()));

console.log('members\tadd member\twrite');
let members = 1;
let i = 0;
while (members <= M) {
  if (checkpoints.has(members)) {
    const add = await time(() => alice.spaces.setMember(space, dids[i++]!, 'member'));
    const write = await time(() => alice.records.put(space, 'app.note', { text: `at ${members}` }));
    console.log(`${members}\t${ms(add)}\t${ms(write)}`);
  } else {
    await alice.spaces.setMember(space, dids[i++]!, 'member');
  }
  members++;
}
await alice.close();
process.exit(0);
