/**
 * Links between records, and the sys.* annotation library.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { runAction } from '../src/node/actions.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { createSigner } from '../src/schema/signer.js';
import { didToPublicKey, publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createExpression } from '../src/schema/expression.js';
import { checkLinks } from '../src/records/links.js';
import { reaction as reactionSchema, comment as commentSchema, useSchemas } from '../src/schemas/index.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';
import { joined } from './helpers/joined.js';
import { hold } from './helpers/hold.js';

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function person(hub?: FakeHub, stores = memoryStores()) {
  const manager = createIdentityManager();
  const me = await manager.fromSeed(generateSeed());
  const node = await createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    stores,
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

describe('links', () => {
  test('a reaction points at a todo, and stays on it when the todo is ticked', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Todos', visibility: 'public' });
    const todo = await me.records.put(space, 'app.todo.item', { text: 'milk', done: false });
    const reaction = await me.records.put(space, 'std.reaction', { emoji: '👍' }, { links: [{ rel: 'about', to: todo.key }] });

    assert.deepEqual(reaction.links, [{ rel: 'about', to: todo.key }]);
    assert.deepEqual((await me.records.linked(space, todo.key, { rel: 'about' })).map((r) => r.key), [reaction.key]);

    await me.records.update(space, todo.key, { text: 'milk', done: true });
    assert.deepEqual((await me.records.linked(space, todo.key)).map((r) => r.key), [reaction.key]);
  });

  test('links are signed: changing one breaks the signature', async () => {
    const provider = createP256Provider();
    const signer = createSigner(provider);
    const pair = await provider.generateKeyPair();
    const author = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
    const signed = await signer.sign(
      createExpression({ author, collection: 'std.reaction', body: { emoji: '👍' }, links: [{ rel: 'about', to: 'todo-a' }] }),
      pair.privateKey,
    );
    const publicKey = await provider.importPublicKey(didToPublicKey(author).publicKeyBytes);
    assert.equal(await signer.verify(signed, publicKey), true);
    assert.equal(await signer.verify({ ...signed, links: [{ rel: 'about', to: 'todo-b' }] }, publicKey), false);
  });

  test('a reaction that arrives before its target is kept, and attaches when the target does', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Todos', visibility: 'public' });
    await useSchemas(me, space, [reactionSchema]);
    const reaction = await me.records.put(space, 'std.reaction', { emoji: '🎉' }, { links: [{ rel: 'about', to: 'not-here-yet' }] });
    assert.equal(reaction.conforms, true);
    await me.records.put(space, 'app.todo.item', { text: 'late' }, { key: 'not-here-yet' });
    assert.deepEqual((await me.records.linked(space, 'not-here-yet')).map((r) => r.key), [reaction.key]);
  });

  test('a deleted reaction leaves the index', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Todos', visibility: 'public' });
    const todo = await me.records.put(space, 'app.todo.item', { text: 'milk' });
    const reaction = await me.records.put(space, 'std.reaction', { emoji: '👍' }, { links: [{ rel: 'about', to: todo.key }] });
    await me.records.delete(space, reaction.key);
    assert.deepEqual(await me.records.linked(space, todo.key), []);
  });

  test('the shape check refuses malformed links', () => {
    assert.equal(checkLinks([{ rel: 'about', to: 'abc' }]), null);
    assert.match(checkLinks([{ rel: 'About', to: 'abc' }]) ?? '', /camel case/);
    assert.match(checkLinks([{ rel: 'about', to: 'Not A Key' }]) ?? '', /record key/);
    assert.match(checkLinks(Array.from({ length: 33 }, () => ({ rel: 'about', to: 'k' }))) ?? '', /At most 32/);
  });
});

describe('declared links', () => {
  test('refused on write when they break the declaration; flagged, never rejected, when they arrive', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.spaces.create({ name: 'Polls', ...team, visibility: 'public' });
    await bob.spaces.join(await alice.spaces.invite(space));
    await hold(alice, space);
    await joined(bob, space);

    // Bob writes a vote before any definition exists — fine where it was written.
    await hold(bob, space);
    const note = await bob.records.put(space, 'app.note', { text: 'not a poll' });
    const vote = await bob.records.put(space, 'app.poll.vote', { choice: 1 }, { links: [{ rel: 'about', to: note.key }] });

    await alice.collections.define(space, { name: 'app.poll', schema: { type: 'object' } });
    await alice.collections.define(space, {
      name: 'app.poll.vote',
      schema: { type: 'object' },
      links: { about: { to: ['app.poll'], cardinality: 'one' } },
    });
    const poll = await alice.records.put(space, 'app.poll', { question: 'Where?' });

    // On write: refused, with a reason an agent can act on — once the target is
    // here to judge. (A link to something not held yet is allowed.)
    await until(async () => (await alice.records.get(space, note.key)) !== null, 3000, 'bob’s note to arrive');
    await assert.rejects(
      alice.records.put(space, 'app.poll.vote', { choice: 1 }, { links: [{ rel: 'about', to: note.key }] }),
      /must point at app\.poll, not app\.note/,
    );
    await assert.rejects(
      alice.records.put(space, 'app.poll.vote', { choice: 1 }, { links: [{ rel: 'on', to: poll.key }] }),
      /has no "on" link/,
    );
    await alice.records.put(space, 'app.poll.vote', { choice: 1 }, { links: [{ rel: 'about', to: poll.key }] });

    // On arrival: Bob's earlier vote is kept, and flagged.
    await until(async () => (await alice.records.get(space, vote.key)) !== null, 3000, 'bob’s vote to arrive');
    const seen = await alice.records.get(space, vote.key);
    assert.equal(seen?.verified, true);
    assert.equal(seen?.conforms, false);
    assert.match(seen?.issues?.map((i) => i.message).join() ?? '', /must point at app\.poll/);
  });
});

describe('private spaces', () => {
  test('seal links with the body — a relay without the key sees neither', async () => {
    const stores = memoryStores();
    const me = await person(undefined, stores);
    const { id: space } = await me.spaces.create({ name: 'Diary', visibility: 'private' });
    const entry = await me.records.put(space, 'app.note', { text: 'secret' });
    const reaction = await me.records.put(space, 'std.reaction', { emoji: '❤️' }, { links: [{ rel: 'about', to: entry.key }] });

    // What the store — and so any relay or node — holds:
    const { createStorageProvider } = await import('../src/storage/storage-provider.js');
    const raw = await createStorageProvider(await stores(`spaces/${space}`)).getCurrent(reaction.key);
    assert.equal(raw?.links, undefined);
    assert.equal(JSON.stringify(raw).includes(entry.key), false);

    // What a member sees:
    assert.deepEqual((await me.records.linked(space, entry.key)).map((r) => r.key), [reaction.key]);
  });
});

describe('an app that knows nothing about todos', () => {
  test('lists and renders the reactions on them', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const todoApp = await person(hub);
    const chatApp = await person(hub);
    const { id: space } = await todoApp.spaces.create({ name: 'Shared', ...team, visibility: 'private' });
    await chatApp.spaces.join(await todoApp.spaces.invite(space));
    await hold(todoApp, space);
    await joined(chatApp, space);
    const todo = await todoApp.records.put(space, 'app.todo.item', { text: 'book flights' });
    await hold(chatApp, space);
    await until(async () => (await chatApp.records.get(space, todo.key)) !== null, 3000, 'the todo to reach the chat app');

    // The chat app reacts to something it has no schema for, using the library.
    await chatApp.records.put(space, 'std.reaction', { emoji: '✈️' }, { links: [{ rel: 'about', to: todo.key }] });
    await until(async () => (await todoApp.records.linked(space, todo.key)).length === 1, 3000, 'the reaction to reach the todo app');
    const [reaction] = await todoApp.records.linked<{ emoji: string }>(space, todo.key, { collection: 'std.reaction' });
    assert.equal(reaction?.body?.emoji, '✈️');
    assert.equal(reaction?.root, chatApp.did);
  });
});

describe('for agents', () => {
  test('a space knows no kinds of record until someone defines them; the schema library is one way to', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    assert.deepEqual(await runAction(me, 'collections_list', { space }), []);

    await useSchemas(me, space, [reactionSchema, commentSchema]);
    await useSchemas(me, space, [reactionSchema, commentSchema]); // again: nothing redefined
    const listed = (await runAction(me, 'collections_list', { space })) as Array<{ name: string; version: number; links: Record<string, unknown> }>;
    const comment = listed.find((c) => c.name === 'std.comment');
    assert.equal(comment?.version, 1);
    assert.deepEqual(Object.keys(comment?.links ?? {}), ['about', 'replyTo']);

    const todo = (await runAction(me, 'records_put', { space, collection: 'app.todo.item', body: { text: 'pack' } })) as { key: string };
    await runAction(me, 'records_put', { space, collection: 'std.comment', body: { text: 'bring the adapter' }, links: [{ rel: 'about', to: todo.key }] });
    const onIt = (await runAction(me, 'records_linked', { space, key: todo.key, collection: 'std.comment' })) as Array<{ body: { text: string } }>;
    assert.deepEqual(onIt.map((c) => c.body.text), ['bring the adapter']);
  });
});
