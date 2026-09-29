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
import { until } from './helpers/until.js';
import { carriedFor, checkNotify, checkProposal, matchesRecord, whereHolds } from '../src/space/notify.js';
import { channel, message, post } from '../src/schemas/library/publishing.js';
import { comment } from '../src/schemas/library/annotations.js';
import { task } from '../src/schemas/library/planning.js';
import { standardNeeds } from '../src/schemas/apps.js';
import { standardDefinition } from '../src/schemas/standard.js';
import { toJsonSchema } from '../src/schema/collection-def.js';
import { isRecord } from '../src/utils/guards.js';

describe('topic tags, worked out', () => {
  test('a definition names at most eight fields, each a field name, none twice', () => {
    assert.equal(checkTopics(['channel', 'mentions', 'author.name']), null);
    assert.match(checkTopics(['channel', 'channel'])!, /twice/);
    assert.match(checkTopics(['not a field'])!, /not a field name/);
    assert.match(checkTopics(Array.from({ length: 9 }, (_, i) => `f${i}`))!, /at most 8/);
    // A link role, named as `onePer` names one.
    assert.equal(checkTopics(['link:channel', 'mentions']), null);
    assert.match(checkTopics(['link:'])!, /not a field name or link role/);
    assert.match(checkTopics(['link:Channel'])!, /not a field name or link role/);
    assert.match(checkTopics(['link:a.b'])!, /not a field name or link role/);
    assert.match(
      checkStoredCollection({ name: 'app.chat', version: 1, schema: { type: 'object' }, topics: [1] })!,
      /not a field name/,
    );
  });

  test('a field’s values: text, numbers and yes/no, or each of those in a list', () => {
    assert.deepEqual(topicValues({ channel: 'design' }, 'channel'), ['design']);
    assert.deepEqual(topicValues({ mentions: ['a', 'b', { x: 1 }, null] }, 'mentions'), ['a', 'b']);
    assert.deepEqual(topicValues({ where: { city: 'Oslo' } }, 'where.city'), ['Oslo']);
    assert.deepEqual(topicValues({ where: 'Oslo' }, 'where.city'), []);
    assert.deepEqual(topicValues({ n: 3, ok: true, gone: null }, 'n'), [3]);
    // A link role's values are where each link of that role points, not the body.
    const links = [
      { rel: 'channel', to: 'k1' },
      { rel: 'shares', to: 'k2' },
      { rel: 'channel', to: 'k3' },
    ];
    assert.deepEqual(topicValues({ channel: 'body' }, 'link:channel', links), ['k1', 'k3']);
    assert.deepEqual(topicValues({}, 'link:replyTo', links), []);
  });

  test('the same value gives the same tag; another field, collection, key or type gives another', async () => {
    const key = await topicKey({ spaceKey: (await generateSpaceKey()).key });
    const tag = await topicTag(key, 'app.chat', 'channel', 'design');
    assert.equal(await topicTag(key, 'app.chat', 'channel', 'design'), tag);
    assert.notEqual(await topicTag(key, 'app.chat', 'topic', 'design'), tag);
    assert.notEqual(await topicTag(key, 'app.mail', 'channel', 'design'), tag);
    assert.notEqual(await topicTag(key, 'app.chat', 'channel', 'Design'), tag);
    assert.notEqual(
      await topicTag(
        await topicKey({ spaceKey: (await generateSpaceKey()).key }),
        'app.chat',
        'channel',
        'design',
      ),
      tag,
    );
    assert.notEqual(await topicTag(key, 'app.n', 'n', 1), await topicTag(key, 'app.n', 'n', '1'));
    assert.equal(tag.includes('design'), false);
    // One per value, sorted, each once.
    const tags = await tagsFor(key, 'app.chat', ['channel', 'mentions'], {
      channel: 'design',
      mentions: ['a', 'b', 'a'],
    });
    assert.equal(tags.length, 3);
    assert.deepEqual(tags, [...tags].sort());
  });

  test('the spec’s examples (02 §8.3)', async () => {
    const key = await topicKey({ spaceId: 'bimjoifogypbqrtuich3e375d67y43znkjsjnp4q4qhe7gwf7u74a' });
    assert.equal(await topicTag(key, 'app.chat.message', 'channel', 'design'), '77UGGhMoLC5C1rXEcsqWKw');
    const [linked] = await tagsFor(key, 'std.message', ['link:channel'], { text: 'hi' }, [
      { rel: 'channel', to: 'mfrggzdfmztwq2lknnwg23tpoa' },
    ]);
    assert.equal(linked, 'KmBza5PO__zHr48zfCH8Pw');
  });

  test('a public space’s tags come from its id: anyone can work them out, and they differ per space', async () => {
    const one = await topicTag(await topicKey({ spaceId: 'space-one' }), 'app.chat', 'channel', 'design');
    assert.equal(
      await topicTag(await topicKey({ spaceId: 'space-one' }), 'app.chat', 'channel', 'design'),
      one,
    );
    assert.notEqual(
      await topicTag(await topicKey({ spaceId: 'space-two' }), 'app.chat', 'channel', 'design'),
      one,
    );
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
  await until(
    async () => (await bob.node.collections.list(space)).some((c) => c.topics.length === 2),
    4000,
    'the definition to reach Bob',
  );
  return { alice, bob, space };
}

describe('topic tags on records', () => {
  for (const visibility of ['private', 'public'] as const) {
    test(`a record carries a tag per value, the one \`collections.tag\` gives — ${visibility}`, async () => {
      const { alice, bob, space } = await chatSpace(visibility);
      const message = await alice.node.records.put(space, 'app.chat', {
        text: 'hi',
        channel: 'design',
        mentions: [bob.me.did],
      });
      const stored = await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(
        message.key,
      );
      const expected = [
        await alice.node.collections.tag(space, 'app.chat', 'channel', 'design'),
        await alice.node.collections.tag(space, 'app.chat', 'mentions', bob.me.did),
      ].sort();
      assert.deepEqual(stored?.tags, expected);
      // Bob works out the same tags, and takes the record: they match what it says.
      assert.deepEqual(
        [
          await bob.node.collections.tag(space, 'app.chat', 'channel', 'design'),
          await bob.node.collections.tag(space, 'app.chat', 'mentions', bob.me.did),
        ].sort(),
        expected,
      );
      await until(
        async () => (await bob.node.records.get(space, message.key)) !== null,
        4000,
        'the message to reach Bob',
      );
      assert.equal(
        JSON.stringify(stored).includes('"design"'),
        visibility === 'public',
        'in a private space the value stays sealed',
      );
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
    assert.equal(
      (await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(note.key))?.tags,
      undefined,
    );
  });
});

describe('topic tags on links', () => {
  const rooms = {
    name: 'app.room',
    schema: { type: 'object' },
    links: { channel: { to: '*' as const, cardinality: 'one' as const } },
    topics: ['link:channel'],
  };

  async function roomSpace(visibility: 'public' | 'private') {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility });
    await alice.node.collections.define(space, rooms);
    await bob.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(alice.node, space);
    await hold(bob.node, space);
    await joined(bob.node, space);
    await until(
      async () => (await bob.node.collections.list(space)).some((c) => c.name === rooms.name),
      4000,
      'the definition to reach Bob',
    );
    return { alice, bob, space };
  }

  for (const visibility of ['private', 'public'] as const) {
    test(`a record is tagged with where its link points, sealed or not — ${visibility}`, async () => {
      const { alice, bob, space } = await roomSpace(visibility);
      const channel = 'mfrggzdfmztwq2lknnwg23tpoa';
      const said = await alice.node.records.put(
        space,
        rooms.name,
        { text: 'hi' },
        { links: [{ rel: 'channel', to: channel }] },
      );
      const stored = await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(said.key);
      const tag = await alice.node.collections.tag(space, rooms.name, 'link:channel', channel);
      assert.deepEqual(stored?.tags, [tag]);
      assert.equal(await bob.node.collections.tag(space, rooms.name, 'link:channel', channel), tag);
      // Bob opens it, works the tag out from its links, and keeps it.
      await until(
        async () => (await bob.node.records.get(space, said.key)) !== null,
        4000,
        'the record to reach Bob',
      );
    });
  }

  test('a record tagged for one channel but linking another is refused', async () => {
    const { alice, bob, space } = await roomSpace('public');
    await letGo(bob.node, space);
    const provider = alice.manager.getProvider();
    const pair = await provider.generateKeyPair();
    const keyDid = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
    const ucan = await createLocalRootSigner(alice.me, provider).delegate({
      audience: keyDid,
      capabilities: [{ with: `space:${space}`, can: 'expression/write' }],
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    const lying = await createSigner(provider).sign(
      createExpression({
        seen: await seenBy(alice.node, space),
        author: keyDid,
        space,
        proof: ucan.encoded,
        collection: rooms.name,
        body: { text: 'psst' },
        links: [{ rel: 'channel', to: 'randomrandomrandomrandom00' }],
        tags: [
          await alice.node.collections.tag(space, rooms.name, 'link:channel', 'designdesigndesigndesign00'),
        ],
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

  test('a standard message in a channel is tagged with it, and “in #design” matches only those', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'private' });
    await alice.node.collections.define(space, channel);
    await alice.node.collections.define(space, message);
    const design = await alice.node.records.put(space, channel.name, { name: 'design' });
    const inDesign = await alice.node.records.put(
      space,
      message.name,
      { text: 'mockups?' },
      { links: [{ rel: 'channel', to: design.key }] },
    );
    const inRoom = await alice.node.records.put(space, message.name, { text: 'hello all' });
    const stored = await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(
      inDesign.key,
    );
    assert.deepEqual(stored?.tags, [
      await alice.node.collections.tag(space, message.name, 'link:channel', design.key),
    ]);
    const since = new Date(Date.now() - 1000).toISOString();
    const inChannel = [inDesign, inRoom].filter((record) =>
      matchesRecord(
        {
          label: '#design',
          collection: message.name,
          spaces: 'all',
          topic: { field: 'link:channel', value: design.key },
          since,
        },
        record,
        'did:key:zDnaeBob',
      ),
    );
    assert.deepEqual(
      inChannel.map((r) => r.key),
      [inDesign.key],
    );
  });
});

describe('a standard message’s topics', () => {
  test('mentions and replies are tagged, so “mentions me” and “replies to me” match only those', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'private' });
    await alice.node.collections.define(space, message);
    const bob = 'did:key:zDnaeBob';
    const since = new Date(Date.now() - 1000).toISOString();

    const mention = await alice.node.records.put(space, message.name, { text: 'hi @Bob', mentions: [bob] });
    const reply = await alice.node.records.put(space, message.name, { text: 'yes', replyingTo: bob });
    const plain = await alice.node.records.put(space, message.name, { text: 'hello all' });

    const stored = await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(mention.key);
    assert.deepEqual(stored?.tags, [await alice.node.collections.tag(space, message.name, 'mentions', bob)]);

    const when = (field: string) => ({
      label: field,
      collection: message.name,
      spaces: 'all' as const,
      topic: { field, value: bob },
      since,
    });
    const matches = (field: string) =>
      [mention, reply, plain].filter((record) => matchesRecord(when(field), record, bob)).map((r) => r.key);
    assert.deepEqual(matches('mentions'), [mention.key]);
    assert.deepEqual(matches('replyingTo'), [reply.key]);
  });

  for (const definition of [comment, post]) {
    test(`a ${definition.name} is tagged like a message, so it can mention and reply to someone`, async () => {
      const hub = createFakeHub({ latencyMs: 1 });
      const alice = await person(hub);
      const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'private' });
      await alice.node.collections.define(space, definition);
      const bob = 'did:key:zDnaeBob';
      const since = new Date(Date.now() - 1000).toISOString();

      const mention = await alice.node.records.put(space, definition.name, {
        text: 'hi @Bob',
        mentions: [bob],
      });
      const reply = await alice.node.records.put(space, definition.name, { text: 'yes', replyingTo: bob });
      const plain = await alice.node.records.put(space, definition.name, { text: 'hello all' });

      const stored = await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(
        mention.key,
      );
      assert.deepEqual(stored?.tags, [
        await alice.node.collections.tag(space, definition.name, 'mentions', bob),
      ]);

      const matches = (field: string) =>
        [mention, reply, plain]
          .filter((record) =>
            matchesRecord(
              {
                label: field,
                collection: definition.name,
                spaces: 'all',
                topic: { field, value: bob },
                since,
              },
              record,
              bob,
            ),
          )
          .map((record) => record.key);
      assert.deepEqual(matches('mentions'), [mention.key]);
      assert.deepEqual(matches('replyingTo'), [reply.key]);
    });
  }

  test('a task carries a tag for each assignee, so “assigned to me” matches only tasks given to me', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Board', ...team, visibility: 'private' });
    await alice.node.collections.define(space, task);
    const [bob, carol] = ['did:key:zDnaeBob', 'did:key:zDnaeCarol'];
    const since = new Date(Date.now() - 1000).toISOString();

    const both = await alice.node.records.put(space, task.name, {
      title: 'Posters',
      assignees: [bob, carol],
    });
    const carols = await alice.node.records.put(space, task.name, { title: 'Venue', assignees: [carol] });
    const nobodys = await alice.node.records.put(space, task.name, { title: 'Snacks' });

    const stored = await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(both.key);
    const tag = (did: string) => alice.node.collections.tag(space, task.name, 'assignees', did);
    assert.deepEqual(stored?.tags, [await tag(bob), await tag(carol)].sort());

    const assigned = (did: string) =>
      [both, carols, nobodys]
        .filter((record) =>
          matchesRecord(
            {
              label: 'Assigned to me',
              collection: task.name,
              spaces: 'all',
              topic: { field: 'assignees', value: did },
              since,
            },
            record,
            did,
          ),
        )
        .map((record) => record.key);
    assert.deepEqual(assigned(bob), [both.key]);
    assert.deepEqual(assigned(carol), [both.key, carols.key]);
  });

  test('an app that needs std.message gets its topics, and one without them is not the standard message', () => {
    const needs = standardNeeds(['std.message']);
    assert.ok(Array.isArray(needs) && isRecord(needs[0]));
    assert.deepEqual(needs[0].topics, ['link:channel', 'mentions', 'replyingTo']);
    const { topics: _topics, ...without } = { ...message, schema: toJsonSchema(message.schema) };
    assert.throws(() => standardNeeds([without]), /different shape/);
  });

  test('every standard collection that names people has them as topics, so a keeper can tell them', () => {
    const expected: Record<string, ReadonlyArray<string>> = {
      'std.message': ['link:channel', 'mentions', 'replyingTo'],
      'std.comment': ['mentions', 'replyingTo', 'respondingTo'],
      'std.post': ['mentions', 'replyingTo'],
      'std.article': ['mentions'],
      'std.note': ['mentions'],
      'std.doc-block': ['mentions'],
      'std.task': ['assignees'],
      'std.reaction': ['respondingTo'],
      'std.repost': ['respondingTo'],
      'std.claim': ['respondingTo'],
      'std.rsvp': ['respondingTo'],
      'std.booking': ['respondingTo'],
      'std.vote': ['respondingTo'],
      'std.ballot': ['respondingTo'],
      'std.pledge': ['respondingTo'],
      'std.order': ['respondingTo'],
      'std.order-update': ['respondingTo'],
      'std.award': ['did'],
      'std.follow': ['did'],
      'std.list-item': ['did'],
      'std.call': ['to', 'people'],
      'std.settlement': ['from', 'to'],
      'std.expense': ['paidBy', 'owedBy'],
      'std.direct': ['to'],
    };
    const needs = standardNeeds(Object.keys(expected));
    assert.ok(Array.isArray(needs));
    assert.deepEqual(
      Object.fromEntries(needs.map((need) => (isRecord(need) ? [need.name, need.topics] : [null, null]))),
      expected,
    );
  });

  test('a report names nobody: whoever is reported is not told, and a keeper can’t tell whom it is about', () => {
    assert.equal(standardDefinition('std.report')?.topics, undefined);
  });

  const bob = 'did:key:zDnaeBob';
  /** A standard record, the field naming someone in it, and what it is about when it must be about something */
  const tagged: ReadonlyArray<
    readonly [string, Record<string, unknown>, string, (readonly [string, Record<string, unknown>])?]
  > = [
    ['std.reaction', { emoji: '👍', respondingTo: bob }, 'respondingTo'],
    [
      'std.rsvp',
      { status: 'going', respondingTo: bob },
      'respondingTo',
      ['std.event', { title: 'Picnic', start: '2026-10-01T12:00:00Z' }],
    ],
    [
      'std.vote',
      { choice: 0, respondingTo: bob },
      'respondingTo',
      ['std.poll', { question: 'Where?', options: ['Park'] }],
    ],
    [
      'std.order',
      { items: [{ title: 'Bike', quantity: 1 }], respondingTo: bob },
      'respondingTo',
      ['std.listing', { title: 'Bike' }],
    ],
    ['std.note', { content: 'Ask @Bob', mentions: [bob] }, 'mentions'],
    ['std.doc-block', { type: 'paragraph', text: '@Bob to review', mentions: [bob] }, 'mentions'],
    ['std.follow', { did: bob }, 'did'],
    ['std.list-item', { did: bob }, 'did'],
    ['std.call', { status: 'missed', startedAt: '2026-09-29T10:00:00Z', to: bob }, 'to'],
    [
      'std.expense',
      {
        title: 'Pizza',
        amount: { amount: '30', currency: 'EUR' },
        paidBy: 'did:key:zDnaeAlice',
        owedBy: [bob],
      },
      'owedBy',
    ],
  ];
  for (const [name, body, field, target] of tagged) {
    test(`a ${name} is tagged for the person in its ${field}, so they can be told`, async () => {
      const hub = createFakeHub({ latencyMs: 1 });
      const alice = await person(hub);
      const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'private' });
      const definition = standardDefinition(name);
      assert.ok(definition);
      await alice.node.collections.define(space, definition);
      const targetDefinition = target && standardDefinition(target[0]);
      if (targetDefinition) await alice.node.collections.define(space, targetDefinition);
      const since = new Date(Date.now() - 1000).toISOString();

      // Each about something of its own, for those that are one per person per record.
      const about = async () =>
        definition.links && 'about' in definition.links
          ? {
              links: [
                {
                  rel: 'about',
                  to: (await alice.node.records.put(space, target?.[0] ?? 'app.thing', target?.[1] ?? {}))
                    .key,
                },
              ],
            }
          : {};
      const carol = 'did:key:zDnaeCarol';
      const written = await alice.node.records.put(space, name, body, await about());
      const other = await alice.node.records.put(
        space,
        name,
        { ...body, [field]: Array.isArray(body[field]) ? [carol] : carol },
        await about(),
      );
      const stored = await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(
        written.key,
      );
      assert.ok(stored?.tags?.includes(await alice.node.collections.tag(space, name, field, bob)));

      const matches = [written, other]
        .filter((record) =>
          matchesRecord(
            { label: field, collection: name, spaces: 'all', topic: { field, value: bob }, since },
            record,
            bob,
          ),
        )
        .map((record) => record.key);
      assert.deepEqual(matches, [written.key]);
    });
  }
});

describe('a subscription’s where', () => {
  test('narrows what an app is told about to records the condition holds for, and is never carried', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Board', ...team, visibility: 'private' });
    await alice.node.collections.define(space, task);
    const bob = 'did:key:zDnaeBob';
    const since = new Date(Date.now() - 1000).toISOString();

    const urgent = await alice.node.records.put(space, task.name, { title: 'Fix the door', priority: 4 });
    const later = await alice.node.records.put(space, task.name, { title: 'Paint', priority: 1 });
    const unset = await alice.node.records.put(space, task.name, { title: 'Sweep' });

    const when = {
      label: 'Urgent task',
      collection: task.name,
      spaces: 'all' as const,
      where: { '>=': [{ var: 'body.priority' }, 3] },
      since,
    };
    assert.equal(checkNotify(when), null);
    const told: string[] = [];
    for (const record of [urgent, later, unset])
      if (matchesRecord(when, record, bob) && (await whereHolds(when, record))) told.push(record.key);
    // A missing priority is not compared: it is simply not a match.
    assert.deepEqual(told, [urgent.key]);

    const carried = await carriedFor(when, [{ id: space, key: null, visibility: 'private' }]);
    assert.equal('where' in carried, false);
  });

  test('is refused when it asks the space, reads what a record doesn’t have, or is not a condition', () => {
    const base = {
      label: 'x',
      collection: 'std.task',
      spaces: 'all' as const,
      since: new Date().toISOString(),
    };
    assert.match(checkNotify({ ...base, where: { member: [{ var: 'author' }] } })!, /asks the space/);
    assert.match(checkNotify({ ...base, where: { '==': [{ var: 'prev.body' }, null] } })!, /prev/);
    assert.match(checkNotify({ ...base, where: { '~': [1, 2] } })!, /not an operator/);
    assert.match(
      checkProposal({ label: 'x', collection: 'std.task', where: { versions: [[]] } })!,
      /asks the space/,
    );
    assert.equal(
      checkProposal({
        label: 'Assigned to me, urgent',
        collection: 'std.task',
        topic: { field: 'assignees', me: true },
        where: { and: [{ '>=': [{ var: 'body.priority' }, 3] }, { '!=': [{ var: 'body.status' }, 'done'] }] },
      }),
      null,
    );
  });
});
