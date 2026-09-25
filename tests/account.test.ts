/**
 * The account across devices and stores: a name that follows it, and moving
 * or merging its data between stores.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { copyAccountData } from '../src/node/copy.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';
import { hold } from './helpers/hold.js';

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function account(seed = generateSeed()) {
  const manager = createIdentityManager();
  const identity = await manager.fromSeed(seed);
  return {
    seed,
    did: identity.did,
    signer: createLocalRootSigner(identity, manager.getProvider()),
    accountKey: await deriveVaultKeyBytes(seed),
  };
}

async function device(me: Awaited<ReturnType<typeof account>>, stores = memoryStores(), hub?: FakeHub) {
  const node = await createNode({
    signer: me.signer,
    stores,
    accountKey: me.accountKey,
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

describe('the account name', () => {
  test('a rename on one device reaches the others, and the newest wins', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(me, memoryStores(), hub);
    const phone = await device(me, memoryStores(), hub);

    assert.equal(await laptop.account.profile(), null);
    await laptop.account.setName('Leif');
    await until(async () => (await phone.account.profile())?.name === 'Leif', 3000, 'the name to reach the phone');

    await new Promise((resolve) => setTimeout(resolve, 5)); // a later time, as a real rename would be
    await phone.account.setName('Leif R.');
    await until(async () => (await laptop.account.profile())?.name === 'Leif R.', 3000, 'the rename to reach the laptop');
  });

  test('another device hears about it as an event', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(me, memoryStores(), hub);
    const phone = await device(me, memoryStores(), hub);
    let heard = 0;
    phone.subscribe((event) => {
      if (event.type === 'account') heard++;
    });
    await laptop.account.setName('Leif');
    await until(async () => heard > 0, 3000, 'an account event on the phone');
  });

  test('cannot be set without the account key', async () => {
    const me = await account();
    const node = await createNode({ signer: me.signer, stores: memoryStores(), watchIntervalMs: 0 });
    open.push(node);
    await assert.rejects(node.account.setName('x'), /account key/);
  });
});

describe('moving and merging an account', () => {
  test('moves every space, key and record into empty stores — deletions included', async () => {
    const me = await account();
    const browser = memoryStores();
    const folder = memoryStores();

    const before = await device(me, browser);
    const diary = await before.spaces.create({ name: 'Diary', visibility: 'private' });
    const kept = await before.records.put(diary.id, 'app.note', { text: 'kept' });
    const gone = await before.records.put(diary.id, 'app.note', { text: 'deleted' });
    await before.records.delete(diary.id, gone.key);
    await before.account.setName('Leif');
    await before.close();

    const result = await copyAccountData({ from: browser, to: folder, did: me.did, accountKey: me.accountKey });
    assert.equal(result.spacesAdded, 1);

    const after = await device(me, folder);
    assert.deepEqual((await after.spaces.list()).map((s) => s.name), ['Diary']);
    assert.deepEqual((await after.records.list<{ text: string }>(diary.id)).map((r) => r.body?.text), ['kept']);
    assert.equal((await after.records.get(diary.id, kept.key))?.encrypted, true);
    assert.equal((await after.account.profile())?.name, 'Leif');
  });

  test('merging into stores that already hold the account keeps both sides', async () => {
    const me = await account();
    const browser = memoryStores();
    const folder = memoryStores();

    const inBrowser = await device(me, browser);
    const shared = await inBrowser.spaces.create({ name: 'Both', visibility: 'public' });
    await inBrowser.records.put(shared.id, 'app.note', { text: 'written in the browser' });
    await inBrowser.spaces.create({ name: 'Browser only', visibility: 'public' });
    const invite = await inBrowser.spaces.invite(shared.id);
    await inBrowser.close();

    const inFolder = await device(me, folder);
    await inFolder.spaces.join(invite);
    await inFolder.records.put(shared.id, 'app.note', { text: 'written in the folder' });
    await inFolder.spaces.create({ name: 'Folder only', visibility: 'public' });
    await inFolder.close();

    await copyAccountData({ from: browser, to: folder, did: me.did, accountKey: me.accountKey });
    const merged = await device(me, folder);
    assert.deepEqual((await merged.spaces.list()).map((s) => s.name).sort(), ['Both', 'Browser only', 'Folder only']);
    assert.deepEqual(
      (await merged.records.list<{ text: string }>(shared.id)).map((r) => r.body?.text).sort(),
      ['written in the browser', 'written in the folder'],
    );

    // Doing it again changes nothing.
    await merged.close();
    const again = await copyAccountData({ from: browser, to: folder, did: me.did, accountKey: me.accountKey });
    assert.deepEqual([again.spacesAdded, again.recordsAdded], [0, 0]);
  });
});

describe('who is connected', () => {
  test("a space tells the account's own devices apart from other people", async () => {
    const me = await account();
    const friend = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(me, memoryStores(), hub);
    const phone = await device(me, memoryStores(), hub);
    const theirs = await device(friend, memoryStores(), hub);

    const trip = await laptop.spaces.create({ name: 'Trip', visibility: 'private', ...team });
    await theirs.spaces.join(await laptop.spaces.invite(trip.id, { role: 'editor' }));
    // The phone hears about the space through the account, and opens it.
    await until(async () => (await phone.spaces.list()).some((space) => space.id === trip.id), 3000, 'the space to reach the phone');
    await hold(phone, trip.id);

    await until(async () => (await laptop.spaces.status(trip.id)).peers.length === 2, 3000, 'both peers to connect');
    await until(async () => (await laptop.spaces.status(trip.id)).own.length === 1, 3000, 'the phone to count as ours');
    const status = await laptop.spaces.status(trip.id);
    assert.deepEqual(status.own, [phone.sessionDid]);
    assert.deepEqual(status.carriers, []);
    assert.ok(status.peers.includes(theirs.sessionDid));
  });
});
