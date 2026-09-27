/**
 * The standard nouns, and the positions that keep a hand-made order.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { column, task, message, poll, vote, standardNouns, positionBetween, useSchemas } from '../src/schemas/index.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';
import * as z from 'zod';

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

describe('positionBetween', () => {
  test('lands strictly between its neighbours, at either end, and never ends in 0', () => {
    const first = positionBetween();
    assert.ok(positionBetween(null, first) < first);
    assert.ok(positionBetween(first) > first);
    assert.equal(positionBetween('1', '2'), '1i');
    assert.ok(!positionBetween(null, '1').endsWith('0'));
  });

  test('keeps finding room: a thousand random inserts stay in order', () => {
    const list = [positionBetween()];
    for (let n = 0; n < 1000; n++) {
      const at = Math.floor(Math.random() * (list.length + 1));
      const made = positionBetween(list[at - 1], list[at]);
      if (at > 0) assert.ok(made > list[at - 1]!, `${made} after ${list[at - 1]}`);
      if (at < list.length) assert.ok(made < list[at]!, `${made} before ${list[at]}`);
      assert.ok(!made.endsWith('0'));
      list.splice(at, 0, made);
    }
    assert.deepEqual([...list].sort(), list);
  });

  test('pushing to one end keeps positions short', () => {
    let last = positionBetween();
    for (let n = 0; n < 200; n++) last = positionBetween(last);
    assert.ok(last.length <= 13, last); // one more character every 18 or so
  });

  test('equal or backwards neighbours still give something after the first', () => {
    assert.ok(positionBetween('m', 'm') > 'm');
    assert.ok(positionBetween('m', 'c') > 'm');
  });
});

describe('standard nouns', () => {
  test('a board: columns in order, tasks linked to their column', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Board', ...team, visibility: 'private' });
    await useSchemas(me, space, standardNouns);
    const names = (await me.collections.list(space)).map((c) => c.name);
    for (const s of [message, column, task]) assert.ok(names.includes(s.name));

    const todo = await me.records.put(space, column.name, { name: 'To do', position: positionBetween() });
    const card = await me.records.put(space, task.name, { title: 'Pack', position: positionBetween() }, { links: [{ rel: 'column', to: todo.key }] });
    assert.ok(card.verified);
    const inTodo = await me.records.linked(space, todo.key, { rel: 'column' });
    assert.deepEqual(inTodo.map((r) => r.key), [card.key]);

    await me.records.put(space, task.name, { title: 'Made elsewhere, no position' });
    await assert.rejects(me.records.put(space, task.name, { position: 'i' }));
  });

  test('a poll: one vote per person, changed by voting again; options stay as asked', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    await useSchemas(me, space, [poll, vote]);
    const where = await me.records.put(space, poll.name, { question: 'Where?', options: ['Oslo', 'Lisbon'] });
    const on = [{ rel: 'about', to: where.key }];

    const first = await me.records.put(space, vote.name, { choice: 0 }, { links: on });
    const again = await me.records.put(space, vote.name, { choice: 1 }, { links: on });
    assert.equal(again.key, first.key);
    const votes = await me.records.linked<{ choice: number }>(space, where.key, { collection: vote.name });
    assert.deepEqual(votes.map((v) => v.body?.choice), [1]);

    await me.records.update(space, where.key, { question: 'Where?', options: ['Oslo', 'Lisbon'], closed: true });
    await assert.rejects(me.records.update(space, where.key, { question: 'Where?', options: ['Rome', 'Lisbon'] }));
  });
});

describe('schemas from a validator you already use', () => {
  // The same poll the landing page builds, step by step.
  const Poll = z.object({
    question: z.string().min(1).max(500),
    options: z.array(z.string().min(1)).min(2).max(10),
  });
  const Vote = z.object({
    choice: z.int().min(0).meta({ 'x-choicesFrom': { rel: 'about', field: 'options' } }),
  });

  test('a Zod schema is stored as JSON Schema, and every write is checked against it', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    const defined = await me.collections.define(space, { name: 'app.poll', schema: Poll, rules: { edit: 'creator', fixed: ['options'] } });
    await me.collections.define(space, {
      name: 'app.poll.vote',
      schema: Vote,
      links: { about: { to: ['app.poll'], cardinality: 'one' } },
      rules: { edit: 'creator', onePer: ['@author', 'link:about'] },
    });

    // Plain data, readable by any app in any language — no trace of Zod.
    assert.deepEqual(defined.schema, JSON.parse(JSON.stringify(defined.schema)));
    assert.equal((defined.schema as Record<string, unknown>).$schema, undefined);
    assert.deepEqual(((defined.schema as any).properties.options), { minItems: 2, maxItems: 10, type: 'array', items: { type: 'string', minLength: 1 } });

    const poll = await me.records.put(space, 'app.poll', { question: 'Where?', options: ['Oslo', 'Lisbon'] });
    await assert.rejects(me.records.put(space, 'app.poll', { question: 'Where?', options: ['Oslo'] }), /options/);
    await me.records.put(space, 'app.poll.vote', { choice: 1 }, { links: [{ rel: 'about', to: poll.key }] });
    await assert.rejects(me.records.put(space, 'app.poll.vote', { choice: -1 }, { links: [{ rel: 'about', to: poll.key }] }));
  });

  test('what a space cannot store is refused up front, saying what it can', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    await assert.rejects(
      me.collections.define(space, { name: 'app.contact', schema: z.object({ email: z.email() }) }),
      /schema\.properties\.email\.(format|pattern) is not supported/,
    );
  });
});

