/**
 * Live messages (`spaces.send`): reach who is connected now, are kept
 * nowhere, and say which account sent them — and spaces opened by two callers
 * stay open until both close them.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { LiveMessage, P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { utf8Encode } from '../src/utils/encoding.js';
import { joined } from './helpers/joined.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function person(hub: FakeHub, stores = memoryStores()) {
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
  return { node, stores };
}

async function until(predicate: () => boolean | Promise<boolean>, ms = 4000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every live message a node hears, in order */
function inbox(node: P2PNode): Array<LiveMessage & { space: string }> {
  const heard: Array<LiveMessage & { space: string }> = [];
  node.subscribe((event) => {
    if (event.type === 'message') heard.push(event);
  });
  return heard;
}

/** Alice, Bob and Carol in one private space, all connected and each known to the others as an account */
async function threeInASpace() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const carol = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Book club', ...team, visibility: 'private' });
  for (const other of [bob, carol]) {
    await other.node.spaces.join(await alice.node.spaces.invite(space, { role: 'editor' }));
    await joined(other.node, space);
  }
  for (const who of [alice, bob, carol]) await who.node.spaces.open(space);
  for (const who of [alice, bob, carol]) {
    await until(async () => Object.keys((await who.node.spaces.status(space)).accounts).length === 2, 4000, 'everyone to know everyone');
  }
  return { hub, alice, bob, carol, space };
}

describe('live messages', () => {
  test('reach everyone connected, from the sending account, and are kept nowhere', async () => {
    const { alice, bob, carol, space } = await threeInASpace();
    const bobHeard = inbox(bob.node);
    const carolHeard = inbox(carol.node);

    await alice.node.spaces.send(space, { type: 'typing' });
    await until(() => bobHeard.length === 1 && carolHeard.length === 1, 4000, 'the message');

    assert.deepEqual(bobHeard[0]!.message, { type: 'typing' });
    assert.equal(bobHeard[0]!.from, alice.node.did);
    assert.equal(bobHeard[0]!.peer, alice.node.sessionDid);
    assert.equal(bobHeard[0]!.agent, false);
    assert.equal(bobHeard[0]!.space, space);
    // Nothing written, on either side.
    for (const who of [alice, bob]) {
      const kept = await who.node.records.list(space);
      assert.equal(kept.some((record) => JSON.stringify(record.body).includes('typing')), false);
    }
  });

  test('sent to one account, a third member never receives it', async () => {
    const { alice, bob, carol, space } = await threeInASpace();
    const bobHeard = inbox(bob.node);
    const carolHeard = inbox(carol.node);

    await alice.node.spaces.send(space, 'for Bob', bob.node.did);
    await until(() => bobHeard.length === 1, 4000, 'Bob to hear it');
    await settle(100);
    assert.equal(carolHeard.length, 0);

    // One device, by its session DID.
    await alice.node.spaces.send(space, 'for Carol’s device', carol.node.sessionDid);
    await until(() => carolHeard.length === 1, 4000, 'Carol to hear it');
    await settle(100);
    assert.equal(bobHeard.length, 1);
  });

  test('a live message over 64 KB is refused', async () => {
    const { alice, space } = await threeInASpace();
    await assert.rejects(alice.node.spaces.send(space, 'x'.repeat(70_000)), /64 KB/);
  });

  test('a peer showing someone else’s note is known as nobody', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Open', ...team, visibility: 'public' });
    await alice.node.spaces.open(space);
    const heard = inbox(alice.node);

    // Mallory holds a session key of her own, and a note she copied off one of Alice's records.
    const manager = createIdentityManager();
    const mallory = await manager.fromSeed(generateSeed());
    const copied = alice.node.delegation().encoded;
    const wire = hub.transport(mallory.did, space);
    await wire.connect?.();
    await until(async () => (await alice.node.spaces.status(space)).peers.includes(mallory.did), 4000, 'Mallory to connect');
    const say = (type: string, payload: unknown) => wire.send(alice.node.sessionDid, utf8Encode(JSON.stringify({ type, from: mallory.did, payload })));
    say('who', { note: copied });
    say('live', { type: 'call.ring' });

    await until(() => heard.length === 1, 4000, 'the message');
    assert.equal(heard[0]!.from, null, 'the note was made out to Alice’s key, not Mallory’s');
    assert.deepEqual((await alice.node.spaces.status(space)).accounts, {});
    wire.closeAll();
  });

  test('a peer that floods live messages is cut off after its allowance', async () => {
    const hub = createFakeHub({ latencyMs: 0 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Open', ...team, visibility: 'public' });
    await alice.node.spaces.open(space);
    const heard = inbox(alice.node);
    const manager = createIdentityManager();
    const mallory = await manager.fromSeed(generateSeed());
    const wire = hub.transport(mallory.did, space);
    await wire.connect?.();
    await until(async () => (await alice.node.spaces.status(space)).peers.includes(mallory.did), 4000, 'Mallory to connect');
    for (let i = 0; i < 500; i++) wire.send(alice.node.sessionDid, utf8Encode(JSON.stringify({ type: 'live', from: mallory.did, payload: i })));
    await settle(200);
    assert.ok(heard.length < 100, `heard ${heard.length}`);
    wire.closeAll();
  });
});

describe('opening a space twice', () => {
  test('it stays open until both callers close it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Call', ...team, visibility: 'private' });
    await bob.node.spaces.join(await alice.node.spaces.invite(space, { role: 'editor' }));
    await joined(bob.node, space);
    await alice.node.spaces.open(space);

    // A screen and a call.
    await bob.node.spaces.open(space);
    await bob.node.spaces.open(space);
    await until(async () => (await alice.node.spaces.status(space)).peers.length === 1, 4000, 'Bob to connect');

    await bob.node.spaces.close(space);
    await settle(100);
    assert.equal((await alice.node.spaces.status(space)).peers.length, 1, 'one close leaves it open');
    const note = await alice.node.records.put(space, 'app.note', { text: 'still here' });
    await until(async () => (await createStorageProvider(await bob.stores(`spaces/${space}`)).getExpression(note.version)) !== null, 4000, 'the write to reach Bob');

    await bob.node.spaces.close(space);
    await until(async () => (await alice.node.spaces.status(space)).peers.length === 0, 4000, 'Bob to go');
  });
});
