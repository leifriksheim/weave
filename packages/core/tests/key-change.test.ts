/**
 * A private space's key changes when someone loses their place in it: the
 * replay that says when one is due, and real nodes that make it, seal it to
 * each member and take it in — so someone removed reads nothing new, a
 * member who was away catches up, and a newcomer still reads the past.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import { deriveMemberKeyBytes } from '../src/identity/contact-key.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { replayAccess, type AccessEvent, type AccessGenesis, type Role } from '../src/space/roles.js';
import { parseSpaceInvite } from '../src/space/space-manager.js';
import { deriveReadKey, membershipContext } from '../src/space/space-access.js';
import { sealWith, spaceKeyFromRaw, type SpaceKey } from '../src/privacy/space-encryption.js';
import { createClientAuth, type ReadAccess } from '../src/network/peer-auth.js';
import { team } from '../src/space/presets.js';
import { base64UrlDecode } from '../src/utils/encoding.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { joined } from './helpers/joined.js';
import { hold, letGo } from './helpers/hold.js';

const provider = createP256Provider();

// ─── The replay ────────────────────────────────────────────────────

const admin: Role = { name: 'admin', rank: 100, permissions: ['*'] };
const member: Role = { name: 'member', rank: 0, permissions: [] };
const genesis: AccessGenesis = {
  id: 'space',
  creator: 'alice',
  roles: [admin, member],
  creatorRole: 'admin',
  key: { keyId: 'k0', readKey: 'did:key:r0' },
};

let n = 0;
const id = (label: string) => `${label}-${String(n++).padStart(3, '0')}`;
const setRole = (root: string, did: string, role: string | null, seen: string[]): AccessEvent => ({
  id: id('m'),
  key: `member:${did}`,
  kind: 'member',
  root,
  did,
  role,
  seen,
  keep: [],
});
const newKey = (root: string, keyId: string, seen: string[], eventId = id('k')): AccessEvent => ({
  id: eventId,
  key: 'key:space',
  kind: 'key',
  root,
  keyId,
  readKey: `did:key:r-${keyId}`,
  seen,
  keep: [],
});

describe('when a new key is due', () => {
  test('someone losing their place makes one due; a new key by someone who manages clears it', () => {
    const bob = setRole('alice', 'bob', 'member', []);
    assert.equal(replayAccess(genesis, [bob]).current.keyDue, false, 'joining takes nothing away');

    const removed = setRole('alice', 'bob', null, [bob.id]);
    assert.equal(replayAccess(genesis, [bob, removed]).current.keyDue, true);

    const changed = newKey('alice', 'k1', [removed.id]);
    const history = replayAccess(genesis, [bob, removed, changed]);
    assert.equal(history.current.keyDue, false);
    assert.deepEqual(history.current.keys.map((key) => key.keyId), ['k0', 'k1']);
  });

  test('leaving yourself makes one due too', () => {
    const bob = setRole('alice', 'bob', 'member', []);
    const leaves = setRole('bob', 'bob', null, [bob.id]);
    assert.equal(replayAccess(genesis, [bob, leaves]).current.keyDue, true);
  });

  test('only someone who manages the space changes its key, and never back to one used before', () => {
    const bob = setRole('alice', 'bob', 'member', []);
    const byBob = newKey('bob', 'k1', [bob.id]);
    assert.equal(replayAccess(genesis, [bob, byBob]).status(byBob.id)?.status, 'dropped');

    const again = newKey('alice', 'k0', [bob.id]);
    assert.equal(replayAccess(genesis, [bob, again]).status(again.id)?.status, 'dropped');
  });

  test('a public space has no key to change', () => {
    const open: AccessGenesis = { ...genesis, key: undefined };
    const changed = newKey('alice', 'k1', []);
    assert.equal(replayAccess(open, [changed]).status(changed.id)?.status, 'dropped');
    const bob = setRole('alice', 'bob', 'member', []);
    assert.equal(replayAccess(open, [bob, setRole('alice', 'bob', null, [bob.id])]).current.keyDue, false);
  });

  test('two new keys made apart: one wins, the same on every peer', () => {
    const carol = setRole('alice', 'carol', 'admin', []);
    const first = newKey('alice', 'ka', [carol.id], 'k-a');
    const second = newKey('carol', 'kb', [carol.id], 'k-b');
    const orders = [
      [carol, first, second],
      [second, first, carol],
    ];
    const current = orders.map((order) => replayAccess(genesis, order).current.keys.at(-1)!.keyId);
    assert.equal(current[0], current[1]);
    assert.equal(replayAccess(genesis, orders[0]!).current.keys.length, 2, 'the other is dropped');
  });
});

// ─── Real nodes ────────────────────────────────────────────────────

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function person(hub: FakeHub) {
  const manager = createIdentityManager();
  const seed = generateSeed();
  const me = await manager.fromSeed(seed);
  const node = await createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    accountKey: await deriveVaultKeyBytes(seed),
    stores: memoryStores(),
    watchIntervalMs: 0,
    network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
  });
  open.push(node);
  return { node, me, manager, accountKey: await deriveVaultKeyBytes(seed) };
}
type Person = Awaited<ReturnType<typeof person>>;

async function until(predicate: () => Promise<boolean>, ms = 6000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Whether a node reads a note with this text */
const readsOn = async (node: P2PNode, space: string, text: string) =>
  (await node.records.list<{ text: string }>(space, { collection: 'app.note' })).some((note) => note.body?.text === text);
const reads = (who: Person, space: string, text: string) => readsOn(who.node, space, text);

/** Whether a note with this text has reached someone — readable or not */
const holdsNote = async (who: Person, space: string, count: number) =>
  (await who.node.records.list(space, { collection: 'app.note' })).length >= count;

const keyChanges = async (who: Person, space: string) => (await who.node.spaces.access(space)).key;

/** Alice's private team space, with Bob and Carol joined as editors and everyone's profile in */
async function team3() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const carol = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Plans', ...team, visibility: 'private' });
  await hold(alice.node, space);
  for (const who of [bob, carol]) {
    await who.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(who.node, space);
    await joined(who.node, space);
  }
  await alice.node.records.put(space, 'app.note', { text: 'before' });
  for (const who of [bob, carol]) await until(() => reads(who, space, 'before'), 6000, 'the first note');
  return { hub, alice, bob, carol, space };
}

describe('removing someone from a private space', () => {
  test('changes the key by itself: the others read on, the one removed reads nothing new', async () => {
    const { alice, bob, carol, space } = await team3();
    await alice.node.spaces.setMember(space, carol.node.did, null);
    await until(async () => (await keyChanges(alice, space))?.changes === 1, 6000, 'a new key');
    await until(async () => (await keyChanges(bob, space))?.held === true && (await keyChanges(bob, space))?.changes === 1, 6000, 'Bob to get it');

    await bob.node.records.put(space, 'app.note', { text: 'after' });
    await until(() => reads(alice, space, 'after'), 6000, 'Alice to read it');
    // Carol's copy arrives — this hub lets anyone sync — but she can't open it.
    await until(() => holdsNote(carol, space, 2), 6000, 'the note to reach Carol');
    assert.equal(await reads(carol, space, 'after'), false);
    assert.equal((await keyChanges(carol, space))?.held, false);
    // What was written before stays readable to those still in.
    assert.equal(await reads(bob, space, 'before'), true);
  });

  test('a newcomer after the change reads what came before it too', async () => {
    const { hub, alice, carol, space } = await team3();
    await alice.node.spaces.setMember(space, carol.node.did, null);
    await until(async () => (await keyChanges(alice, space))?.changes === 1, 6000, 'a new key');
    await alice.node.records.put(space, 'app.note', { text: 'after' });

    const dave = await person(hub);
    await dave.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(dave.node, space);
    await until(async () => (await reads(dave, space, 'after')) && (await reads(dave, space, 'before')), 6000, 'Dave to read both');
  });

  test('a member who was away catches up: the new key waits for them, sealed to them', async () => {
    const { alice, bob, carol, space } = await team3();
    await letGo(bob.node, space);
    await alice.node.spaces.setMember(space, carol.node.did, null);
    await until(async () => (await keyChanges(alice, space))?.changes === 1, 6000, 'a new key');
    await alice.node.records.put(space, 'app.note', { text: 'while away' });

    await hold(bob.node, space);
    await until(() => reads(bob, space, 'while away'), 6000, 'Bob to catch up');
    // And he writes with the new key, not the one Carol still has.
    await bob.node.records.put(space, 'app.note', { text: 'back' });
    await until(() => holdsNote(carol, space, 3), 6000, 'the note to reach Carol');
    assert.equal(await reads(carol, space, 'back'), false);
  });

  test('someone joining with a link made before the change gets the new key once they are in', async () => {
    const { hub, alice, carol, space } = await team3();
    const oldLink = await alice.node.spaces.invite(space);
    await alice.node.spaces.setMember(space, carol.node.did, null);
    await until(async () => (await keyChanges(alice, space))?.changes === 1, 6000, 'a new key');
    await alice.node.records.put(space, 'app.note', { text: 'after' });

    const erin = await person(hub);
    await erin.node.spaces.join(oldLink);
    await hold(erin.node, space);
    await joined(erin.node, space);
    await until(() => reads(erin, space, 'after'), 6000, 'Erin to read the new note');
  });

  test('a public space has no key to change', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Open', ...team, visibility: 'public' });
    assert.equal((await alice.node.spaces.access(space)).key, null);
    await assert.rejects(alice.node.spaces.changeKey(space), /public space has no key/);
  });

  test('only someone who manages the space changes its key by hand', async () => {
    const { bob, space } = await team3();
    await assert.rejects(bob.node.spaces.changeKey(space), /Only someone who manages/);
  });
});

describe('proving you may read, after the key changed', () => {
  /** A session key for someone, with the note that makes it theirs */
  async function session(who: Person, space: string) {
    const pair = await provider.generateKeyPair();
    const did = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
    const note = await createLocalRootSigner(who.me, who.manager.getProvider()).delegate({
      audience: did,
      capabilities: [{ with: `space:${space}`, can: 'expression/write' }],
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    return { did, key: pair.privateKey, note: note.encoded };
  }

  /** A reader holding `key`, sending its note sealed with it when `sendNote` */
  function reader(space: string, key: SpaceKey, note: string | null): ReadAccess {
    return {
      key: () => deriveReadKey(key, provider),
      current: () => 'did:key:not-this-one',
      membership: async () => (note ? sealWith(key, note, membershipContext(space)) : null),
    };
  }

  test('the current key lets you in; an old one only with a note from someone still a member', async () => {
    const { alice, bob, carol, space } = await team3();
    const oldKey = await spaceKeyFromRaw(base64UrlDecode(parseSpaceInvite(await alice.node.spaces.invite(space, { write: false })).key!));
    await alice.node.spaces.setMember(space, carol.node.did, null);
    await until(async () => (await keyChanges(alice, space))?.changes === 1, 6000, 'a new key');
    const newKey = await spaceKeyFromRaw(base64UrlDecode(parseSpaceInvite(await alice.node.spaces.invite(space, { write: false })).key!));
    assert.notEqual(newKey.id, oldKey.id);

    const server = (await alice.node.spaces.authenticator(space))!;
    const nodeDid = 'did:key:zNode';
    const tries = async (who: Person, key: SpaceKey, withNote: boolean) => {
      const me = await session(who, space);
      const read = reader(space, key, withNote ? me.note : null);
      const hello = await createClientAuth(space, { did: me.did, key: me.key }, read, provider).hello(me.did, nodeDid, 'nonce');
      return server.checkHello(me.did, nodeDid, 'nonce', hello);
    };

    assert.equal(await tries(bob, newKey, false), true, 'the current key');
    assert.equal(await tries(bob, oldKey, true), true, 'an old key, from a member');
    assert.equal(await tries(bob, oldKey, false), false, 'an old key alone — a view-only link from before, say');
    assert.equal(await tries(carol, oldKey, true), false, 'an old key, from someone removed');
  });
});

describe('everything else that holds a space follows its new key', () => {
  test('an app given one space by its home — no account key, just that space’s member key — gets the next key', async () => {
    const { hub, alice, bob, carol, space } = await team3();
    // Bob's app: his identity, no account key, the space's member key from his home.
    const seedless = await createNode({
      signer: createLocalRootSigner(bob.me, bob.manager.getProvider()),
      stores: memoryStores(),
      watchIntervalMs: 0,
      network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
    });
    open.push(seedless);
    await seedless.spaces.join(await bob.node.spaces.invite(space, { write: false }), {
      memberKey: await deriveMemberKeyBytes(bob.accountKey, space),
    });
    await letGo(bob.node, space);
    await seedless.spaces.hold(space);

    await alice.node.spaces.setMember(space, carol.node.did, null);
    await alice.node.records.put(space, 'app.note', { text: 'after' });
    await until(() => readsOn(seedless, space, 'after'), 6000, 'the app to read the new note');
  });

  test('a carrier gets a new pass, proving the new read key', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Notes', visibility: 'private' });
    const added = await alice.node.carriers.add({ did: 'did:key:zCarrier', name: 'Chrome' });
    const passReadKey = async () => {
      const passes = await alice.node.records.list<{ space: { id: string }; readKey?: string }>(added.space, { collection: 'sys.pass' });
      return passes.find((pass) => pass.body?.space.id === space)?.body?.readKey ?? null;
    };
    await until(async () => (await alice.node.records.list(added.space, { collection: 'sys.pass' })).length > 0, 6000, 'the passes');
    assert.equal(await passReadKey(), null, 'the first key: the space vouches for it');

    await alice.node.spaces.changeKey(space);
    const key = await spaceKeyFromRaw(base64UrlDecode(parseSpaceInvite(await alice.node.spaces.invite(space, { write: false })).key!));
    const readKey = (await deriveReadKey(key, provider)).did;
    await until(async () => (await passReadKey()) === readKey, 6000, 'the pass to carry the new read key');
  });
});
