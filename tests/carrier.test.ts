/**
 * Carriers: a node holding passes, not keys, that keeps an account's spaces
 * online — and its pod current — without being able to read or write them.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { createCarrierNode, type CarrierNode } from '../src/node/carrier.js';
import { folderStores } from '../src/node/stores.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createMeshAuth } from '../src/network/peer-auth.js';
import { makePass, openPass, carriedRecord } from '../src/space/pass.js';
import { createSpaceManager, parseSpaceInvite } from '../src/space/space-manager.js';
import { team } from '../src/space/presets.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createMemoryDirectory } from './helpers/memory-directory.js';

const provider = createP256Provider();
const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function account(seed = generateSeed()) {
  const manager = createIdentityManager();
  const identity = await manager.fromSeed(seed);
  return {
    did: identity.did,
    signer: createLocalRootSigner(identity, manager.getProvider()),
    accountKey: await deriveVaultKeyBytes(seed),
  };
}
type Account = Awaited<ReturnType<typeof account>>;

const onHub = (hub: FakeHub) => ({ transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] });

async function device(me: Account, hub: FakeHub | null, stores = memoryStores(), options: { accountKey?: boolean } = {}): Promise<P2PNode> {
  const node = await createNode({
    signer: me.signer,
    stores,
    ...(options.accountKey === false ? {} : { accountKey: me.accountKey }),
    watchIntervalMs: 20,
    ...(hub ? { network: onHub(hub) } : {}),
  });
  open.push(node);
  return node;
}

async function carrierKey() {
  const keys = await provider.generateKeyPair();
  return { keys, did: publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC) };
}

async function carrier(me: Account, invite: string, hub: FakeHub, stores = memoryStores(), key?: CryptoKeyPair): Promise<CarrierNode> {
  const node = await createCarrierNode({
    key: key ?? (await carrierKey()).keys,
    account: me.did,
    carry: invite,
    stores,
    network: onHub(hub),
    watchIntervalMs: 20,
  });
  open.push(node);
  return node;
}

async function until(check: () => Promise<boolean>, ms = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const carries = (node: CarrierNode, spaceId: string) => async () => (await node.spaces()).some((space) => space.id === spaceId);

describe('passes', () => {
  test('a pass opens a private space for carrying, and holds no key', async () => {
    const registry = createSpaceManager(createMemoryAdapter(), provider);
    const record = await registry.create({ name: 'Notes', visibility: 'private', creator: 'did:key:zCreator' });
    const pass = await makePass(record);

    assert.equal(JSON.stringify(pass).includes(parseSpaceInvite(await registry.createInvite(record.space.id, 'x')).key!), false);
    const opened = await openPass(pass, provider);
    assert.ok(opened);
    assert.equal(opened.read?.did, record.space.readKey);
    assert.equal(carriedRecord(opened).key, null);
  });

  test('a pass whose space was edited, or whose read key is another space\'s, is refused', async () => {
    const registry = createSpaceManager(createMemoryAdapter(), provider);
    const a = await registry.create({ name: 'A', visibility: 'private', creator: 'did:key:zCreator' });
    const b = await registry.create({ name: 'B', visibility: 'private', creator: 'did:key:zCreator' });
    const pass = await makePass(a);

    assert.equal(await openPass({ ...pass, space: { ...pass.space, creator: 'did:key:zSomeoneElse' } }, provider), null);
    assert.equal(await openPass({ ...pass, read: (await makePass(b)).read }, provider), null);
    assert.equal(await openPass({ v: 1, space: pass.space }, provider), null);
  });

  test('the read key from a pass is enough to join the space\'s peers', async () => {
    const registry = createSpaceManager(createMemoryAdapter(), provider);
    const record = await registry.create({ name: 'Notes', visibility: 'private', creator: 'did:key:zCreator' });
    const opened = (await openPass(await makePass(record), provider))!;

    const one = await carrierKey();
    const two = await carrierKey();
    const read = { key: opened.read, publicDid: record.space.readKey! };
    const prover = createMeshAuth(record.space.id, { did: one.did, key: one.keys.privateKey }, read, provider);
    const checker = createMeshAuth(record.space.id, { did: two.did, key: two.keys.privateKey }, read, provider);
    const proof = await prover.prove(two.did, 'nonce', null);
    assert.equal(await checker.check(one.did, 'nonce', null, proof), true);
  });
});

describe('a carrier', () => {
  test('carries every space of the account, and holds no key but its carry space\'s', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(me, hub);
    const notes = await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    const blog = await laptop.spaces.create({ name: 'Blog', visibility: 'public' });

    const { did, keys } = await carrierKey();
    const added = await laptop.carriers.add({ did, name: 'Chrome' });
    const stores = memoryStores();
    const node = await carrier(me, added.invite, hub, stores, keys);

    await until(carries(node, notes.id), 5000, 'the private space to be carried');
    await until(carries(node, blog.id), 5000, 'the public space to be carried');
    assert.deepEqual((await laptop.carriers.list()).map((c) => c.did), [did]);
    // Connected in the space, it is named a carrier — not one of the account's devices.
    await until(async () => (await laptop.spaces.status(notes.id)).carriers.includes(did), 5000, 'the carrier to be named');
    assert.deepEqual((await laptop.spaces.status(notes.id)).own, []);
    // The carry space is the account's, but not a space it uses.
    assert.equal((await laptop.spaces.list()).some((space) => space.id === added.space), false);

    // Its own registry holds one space — the carry space — and so one key.
    const registry = createSpaceManager(await stores('registry'), provider);
    assert.deepEqual((await registry.list()).map((record) => record.space.id), [added.space]);
  });

  test('two devices never online together meet through it, and it cannot read what it carries', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(me, hub);
    const notes = await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    await laptop.records.put(notes.id, 'note', { text: 'the secret plan' });
    const added = await laptop.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    const stores = memoryStores();
    const node = await carrier(me, added.invite, hub, stores);

    const rootOf = async (n: { spaces: { status(id: string): Promise<{ root: string | null }> } }) => (await n.spaces.status(notes.id)).root;
    const carriedRoot = async () => (await node.spaces()).find((s) => s.id === notes.id) && (await laptopStatusRoot());
    const laptopStatusRoot = async () => rootOf(laptop);
    await until(async () => !!(await carriedRoot()), 5000, 'the space to be carried');
    // Wait until the carrier holds what the laptop holds.
    await until(async () => (await stores(`spaces/${notes.id}`)).list('').then((keys) => keys.length > 0), 5000, 'records at the carrier');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await laptop.close();

    // Nothing readable at the carrier.
    const adapter = await stores(`spaces/${notes.id}`);
    for (const key of await adapter.list('')) {
      const bytes = await adapter.get(key);
      assert.equal(new TextDecoder().decode(bytes ?? new Uint8Array()).includes('the secret plan'), false);
    }

    // A phone that was never online with the laptop gets everything from the carrier.
    const phone = await device(me, hub);
    await until(async () => (await phone.spaces.list()).some((space) => space.id === notes.id), 5000, 'the phone to learn of the space');
    await until(async () => (await phone.records.list(notes.id)).length === 1, 5000, 'the note to reach the phone');
    assert.deepEqual((await phone.records.list(notes.id))[0]?.body, { text: 'the secret plan' });
  });

  test('a space made after it was added is carried, with nothing done in the home', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const home = await device(me, hub);
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    const node = await carrier(me, added.invite, hub);

    // Another device of the account — an app with the account key — makes a space.
    const app = await device(me, hub);
    await until(async () => (await app.carriers.list()).length === 1, 5000, 'the app to hear of the carrier');
    const made = await app.spaces.create({ name: 'Made in an app', visibility: 'private' });
    await until(carries(node, made.id), 5000, 'the new space to be carried');

    await app.spaces.leave(made.id);
    await until(async () => !(await carries(node, made.id)()), 5000, 'the space left to stop being carried');
  });

  test('keeps the pod current while every app is closed', async () => {
    const me = await account();
    const friend = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const pod = createMemoryDirectory('pod');
    const dataPath = 'accounts/me/stores';
    const podStores = () => folderStores(pod.open(), { basePath: dataPath });

    // The home, on the pod.
    const home = await device(me, hub, podStores());
    const shared = await home.spaces.create({ name: 'Shared', visibility: 'private', ...team });
    const invite = await home.spaces.invite(shared.id, { role: 'editor' });
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });

    const node = await carrier(me, added.invite, hub);
    await node.usePod(podStores());
    await until(carries(node, shared.id), 5000, 'the shared space to be carried');

    const theirs = await device(friend, hub);
    await theirs.spaces.join(invite);
    await until(async () => (await theirs.records.can(shared.id, 'create', 'note')), 5000, 'the friend to join');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await home.close();

    // The friend writes while every one of our apps is closed.
    await theirs.records.put(shared.id, 'note', { text: 'while you were away' });
    await new Promise((resolve) => setTimeout(resolve, 800));
    await theirs.close();

    // The home opens on the pod, with nobody online at all, and it is there.
    const back = await device(me, null, podStores());
    await until(async () => (await back.records.list(shared.id)).length === 1, 5000, 'the note to be in the pod');
    assert.deepEqual((await back.records.list(shared.id))[0]?.body, { text: 'while you were away' });

    // It only ever wrote spaces: the account's sealed registry is the home's alone.
    assert.ok(pod.paths().every((path) => !path.startsWith(`${dataPath}/`) || path.startsWith(`${dataPath}/spaces/`) || path.startsWith(`${dataPath}/registry/`)));
  });

  test('removing it tells it to forget, and stops the passes', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const home = await device(me, hub);
    await home.spaces.create({ name: 'Notes', visibility: 'private' });
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    const node = await carrier(me, added.invite, hub);
    // Its own carry space, the registry, the contacts, and Notes.
    await until(async () => (await node.spaces()).length === 4, 5000, 'the spaces to be carried');

    let closed = false;
    node.subscribe((event) => {
      if (event.type === 'closed') closed = true;
    });
    await home.carriers.remove(added.space);
    await until(async () => closed, 5000, 'the carrier to hear it was removed');
    assert.deepEqual(await home.carriers.list(), []);
  });

  test('a device without the account key does not see carriers, and apps cannot write passes', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const home = await device(me, hub);
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    const notes = await home.spaces.create({ name: 'Notes', visibility: 'private' });
    await assert.rejects(home.records.put(notes.id, 'sys.pass', { v: 1 }), /written by the node itself/);
    await assert.rejects(home.records.put(added.space, 'sys.pass', { v: 1 }), /written by the node itself/);
  });
});
