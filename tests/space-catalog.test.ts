/**
 * Self-describing spaces: collection definitions stored as data, the subset of
 * JSON Schema they may use, and who may change them.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  asStandardSchema,
  checkPublishableSchema,
  checkStoredCollection,
  validateJsonSchema,
} from '../src/schema/collection-def.js';
import { createNode } from '../src/node/node.js';
import { runAction } from '../src/node/actions.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';
import { joined } from './helpers/joined.js';

const expense = {
  type: 'object',
  properties: {
    what: { type: 'string', minLength: 1 },
    amount: { type: 'number', minimum: 0 },
    currency: { type: 'string', enum: ['EUR', 'NOK'] },
  },
  required: ['what', 'amount'],
};

describe('stored schemas', () => {
  test('validate and reject within the supported subset', () => {
    assert.deepEqual(validateJsonSchema(expense, { what: 'train', amount: 12, currency: 'EUR' }), []);
    const issues = validateJsonSchema(expense, { what: '', amount: -1, currency: 'USD' });
    assert.deepEqual(issues.map((i) => i.path).sort(), ['/amount', '/currency', '/what']);
    assert.equal(validateJsonSchema(expense, { amount: 1 })[0]!.message.includes('"what"'), true);
  });

  test('an unknown keyword is ignored when validating, so newer spaces stay readable', () => {
    assert.deepEqual(validateJsonSchema({ ...expense, 'x-from-the-future': { anything: true } }, { what: 'a', amount: 1 }), []);
  });

  test('but refused when publishing, where the author can fix it', () => {
    assert.match(checkPublishableSchema({ ...expense, pattern: '^a' }) ?? '', /pattern is not supported/);
    assert.match(checkPublishableSchema({ type: 'object', properties: { a: { oneOf: [] } } }) ?? '', /properties\.a\.oneOf/);
    assert.equal(checkPublishableSchema(expense), null);
  });

  test('choices can carry labels, or come from a linked record', () => {
    assert.equal(checkPublishableSchema({ type: 'string', oneOf: [{ const: 'low', title: 'Low' }, { const: 'high', title: 'High' }] }), null);
    assert.match(checkPublishableSchema({ oneOf: [{ type: 'string' }] }) ?? '', /\{ const, title \}/);
    assert.match(checkPublishableSchema({ oneOf: [{ const: 1, type: 'integer' }] }) ?? '', /only for labelled choices/);
    const vote = { type: 'object', properties: { choice: { type: 'integer', 'x-choicesFrom': { rel: 'about', field: 'options' } } } };
    assert.equal(checkPublishableSchema(vote), null);
    assert.match(checkPublishableSchema({ type: 'integer', 'x-choicesFrom': { rel: 'about' } }) ?? '', /x-choicesFrom/);
    // Labelled choices are enforced like enum; x-choicesFrom is a hint and never refuses.
    const level = { type: 'string', oneOf: [{ const: 'low', title: 'Low' }] };
    assert.deepEqual(validateJsonSchema(level, 'low'), []);
    assert.equal(validateJsonSchema(level, 'mid').length > 0, true);
    assert.deepEqual(validateJsonSchema(vote, { choice: 7 }), []);
  });

  test('names are reverse-DNS, and sys.* is reserved', () => {
    assert.equal(checkStoredCollection({ name: 'app.trip.expense', schema: expense, version: 1 }), null);
    assert.match(checkStoredCollection({ name: 'Expense', schema: expense, version: 1 }) ?? '', /reverse-DNS/);
    assert.match(checkStoredCollection({ name: 'sys.anything', schema: expense, version: 1 }) ?? '', /protocol/);
    assert.match(checkStoredCollection({ name: 'app.x.y', schema: expense, version: 0 }) ?? '', /version/);
  });

  test('works as a Standard Schema, so the gates take it unchanged', async () => {
    const standard = asStandardSchema(expense);
    assert.deepEqual(await standard['~standard'].validate({ what: 'a', amount: 1 }), { value: { what: 'a', amount: 1 } });
    const failed = (await standard['~standard'].validate({ what: 'a', amount: 'lots' })) as { issues: Array<{ message: string }> };
    assert.match(failed.issues[0]!.message, /^\/amount:/);
  });
});

describe('a space that describes itself', () => {
  const open: P2PNode[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((node) => node.close()));
  });

  async function person(hub?: FakeHub) {
    const manager = createIdentityManager();
    const me = await manager.fromSeed(generateSeed());
    const node = await createNode({
      signer: createLocalRootSigner(me, manager.getProvider()),
      stores: memoryStores(),
      watchIntervalMs: 0,
      ...(hub ? { network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] } } : {}),
    });
    open.push(node);
    return node;
  }

  async function until(predicate: () => Promise<boolean>, ms = 3000, what = 'condition') {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  test('a definition is listed with its schema, and records written against it are checked', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Trip', ...team, visibility: 'private' });

    const defined = await me.collections.define(space, { name: 'app.trip.expense', title: 'Expense', schema: expense });
    assert.equal(defined.version, 1);
    assert.equal(defined.definedBy, me.did);

    const ok = await me.records.put(space, 'app.trip.expense', { what: 'train', amount: 12 });
    assert.equal(ok.conforms, true);
    await assert.rejects(me.records.put(space, 'app.trip.expense', { what: 'train' }), /Not a valid app\.trip\.expense.*"amount"/);

    await me.records.put(space, 'app.trip.note', { text: 'undescribed' });
    const listed = (await me.collections.list(space));
    assert.deepEqual(
      listed.map((c) => [c.name, c.records, c.version]),
      [['app.trip.expense', 1, 1], ['app.trip.note', 1, null]],
    );
  });

  test('redefining bumps the version, and only the definer or someone who can manage the space may', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const owner = await person(hub);
    const member = await person(hub);
    const outsider = await person(hub);
    const { id: space } = await owner.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    const invite = await owner.spaces.invite(space);
    await member.spaces.join(invite);
    await outsider.spaces.join(invite);
    for (const node of [owner, member, outsider]) await node.spaces.open(space);
    await joined(member, space);
    await joined(outsider, space);

    await member.collections.define(space, { name: 'app.trip.expense', schema: expense });
    const has = (node: P2PNode, version: number) => async () =>
      (await node.collections.list(space)).some((c) => c.name === 'app.trip.expense' && c.version === version);
    await until(has(outsider, 1), 3000, 'the definition to sync');

    // A third member may not redefine someone else's collection...
    await assert.rejects(outsider.collections.define(space, { name: 'app.trip.expense', schema: { type: 'object' } }), /Only whoever defined it, or someone who manages the space, may change it/);
    // ...the definer may, and so may the owner.
    const v2 = await member.collections.define(space, { name: 'app.trip.expense', schema: { ...expense, required: ['what'] } });
    assert.equal(v2.version, 2);
    await until(has(owner, 2), 3000, 'v2 to reach the owner');
    const v3 = await owner.collections.define(space, { name: 'app.trip.expense', schema: expense });
    assert.equal(v3.version, 3);
    await assert.rejects(owner.collections.define(space, { name: 'app.trip.expense', schema: expense, version: 3 }), /higher/);
  });

  test('a record that does not fit is kept and flagged when it arrives, never rejected', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const a = await person(hub);
    const b = await person(hub);
    const { id: space } = await a.spaces.create({ name: 'Trip', ...team, visibility: 'public' });
    await b.spaces.join(await a.spaces.invite(space));
    await a.spaces.open(space);
    await joined(b, space);
    await a.spaces.close(space);

    // B writes before it has seen any definition — valid where it was written.
    await b.spaces.open(space);
    const loose = await b.records.put(space, 'app.trip.expense', { what: 'dinner' });
    await a.collections.define(space, { name: 'app.trip.expense', schema: expense });
    await a.spaces.open(space);

    await until(async () => (await a.records.get(space, loose.key)) !== null, 3000, 'B’s record to reach A');
    const seen = await a.records.get(space, loose.key);
    assert.equal(seen?.verified, true);
    assert.equal(seen?.conforms, false);
    assert.match(seen?.issues?.[0]?.message ?? '', /"amount"/);
    await until(async () => (await a.spaces.status(space)).root === (await b.spaces.status(space)).root, 3000, 'the peers to converge');
  });

  test('an agent can discover and define collections through the actions', async () => {
    const me = await person();
    const space = (await runAction(me, 'spaces_create', { name: 'Friends', roles: 'team', visibility: 'private' })) as { id: string };
    await runAction(me, 'collections_define', {
      space: space.id,
      name: 'app.friends.poll',
      title: 'Poll',
      description: 'A question with fixed answers',
      schema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question', 'options'] },
    });
    const listed = (await runAction(me, 'collections_list', { space: space.id })) as Array<{ name: string; title: string }>;
    assert.deepEqual(listed.map((c) => [c.name, c.title]), [['app.friends.poll', 'Poll']]);
    await assert.rejects(runAction(me, 'records_put', { space: space.id, collection: 'sys.collection', body: {} }), /written by the node itself/);
  });
});
