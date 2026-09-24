/**
 * Profiles in a space: who is who, set once for the account, and only by the
 * person it names.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { runAction } from '../src/node/actions.js';
import { profileKey } from '../src/node/space-runtime.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { PROFILE_COLLECTION } from '../src/space/account-registry.js';
import { seenBy } from './helpers/as-member.js';
import { joined } from './helpers/joined.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function person(hub: FakeHub, name?: string, stores = memoryStores()) {
  const seed = generateSeed();
  const manager = createIdentityManager();
  const me = await manager.fromSeed(seed);
  const node = await createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    stores,
    accountKey: await deriveVaultKeyBytes(seed),
    watchIntervalMs: 0,
    network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
  });
  open.push(node);
  if (name) await node.account.setName(name);
  return { node, me, manager, stores };
}

async function until(predicate: () => Promise<boolean>, ms = 4000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const nameIn = async (node: P2PNode, space: string, did: string) => (await node.spaces.profiles(space)).find((p) => p.did === did)?.name;

describe('profiles', () => {
  test('each person is known by the name they set once, in every space they are in', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub, 'Alice');
    const bob = await person(hub, 'Bob');
    const { id: space } = await alice.node.spaces.create({ name: 'Chat', ...team, visibility: 'private' });
    await bob.node.spaces.join(await alice.node.spaces.invite(space));
    await alice.node.spaces.open(space);
    await bob.node.spaces.open(space);

    await until(async () => (await nameIn(alice.node, space, bob.node.did)) === 'Bob', 4000, 'Bob’s name to reach Alice');
    await until(async () => (await nameIn(bob.node, space, alice.node.did)) === 'Alice', 4000, 'Alice’s name to reach Bob');
  });

  test('a rename reaches the spaces that are open', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub, 'Alice');
    const bob = await person(hub, 'Bob');
    const { id: space } = await alice.node.spaces.create({ name: 'Chat', ...team, visibility: 'public' });
    await bob.node.spaces.join(await alice.node.spaces.invite(space));
    await alice.node.spaces.open(space);
    await bob.node.spaces.open(space);
    await until(async () => (await nameIn(bob.node, space, alice.node.did)) === 'Alice', 4000, 'first name');

    await alice.node.account.setName('Alice R.');
    await until(async () => (await nameIn(bob.node, space, alice.node.did)) === 'Alice R.', 4000, 'the rename');
    assert.equal((await alice.node.spaces.profiles(space)).filter((p) => p.did === alice.node.did).length, 1);
  });

  test('nobody can set someone else’s name — a forged version is never the answer, and cannot push theirs out', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub, 'Alice');
    const mallory = await person(hub, 'Mallory');
    const { id: space } = await alice.node.spaces.create({ name: 'Chat', ...team, visibility: 'public' });
    await mallory.node.spaces.join(await alice.node.spaces.invite(space));
    await alice.node.spaces.open(space);
    await joined(mallory.node, space);
    await until(async () => (await nameIn(alice.node, space, alice.node.did)) === 'Alice', 4000, 'Alice’s own profile');

    // Mallory signs a version under Alice's profile key, far ahead in sequence
    // and naming Alice's real first version, and slips it into her own copy of
    // the space before it syncs.
    const aliceKey = await profileKey(alice.node.did);
    const aliceFirst = (await createStorageProvider(await alice.stores(`spaces/${space}`)).history(aliceKey)).find((v) => v.seq === 0)!;
    const provider = mallory.manager.getProvider();
    const pair = await provider.generateKeyPair();
    const keyDid = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
    const ucan = await createLocalRootSigner(mallory.me, provider).delegate({
      audience: keyDid,
      capabilities: [{ with: `space:${space}`, can: 'expression/write' }],
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    const authored = await createSigner(provider).sign(
      createExpression({
        author: keyDid,
        collection: PROFILE_COLLECTION,
        space,
        body: { name: 'Evil Alice' },
        proof: ucan.encoded,
        version: { key: aliceKey, seq: 99, prev: aliceFirst.id, genesis: aliceFirst.id },
        retain: true,
        seen: await seenBy(mallory.node, space),
      }),
      pair.privateKey,
    );
    // Mallory is a member — she may write here — so the profile rule is what must stop her.
    const forged = authored;
    await createStorageProvider(await mallory.stores(`spaces/${space}`)).addExpression(forged);
    await mallory.node.spaces.open(space);

    // Mallory's own records reach Alice, so sync is working…
    await until(async () => (await nameIn(alice.node, space, mallory.node.did)) === 'Mallory', 4000, 'Mallory’s profile');
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The forgery did arrive — it is even the "current" version by sequence…
    const aliceCopy = createStorageProvider(await alice.stores(`spaces/${space}`));
    await until(async () => (await aliceCopy.getCurrent(await profileKey(alice.node.did)))?.seq === 99, 4000, 'the forgery to reach Alice');
    assert.equal((await aliceCopy.history(await profileKey(alice.node.did))).some((v) => v.seq === 0), true);
    // …and Alice is still Alice, on both sides.
    assert.equal(await nameIn(alice.node, space, alice.node.did), 'Alice');
    assert.equal(await nameIn(mallory.node, space, alice.node.did), 'Alice');
  });

  test('a follower of a personal space writes nothing there', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub, 'Alice');
    const carol = await person(hub, 'Carol');
    const { id: space } = await alice.node.spaces.create({ name: 'Blog', visibility: 'public' });
    await carol.node.spaces.join(await alice.node.spaces.invite(space));
    await alice.node.spaces.open(space);
    await carol.node.spaces.open(space);
    await until(async () => (await nameIn(carol.node, space, alice.node.did)) === 'Alice', 4000, 'the owner’s name');
    assert.equal(await nameIn(carol.node, space, carol.node.did), undefined);
  });

  test('agents read names through spaces_profiles', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub, 'Alice');
    const { id: space } = await alice.node.spaces.create({ name: 'Notes', visibility: 'private' });
    await alice.node.spaces.open(space);
    await until(async () => (await nameIn(alice.node, space, alice.node.did)) === 'Alice', 4000, 'own profile');
    const listed = (await runAction(alice.node, 'spaces_profiles', { space })) as Array<{ did: string; name: string }>;
    assert.deepEqual(listed.map((p) => [p.did, p.name]), [[alice.node.did, 'Alice']]);
  });
});
