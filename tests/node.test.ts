/**
 * Node tests — the API every front end sits on: spaces, records, deletes that
 * stay deleted, and two nodes converging over a transport.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { TOMBSTONE_COLLECTION } from '../src/node/space-runtime.js';
import { NODE_ACTIONS, runAction } from '../src/node/actions.js';
import type { P2PNode, NodeRecord } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import type { StandardSchemaV1 } from '../src/types.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function rootSigner(seed = generateSeed()) {
  const manager = createIdentityManager();
  const identity = await manager.fromSeed(seed);
  return createLocalRootSigner(identity, manager.getProvider());
}

interface Todo {
  readonly text: string;
  readonly done: boolean;
}

const todoSchema: StandardSchemaV1<Todo> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value: unknown) =>
      typeof (value as Todo)?.text === 'string' && typeof (value as Todo)?.done === 'boolean'
        ? { value: value as Todo }
        : { issues: [{ message: 'a todo needs text and done' }] },
  },
};

async function startNode(options: { hub?: FakeHub; seed?: Uint8Array; ttl?: number } = {}) {
  const signer = await rootSigner(options.seed);
  let sessionDid = '';
  const node = await createNode({
    signer,
    stores: memoryStores(),
    collections: [{ name: 'app.todo.item', schema: todoSchema as StandardSchemaV1 }],
    watchIntervalMs: 0,
    ...(options.ttl ? { sessionTtlSeconds: options.ttl } : {}),
    ...(options.hub
      ? { network: { transports: () => [options.hub!.transport(`${sessionDid}`)] } }
      : {}),
  });
  sessionDid = node.sessionDid;
  open.push(node);
  return node;
}

async function until(predicate: () => Promise<boolean> | boolean, ms = 3000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('spaces', () => {
  test('create, list, and describe without ever exposing a key', async () => {
    const node = await startNode();
    const created = await node.spaces.create({ name: 'Groceries', type: 'shared', visibility: 'private' });

    assert.equal(created.owner, node.did);
    assert.equal(created.readable, true);
    const listed = await node.spaces.list();
    assert.deepEqual(listed.map((s) => s.name), ['Groceries']);
    assert.equal(JSON.stringify(listed).includes('key"'), false);
  });

  test('an invite previews, and joining a private space brings its key', async () => {
    const alice = await startNode();
    const bob = await startNode();
    const space = await alice.spaces.create({ name: 'Trip', type: 'shared', visibility: 'private' });
    const invite = await alice.spaces.invite(space.id);

    const preview = bob.spaces.preview(invite);
    assert.equal(preview.space.name, 'Trip');
    assert.equal(preview.carriesKey, true);

    const joined = await bob.spaces.join(invite);
    assert.equal(joined.id, space.id);
    assert.equal(joined.readable, true);
  });
});

describe('records', () => {
  test('put, get and list, oldest first', async () => {
    const node = await startNode();
    const { id: space } = await node.spaces.create({ name: 'Todos', type: 'personal', visibility: 'public' });

    const first = await node.records.put<Todo>(space, 'app.todo.item', { text: 'milk', done: false });
    const second = await node.records.put<Todo>(space, 'app.todo.item', { text: 'eggs', done: false });

    assert.equal(first.verified, true);
    assert.equal(first.root, node.did);
    assert.deepEqual((await node.records.get<Todo>(space, first.id))?.body, { text: 'milk', done: false });
    const listed = await node.records.list<Todo>(space);
    assert.deepEqual(listed.map((r) => r.id), [first.id, second.id]);
    assert.deepEqual((await node.records.list(space, { newestFirst: true, limit: 1 })).map((r) => r.id), [second.id]);
  });

  test('a known collection refuses a malformed body; an unknown one takes anything', async () => {
    const node = await startNode();
    const { id: space } = await node.spaces.create({ name: 'Todos', type: 'personal', visibility: 'public' });

    await assert.rejects(node.records.put(space, 'app.todo.item', { text: 42 }), /needs text and done/);
    const free = await node.records.put(space, 'app.agent.idea', { anything: ['goes'] });
    assert.equal(free.verified, true);
  });

  test('a private space stores ciphertext and reads back plaintext', async () => {
    const node = await startNode();
    const { id: space } = await node.spaces.create({ name: 'Diary', type: 'personal', visibility: 'private' });

    const written = await node.records.put<Todo>(space, 'app.todo.item', { text: 'secret', done: false });
    assert.equal(written.encrypted, true);
    assert.deepEqual(written.body, { text: 'secret', done: false });
  });

  test('update replaces, delete hides, and neither shows tombstones', async () => {
    const node = await startNode();
    const { id: space } = await node.spaces.create({ name: 'Todos', type: 'personal', visibility: 'public' });

    const original = await node.records.put<Todo>(space, 'app.todo.item', { text: 'milk', done: false });
    const updated = await node.records.update<Todo>(space, original.id, { text: 'milk', done: true });
    assert.notEqual(updated.id, original.id);
    assert.equal(await node.records.get(space, original.id), null);

    await node.records.delete(space, updated.id);
    assert.deepEqual(await node.records.list(space), []);
    assert.deepEqual(await node.records.list(space, { collection: 'app.todo.item' }), []);
    await assert.rejects(node.records.put(space, TOMBSTONE_COLLECTION, { target: 'x' }), /Use delete/);
  });

  test('events announce local writes', async () => {
    const node = await startNode();
    const { id: space } = await node.spaces.create({ name: 'Todos', type: 'personal', visibility: 'public' });
    const events: string[] = [];
    node.subscribe((event) => events.push(event.type));

    await node.records.put(space, 'app.todo.item', { text: 'milk', done: false });
    assert.ok(events.includes('records'));
  });
});

describe('two nodes', () => {
  async function pair() {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await startNode({ hub });
    const bob = await startNode({ hub });
    const space = await alice.spaces.create({ name: 'Shared', type: 'shared', visibility: 'private' });
    await bob.spaces.join(await alice.spaces.invite(space.id));
    await alice.spaces.open(space.id);
    await bob.spaces.open(space.id);
    const converged = async () =>
      (await alice.spaces.status(space.id)).root === (await bob.spaces.status(space.id)).root;
    return { alice, bob, space: space.id, converged };
  }

  test('a record written on one reaches the other, readable', async () => {
    const { alice, bob, space, converged } = await pair();
    const written = await alice.records.put<Todo>(space, 'app.todo.item', { text: 'from alice', done: false });

    await until(async () => (await bob.records.get(space, written.id)) !== null, 3000, 'record to reach bob');
    const seen = (await bob.records.get<Todo>(space, written.id)) as NodeRecord<Todo>;
    assert.deepEqual(seen.body, { text: 'from alice', done: false });
    assert.equal(seen.root, alice.did);
    assert.equal(seen.verified, true);
    await until(converged, 3000, 'roots to match');
  });

  test('a delete stays deleted after sync instead of coming back', async () => {
    const { alice, bob, space, converged } = await pair();
    const written = await alice.records.put<Todo>(space, 'app.todo.item', { text: 'soon gone', done: false });
    await until(async () => (await bob.records.get(space, written.id)) !== null, 3000, 'record to reach bob');

    await alice.records.delete(space, written.id);
    await until(async () => (await bob.records.get(space, written.id)) === null, 3000, 'delete to reach bob');
    await until(converged, 3000, 'roots to match');

    // Reconcile again: the record must not be resurrected on either side.
    await alice.spaces.close(space);
    await alice.spaces.open(space);
    await until(converged, 3000, 'roots to match after reopening');
    assert.equal(await alice.records.get(space, written.id), null);
    assert.equal(await bob.records.get(space, written.id), null);
  });

  test("a member cannot delete someone else's record", async () => {
    const { alice, bob, space } = await pair();
    const written = await alice.records.put<Todo>(space, 'app.todo.item', { text: "alice's", done: false });
    await until(async () => (await bob.records.get(space, written.id)) !== null, 3000, 'record to reach bob');

    // Bob is neither the author nor the owner. His tombstone is written and
    // synced, but nobody honours it.
    await bob.records.delete(space, written.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.notEqual(await alice.records.get(space, written.id), null);
    assert.notEqual(await bob.records.get(space, written.id), null);
  });
});

describe('session', () => {
  test('the delegation is renewed before it expires', async () => {
    const node = await startNode({ ttl: 1 });
    const { id: space } = await node.spaces.create({ name: 'Todos', type: 'personal', visibility: 'public' });
    // Past the original expiry: only a renewed delegation still verifies.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const written = await node.records.put(space, 'app.todo.item', { text: 'late', done: false });
    assert.equal(written.verified, true);
  });

  test('records outlive the session that wrote them', async () => {
    const signer = await rootSigner();
    const stores = memoryStores();
    const first = await createNode({ signer, stores, sessionTtlSeconds: 1, watchIntervalMs: 0 });
    const { id: space } = await first.spaces.create({ name: 'Old', type: 'personal', visibility: 'public' });
    const written = await first.records.put(space, 'app.note', { text: 'from an old session' });
    await first.close();

    // The delegation that authorised it has expired. A fresh node must still
    // accept it, or no peer could ever sync data older than an hour.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const later = await createNode({ signer, stores, watchIntervalMs: 0 });
    open.push(later);
    const seen = await later.records.get(space, written.id);
    assert.equal(seen?.verified, true, seen?.reason);
  });
});

describe('actions', () => {
  test('every action has a tool-safe name and an object schema', () => {
    for (const action of NODE_ACTIONS) {
      assert.match(action.name, /^[a-z_]+$/);
      assert.equal(action.input.type, 'object');
      for (const key of action.input.required ?? []) assert.ok(key in action.input.properties, `${action.name}.${key}`);
    }
  });

  test('run by name with checked input, returning plain JSON', async () => {
    const node = await startNode();
    const space = (await runAction(node, 'spaces_create', { name: 'Via actions', type: 'personal', visibility: 'public' })) as { id: string };
    await runAction(node, 'records_put', { space: space.id, collection: 'app.note', body: { text: 'hi' } });
    const records = await runAction(node, 'records_list', { space: space.id });

    assert.deepEqual(JSON.parse(JSON.stringify(records)), records);
    await assert.rejects(runAction(node, 'records_put', { space: space.id }), /Missing "collection"/);
    await assert.rejects(runAction(node, 'spaces_create', { name: 'x', type: 'weird', visibility: 'public' }), /must be one of/);
    await assert.rejects(runAction(node, 'no_such_thing'), /Unknown action/);
  });
});
