/**
 * sys.view: a query and a layout, written as a record, that any app can render.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { runAction } from '../src/node/actions.js';
import type { P2PNode } from '../src/node/types.js';
import { checkView, type View } from '../src/records/views.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';

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

const openTodos: View = {
  title: 'Still to do',
  query: {
    collection: 'app.todo.item',
    where: { completed: false },
    sort: { order: 'asc' },
    include: { likes: { rel: 'about', from: 'sys.reaction', count: true } },
  },
  layout: 'table',
  fields: [{ field: 'text', label: 'What' }, { field: '@createdAt', label: 'Added' }],
};

describe('checking a view', () => {
  test('its query must run, and a board must say what to group by', () => {
    assert.deepEqual(checkView(openTodos), []);
    assert.match(checkView({ ...openTodos, query: { collection: 'app.x', where: { a: { $regex: '.' } } } })[0]?.message ?? '', /unknown operator/);
    assert.match(checkView({ ...openTodos, layout: 'board' })[0]?.message ?? '', /groupBy/);
    assert.deepEqual(checkView({ ...openTodos, layout: 'board', groupBy: 'completed' }), []);
  });
});

describe('views in a space', () => {
  test('an agent writes one; another person’s app finds it and runs it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.spaces.create({ name: 'Home', type: 'shared', visibility: 'private' });
    await bob.spaces.join(await alice.spaces.invite(space));
    for (const node of [alice, bob]) await node.spaces.open(space);

    const milk = await alice.records.put(space, 'app.todo.item', { text: 'milk', completed: false, order: 1 });
    await alice.records.put(space, 'app.todo.item', { text: 'bread', completed: true, order: 2 });
    await alice.records.put(space, 'sys.reaction', { emoji: '👍' }, { links: [{ rel: 'about', to: milk.key }] });

    // An agent, through the same action a person's app would use.
    const view = (await runAction(alice, 'records_put', { space, collection: 'sys.view', body: openTodos })) as { key: string };

    // Bob's app has never heard of it; it lists the space's views and runs one.
    await until(async () => (await bob.records.query(space, { collection: 'app.todo.item' })).records.length === 2, 3000, 'the todos');
    await until(async () => (await bob.records.get(space, view.key)) !== null, 3000, 'the view');
    await until(async () => (await bob.records.linked(space, milk.key)).length === 1, 3000, 'the reaction');
    const [found] = (await bob.records.query<View>(space, { collection: 'sys.view' })).records;
    assert.equal(found?.body?.title, 'Still to do');
    const shown = await bob.records.query<{ text: string }>(space, found!.body!.query);
    assert.deepEqual(shown.records.map((r) => [r.body?.text, r.included?.likes]), [['milk', 1]]);
  });

  test('a view whose query cannot run is refused on write', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Home', type: 'personal', visibility: 'public' });
    await assert.rejects(
      me.records.put(space, 'sys.view', { ...openTodos, query: { collection: 'app.todo.item', where: { $where: 'true' } } }),
      /not a field/,
    );
    await assert.rejects(me.records.put(space, 'sys.view', { title: 'x', query: { collection: 'a.b' }, layout: 'carousel' }), /layout/);
  });

  test('is listed with the built-in library, so an agent knows the format', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Home', type: 'personal', visibility: 'public' });
    const listed = (await runAction(me, 'collections_list', { space })) as Array<{ name: string; builtIn: boolean; schema: { required: string[] } }>;
    const views = listed.find((c) => c.name === 'sys.view');
    assert.equal(views?.builtIn, true);
    assert.deepEqual(views?.schema.required, ['title', 'query', 'layout']);
  });
});
