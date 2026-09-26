/**
 * Topic tags: a keyed hash of each value of a collection's topic fields, on
 * the outside of every record, so a node that can't read it can still match
 * what it's about — and a writer can't lie about it to anyone who can read.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { checkStoredCollection } from '../src/schema/collection-def.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { generateSpaceKey } from '../src/privacy/space-encryption.js';
import { checkTopics, tagsFor, topicKey, topicTag, topicValues } from '../src/records/topics.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { seenBy } from './helpers/as-member.js';
import { joined } from './helpers/joined.js';
import { hold, letGo } from './helpers/hold.js';
import { team } from '../src/space/presets.js';

describe('topic tags, worked out', () => {
  test('a definition names at most eight fields, each a field name, none twice', () => {
    assert.equal(checkTopics(['channel', 'mentions', 'author.name']), null);
    assert.match(checkTopics(['channel', 'channel'])!, /twice/);
    assert.match(checkTopics(['not a field'])!, /not a field name/);
    assert.match(checkTopics(Array.from({ length: 9 }, (_, i) => `f${i}`))!, /at most 8/);
    assert.match(checkStoredCollection({ name: 'app.chat', version: 1, schema: { type: 'object' }, topics: [1] })!, /not a field name/);
  });

  test('a field’s values: text, numbers and yes/no, or each of those in a list', () => {
    assert.deepEqual(topicValues({ channel: 'design' }, 'channel'), ['design']);
    assert.deepEqual(topicValues({ mentions: ['a', 'b', { x: 1 }, null] }, 'mentions'), ['a', 'b']);
    assert.deepEqual(topicValues({ where: { city: 'Oslo' } }, 'where.city'), ['Oslo']);
    assert.deepEqual(topicValues({ where: 'Oslo' }, 'where.city'), []);
    assert.deepEqual(topicValues({ n: 3, ok: true, gone: null }, 'n'), [3]);
  });

  test('the same value gives the same tag; another field, collection, key or type gives another', async () => {
    const key = await topicKey({ spaceKey: (await generateSpaceKey()).key });
    const tag = await topicTag(key, 'app.chat', 'channel', 'design');
    assert.equal(await topicTag(key, 'app.chat', 'channel', 'design'), tag);
    assert.notEqual(await topicTag(key, 'app.chat', 'topic', 'design'), tag);
    assert.notEqual(await topicTag(key, 'app.mail', 'channel', 'design'), tag);
    assert.notEqual(await topicTag(key, 'app.chat', 'channel', 'Design'), tag);
    assert.notEqual(await topicTag(await topicKey({ spaceKey: (await generateSpaceKey()).key }), 'app.chat', 'channel', 'design'), tag);
    assert.notEqual(await topicTag(key, 'app.n', 'n', 1), await topicTag(key, 'app.n', 'n', '1'));
    assert.equal(tag.includes('design'), false);
    // One per value, sorted, each once.
    const tags = await tagsFor(key, 'app.chat', ['channel', 'mentions'], { channel: 'design', mentions: ['a', 'b', 'a'] });
    assert.equal(tags.length, 3);
    assert.deepEqual(tags, [...tags].sort());
  });

  test('a public space’s tags come from its id: anyone can work them out, and they differ per space', async () => {
    const one = await topicTag(await topicKey({ spaceId: 'space-one' }), 'app.chat', 'channel', 'design');
    assert.equal(await topicTag(await topicKey({ spaceId: 'space-one' }), 'app.chat', 'channel', 'design'), one);
    assert.notEqual(await topicTag(await topicKey({ spaceId: 'space-two' }), 'app.chat', 'channel', 'design'), one);
  });
});

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

async function until(predicate: () => Promise<boolean>, ms = 4000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const chat = { name: 'app.chat', schema: { type: 'object' }, topics: ['channel', 'mentions'] };

async function chatSpace(visibility: 'public' | 'private') {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility });
  await alice.node.collections.define(space, chat);
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await hold(alice.node, space);
  await hold(bob.node, space);
  await joined(bob.node, space);
  await until(async () => (await bob.node.collections.list(space)).some((c) => c.topics.length === 2), 4000, 'the definition to reach Bob');
  return { alice, bob, space };
}

describe('topic tags on records', () => {
  for (const visibility of ['private', 'public'] as const) {
    test(`a record carries a tag per value, the one \`collections.tag\` gives — ${visibility}`, async () => {
      const { alice, bob, space } = await chatSpace(visibility);
      const message = await alice.node.records.put(space, 'app.chat', { text: 'hi', channel: 'design', mentions: [bob.me.did] });
      const stored = await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(message.key);
      const expected = [
        await alice.node.collections.tag(space, 'app.chat', 'channel', 'design'),
        await alice.node.collections.tag(space, 'app.chat', 'mentions', bob.me.did),
      ].sort();
      assert.deepEqual(stored?.tags, expected);
      // Bob works out the same tags, and takes the record: they match what it says.
      assert.deepEqual(
        [await bob.node.collections.tag(space, 'app.chat', 'channel', 'design'), await bob.node.collections.tag(space, 'app.chat', 'mentions', bob.me.did)].sort(),
        expected,
      );
      await until(async () => (await bob.node.records.get(space, message.key)) !== null, 4000, 'the message to reach Bob');
      assert.equal(JSON.stringify(stored).includes('"design"'), visibility === 'public', 'in a private space the value stays sealed');
    });
  }

  test('a record whose tags don’t match what it says is refused by everyone who can read it', async () => {
    const { alice, bob, space } = await chatSpace('public');
    await letGo(bob.node, space);
    const provider = alice.manager.getProvider();
    const pair = await provider.generateKeyPair();
    const keyDid = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
    const ucan = await createLocalRootSigner(alice.me, provider).delegate({
      audience: keyDid,
      capabilities: [{ with: `space:${space}`, can: 'expression/write' }],
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    // Says #random, tagged #design: a push to the wrong people, or hiding from the right ones.
    const lying = await createSigner(provider).sign(
      createExpression({
        seen: await seenBy(alice.node, space),
        author: keyDid,
        space,
        proof: ucan.encoded,
        collection: 'app.chat',
        body: { text: 'psst', channel: 'random' },
        tags: [await alice.node.collections.tag(space, 'app.chat', 'channel', 'design')],
      }),
      pair.privateKey,
    );
    await createStorageProvider(await alice.stores(`spaces/${space}`)).addExpression(lying);

    let rejected = '';
    bob.node.subscribe((event) => {
      if (event.type === 'rejected') rejected = event.reason;
    });
    await hold(bob.node, space);
    await until(async () => rejected !== '', 4000, 'Bob to refuse it');
    assert.match(rejected, /topic tags don’t match|topic tags don't match/);
    assert.equal(await bob.node.records.get(space, lying.key), null);
  });

  test('without topics a record carries no tags', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'public' });
    await alice.node.collections.define(space, { name: 'app.note', schema: { type: 'object' } });
    const note = await alice.node.records.put(space, 'app.note', { channel: 'design' });
    assert.equal((await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(note.key))?.tags, undefined);
  });
});
