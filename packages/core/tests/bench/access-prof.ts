/**
 * Where the time goes when adding a member to a space of M: a CPU profile of
 * three adds, written to /tmp/access.cpuprofile (or $PROF_OUT/access.cpuprofile).
 *
 *   npx tsx --conditions=@weaveprotocol/source tests/bench/access-prof.ts [M]
 */
import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { community } from '../../src/space/presets.js';
import { person, someone, time, ms } from './common.js';

const M = Number(process.argv[2] ?? 100);
const alice = await person();
const { id: space } = await alice.spaces.create({ name: 'Club', ...community, visibility: 'private' });
for (let i = 1; i < M; i++) await alice.spaces.setMember(space, await someone(), 'member');
const extra = await Promise.all([someone(), someone(), someone()]);

const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.setSamplingInterval', { interval: 50 });
await session.post('Profiler.start');
for (const did of extra)
  console.log(`add at ${M}: ${ms(await time(() => alice.spaces.setMember(space, did, 'member')))}`);
const { profile } = await session.post('Profiler.stop');
const out = `${process.env.PROF_OUT ?? '/tmp'}/access.cpuprofile`;
writeFileSync(out, JSON.stringify(profile));
console.log(`wrote ${out}`);

// The functions that took the most time themselves.
const self = new Map<string, number>();
const nodes = profile.nodes;
const byId = new Map(nodes.map((node) => [node.id, node]));
const interval = (profile.endTime - profile.startTime) / Math.max(1, profile.samples?.length ?? 1);
for (const sample of profile.samples ?? []) {
  const frame = byId.get(sample)?.callFrame;
  if (!frame) continue;
  const name = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').slice(-2).join('/')}:${frame.lineNumber + 1}`;
  self.set(name, (self.get(name) ?? 0) + interval / 1000);
}
for (const [name, total] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 8))
  console.log(`${ms(total).padStart(10)}  ${name}`);
await alice.close();
process.exit(0);
