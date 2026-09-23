/**
 * Collection rules: who may create, edit and delete; one per something; fixed
 * fields — enforced on write, and by every peer during sync.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { runAction } from '../src/node/actions.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { checkRules } from '../src/records/rules.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function person(hub: FakeHub) {
  const manager = createIdentityManager();
  const me = await manager.fromSeed(generateSeed());
  const stores = memoryStores();
  const node = await createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    stores,
    watchIntervalMs: 0,
    network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
  });
  open.push(node);
  return { node, me, manager, stores };
}
type Person = Awaited<ReturnType<typeof person>>;

async function until(predicate: () => Promise<boolean>, ms = 4000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Signs a version by hand — what a modified app, or an attacker, could send —
 * and slips it into the writer's own copy of the space, from where it syncs.
 */
async function forge(who: Person, space: string, fields: Parameters<typeof createExpression>[0]) {
  const provider = who.manager.getProvider();
  const pair = await provider.generateKeyPair();
  const keyDid = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  const ucan = await createLocalRootSigner(who.me, provider).delegate({
    audience: keyDid,
    capabilities: [{ with: `space:${space}`, can: 'expression/write' }],
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  const signed = await createSigner(provider).sign(createExpression({ ...fields, author: keyDid, space, proof: ucan.encoded }), pair.privateKey);
  await createStorageProvider(await who.stores(`spaces/${space}`)).addExpression(signed);
  return signed;
}

const pollSchema = { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] };
const voteSchema = { type: 'object', properties: { choice: { type: 'integer' } }, required: ['choice'] };

async function pollSpace(visibility: 'public' | 'private' = 'public') {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Trip', type: 'shared', visibility });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await alice.node.collections.define(space, {
    name: 'app.poll',
    schema: pollSchema,
    rules: { edit: 'creator', delete: ['creator', 'owner'], fixed: ['options'] },
  });
  await alice.node.collections.define(space, {
    name: 'app.poll.vote',
    schema: voteSchema,
    links: { about: { to: ['app.poll'], cardinality: 'one' } },
    rules: { edit: 'creator', onePer: ['@author', 'link:about'] },
  });
  await alice.node.spaces.open(space);
  await bob.node.spaces.open(space);
  await until(async () => (await bob.node.collections.list(space)).filter((c) => c.version !== null).length === 2, 4000, 'definitions to reach Bob');
  return { hub, alice, bob, space };
}

describe('rules: checking a definition', () => {
  test('refuses what it cannot enforce', () => {
    assert.equal(checkRules({ edit: 'creator', onePer: ['@author', 'link:about'], fixed: ['options'] }), null);
    assert.match(checkRules({ edit: 'admin' }) ?? '', /"member", "owner" or "creator"/);
    assert.match(checkRules({ create: 'creator' }) ?? '', /no creator until/);
    assert.match(checkRules({ unique: ['x'] }) ?? '', /not a rule/);
  });
});

describe('rules: who may edit and delete', () => {
  test('only the creator edits; the refusal comes before signing, with the reason', async () => {
    const { alice, bob, space } = await pollSpace();
    const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?', options: ['Oslo', 'Lisbon'] });
    await until(async () => (await bob.node.records.get(space, poll.key)) !== null, 4000, 'the poll');

    assert.equal(await bob.node.records.can(space, 'edit', poll.key), false);
    assert.equal(await alice.node.records.can(space, 'edit', poll.key), true);
    await assert.rejects(bob.node.records.update(space, poll.key, { question: 'Mine now', options: ['Oslo', 'Lisbon'] }), /Only whoever created it can edit/);
    await alice.node.records.update(space, poll.key, { question: 'Where in May?', options: ['Oslo', 'Lisbon'] });
  });

  test('a forged edit is refused by every peer that receives it', async () => {
    const { alice, bob, space } = await pollSpace();
    const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?', options: ['Oslo', 'Lisbon'] });
    await until(async () => (await bob.node.records.get(space, poll.key)) !== null, 4000, 'the poll');

    await bob.node.spaces.close(space);
    await forge(bob, space, {
      author: '',
      collection: 'app.poll',
      body: { question: 'Hijacked', options: ['Oslo', 'Lisbon'] },
      version: { key: poll.key, seq: 7, prev: poll.version, genesis: poll.version },
    });
    let rejected = '';
    alice.node.subscribe((event) => {
      if (event.type === 'rejected') rejected = event.reason;
    });
    await bob.node.spaces.open(space);
    await until(async () => rejected !== '', 4000, 'Alice to refuse it');
    assert.match(rejected, /Only whoever created it can edit/);
    assert.equal((await alice.node.records.get<{ question: string }>(space, poll.key))?.body?.question, 'Where?');
  });

  test('delete follows its own rule: the space owner may delete a member’s poll', async () => {
    const { alice, bob, space } = await pollSpace();
    const poll = await bob.node.records.put(space, 'app.poll', { question: 'Bob’s', options: ['a'] });
    await until(async () => (await alice.node.records.get(space, poll.key)) !== null, 4000, 'Bob’s poll');
    assert.equal(await alice.node.records.can(space, 'edit', poll.key), false);
    assert.equal(await alice.node.records.can(space, 'delete', poll.key), true);
    await alice.node.records.delete(space, poll.key);
    await until(async () => (await bob.node.records.get(space, poll.key)) === null, 4000, 'the delete to reach Bob');
  });

  test('fixed fields keep their first value', async () => {
    const { alice, space } = await pollSpace();
    const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?', options: ['Oslo', 'Lisbon'] });
    await assert.rejects(alice.node.records.update(space, poll.key, { question: 'Where?', options: ['Rome'] }), /"options" is fixed/);
  });

  test('create can be the owner’s alone', async () => {
    const { alice, bob, space } = await pollSpace();
    await alice.node.collections.define(space, { name: 'app.announcement', schema: { type: 'object' }, rules: { create: 'owner' } });
    await until(async () => (await bob.node.collections.list(space)).some((c) => c.name === 'app.announcement'), 4000, 'the definition');
    assert.equal(await bob.node.records.can(space, 'create', 'app.announcement'), false);
    await assert.rejects(bob.node.records.put(space, 'app.announcement', { text: 'hi' }), /Only the space owner can create/);
    await alice.node.records.put(space, 'app.announcement', { text: 'Welcome' });
  });
});

describe('rules: one per something', () => {
  for (const visibility of ['public', 'private'] as const) {
    test(`voting again changes your vote — one per person per poll (${visibility} space)`, async () => {
      const { alice, bob, space } = await pollSpace(visibility);
      const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?', options: ['Oslo', 'Lisbon'] });
      const about = [{ rel: 'about', to: poll.key }];
      const first = await alice.node.records.put(space, 'app.poll.vote', { choice: 0 }, { links: about });
      const again = await alice.node.records.put(space, 'app.poll.vote', { choice: 1 }, { links: about });
      assert.equal(again.key, first.key);
      assert.equal(again.seq, 1);
      await until(async () => (await bob.node.records.get(space, poll.key)) !== null, 4000, 'the poll');
      await bob.node.records.put(space, 'app.poll.vote', { choice: 0 }, { links: about });

      await until(async () => (await alice.node.records.linked(space, poll.key, { collection: 'app.poll.vote' })).length === 2, 4000, 'both votes');
      const votes = await alice.node.records.linked<{ choice: number }>(space, poll.key, { collection: 'app.poll.vote' });
      assert.deepEqual(votes.map((v) => v.body?.choice).sort(), [0, 1]);
    });
  }

  test('a second vote under a made-up key is refused by every peer', async () => {
    const { alice, bob, space } = await pollSpace();
    const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?', options: ['Oslo', 'Lisbon'] });
    await until(async () => (await bob.node.records.get(space, poll.key)) !== null, 4000, 'the poll');
    await bob.node.records.put(space, 'app.poll.vote', { choice: 0 }, { links: [{ rel: 'about', to: poll.key }] });
    const def = (await bob.node.collections.list(space)).find((c) => c.name === 'app.poll.vote');
    assert.deepEqual(def?.rules.onePer, ['@author', 'link:about']);

    // The definition version to pin, as a modified app would.
    const pinned = (await createStorageProvider(await bob.stores(`spaces/${space}`)).getCurrent('collection:app.poll.vote'))!.id;
    await bob.node.spaces.close(space);
    await forge(bob, space, {
      author: '',
      collection: 'app.poll.vote',
      body: { choice: 0 },
      links: [{ rel: 'about', to: poll.key }],
      version: { key: 'stuffing-the-ballot', seq: 0 },
      def: pinned,
    });
    let rejected = '';
    alice.node.subscribe((event) => {
      if (event.type === 'rejected') rejected = event.reason;
    });
    await bob.node.spaces.open(space);
    await until(async () => rejected !== '', 4000, 'Alice to refuse the second vote');
    assert.match(rejected, /one per @author \+ link:about/);
    assert.equal((await alice.node.records.linked(space, poll.key, { collection: 'app.poll.vote' })).length, 1);
  });
});

describe('rules: arriving in any order', () => {
  test('a newcomer gets a record’s edits even though they depend on its first version and its definition', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Trip', type: 'shared', visibility: 'public' });
    await alice.node.collections.define(space, { name: 'app.poll', schema: pollSchema, rules: { edit: 'creator' } });
    const poll = await alice.node.records.put(space, 'app.poll', { question: 'v0' });
    await alice.node.records.update(space, poll.key, { question: 'v1' });
    await alice.node.records.update(space, poll.key, { question: 'v2' });
    await alice.node.spaces.open(space);

    const carol = await person(hub);
    await carol.node.spaces.join(await alice.node.spaces.invite(space));
    let rejected = 0;
    carol.node.subscribe((event) => {
      if (event.type === 'rejected') rejected++;
    });
    await carol.node.spaces.open(space);
    await until(async () => (await carol.node.records.get<{ question: string }>(space, poll.key))?.body?.question === 'v2', 4000, 'the latest version');
    assert.equal(rejected, 0);
  });

  test('records written before a collection had rules are kept, and flagged', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Trip', type: 'shared', visibility: 'public' });
    const old = await alice.node.records.put(space, 'app.poll', { question: 'Before' });
    await alice.node.collections.define(space, { name: 'app.poll', schema: pollSchema, rules: { edit: 'creator' } });
    const seen = await alice.node.records.get(space, old.key);
    assert.equal(seen?.conforms, false);
    assert.match(seen?.issues?.map((i) => i.message).join() ?? '', /without this collection's rules/);
    const fresh = await alice.node.records.put(space, 'app.poll', { question: 'After' });
    assert.equal(fresh.conforms, true);
  });

  test('agents see the rules, and can ask before acting', async () => {
    const { alice, bob, space } = await pollSpace();
    const listed = (await runAction(bob.node, 'collections_list', { space })) as Array<{ name: string; rules: { edit?: string } }>;
    assert.equal(listed.find((c) => c.name === 'app.poll')?.rules.edit, 'creator');
    const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?' });
    await until(async () => (await bob.node.records.get(space, poll.key)) !== null, 4000, 'the poll');
    assert.equal(await runAction(bob.node, 'records_can', { space, action: 'edit', target: poll.key }), false);
  });
});
