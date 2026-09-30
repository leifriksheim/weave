/**
 * Direct messages (`node.direct`, `packages/core/docs/direct-messages.md`): text in a shared
 * space only the people it is for, and whoever wrote it, can read — on every
 * one of their devices — and a copy under anyone else's name opens nothing.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { runAction } from '../src/node/actions.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import { contactKeyPair, deriveMemberKeyBytes } from '../src/identity/contact-key.js';
import { directContext, openDirect, sealDirect, type DirectBody } from '../src/privacy/direct.js';
import { direct } from '../src/schemas/library/publishing.js';
import { joined } from './helpers/joined.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';
import { until } from './helpers/until.js';

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function device(hub: FakeHub, seed: Uint8Array, name: string) {
  const manager = createIdentityManager();
  const node = await createNode({
    signer: createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider()),
    stores: memoryStores(),
    accountKey: await deriveVaultKeyBytes(seed),
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

/** A member key pair, as the account derives it for a space */
async function memberPair(seed: Uint8Array, spaceId: string) {
  return contactKeyPair(await deriveMemberKeyBytes(await deriveVaultKeyBytes(seed), spaceId));
}

/** Leif, Anna and Carol in a private book club, each seeing the others' member keys */
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
      async () => (await who.node.direct.reachable(club)).length === 2,
      5000,
      'everyone to see everyone’s member key',
    );
  }
  return { hub, leif, anna, carol, club };
}

describe('sealing a direct message', () => {
  const space = 'space-1';
  async function three() {
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => memberPair(generateSeed(), space)));
    const keys = new Map([
      ['did:a', a!.publicKey],
      ['did:b', b!.publicKey],
      ['did:c', c!.publicKey],
    ]);
    return { a: a!, b: b!, c: c!, keys };
  }

  test('opens for the people it is for and the writer, and nobody else', async () => {
    const { a, b, c, keys } = await three();
    const body = await sealDirect(space, 'did:a', ['did:b'], { text: 'hi' }, keys);
    assert.deepEqual(body.to, ['did:b']);
    assert.deepEqual(
      body.boxes.map((box) => box.to),
      ['did:b', 'did:a'],
    );
    assert.deepEqual(await openDirect(space, 'did:a', body, 'did:b', b.privateKey), { text: 'hi' });
    assert.deepEqual(await openDirect(space, 'did:a', body, 'did:a', a.privateKey), { text: 'hi' });
    assert.equal(await openDirect(space, 'did:a', body, 'did:c', c.privateKey), null);
    // Someone else's key under a reader's name opens nothing either.
    assert.equal(await openDirect(space, 'did:a', body, 'did:b', c.privateKey), null);
  });

  test('opens nothing in another space, from another writer, or for other people', async () => {
    const { b, keys } = await three();
    const body = await sealDirect(space, 'did:a', ['did:b'], { text: 'hi' }, keys);
    assert.equal(await openDirect('space-2', 'did:a', body, 'did:b', b.privateKey), null);
    assert.equal(await openDirect(space, 'did:c', body, 'did:b', b.privateKey), null);
    const widened: DirectBody = { ...body, to: ['did:b', 'did:c'] };
    assert.equal(await openDirect(space, 'did:a', widened, 'did:b', b.privateKey), null);
  });

  test('names who it is for once each, sorted, without the writer', async () => {
    const { keys } = await three();
    const body = await sealDirect(space, 'did:a', ['did:c', 'did:b', 'did:a', 'did:c'], { text: 'hi' }, keys);
    assert.deepEqual(body.to, ['did:b', 'did:c']);
    assert.equal(
      directContext(space, 'did:a', ['did:c', 'did:b']),
      'weave/direct/v1|space-1|did:a|did:b,did:c',
    );
  });

  test('refuses someone with no member key, and a message for nobody', async () => {
    const { keys } = await three();
    await assert.rejects(sealDirect(space, 'did:a', ['did:z'], { text: 'hi' }, keys), /no member key/);
    await assert.rejects(
      sealDirect(space, 'did:a', ['did:a'], { text: 'hi' }, keys),
      /someone to send it to/,
    );
  });
});

describe('node.direct', () => {
  test('the person it is for reads it; another member sees that it was sent, not what', async () => {
    const { leif, anna, carol, club } = await bookClub();
    const sent = await leif.node.direct.send(club, [anna.node.did], 'Chapter 3 was a slog');
    assert.equal(sent.text, 'Chapter 3 was a slog');
    assert.deepEqual(sent.to, [anna.node.did]);

    await until(async () => (await anna.node.direct.list(club)).length === 1, 5000, 'Anna to get it');
    const [got] = await anna.node.direct.list(club);
    assert.equal(got?.from, leif.node.did);
    assert.equal(got?.text, 'Chapter 3 was a slog');

    // Carol holds the record, and it is none of hers.
    await until(
      async () => (await carol.node.records.list(club, { collection: direct.name })).length === 1,
      5000,
      'Carol to hold the record',
    );
    assert.deepEqual(await carol.node.direct.list(club), []);
    const [record] = await carol.node.records.list(club, { collection: direct.name });
    assert.equal(
      await openDirect(
        club,
        leif.node.did,
        record?.body,
        carol.node.did,
        (await memberPair(carol.seed, club)).privateKey,
      ),
      null,
    );
  });

  test('a copy posted under another name opens nothing', async () => {
    const { leif, anna, carol, club } = await bookClub();
    await leif.node.direct.send(club, [anna.node.did], 'Just between us');
    await until(
      async () => (await carol.node.records.list(club, { collection: direct.name })).length === 1,
      5000,
      'Carol to hold the record',
    );
    const [record] = await carol.node.records.list(club, { collection: direct.name });
    await carol.node.records.put(club, direct.name, record!.body);

    await until(async () => (await anna.node.direct.list(club)).length === 2, 5000, 'Anna to get both');
    const byCarol = (await anna.node.direct.list(club)).find((m) => m.from === carol.node.did);
    assert.equal(byCarol?.text, null);
  });

  test("the writer's other devices read what was sent", async () => {
    const { hub, leif, anna, club } = await bookClub();
    await leif.node.direct.send(club, [anna.node.did], 'On my phone too');
    const phone = await device(hub, leif.seed, 'Leif');
    await until(
      async () => (await phone.spaces.list()).some((space) => space.id === club),
      5000,
      'the phone to know the club',
    );
    await phone.spaces.hold(club);
    await until(async () => (await phone.direct.list(club)).length === 1, 5000, 'the phone to get it');
    assert.equal((await phone.direct.list(club))[0]?.text, 'On my phone too');
  });

  test('needs a private space: a public one has no member keys', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const leif = await person(hub, 'Leif');
    const anna = await person(hub, 'Anna');
    const { id } = await leif.node.spaces.create({ name: 'Town square', ...team, visibility: 'public' });
    await anna.node.spaces.join(await leif.node.spaces.invite(id, { role: 'editor' }));
    await joined(anna.node, id);
    assert.deepEqual(await leif.node.direct.reachable(id), []);
    await assert.rejects(leif.node.direct.send(id, [anna.node.did], 'hello'), /no member key/);
  });
});

describe('the direct message actions', () => {
  test('direct_send seals for its readers; direct_list opens them, one conversation at a time', async () => {
    const { leif, anna, carol, club } = await bookClub();
    await runAction(anna.node, 'direct_send', { space: club, to: [leif.node.did], text: 'Chapter 3?' });
    await runAction(carol.node, 'direct_send', { space: club, to: [leif.node.did], text: 'Pizza?' });
    await until(async () => (await leif.node.direct.list(club)).length === 2, 5000, 'both to reach Leif');
    const withAnna: unknown = await runAction(leif.node, 'direct_list', { space: club, with: anna.node.did });
    assert.ok(Array.isArray(withAnna));
    assert.deepEqual(
      withAnna.map((m: unknown) => (typeof m === 'object' && m !== null && 'text' in m ? m.text : null)),
      ['Chapter 3?'],
    );
    const newest: unknown = await runAction(leif.node, 'direct_list', { space: club, limit: 1 });
    assert.ok(Array.isArray(newest) && newest.length === 1);
    await assert.rejects(
      runAction(anna.node, 'direct_send', { space: club, to: 'not a list', text: 'x' }),
      /"to"/,
    );
  });
});
