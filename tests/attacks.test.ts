/**
 * What a member — or a stranger in the room — must not be able to do to a
 * shared space. Each test is an attack found in a security audit, replayed
 * against the fix.
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
import { createExpression, type CreateExpressionParams } from '../src/schema/expression.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { SYNC_PROTOCOL_VERSION } from '../src/sync/sync-messages.js';
import type { Expression } from '../src/types.js';
import { seenBy } from './helpers/as-member.js';
import { joined } from './helpers/joined.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';
import { hold, letGo } from './helpers/hold.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import { contactPublicKey, deriveContactKeyBytes } from '../src/identity/contact-key.js';
import { profileKey } from '../src/node/space-runtime.js';
import { contactRequest } from '../src/schemas/contacts.js';

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

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

/** A version signed by a member by hand — whatever fields they like — and slipped into their own store. */
async function forge(who: Person, space: string, fields: Omit<CreateExpressionParams<unknown>, 'author' | 'space' | 'proof'>): Promise<Expression> {
  const provider = who.manager.getProvider();
  const pair = await provider.generateKeyPair();
  const keyDid = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  const ucan = await createLocalRootSigner(who.me, provider).delegate({
    audience: keyDid,
    capabilities: [{ with: `space:${space}`, can: 'expression/write' }],
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  const authored = await createSigner(provider).sign(createExpression({ seen: await seenBy(who.node, space), ...fields, author: keyDid, space, proof: ucan.encoded }), pair.privateKey);
  const signed = authored;
  await createStorageProvider(await who.stores(`spaces/${space}`)).addExpression(signed);
  return signed;
}

/** Alice owns a shared space with a creator-only poll collection; Bob is a member. */
async function setup() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Polls', ...team, visibility: 'public' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await hold(alice.node, space);
  await joined(bob.node, space);
  await alice.node.collections.define(space, {
    name: 'app.poll',
    schema: { type: 'object' },
    rules: { edit: 'creator', delete: 'creator', fixed: ['options'] },
  });
  await hold(alice.node, space);
  await hold(bob.node, space);
  await until(async () => (await bob.node.collections.list(space)).some((c) => c.name === 'app.poll' && c.version !== null), 4000, 'the definition');
  const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?', options: ['a'] });
  await until(async () => (await bob.node.records.get(space, poll.key)) !== null, 4000, 'the poll');
  return { hub, alice, bob, space, poll };
}

describe('attacks on a shared space', () => {
  test('a version cannot escape its record\'s rules by naming another record as its first', async () => {
    const { alice, bob, space, poll } = await setup();
    const unruled = await bob.node.records.put(space, 'app.other', { x: 1 });
    await letGo(bob.node, space);
    await forge(bob, space, {
      collection: 'app.poll',
      body: { question: 'Hijacked', options: ['zzz'] },
      version: { key: poll.key, seq: 5, prev: poll.version, genesis: unruled.version },
    });
    await hold(bob.node, space);
    await until(async () => (await bob.node.spaces.status(space)).peers.length > 0, 4000, 'Bob to reconnect');
    await settle();
    assert.equal((await alice.node.records.get<{ question: string }>(space, poll.key))?.body?.question, 'Where?');
  });

  test('a member cannot take down a collection\'s definition they did not write', async () => {
    const { alice, bob, space } = await setup();
    const definition = await createStorageProvider(await bob.stores(`spaces/${space}`)).getCurrent('collection:app.poll');
    await letGo(bob.node, space);
    await forge(bob, space, {
      collection: 'sys.collection',
      body: null,
      deleted: true,
      retain: true,
      version: { key: 'collection:app.poll', seq: 50, prev: definition!.id, genesis: definition!.id },
    });
    await hold(bob.node, space);
    // It does arrive — and changes nothing.
    const aliceStore = createStorageProvider(await alice.stores(`spaces/${space}`));
    await until(async () => (await aliceStore.getCurrent('collection:app.poll'))?.seq === 50, 4000, 'the delete to arrive');
    const poll = (await alice.node.collections.list(space)).find((c) => c.name === 'app.poll');
    assert.equal(poll?.version, 1);
    assert.deepEqual(poll?.rules, { edit: 'creator', delete: 'creator', fixed: ['options'] });
  });

  test('a stranger sending a mangled copy first does not get the real record refused', async () => {
    const { hub, alice, bob, space } = await setup();
    await letGo(bob.node, space);
    const second = await alice.node.records.put(space, 'app.poll', { question: 'Second', options: ['a'] });
    const real = await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(second.key);
    await letGo(alice.node, space);

    const rejected: string[] = [];
    bob.node.subscribe((event) => {
      if (event.type === 'rejected') rejected.push(event.reason);
    });
    // No keys at all: just a copy with its signature broken, pushed unasked.
    const stranger = hub.transport('did:key:zstranger', space);
    stranger.on('connected', (peer: string) => {
      const payload = { v: SYNC_PROTOCOL_VERSION, type: 'push-update', expression: { ...real!, signature: 'AAAA' }, newRootCid: '' };
      stranger.send(peer, new TextEncoder().encode(JSON.stringify({ type: 'sync', from: 'did:key:zstranger', payload })));
    });
    await stranger.connect();
    await hold(bob.node, space);
    await until(async () => rejected.length > 0, 4000, 'the mangled copy to be refused');

    await hold(alice.node, space);
    await until(async () => (await bob.node.records.get(space, second.key)) !== null, 4000, 'the real record');
  });
});

describe('attacks on contacts', () => {
  /** Someone with a name, a contacts space and a contact key, in `space` as an editor */
  async function contactPerson(hub: FakeHub, name: string) {
    const seed = generateSeed();
    const manager = createIdentityManager();
    const me = await manager.fromSeed(seed);
    const stores = memoryStores();
    const node = await createNode({
      signer: createLocalRootSigner(me, manager.getProvider()),
      stores,
      accountKey: await deriveVaultKeyBytes(seed),
      contactKey: await deriveContactKeyBytes(seed),
      watchIntervalMs: 0,
      network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
    });
    open.push(node);
    await node.account.setName(name);
    return { node, me, manager, stores, seed };
  }

  /** Leif, Anna and Carol in a space Leif made, each seeing the others' contact keys */
  async function threeIn(visibility: 'public' | 'private') {
    const hub = createFakeHub({ latencyMs: 1 });
    const leif = await contactPerson(hub, 'Leif');
    const anna = await contactPerson(hub, 'Anna');
    const carol = await contactPerson(hub, 'Carol');
    const { id: space } = await leif.node.spaces.create({ name: 'Book club', ...team, visibility });
    for (const other of [anna, carol]) {
      await other.node.spaces.join(await leif.node.spaces.invite(space, { role: 'editor' }));
      await joined(other.node, space);
    }
    for (const who of [leif, anna, carol]) await hold(who.node, space);
    for (const who of [leif, anna, carol]) {
      await until(async () => (await who.node.spaces.profiles(space)).filter((p) => p.contactKey).length === 3, 5000, 'everyone’s contact key');
    }
    return { hub, leif, anna, carol, space };
  }

  test('a contact key on a profile signed by another account is ignored', async () => {
    const { leif, anna, carol, space } = await threeIn('public');
    const annasKey = contactPublicKey(await deriveContactKeyBytes(anna.seed));
    const current = await createStorageProvider(await carol.stores(`spaces/${space}`)).getCurrent(await profileKey(anna.node.did));
    await letGo(carol.node, space);
    // Carol writes "Anna's" profile, carrying Carol's own contact key.
    await forge(carol, space, {
      collection: 'sys.profile',
      body: { name: 'Anna', contactKey: contactPublicKey(await deriveContactKeyBytes(carol.seed)) },
      retain: true,
      version: { key: current!.key, seq: current!.seq + 1, prev: current!.id, genesis: current!.id },
    });
    await hold(carol.node, space);
    const leifStore = createStorageProvider(await leif.stores(`spaces/${space}`));
    await until(async () => (await leifStore.getCurrent(await profileKey(anna.node.did)))?.seq === current!.seq + 1, 4000, 'the forgery to arrive');
    const seen = (await leif.node.spaces.profiles(space)).find((profile) => profile.did === anna.node.did);
    assert.equal(seen?.contactKey, annasKey);
  });

  test('a request re-posted by someone else, or copied into another space, does not open', async () => {
    const { leif, anna, carol, space } = await threeIn('private');
    await leif.node.contacts.ask(space, anna.node.did);
    await until(async () => (await carol.node.records.list(space, { collection: 'std.contact-request' })).length === 1, 5000, 'the request');
    const [original] = await carol.node.records.list<{ to: string; sealed: string }>(space, { collection: 'std.contact-request' });

    // Carol posts Leif's sealed invite as her own.
    await carol.node.records.put(space, 'std.contact-request', original!.body!);
    // Leif posts the same sealed invite in another space Anna is in.
    const { id: other } = await leif.node.spaces.create({ name: 'Other', ...team, visibility: 'private' });
    await anna.node.spaces.join(await leif.node.spaces.invite(other, { role: 'editor' }));
    await joined(anna.node, other);
    await leif.node.collections.define(other, contactRequest);
    await leif.node.records.put(other, 'std.contact-request', original!.body!);
    await hold(anna.node, other);
    await hold(leif.node, other);

    await until(async () => (await anna.node.records.list(space, { collection: 'std.contact-request' })).length === 2, 5000, 'Carol’s copy');
    await until(async () => (await anna.node.records.list(other, { collection: 'std.contact-request' })).length === 1, 5000, 'Leif’s copy');
    const here = await anna.node.contacts.requests(space);
    assert.deepEqual(here.map((request) => request.from), [leif.node.did], 'only the original, from Leif');
    assert.deepEqual(await anna.node.contacts.requests(other), []);
  });
});
