/**
 * Where a space's members meet: the relays the space names (`sys.relays`),
 * set by whoever manages it and carried in its invites — so two people whose
 * apps use different relays still find each other.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { checkRelays, replayAccess, type AccessEvent, type AccessGenesis, type Role } from '../src/space/roles.js';
import { parseSpaceInvite } from '../src/space/space-manager.js';
import { team } from '../src/space/presets.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { joined } from './helpers/joined.js';
import { hold } from './helpers/hold.js';

const admin: Role = { name: 'admin', rank: 100, permissions: ['*'] };
const member: Role = { name: 'member', rank: 0, permissions: [] };
const genesis: AccessGenesis = { id: 'space', creator: 'alice', roles: [admin, member], creatorRole: 'admin' };

let n = 0;
const named = (root: string, relays: string[], seen: string[] = []): AccessEvent => ({
  id: `r-${String(n++).padStart(3, '0')}`,
  key: 'relays:space',
  kind: 'relays',
  root,
  relays,
  seen,
  keep: [],
});

describe('a space’s relays, in its history', () => {
  test('someone who manages the space names them; anyone else is ignored', () => {
    const bob: AccessEvent = { id: 'm-bob', key: 'member:bob', kind: 'member', root: 'alice', did: 'bob', role: 'member', seen: [], keep: [] };
    const byAlice = named('alice', ['wss://relay.one.test'], [bob.id]);
    const byBob = named('bob', ['wss://relay.bob.test'], [byAlice.id]);
    const history = replayAccess(genesis, [bob, byAlice, byBob]);
    assert.deepEqual(history.current.relays, ['wss://relay.one.test']);
    assert.equal(history.status(byBob.id)?.status, 'dropped');
  });

  test('only wss:// relays, plain ws:// on this machine alone, at most eight, none twice', () => {
    assert.equal(checkRelays(['wss://relay.one.test', 'ws://localhost:8787']), null);
    assert.match(checkRelays(['ws://relay.one.test'])!, /not a wss/);
    assert.match(checkRelays(['https://relay.one.test'])!, /not a wss/);
    assert.match(checkRelays(['wss://a.test', 'wss://a.test'])!, /twice/);
    assert.match(checkRelays(Array.from({ length: 9 }, (_, i) => `wss://r${i}.test`))!, /at most 8/);
    const bad = named('alice', ['ws://relay.one.test']);
    assert.equal(replayAccess(genesis, [bad]).status(bad.id)?.status, 'dropped');
  });
});

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

/** Someone whose app meets on `relays` — and, in this test, on a shared fake hub too */
async function person(hub: FakeHub, relays: string[]) {
  const manager = createIdentityManager();
  const me = await manager.fromSeed(generateSeed());
  const node = await createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    stores: memoryStores(),
    watchIntervalMs: 0,
    network: { relays, transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
  });
  open.push(node);
  return node;
}

async function until(predicate: () => Promise<boolean>, ms = 5000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const relaysOf = async (node: P2PNode, space: string) => (await node.spaces.access(space)).relays;

describe('a space’s relays, through real nodes', () => {
  test('a new space names its creator’s relays by itself, and its invites carry them', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub, ['wss://relay.alice.test']);
    const { id: space } = await alice.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    await hold(alice, space);
    await until(async () => (await relaysOf(alice, space)).length === 1, 5000, 'the space to name a relay');
    assert.deepEqual(await relaysOf(alice, space), ['wss://relay.alice.test']);
    assert.deepEqual(parseSpaceInvite(await alice.spaces.invite(space)).relays, ['wss://relay.alice.test']);
  });

  test('someone whose app uses another relay joins the space’s — from the invite at once, then from the space', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub, ['wss://relay.alice.test']);
    const bob = await person(hub, ['wss://relay.bob.test']);
    const { id: space } = await alice.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    await hold(alice, space);
    await until(async () => (await relaysOf(alice, space)).length === 1, 5000, 'the space to name a relay');

    await bob.spaces.join(await alice.spaces.invite(space));
    assert.deepEqual(await relaysOf(bob, space), ['wss://relay.alice.test'], 'from the invite, before any sync');
    await hold(bob, space);
    await joined(bob, space);
    // Bob does not manage the space, so his own relays never replace the space's.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await relaysOf(bob, space), ['wss://relay.alice.test']);

    // Moving the space moves everyone.
    await alice.spaces.setRelays(space, ['wss://relay.new.test', 'wss://relay.alice.test']);
    await until(async () => (await relaysOf(bob, space)).length === 2, 5000, 'Bob to hear of the new relays');
    // And what he invites people with names them too.
    assert.deepEqual(parseSpaceInvite(await bob.spaces.invite(space, { write: false })).relays, ['wss://relay.new.test', 'wss://relay.alice.test']);
  });

  test('only someone who manages the space says where it meets, and only somewhere a space may', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub, ['wss://relay.alice.test']);
    const bob = await person(hub, ['wss://relay.bob.test']);
    const { id: space } = await alice.spaces.create({ name: 'Trip', ...team, visibility: 'public' });
    await hold(alice, space);
    await bob.spaces.join(await alice.spaces.invite(space));
    await hold(bob, space);
    await joined(bob, space);
    await assert.rejects(bob.spaces.setRelays(space, ['wss://relay.bob.test']), /may not change where the space meets/);
    await assert.rejects(alice.spaces.setRelays(space, ['http://relay.test']), /not a wss/);
  });
});
