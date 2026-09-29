/**
 * Calls (`weave-protocol/calls`): set up by live messages in a space, a
 * connection of their own between each pair of people, and only for the
 * space's members.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createCalls, type Calls, type CallsOptions } from '../src/calls/calls.js';
import { call as callSchema } from '../src/schemas/index.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import { joined } from './helpers/joined.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { fakeConnection, fakeDisplayMedia, fakeStream, fakeUserMedia } from './helpers/fake-rtc.js';
import { team } from '../src/space/presets.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { isObject } from '../src/utils/guards.js';

const nodes: P2PNode[] = [];
const allCalls: Calls[] = [];
afterEach(async () => {
  await Promise.all(allCalls.splice(0).map((calls) => calls.close()));
  await Promise.all(nodes.splice(0).map((node) => node.close()));
});

const OPTIONS: CallsOptions = {
  createConnection: fakeConnection,
  getUserMedia: fakeUserMedia,
  getDisplayMedia: fakeDisplayMedia,
  createStream: (tracks) => fakeStream(tracks),
  storage: null,
  heartbeatMs: 100,
  goneMs: 400,
  ringMs: 600,
};

/** @param loseSignal The first offer or answer this person sends is lost on the way */
async function person(hub: FakeHub, seed = generateSeed(), loseSignal = false) {
  const manager = createIdentityManager();
  const me = await manager.fromSeed(seed);
  const node = await createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    stores: memoryStores(),
    accountKey: await deriveVaultKeyBytes(seed),
    watchIntervalMs: 0,
    network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
  });
  nodes.push(node);
  let lost = !loseSignal;
  const lossy: P2PNode = {
    ...node,
    spaces: {
      ...node.spaces,
      send: async (space, message, to) => {
        if (lost || !isObject(message) || message.type !== 'call.signal' || !message.description)
          return node.spaces.send(space, message, to);
        lost = true;
      },
    },
  };
  const calls = createCalls(lossy, OPTIONS);
  allCalls.push(calls);
  return { node, calls, seed };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Alice and Bob as editors of one private space that keeps call history, both connected; Carol can only read it */
async function space(options: { reader?: boolean; losesSignal?: 'alice' | 'bob' } = {}) {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub, generateSeed(), options.losesSignal === 'alice');
  const bob = await person(hub, generateSeed(), options.losesSignal === 'bob');
  const { id } = await alice.node.spaces.create({ name: 'Us', ...team, visibility: 'private' });
  await alice.node.collections.define(id, callSchema);
  await bob.node.spaces.join(await alice.node.spaces.invite(id, { role: 'editor' }));
  await joined(bob.node, id);
  let carol: Awaited<ReturnType<typeof person>> | null = null;
  if (options.reader) {
    carol = await person(hub);
    await carol.node.spaces.join(await alice.node.spaces.invite(id, { write: false }));
    await until(
      async () => (await carol!.node.spaces.list()).some((s) => s.id === id && !s.joining),
      4000,
      'Carol to join',
    );
  }
  const everyone = [alice, bob, ...(carol ? [carol] : [])];
  // Their screens have the space open.
  for (const who of everyone) await hold(who.node, id);
  for (const who of everyone) {
    await until(
      async () => Object.keys((await who.node.spaces.status(id)).accounts).length === everyone.length - 1,
      4000,
      'everyone to connect',
    );
  }
  return { hub, alice, bob, carol: carol!, space: id };
}

const peopleIn = (calls: Calls) => calls.getState().current?.people ?? [];
const connected = (calls: Calls) =>
  peopleIn(calls).filter((p) => p.connection === 'connected' && p.stream !== null);

describe('calls', () => {
  test('a call started in a space shows to the others there, and joining it connects both ways', async () => {
    const { alice, bob, space: id } = await space();
    await alice.calls.start(id);
    await until(
      () => bob.calls.getState().around.some((c) => c.space === id && c.people.includes(alice.node.did)),
      4000,
      'Bob to see the call',
    );
    const going = bob.calls.getState().around[0]!;

    await bob.calls.start(id);
    assert.equal(bob.calls.getState().current?.id, going.id, 'Bob joined the call going on, not a new one');
    await until(
      () => connected(alice.calls).length === 1 && connected(bob.calls).length === 1,
      4000,
      'both to connect',
    );
    assert.equal(peopleIn(alice.calls)[0]!.account, bob.node.did);
    assert.equal(peopleIn(bob.calls)[0]!.account, alice.node.did);
    assert.equal(bob.calls.getState().around.length, 0, 'the call you are in is not "around"');
  });

  test('ringing one person: they hear it, answer, and the caller stops ringing', async () => {
    const { alice, bob, space: id } = await space();
    await alice.calls.ring(id, bob.node.did);
    assert.equal(alice.calls.getState().current?.outgoing?.state, 'ringing');
    await until(() => bob.calls.getState().ringing.length === 1, 4000, 'Bob’s phone to ring');
    const ring = bob.calls.getState().ringing[0]!;
    assert.equal(ring.from, alice.node.did);
    assert.equal(ring.space, id);

    await bob.calls.answer(ring.id);
    assert.equal(bob.calls.getState().ringing.length, 0);
    await until(() => alice.calls.getState().current?.outgoing === null, 4000, 'Alice to hear the answer');
    await until(
      () => connected(alice.calls).length === 1 && connected(bob.calls).length === 1,
      4000,
      'both to connect',
    );
  });

  test('joining the call you are being rung for answers it, however you join', async () => {
    const { alice, bob, space: id } = await space();
    await alice.calls.ring(id, bob.node.did);
    await until(() => bob.calls.getState().ringing.length === 1, 4000, 'Bob’s phone to ring');

    // Bob uses "Join call" in the space rather than the ring's own button.
    await bob.calls.start(id);
    assert.equal(bob.calls.getState().ringing.length, 0, 'the ringing stops');
    await until(() => alice.calls.getState().current?.outgoing === null, 4000, 'Alice to stop ringing');
    await until(() => connected(alice.calls).length === 1, 4000, 'both to connect');
  });

  test('a ring that arrives again after it was answered does not ring again', async () => {
    const { alice, bob, space: id } = await space();
    await alice.calls.ring(id, bob.node.did);
    await until(() => bob.calls.getState().ringing.length === 1, 4000, 'the ring');
    const { id: call } = bob.calls.getState().ringing[0]!;
    await bob.calls.answer(call);
    await bob.calls.leave();
    // The same ring, delivered a second time.
    await alice.node.spaces.send(id, { type: 'call.ring', call }, bob.node.did);
    await settle(200);
    assert.equal(bob.calls.getState().ringing.length, 0);
  });

  test('a ring stops when the caller is gone without saying so', async () => {
    const { alice, bob, space: id } = await space();
    // Rings for a minute, so only the caller being gone can stop it in time.
    const patient = createCalls(bob.node, { ...OPTIONS, ringMs: 60_000 });
    allCalls.push(patient);
    // A ring from nobody who is in a call: as if the caller's page closed at once.
    await alice.node.spaces.send(id, { type: 'call.ring', call: 'vanished' }, bob.node.did);
    await until(() => patient.getState().ringing.length === 1, 4000, 'the ring');
    await until(() => patient.getState().ringing.length === 0, 4000, 'the ringing to stop');
  });

  test('a declined ring ends a call nobody else is in', async () => {
    const { alice, bob, space: id } = await space();
    await alice.calls.ring(id, bob.node.did);
    await until(() => bob.calls.getState().ringing.length === 1, 4000, 'the ring');
    await bob.calls.decline(bob.calls.getState().ringing[0]!.id);
    await until(
      () => alice.calls.getState().current?.outgoing?.state === 'declined',
      4000,
      'Alice to hear it',
    );
    await until(() => alice.calls.getState().current === null, 5000, 'the call to end');
  });

  test('a ring nobody answers stops, and leaves a missed call in the space', async () => {
    const { alice, bob, space: id } = await space();
    await alice.calls.ring(id, bob.node.did);
    await until(() => bob.calls.getState().ringing.length === 1, 4000, 'the ring');
    await until(() => bob.calls.getState().ringing.length === 0, 4000, 'the ringing to stop');
    await until(
      async () => (await bob.node.records.list(id, { collection: 'std.call' })).length === 1,
      4000,
      'the missed call to reach Bob',
    );
    const missed = (
      await bob.node.records.list<{ status: string; to: string }>(id, { collection: 'std.call' })
    )[0]!;
    assert.equal(missed.body?.status, 'missed');
    assert.equal(missed.body?.to, bob.node.did);
    assert.equal(missed.root, alice.node.did);
  });

  test('the last one to leave writes down who was in the call', async () => {
    const { alice, bob, space: id } = await space();
    await alice.calls.start(id);
    await until(() => bob.calls.getState().around.length === 1, 4000, 'the call');
    await bob.calls.start(id);
    await until(() => connected(alice.calls).length === 1, 4000, 'both to connect');

    await bob.calls.leave();
    await until(() => peopleIn(alice.calls).length === 0, 4000, 'Alice to see Bob go');
    assert.equal(
      (await alice.node.records.list(id, { collection: 'std.call' })).length,
      0,
      'Bob left someone behind, so wrote nothing',
    );
    await alice.calls.leave();
    await until(
      async () => (await bob.node.records.list(id, { collection: 'std.call' })).length === 1,
      4000,
      'the record',
    );
    const ended = (
      await bob.node.records.list<{ status: string; people: string[] }>(id, { collection: 'std.call' })
    )[0]!;
    assert.equal(ended.body?.status, 'ended');
    assert.deepEqual([...ended.body.people].sort(), [alice.node.did, bob.node.did].sort());
  });

  test('the call goes on when the screen showing its space closes it', async () => {
    const { alice, bob, space: id } = await space();
    await alice.calls.start(id);
    await until(() => bob.calls.getState().around.length === 1, 4000, 'the call');
    await bob.calls.start(id);
    await until(() => connected(bob.calls).length === 1, 4000, 'both to connect');

    // Both move to another space: their screens close this one.
    await letGo(alice.node, id);
    await letGo(bob.node, id);
    await settle(600);
    assert.equal(connected(alice.calls).length, 1, 'still hearing Bob after he would have gone quiet');
    assert.equal(connected(bob.calls).length, 1);
    assert.equal(
      (await alice.node.spaces.status(id)).peers.length,
      1,
      'the space is still open for the call',
    );
  });

  test('a view-only reader is not let into the call', async () => {
    const { alice, carol, space: id } = await space({ reader: true });
    await alice.calls.start(id);
    await until(() => carol.calls.getState().around.length === 1, 4000, 'Carol to see the call');
    await carol.calls.start(id);
    await settle(500);
    assert.equal(peopleIn(alice.calls).length, 0, 'Alice never counts Carol in');
    assert.equal(connected(carol.calls).length, 0, 'and no connection is made');
    assert.equal(alice.calls.getState().around.length, 0);
  });

  // Whichever of the two offers, one of them loses the offer or the answer.
  for (const loser of ['alice', 'bob'] as const)
    test(`a lost offer or answer is made again (${loser} loses one)`, async () => {
      const { alice, bob, space: id } = await space({ losesSignal: loser });
      await alice.calls.start(id);
      await until(() => bob.calls.getState().around.length === 1, 4000, 'the call');
      await bob.calls.start(id);
      await until(
        () => connected(alice.calls).length === 1 && connected(bob.calls).length === 1,
        4000,
        'both to connect',
      );
    });

  test('one account can only ring you a few times a minute', async () => {
    const { alice, bob, space: id } = await space();
    for (let i = 0; i < 6; i++)
      await alice.node.spaces.send(id, { type: 'call.ring', call: `ring-${i}` }, bob.node.did);
    await settle(200);
    assert.equal(bob.calls.getState().ringing.length, 3);
  });

  test('muting and the camera are told to the others', async () => {
    const { alice, bob, space: id } = await space();
    await alice.calls.start(id);
    await until(() => bob.calls.getState().around.length === 1, 4000, 'the call');
    await bob.calls.start(id);
    await until(() => connected(bob.calls).length === 1, 4000, 'both to connect');

    alice.calls.setMuted(true);
    await alice.calls.setCamera(true);
    await until(
      () => peopleIn(bob.calls)[0]?.muted === true && peopleIn(bob.calls)[0]?.camera === true,
      4000,
      'Bob to see it',
    );
    assert.equal(alice.calls.getState().current?.camera, true);
    await alice.calls.shareScreen();
    assert.equal(alice.calls.getState().current?.sharing, true);
    await alice.calls.stopSharing();
    assert.equal(alice.calls.getState().current?.sharing, false);
    assert.equal(alice.calls.getState().current?.camera, true, 'the camera comes back after sharing');
  });
});
