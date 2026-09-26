/**
 * Holding part of a space: an app connected to an account holds only the
 * collections it uses once the space names keepers, keeps its own writes
 * until enough keepers have them, and says when a query is complete.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { CacheConfig, P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner, type RootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { team } from '../src/space/presets.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { joined } from './helpers/joined.js';
import { hold, letGo } from './helpers/hold.js';
import type { StoreFactory } from '../src/node/stores.js';

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close().catch(() => {})));
});

interface Person {
  node: P2PNode;
  /** The key its node shows peers — what a space names as a keeper */
  session: () => string;
  stores: StoreFactory;
  signer: RootSigner;
}

async function person(hub: FakeHub, options: { cache?: CacheConfig; stores?: StoreFactory; signer?: RootSigner } = {}): Promise<Person> {
  let signer = options.signer;
  if (!signer) {
    const manager = createIdentityManager();
    signer = createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider());
  }
  const stores = options.stores ?? memoryStores();
  let session = '';
  const node = await createNode({
    signer,
    stores,
    watchIntervalMs: 0,
    ...(options.cache ? { cache: options.cache } : {}),
    network: {
      transports: (spaceId: string, sessionDid: string) => {
        session = sessionDid;
        return [hub.transport(sessionDid, spaceId)];
      },
    },
  });
  open.push(node);
  return { node, session: () => session, stores, signer };
}

async function until(predicate: () => Promise<boolean>, ms = 5000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** How many versions of a collection a node's store holds, looked at directly */
async function held(p: Person, space: string, collection: string): Promise<number> {
  return (await createStorageProvider(await p.stores(`spaces/${space}`)).queryExpressions(collection)).length;
}

/** Alice's space with chat and photos in it, and Bob and Carol in it too, their nodes holding everything */
async function spaceWithKeepers(hub: FakeHub, options: { keepers?: boolean } = {}) {
  const alice = await person(hub);
  const bob = await person(hub);
  const carol = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'public' });
  await hold(alice.node, space);
  for (const name of ['app.chat', 'app.photos']) await alice.node.collections.define(space, { name, schema: { type: 'object' } });
  for (let i = 0; i < 10; i++) {
    await alice.node.records.put(space, 'app.chat', { text: `hello ${i}` });
    await alice.node.records.put(space, 'app.photos', { title: `photo ${i}` });
  }
  for (const keeper of [bob, carol]) {
    await keeper.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(keeper.node, space);
    await joined(keeper.node, space);
  }
  await until(async () => (await held(bob, space, 'app.photos')) === 10 && (await held(carol, space, 'app.photos')) === 10, 5000, 'the keepers to hold it all');
  if (options.keepers !== false) {
    await alice.node.spaces.setKeepers(space, [
      { did: bob.session(), name: 'Bob’s host' },
      { did: carol.session(), name: 'Carol’s extension' },
    ]);
  }
  return { alice, bob, carol, space };
}

async function app(hub: FakeHub, alice: Person, space: string, cache: CacheConfig = {}) {
  const dave = await person(hub, { cache });
  await dave.node.spaces.join(await alice.node.spaces.invite(space));
  await hold(dave.node, space);
  await joined(dave.node, space);
  return dave;
}

describe('holding part of a space', () => {
  test('with keepers named, an app holds only what it uses, and says when a query is complete', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, space } = await spaceWithKeepers(hub);
    assert.deepEqual((await alice.node.spaces.access(space)).keepers.map((k) => k.name), ['Bob’s host', 'Carol’s extension']);

    const dave = await app(hub, alice, space);
    await until(async () => (await dave.node.spaces.status(space)).holds !== 'all', 5000, 'the app to hold part of the space');

    let result = await dave.node.records.query(space, { collection: 'app.chat' });
    await until(async () => (result = await dave.node.records.query(space, { collection: 'app.chat' })).complete, 5000, 'the chat to be complete');
    assert.equal(result.records.length, 10);
    assert.deepEqual((await dave.node.spaces.status(space)).holds, ['app.chat']);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await held(dave, space, 'app.photos'), 0, 'photos were never asked for');

    // Asking for photos brings them.
    await until(async () => (await dave.node.records.query(space, { collection: 'app.photos' })).complete, 5000, 'the photos');
    assert.equal(await held(dave, space, 'app.photos'), 10);
  });

  test('a space that names no keeper is held whole, as before', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, space } = await spaceWithKeepers(hub, { keepers: false });
    const dave = await app(hub, alice, space);
    await until(async () => (await held(dave, space, 'app.photos')) === 10, 5000, 'everything to arrive');
    assert.equal((await dave.node.spaces.status(space)).holds, 'all');
    assert.equal((await dave.node.records.query(space, { collection: 'app.chat' })).complete, true);
  });

  test('an app’s own write stays pending until two keepers have it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, carol, space } = await spaceWithKeepers(hub);
    const dave = await app(hub, alice, space);
    await until(async () => (await dave.node.records.query(space, { collection: 'app.chat' })).complete, 5000, 'the chat');

    // Carol's keeper is away.
    await letGo(carol.node, space);
    await dave.node.records.put(space, 'app.chat', { text: 'from the app' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await dave.node.spaces.status(space)).pending, 1, 'one keeper is not enough');

    await hold(carol.node, space);
    await until(async () => (await dave.node.spaces.status(space)).pending === 0, 5000, 'the second keeper to have it');
  });

  test('a collection nobody used for a while is dropped when the app opens again; declared ones stay', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, space } = await spaceWithKeepers(hub);
    const dave = await app(hub, alice, space, { collections: ['app.chat'] });
    await until(async () => (await dave.node.records.query(space, { collection: 'app.photos' })).complete, 5000, 'the photos');
    await until(async () => (await held(dave, space, 'app.chat')) === 10, 5000, 'the chat');
    assert.equal(await held(dave, space, 'app.photos'), 10);
    await dave.node.close();

    const again = await person(hub, { cache: { collections: ['app.chat'], unusedAfterDays: 0 }, stores: dave.stores, signer: dave.signer });
    await hold(again.node, space);
    await until(async () => (await held(again, space, 'app.photos')) === 0, 5000, 'the photos to be dropped');
    assert.equal(await held(again, space, 'app.chat'), 10, 'declared, so kept');
    assert.deepEqual((await again.node.spaces.status(space)).holds, ['app.chat']);
  });

  test('only someone who manages the space names its keepers', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { bob, space } = await spaceWithKeepers(hub, { keepers: false });
    await assert.rejects(bob.node.spaces.setKeepers(space, [{ did: bob.session(), name: 'mine' }]), /may not change who keeps the space/);
  });
});
