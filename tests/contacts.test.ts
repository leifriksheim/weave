/**
 * Contacts (`node.contacts`): a list only the account can find, the same on
 * every device; asking someone inside a shared space with an invite only they
 * can open; and a space for two that stays the two of you, or says when not.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import { contactKeyPair, contactPublicKey, deriveContactKeyBytes, openSealed, sealFor } from '../src/identity/contact-key.js';
import { joined } from './helpers/joined.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

/** A device of an account: the seed's own node, with its account key and contact key */
async function device(hub: FakeHub, seed: Uint8Array, name: string) {
  const manager = createIdentityManager();
  const node = await createNode({
    signer: createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider()),
    stores: memoryStores(),
    accountKey: await deriveVaultKeyBytes(seed),
    contactKey: await deriveContactKeyBytes(seed),
    watchIntervalMs: 0,
    network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
  });
  open.push(node);
  await node.account.setName(name);
  return node;
}

async function person(hub: FakeHub, name: string) {
  const seed = generateSeed();
  return { seed, node: await device(hub, seed, name) };
}

async function until(predicate: () => boolean | Promise<boolean>, ms = 5000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Leif, Anna and Carol in a book club, each knowing the others' contact keys */
async function bookClub() {
  const hub = createFakeHub({ latencyMs: 1 });
  const leif = await person(hub, 'Leif');
  const anna = await person(hub, 'Anna');
  const carol = await person(hub, 'Carol');
  const { id: club } = await leif.node.spaces.create({ name: 'Book club', ...team, visibility: 'private' });
  for (const other of [anna, carol]) {
    await other.node.spaces.join(await leif.node.spaces.invite(club, { role: 'editor' }));
    await joined(other.node, club);
  }
  for (const who of [leif, anna, carol]) await who.node.spaces.hold(club);
  for (const who of [leif, anna, carol]) {
    await until(
      async () => (await who.node.spaces.profiles(club)).filter((profile) => profile.contactKey).length === 3,
      5000,
      'everyone to see everyone’s contact key',
    );
  }
  return { hub, leif, anna, carol, club };
}

describe('the contact key', () => {
  test('is derived from the seed — the same on every device — and is not the signing key', async () => {
    const seed = generateSeed();
    const a = await deriveContactKeyBytes(seed);
    const b = await deriveContactKeyBytes(seed);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, await deriveContactKeyBytes(generateSeed()));
    const identity = await createIdentityManager().fromSeed(seed);
    assert.ok(!identity.did.includes(contactPublicKey(a)));
  });

  test('opens what was sealed to it, only in the same context', async () => {
    const pair = await contactKeyPair(await deriveContactKeyBytes(generateSeed()));
    const other = await contactKeyPair(await deriveContactKeyBytes(generateSeed()));
    const sealed = await sealFor(pair.publicKey, { hello: 'Anna' }, 'here');
    assert.deepEqual(await openSealed(pair.privateKey, sealed, 'here'), { hello: 'Anna' });
    assert.equal(await openSealed(pair.privateKey, sealed, 'somewhere else'), null);
    assert.equal(await openSealed(other.privateKey, sealed, 'here'), null);
  });

  test('its public half is on the account’s profile in every space it writes in', async () => {
    const { leif, anna, club } = await bookClub();
    const profiles = await anna.node.spaces.profiles(club);
    assert.equal(profiles.find((profile) => profile.did === leif.node.did)?.contactKey, contactPublicKey(await deriveContactKeyBytes(leif.seed)));
  });

  test('a node without it keeps the key another device published', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const leif = await person(hub, 'Leif');
    const { id } = await leif.node.spaces.create({ name: 'Notes', visibility: 'private' });
    await until(async () => !!(await leif.node.spaces.profiles(id))[0]?.contactKey, 5000, 'the profile');

    // Another device of the same account, with no contact key, renames it.
    const manager = createIdentityManager();
    const bare = await createNode({
      signer: createLocalRootSigner(await manager.fromSeed(leif.seed), manager.getProvider()),
      stores: memoryStores(),
      accountKey: await deriveVaultKeyBytes(leif.seed),
      watchIntervalMs: 0,
      network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
    });
    open.push(bare);
    await until(async () => (await bare.spaces.list()).some((space) => space.id === id), 5000, 'the other device to join');
    await bare.spaces.hold(id);
    await until(async () => (await bare.spaces.profiles(id)).length === 1, 5000, 'the profile to reach it');
    await bare.account.setName('Leif R');
    await until(async () => (await bare.spaces.profiles(id))[0]?.name === 'Leif R', 5000, 'the rename');
    assert.equal((await bare.spaces.profiles(id))[0]?.contactKey, contactPublicKey(await deriveContactKeyBytes(leif.seed)));
  });
});

describe('the contact list', () => {
  test('lives in a hidden space every device of the account derives, and syncs between them', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const leif = await person(hub, 'Leif');
    const phone = await device(hub, leif.seed, 'Leif');

    const space = await leif.node.contacts.space();
    assert.ok(space);
    assert.equal(await phone.contacts.space(), space);
    assert.equal((await leif.node.spaces.list()).some((listed) => listed.id === space), false);
    await assert.rejects(leif.node.spaces.leave(space!), /cannot be left/);

    await leif.node.contacts.put({ did: 'did:key:zAnna', name: 'Anna', note: 'from book club' });
    await leif.node.spaces.hold(space!);
    await phone.spaces.hold(space!);
    await until(async () => (await phone.contacts.list()).length === 1, 5000, 'the contact to reach the phone');
    assert.deepEqual(
      (await phone.contacts.list()).map(({ did, name, note, blocked, space }) => ({ did, name, note, blocked, space })),
      [{ did: 'did:key:zAnna', name: 'Anna', note: 'from book club', blocked: false, space: null }],
    );

    // One per person: putting them again changes the one record.
    await phone.contacts.put({ did: 'did:key:zAnna', name: 'Anna K' });
    assert.deepEqual((await phone.contacts.list()).map((contact) => contact.name), ['Anna K']);
  });

  test('a node with no account key and no contacts space was not given them', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const manager = createIdentityManager();
    const node = await createNode({
      signer: createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider()),
      stores: memoryStores(),
      watchIntervalMs: 0,
      network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
    });
    open.push(node);
    assert.equal(await node.contacts.space(), null);
    assert.deepEqual(await node.contacts.list(), []);
    await assert.rejects(node.contacts.put({ did: 'did:key:zAnna', name: 'Anna' }), /not given your contacts/);
  });
});

describe('asking to be added', () => {
  test('the person asked opens it and accepts; both end up in a space for two, on each other’s list', async () => {
    const { leif, anna, club } = await bookClub();

    const asked = await leif.node.contacts.ask(club, anna.node.did, { note: 'it’s Leif from book club' });
    assert.deepEqual((await leif.node.contacts.get(anna.node.did))?.space, asked.space);

    await until(async () => (await anna.node.contacts.requests(club)).length === 1, 5000, 'Anna to see the request');
    const [request] = await anna.node.contacts.requests(club);
    assert.equal(request!.from, leif.node.did);
    assert.equal(request!.name, 'Leif');
    assert.equal(request!.note, 'it’s Leif from book club');
    assert.equal(request!.pairSpace, asked.space);

    const added = await anna.node.contacts.accept(club, request!.key);
    assert.equal(added.did, leif.node.did);
    assert.equal(added.name, 'Leif');
    assert.equal(added.space, asked.space);
    await joined(anna.node, asked.space);

    // Accepted: it's no longer waiting.
    assert.deepEqual(await anna.node.contacts.requests(club), []);

    // The space holds the two of them, and a record written there reaches the other.
    await leif.node.spaces.hold(asked.space);
    await anna.node.spaces.hold(asked.space);
    await anna.node.collections.define(asked.space, { name: 'app.chat.message', schema: { type: 'object', properties: { text: { type: 'string' } } } });
    await anna.node.records.put(asked.space, 'app.chat.message', { text: 'hi' });
    await until(async () => (await leif.node.records.list(asked.space)).length === 1, 5000, 'the message to reach Leif');
    assert.deepEqual(await leif.node.contacts.others(anna.node.did), []);
    assert.deepEqual(await anna.node.contacts.others(leif.node.did), []);
  });

  test('another member of the space cannot open a request meant for someone else', async () => {
    const { leif, anna, carol, club } = await bookClub();
    await leif.node.contacts.ask(club, anna.node.did);
    await until(async () => (await carol.node.records.list(club, { collection: 'std.contact-request' })).length === 1, 5000, 'the request to reach Carol');
    assert.deepEqual(await carol.node.contacts.requests(club), []);
  });

  test('accepting a request on one device reaches the account’s other devices', async () => {
    const { hub, leif, anna, club } = await bookClub();
    const annasPhone = await device(hub, anna.seed, 'Anna');
    const asked = await leif.node.contacts.ask(club, anna.node.did);
    await until(async () => (await anna.node.contacts.requests(club)).length === 1, 5000, 'the request');
    await anna.node.contacts.accept(club, (await anna.node.contacts.requests(club))[0]!.key);

    const contacts = (await annasPhone.contacts.space())!;
    await annasPhone.spaces.hold(contacts);
    await anna.node.spaces.hold(contacts);
    await until(async () => (await annasPhone.contacts.get(leif.node.did))?.space === asked.space, 5000, 'the contact to reach Anna’s phone');
    await until(async () => (await annasPhone.spaces.list()).some((space) => space.id === asked.space), 5000, 'the phone to join the space for two');
  });

  test('someone not asked turning up in the space for two is reported', async () => {
    const { hub, leif, anna, club } = await bookClub();
    const bob = await person(hub, 'Bob');
    const asked = await leif.node.contacts.ask(club, anna.node.did);
    await until(async () => (await anna.node.contacts.requests(club)).length === 1, 5000, 'the request');
    await anna.node.contacts.accept(club, (await anna.node.contacts.requests(club))[0]!.key);
    await joined(anna.node, asked.space);

    // Leif invites Bob into the conversation anyway.
    await bob.node.spaces.join(await leif.node.spaces.invite(asked.space, { role: 'editor' }));
    await joined(bob.node, asked.space);
    for (const who of [leif, anna, bob]) await who.node.spaces.hold(asked.space);
    await until(async () => (await anna.node.contacts.others(leif.node.did)).includes(bob.node.did), 5000, 'Anna to see Bob');
  });

  test('removing a contact leaves their space; other contacts’ spaces keep working', async () => {
    const { leif, anna, carol, club } = await bookClub();
    const withAnna = await leif.node.contacts.ask(club, anna.node.did);
    const withCarol = await leif.node.contacts.ask(club, carol.node.did);
    await leif.node.contacts.remove(anna.node.did);
    assert.equal(await leif.node.contacts.get(anna.node.did), null);
    const held = (await leif.node.spaces.list()).map((space) => space.id);
    assert.equal(held.includes(withAnna.space), false);
    assert.equal(held.includes(withCarol.space), true);
    assert.equal((await leif.node.contacts.get(carol.node.did))?.space, withCarol.space);
  });

  test('blocking someone hides their requests', async () => {
    const { leif, anna, club } = await bookClub();
    await leif.node.contacts.ask(club, anna.node.did);
    await until(async () => (await anna.node.contacts.requests(club)).length === 1, 5000, 'the request');
    await anna.node.contacts.block(leif.node.did);
    assert.deepEqual(await anna.node.contacts.requests(club), []);
    assert.equal((await anna.node.contacts.get(leif.node.did))?.blocked, true);
  });

  test('someone with no contact key in the space cannot be asked', async () => {
    const { leif, club } = await bookClub();
    await assert.rejects(leif.node.contacts.ask(club, 'did:key:zStranger'), /no contact key/);
    await assert.rejects(leif.node.contacts.ask(club, leif.node.did), /That is you/);
  });
});
