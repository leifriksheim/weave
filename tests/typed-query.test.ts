/**
 * Queries typed from the collections they name. The type assertions are the
 * point: this file is also checked with tsc (see the note at the bottom).
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';

import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { collection } from '../src/schema/collection-def.js';
import type { Typed } from '../src/query/types.js';
import { poll as stdPoll, vote as stdVote, useSchemas } from '../src/schemas/index.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function person() {
  const manager = createIdentityManager();
  const me = await manager.fromSeed(generateSeed());
  const node = await createNode({ signer: createLocalRootSigner(me, manager.getProvider()), stores: memoryStores(), watchIntervalMs: 0 });
  open.push(node);
  return node;
}

const Poll = z.object({ question: z.string().min(1), options: z.array(z.string().min(1)).min(2) });
const Vote = z.object({ choice: z.int().min(0) });
const polls = collection({ name: 'app.poll', schema: Poll, rules: { edit: 'creator', fixed: ['options'] } });
const votes = collection({
  name: 'app.poll.vote',
  schema: Vote,
  links: { about: { to: ['app.poll'], cardinality: 'one' } },
  rules: { edit: 'creator', onePer: ['@author', 'link:about'] },
});

describe('typed queries', () => {
  test('records and what they include come back typed, from the definitions', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    await me.collections.define(space, polls);
    await me.collections.define(space, votes);

    const asked = await me.records.put(space, polls, { question: 'Where?', options: ['Oslo', 'Lisbon'] });
    // @ts-expect-error — a poll needs its options
    await assert.rejects(me.records.put(space, polls, { question: 'Where?' }));
    await me.records.put(space, votes, { choice: 1 }, { links: [{ rel: 'about', to: asked.key }] });

    const { records } = await me.records.query(space, {
      collection: polls,
      include: {
        votes: { rel: 'about', from: votes },
        voters: { rel: 'about', from: votes, count: true },
      },
    });
    const [first] = records;
    assert.ok(first);
    // No null check, no cast: a query returns only what this device can read.
    const question: string = first.body.question;
    const choices: number[] = first.included.votes.map((v) => v.body.choice);
    const voters: number = first.included.voters;
    assert.equal(question, 'Where?');
    assert.deepEqual(choices, [1]);
    assert.equal(voters, 1);
    // @ts-expect-error — no such include
    void first.included.likes;
    // @ts-expect-error — a count is a number, not a list
    void first.included.voters.map;
  });

  test('the standard schemas are typed too, and a bare name still works, untyped', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    await useSchemas(me, space, [stdPoll, stdVote]);
    const asked = await me.records.put(space, stdPoll, { question: 'Lunch?', options: ['Pizza', 'Tacos'] });
    await me.records.put(space, stdVote, { choice: 0 }, { links: [{ rel: 'about', to: asked.key }] });

    const typed = await me.records.query(space, { collection: stdPoll, include: { votes: { rel: 'about', from: stdVote } } });
    const options: ReadonlyArray<string> = typed.records[0]!.body.options;
    const choice: number = typed.records[0]!.included.votes[0]!.body.choice;
    assert.deepEqual([options, choice], [['Pizza', 'Tacos'], 0]);

    const loose = await me.records.query(space, { collection: 'std.poll' });
    const body: unknown = loose.records[0]!.body;
    assert.ok(body);

    const named: Typed<{ question: string }> = { name: 'std.poll' };
    const viaName = await me.records.query(space, { collection: named });
    assert.equal(viaName.records[0]!.body.question, 'Lunch?');
  });

  test('a record this device cannot open is left out, instead of coming back empty', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    await me.collections.define(space, polls);
    await me.records.put(space, polls, { question: 'Where?', options: ['Oslo', 'Lisbon'] });
    const { records } = await me.records.query(space, { collection: polls });
    assert.ok(records.every((r) => r.body !== null));
  });
});

// Checked with: npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck tests/typed-query.test.ts
