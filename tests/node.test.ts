/**
 * Node tests — the API every front end sits on: spaces, records, deletes that
 * stay deleted, and two nodes converging over a transport.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { NODE_ACTIONS, runAction } from '../src/node/actions.js';
import type { P2PNode, NodeRecord } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import type { StandardSchemaV1 } from '../src/types.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';
import { joined } from './helpers/joined.js';
import { hold, letGo } from './helpers/hold.js';

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
  const node = await createNode({
    signer,
    stores: memoryStores(),
    collections: [{ name: 'app.todo.item', schema: todoSchema as StandardSchemaV1 }],
    watchIntervalMs: 0,
    ...(options.ttl ? { sessionTtlSeconds: options.ttl } : {}),
    ...(options.hub
      ? { network: { transports: (spaceId: string, sessionDid: string) => [options.hub!.transport(sessionDid, spaceId)] } }
      : {}),
  });
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
    const created = await node.spaces.create({ name: 'Groceries', ...team, visibility: 'private' });

    assert.equal(created.creator, node.did);
    assert.equal(created.role, 'owner');
    assert.equal(created.readable, true);
    const listed = await node.spaces.list();
    assert.deepEqual(listed.map((s) => s.name), ['Groceries']);
    assert.equal(JSON.stringify(listed).includes('key"'), false);
  });

  test('an invite previews, and joining a private space brings its key', async () => {
    const alice = await startNode();
    const bob = await startNode();
    const space = await alice.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
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
    const { id: space } = await node.spaces.create({ name: 'Todos', visibility: 'public' });

    const first = await node.records.put<Todo>(space, 'app.todo.item', { text: 'milk', done: false });
    const second = await node.records.put<Todo>(space, 'app.todo.item', { text: 'eggs', done: false });

    assert.equal(first.verified, true);
    assert.equal(first.root, node.did);
    assert.deepEqual((await node.records.get<Todo>(space, first.key))?.body, { text: 'milk', done: false });
    const listed = await node.records.list<Todo>(space);
    assert.deepEqual(listed.map((r) => r.key), [first.key, second.key]);
    assert.deepEqual((await node.records.list(space, { newestFirst: true, limit: 1 })).map((r) => r.key), [second.key]);
  });

  test('a known collection refuses a malformed body; an unknown one takes anything', async () => {
    const node = await startNode();
    const { id: space } = await node.spaces.create({ name: 'Todos', visibility: 'public' });

    await assert.rejects(node.records.put(space, 'app.todo.item', { text: 42 }), /needs text and done/);
    const free = await node.records.put(space, 'app.agent.idea', { anything: ['goes'] });
    assert.equal(free.verified, true);
  });

  test('a private space stores ciphertext and reads back plaintext', async () => {
    const node = await startNode();
    const { id: space } = await node.spaces.create({ name: 'Diary', visibility: 'private' });

    const written = await node.records.put<Todo>(space, 'app.todo.item', { text: 'secret', done: false });
    assert.equal(written.encrypted, true);
    assert.deepEqual(written.body, { text: 'secret', done: false });
  });

  test('update writes the next version, delete hides the record', async () => {
    const node = await startNode();
    const { id: space } = await node.spaces.create({ name: 'Todos', visibility: 'public' });

    const original = await node.records.put<Todo>(space, 'app.todo.item', { text: 'milk', done: false });
    const updated = await node.records.update<Todo>(space, original.key, { text: 'milk', done: true });
    assert.equal(updated.key, original.key);
    assert.equal(updated.seq, 1);
    assert.deepEqual((await node.records.get<Todo>(space, original.key))?.body, { text: 'milk', done: true });

    await node.records.delete(space, updated.key);
    assert.deepEqual(await node.records.list(space), []);
    assert.deepEqual(await node.records.list(space, { collection: 'app.todo.item' }), []);
    await assert.rejects(node.records.put(space, 'sys.collection', {}), /written by the node itself/);
  });

  test('events announce local writes', async () => {
    const node = await startNode();
    const { id: space } = await node.spaces.create({ name: 'Todos', visibility: 'public' });
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
    const space = await alice.spaces.create({ name: 'Shared', ...team, visibility: 'private' });
    await bob.spaces.join(await alice.spaces.invite(space.id));
    await hold(alice, space.id);
    await hold(bob, space.id);
    await joined(bob, space.id);
    const converged = async () =>
      (await alice.spaces.status(space.id)).root === (await bob.spaces.status(space.id)).root;
    return { alice, bob, space: space.id, converged };
  }

  test('a record written on one reaches the other, readable', async () => {
    const { alice, bob, space, converged } = await pair();
    const written = await alice.records.put<Todo>(space, 'app.todo.item', { text: 'from alice', done: false });

    await until(async () => (await bob.records.get(space, written.key)) !== null, 3000, 'record to reach bob');
    const seen = (await bob.records.get<Todo>(space, written.key)) as NodeRecord<Todo>;
    assert.deepEqual(seen.body, { text: 'from alice', done: false });
    assert.equal(seen.root, alice.did);
    assert.equal(seen.verified, true);
    await until(converged, 3000, 'roots to match');
  });

  test('a delete stays deleted after sync instead of coming back', async () => {
    const { alice, bob, space, converged } = await pair();
    const written = await alice.records.put<Todo>(space, 'app.todo.item', { text: 'soon gone', done: false });
    await until(async () => (await bob.records.get(space, written.key)) !== null, 3000, 'record to reach bob');

    await alice.records.delete(space, written.key);
    await until(async () => (await bob.records.get(space, written.key)) === null, 3000, 'delete to reach bob');
    await until(converged, 3000, 'roots to match');

    // Reconcile again: the record must not be resurrected on either side.
    await letGo(alice, space);
    await hold(alice, space);
    await until(converged, 3000, 'roots to match after reopening');
    assert.equal(await alice.records.get(space, written.key), null);
    assert.equal(await bob.records.get(space, written.key), null);
  });

  test("in a shared space, members tick and delete each other's items", async () => {
    const { alice, bob, space, converged } = await pair();
    const written = await alice.records.put<Todo>(space, 'app.todo.item', { text: "alice's", done: false });
    await until(async () => (await bob.records.get(space, written.key)) !== null, 3000, 'record to reach bob');

    // Bob ticks Alice's item: the old version goes away for both, one ticked copy remains.
    const ticked = await bob.records.update<Todo>(space, written.key, { text: "alice's", done: true });
    assert.equal(ticked.key, written.key);
    await until(async () => (await alice.records.get<Todo>(space, written.key))?.body?.done === true, 3000, 'alice to see it ticked');
    await until(converged, 3000, 'roots to match');
    const seen = await alice.records.list<Todo>(space);
    assert.deepEqual(seen.map((r) => [r.key, r.body?.done]), [[written.key, true]]);

    await alice.records.delete(space, ticked.key);
    await until(async () => (await bob.records.list(space)).length === 0, 3000, 'the delete to reach bob');
  });

  test('someone following a space without a role can read it but not change it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const owner = await startNode({ hub });
    const follower = await startNode({ hub });
    const space = await owner.spaces.create({ name: 'Mine', visibility: 'private' });
    const written = await owner.records.put<Todo>(space.id, 'app.todo.item', { text: 'only I edit this', done: false });

    const joined = await follower.spaces.join(await owner.spaces.invite(space.id));
    assert.equal(joined.writable, false);
    assert.equal((await owner.spaces.get(space.id))?.writable, true);
    await hold(owner, space.id);
    await hold(follower, space.id);
    await until(async () => (await follower.records.get(space.id, written.key)) !== null, 3000, 'the follower to read it');

    await assert.rejects(follower.records.update(space.id, written.key, { text: 'x', done: true }), /shared with you to view/);
    await assert.rejects(follower.records.put(space.id, 'app.todo.item', { text: 'y', done: false }), /shared with you to view/);
    await assert.rejects(follower.records.delete(space.id, written.key), /shared with you to view/);
  });
});

describe('the account registry', () => {
  /** A device of one account: same seed, its own store, on a shared hub. */
  async function device(seed: Uint8Array, hub: FakeHub, stores = memoryStores()) {
    const signer = await rootSigner(seed);
    const node = await createNode({
      signer,
      stores,
      accountKey: await deriveVaultKeyBytes(seed),
      watchIntervalMs: 0,
      network: { transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)] },
    });
    open.push(node);
    return node;
  }

  const names = async (node: P2PNode) => (await node.spaces.list()).map((space) => space.name).sort();

  test('a space made on one device appears on the others by itself, readable', async () => {
    const seed = generateSeed();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(seed, hub);
    const phone = await device(seed, hub);

    const space = await laptop.spaces.create({ name: 'Diary', visibility: 'private' });
    const written = await laptop.records.put(space.id, 'app.note', { text: 'dear diary' });

    await until(async () => (await names(phone)).includes('Diary'), 3000, 'the phone to join');
    await until(async () => (await phone.records.get(space.id, written.key)) !== null, 3000, 'the note to reach the phone');
    assert.deepEqual((await phone.records.get<{ text: string }>(space.id, written.key))?.body, { text: 'dear diary' });
    // The registry itself never shows up as a space.
    assert.deepEqual(await names(laptop), ['Diary']);
  });

  test('leaving on one device leaves on all of them', async () => {
    const seed = generateSeed();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(seed, hub);
    const phone = await device(seed, hub);
    const space = await laptop.spaces.create({ name: 'Old project', visibility: 'public' });
    await until(async () => (await names(phone)).includes('Old project'), 3000, 'the phone to join');

    await phone.spaces.leave(space.id);
    await until(async () => (await names(laptop)).length === 0, 3000, 'the laptop to leave');
  });

  test('a device that was offline catches up when it comes back', async () => {
    const seed = generateSeed();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(seed, hub);
    await laptop.spaces.create({ name: 'While you were away', ...team, visibility: 'private' });

    const phone = await device(seed, hub);
    await until(async () => (await names(phone)).includes('While you were away'), 3000, 'the phone to catch up');
  });

  test('spaces from before the registry are recorded, so other devices follow', async () => {
    const seed = generateSeed();
    const hub = createFakeHub({ latencyMs: 1 });
    const stores = memoryStores();

    // An older node, with no account key: its space is its own.
    const signer = await rootSigner(seed);
    const before = await createNode({ signer, stores, watchIntervalMs: 0 });
    await before.spaces.create({ name: 'Legacy', visibility: 'private' });
    await before.close();

    await device(seed, hub, stores); // the same store, now with the account key
    const phone = await device(seed, hub);
    await until(async () => (await names(phone)).includes('Legacy'), 3000, 'the phone to learn of it');
  });

  test('a different account cannot find the registry, let alone read it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const mine = await device(generateSeed(), hub);
    const theirs = await device(generateSeed(), hub);
    await mine.spaces.create({ name: 'Mine', visibility: 'private' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(await names(theirs), []);
  });
});

describe('session', () => {
  test('the delegation is renewed before it expires', async () => {
    // Expiry is whole seconds, so a delegation for 2 s expires between 1 and 2 s
    // from now, and its renewal (at 1.5 s) lasts until at least 2.5 s. Writing at
    // 2.2 s is past the first and inside the second, whenever the test starts.
    const node = await startNode({ ttl: 2 });
    const { id: space } = await node.spaces.create({ name: 'Todos', visibility: 'public' });
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const written = await node.records.put(space, 'app.todo.item', { text: 'late', done: false });
    assert.equal(written.verified, true);
  });

  test('records outlive the session that wrote them', async () => {
    const signer = await rootSigner();
    const stores = memoryStores();
    const first = await createNode({ signer, stores, sessionTtlSeconds: 1, watchIntervalMs: 0 });
    const { id: space } = await first.spaces.create({ name: 'Old', visibility: 'public' });
    const written = await first.records.put(space, 'app.note', { text: 'from an old session' });
    await first.close();

    // The delegation that authorised it has expired. A fresh node must still
    // accept it, or no peer could ever sync data older than an hour.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const later = await createNode({ signer, stores, watchIntervalMs: 0 });
    open.push(later);
    const seen = await later.records.get(space, written.key);
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
    const space = (await runAction(node, 'spaces_create', { name: 'Via actions', visibility: 'public' })) as { id: string };
    await runAction(node, 'records_put', { space: space.id, collection: 'app.note', body: { text: 'hi' } });
    const records = await runAction(node, 'records_list', { space: space.id });

    assert.deepEqual(JSON.parse(JSON.stringify(records)), records);
    await assert.rejects(runAction(node, 'records_put', { space: space.id }), /Missing "collection"/);
    await assert.rejects(runAction(node, 'spaces_create', { name: 'x', roles: 'weird', visibility: 'public' }), /must be one of/);
    await assert.rejects(runAction(node, 'no_such_thing'), /Unknown action/);
  });
});
