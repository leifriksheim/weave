/**
 * Who may write in a space, through real nodes: members by role, invites that
 * open and close, removal that holds even against old dates, revoked notes,
 * handing over — and a node with no secret at all reaching the same verdict
 * as a member.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { createSpaceManager, parseSpaceInvite } from '../src/space/space-manager.js';
import { checkSpace, deriveInviteKey, deriveReadKey, generateInviteSecret, signInvite, verifyInvite } from '../src/space/space-access.js';
import { community, team } from '../src/space/presets.js';
import type { Expression } from '../src/types.js';
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from '../src/utils/encoding.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { joined } from './helpers/joined.js';
import { hold, letGo } from './helpers/hold.js';

const provider = createP256Provider();

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

/** A record signed by hand with a valid session and delegation, claiming to have seen `seen` */
async function forge(who: Person, space: string, body: unknown, seen: ReadonlyArray<string> = []): Promise<Expression> {
  const pair = await provider.generateKeyPair();
  const keyDid = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  const ucan = await createLocalRootSigner(who.me, who.manager.getProvider()).delegate({
    audience: keyDid,
    capabilities: [{ with: `space:${space}`, can: 'expression/write' }],
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  return createSigner(provider).sign(createExpression({ author: keyDid, collection: 'app.note', space, body, proof: ucan.encoded, seen }), pair.privateKey);
}

/** Rewrites an invite, as whoever passes it along could */
function tamper(invite: string, change: (parsed: Record<string, any>) => void): string {
  const parsed = JSON.parse(utf8Decode(base64UrlDecode(invite)));
  change(parsed);
  return base64UrlEncode(utf8Encode(JSON.stringify(parsed)));
}

/** A space shared with Bob as an Editor, synced both ways */
async function sharedWithBob() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Plans', ...team, visibility: 'public' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await hold(alice.node, space);
  await joined(bob.node, space);
  return { hub, alice, bob, space };
}

describe('space access: the keys', () => {
  test('derivation is fixed — a known secret gives a known key, and never an account’s', async () => {
    const secret = new Uint8Array(32).map((_, i) => i);
    const inviteDid = (await deriveInviteKey(secret, provider)).did;
    assert.equal(inviteDid, (await deriveInviteKey(secret, provider)).did);
    const aes = await crypto.subtle.importKey('raw', new Uint8Array(32).map((_, i) => 255 - i), { name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    assert.equal((await deriveReadKey({ id: 'k', key: aes, createdAt: '', version: 1 }, provider)).did, 'did:key:zDnaem2ikLwS3eYm46gspC7nm6dmYYCMHUHU5yvVHNgARcsWf');
    // The same bytes as an account seed give a different key: each use has its own label.
    assert.notEqual((await createIdentityManager().fromSeed(secret)).did, inviteDid);
  });

  test('an invite signature lets one account join one space — and nobody else, nowhere else', async () => {
    const invite = await deriveInviteKey(generateInviteSecret(), provider);
    const signature = await signInvite('space-a', 'did:key:zBob', invite, provider);
    assert.equal(await verifyInvite('space-a', 'did:key:zBob', invite.did, signature, provider), true);
    assert.equal(await verifyInvite('space-b', 'did:key:zBob', invite.did, signature, provider), false);
    assert.equal(await verifyInvite('space-a', 'did:key:zMallory', invite.did, signature, provider), false);
    const other = await deriveInviteKey(generateInviteSecret(), provider);
    assert.equal(await verifyInvite('space-a', 'did:key:zBob', other.did, signature, provider), false);
  });
});

describe('space access: the space vouches for itself', () => {
  test('a created space checks out, and its id does not depend on its name', async () => {
    const registry = createSpaceManager(createMemoryAdapter(), provider);
    const { space } = await registry.create({ name: 'Trip', ...team, visibility: 'private', creator: 'did:key:zAlice' });
    assert.equal(await checkSpace(space), null);
    assert.equal(await checkSpace({ ...space, name: 'Renamed' }), null);
    assert.match(String(await checkSpace({ ...space, creator: 'did:key:zMallory' })), /id does not match/);
    assert.match(String(await checkSpace({ ...space, creatorRole: 'editor' })), /id does not match/);
    assert.match(String(await checkSpace({ ...space, roles: [...space.roles, { name: 'x', rank: 1000, permissions: ['*'] }] })), /id does not match/);
    assert.match(String(await checkSpace({ ...space, creatorRole: 'nobody' })), /not one of the starting roles/);
  });

  test('a forged invite is refused: changed creator, changed roles', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    const invite = await alice.node.spaces.invite(space);

    await assert.rejects(bob.node.spaces.join(tamper(invite, (p) => (p.space.creator = bob.node.did))), /does not describe a real space/);
    await assert.rejects(bob.node.spaces.join(tamper(invite, (p) => (p.space.creatorRole = 'editor'))), /does not describe a real space/);
    assert.equal((await bob.node.spaces.list()).length, 0);
  });

  test('a key that is not the space’s opens nothing — a later key is taken on trust until the history names it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    await alice.node.records.put(space, 'app.note', { text: 'secret' });
    const invite = await alice.node.spaces.invite(space, { write: false });

    await bob.node.spaces.join(tamper(invite, (p) => (p.key = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))))));
    await hold(alice.node, space);
    await hold(bob.node, space);
    await until(async () => (await bob.node.records.list(space, { collection: 'app.note' })).length === 1, 4000, 'the note to arrive');
    const [note] = await bob.node.records.list(space, { collection: 'app.note' });
    assert.equal(note!.body, null);
    assert.equal((await bob.node.spaces.access(space)).key?.held, false);
  });
});

describe('space access: who may write', () => {
  test('a stranger who knows the space cannot write in it — every peer refuses, and nobody stores it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const mallory = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Trip', ...team, visibility: 'public' });
    await alice.node.records.put(space, 'app.note', { text: 'from Alice' });
    // Mallory can follow — she was given a view-only invite — and so can reach the space.
    await mallory.node.spaces.join(await alice.node.spaces.invite(space, { write: false }));
    assert.equal((await mallory.node.spaces.get(space))?.writable, false);
    await assert.rejects(mallory.node.records.put(space, 'app.note', { text: 'spam' }), /shared with you to view/);

    // She forges a record anyway: valid account, valid session, no role.
    await letGo(mallory.node, space);
    const forged = await forge(mallory, space, { text: 'spam' });
    await createStorageProvider(await mallory.stores(`spaces/${space}`)).addExpression(forged);

    const reasons: string[] = [];
    alice.node.subscribe((event) => {
      if (event.type === 'rejected') reasons.push(event.reason);
    });
    await hold(mallory.node, space);
    await until(async () => reasons.length >= 1, 4000, 'Alice to refuse it');
    assert.ok(reasons.some((r) => /not a member/.test(r)));
    assert.equal(await createStorageProvider(await alice.stores(`spaces/${space}`)).getExpression(forged.id), null);
    // Mallory still reads what Alice wrote.
    await until(
      async () => (await mallory.node.records.list(space)).some((r) => (r.body as { text?: string })?.text === 'from Alice'),
      4000,
      'Alice’s note to reach Mallory',
    );
  });

  test('a node with no secret at all reaches the same verdict as a member', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const mallory = await person(hub);
    const blind = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    const written = await alice.node.records.put(space, 'app.note', { text: 'secret' });

    // The blind node holds the space as anyone could be handed it: no key, no role.
    await blind.node.spaces.join(tamper(await alice.node.spaces.invite(space, { write: false }), (p) => delete p.key));
    await hold(blind.node, space);
    await until(async () => (await createStorageProvider(await blind.stores(`spaces/${space}`)).getExpression(written.version)) !== null, 4000, 'the note');

    // A stranger's record, sealed-looking, reaches it — and is refused, as the member refuses it.
    await mallory.node.spaces.join(tamper(await alice.node.spaces.invite(space, { write: false }), (p) => delete p.key));
    await letGo(mallory.node, space);
    const stranger = await forge(mallory, space, { ciphertext: 'x', iv: 'y' });
    await createStorageProvider(await mallory.stores(`spaces/${space}`)).addExpression(stranger);
    const refused: string[] = [];
    blind.node.subscribe((event) => {
      if (event.type === 'rejected') refused.push(event.reason);
    });
    await hold(mallory.node, space);
    await until(async () => refused.length > 0, 4000, 'the blind node to refuse it');
    assert.equal(await createStorageProvider(await blind.stores(`spaces/${space}`)).getExpression(stranger.id), null);
    assert.equal((await blind.node.records.get(space, written.key))?.verified, true, 'the member’s record stands, unread');
  });

  test('just the creator: they write, anyone invited follows and reads', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const carol = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Blog', visibility: 'public' });
    const post = await alice.node.records.put(space, 'app.post', { text: 'hello' });
    // No role below the creator's: an invite is view-only.
    const invite = await alice.node.spaces.invite(space);
    assert.equal(parseSpaceInvite(invite).invite, undefined);
    await carol.node.spaces.join(invite);
    assert.equal((await carol.node.spaces.get(space))?.writable, false);
    await until(async () => (await carol.node.records.get(space, post.key)) !== null, 4000, 'the post');
  });
});

describe('space access: invites', () => {
  test('an invite gives the lowest role below yours, once its record reaches the joiner', async () => {
    const { alice, bob, space } = await sharedWithBob();
    const access = await bob.node.spaces.access(space);
    assert.equal(access.role?.name, 'editor');
    assert.deepEqual(access.members.map((m) => m.role).sort(), ['editor', 'owner']);
    const note = await bob.node.records.put(space, 'app.note', { text: 'from Bob' });
    await until(async () => (await alice.node.records.get(space, note.key)) !== null, 4000, 'Bob’s note to reach Alice');
    assert.equal((await bob.node.spaces.get(space))?.writable, true);
  });

  test('an invite for a named role; not above your own', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Club', ...community, visibility: 'public' });
    await bob.node.spaces.join(await alice.node.spaces.invite(space, { role: 'moderator' }));
    await hold(alice.node, space);
    await joined(bob.node, space);
    assert.equal((await bob.node.spaces.access(space)).role?.name, 'moderator');
    await assert.rejects(bob.node.spaces.invite(space, { role: 'admin' }), /up to their own rank/);
  });

  test('a closed invite lets nobody else in; who joined before stays', async () => {
    const { hub, alice, bob, space } = await sharedWithBob();
    const invite = await alice.node.spaces.invite(space);
    await alice.node.spaces.closeInvite(space, invite);
    const key = (await alice.node.spaces.access(space)).invites.filter((i) => !i.open).map((i) => i.key)[0]!;

    const carol = await person(hub);
    await carol.node.spaces.join(invite);
    await hold(carol.node, space);
    await until(async () => (await carol.node.spaces.access(space)).invites.some((i) => i.key === key && !i.open), 4000, 'the close to reach Carol');
    // Whether she used it before the close reached her or not, the close came first: she holds nothing.
    await until(async () => (await carol.node.spaces.access(space)).role === null, 4000, 'Carol to hold no role');
    assert.equal((await bob.node.spaces.access(space)).role?.name, 'editor');
  });

  test('a view-only invite to a private space reads everything and writes nothing', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Plans', ...team, visibility: 'private' });
    const note = await alice.node.records.put(space, 'app.note', { text: 'meet at 8' });

    const viewOnly = await alice.node.spaces.invite(space, { write: false });
    const preview = bob.node.spaces.preview(viewOnly);
    assert.deepEqual({ carriesKey: preview.carriesKey, carriesWrite: preview.carriesWrite }, { carriesKey: true, carriesWrite: false });
    const joinedSpace = await bob.node.spaces.join(viewOnly);
    assert.equal(joinedSpace.readable, true);
    assert.equal(joinedSpace.writable, false);
    await until(async () => (await bob.node.records.get<{ text: string }>(space, note.key))?.body?.text === 'meet at 8', 4000, 'the note');
    assert.equal(await bob.node.records.can(space, 'create', 'app.note'), false);
    await assert.rejects(bob.node.records.update(space, note.key, { text: 'meet at 9' }), /shared with you to view/);
  });

  test('invite secrets are never kept: the account registry holds view-only invites', async () => {
    const { bob, space } = await sharedWithBob();
    const summary = await bob.node.spaces.get(space);
    assert.equal(summary?.joining, false, 'the secret was used and forgotten');
    const again = await bob.node.spaces.invite(space, { write: false });
    assert.equal(parseSpaceInvite(again).invite, undefined);
  });
});

describe('space access: taking it back', () => {
  test('a removed member cannot write — not even by claiming an old point in history', async () => {
    const { alice, bob, space } = await sharedWithBob();
    const before = await bob.node.records.put(space, 'app.note', { text: 'before' });
    await until(async () => (await alice.node.records.get(space, before.key)) !== null, 4000, 'Bob’s note');
    const seenThen = (await createStorageProvider(await bob.stores(`spaces/${space}`)).getExpression(before.version))!.seen ?? [];

    await alice.node.spaces.setMember(space, bob.node.did, null);
    await until(async () => (await bob.node.spaces.access(space)).role === null, 4000, 'the removal to reach Bob');
    await assert.rejects(bob.node.records.put(space, 'app.note', { text: 'after' }), /shared with you to view/);

    // He forges one that claims to have been written before the removal.
    const backdated = await forge(bob, space, { text: 'backdated' }, seenThen);
    const refused: string[] = [];
    alice.node.subscribe((event) => {
      if (event.type === 'rejected') refused.push(event.reason);
    });
    await letGo(bob.node, space);
    await createStorageProvider(await bob.stores(`spaces/${space}`)).addExpression(backdated);
    await hold(bob.node, space);
    await until(async () => refused.some((r) => /taken away/.test(r)), 4000, 'Alice to refuse the backdated note');

    // What Alice had seen him write before stays.
    assert.equal((await alice.node.records.get(space, before.key))?.verified, true);
  });

  test('handing over: the creator gives their role and leaves, and the new owner keeps managing', async () => {
    const { hub, alice, bob, space } = await sharedWithBob();
    await alice.node.spaces.setMember(space, bob.node.did, 'owner');
    await alice.node.spaces.setMember(space, alice.node.did, null);
    await until(async () => (await bob.node.spaces.access(space)).members.every((m) => m.did !== alice.node.did), 4000, 'Alice to leave');

    const carol = await person(hub);
    await carol.node.spaces.join(await bob.node.spaces.invite(space));
    await hold(carol.node, space);
    await joined(carol.node, space);
    assert.equal((await carol.node.spaces.access(space)).role?.name, 'editor');
    await assert.rejects(alice.node.records.put(space, 'app.note', { text: 'still here?' }), /shared with you to view/);
  });

  test('two owners cannot remove each other', async () => {
    const { alice, bob, space } = await sharedWithBob();
    await alice.node.spaces.setMember(space, bob.node.did, 'owner');
    await until(async () => (await bob.node.spaces.access(space)).role?.name === 'owner', 4000, 'Bob to be an owner');
    await assert.rejects(bob.node.spaces.setMember(space, alice.node.did, null), /ranked below them/);
  });

  test('a revoked note: nothing more under it counts, what was seen stays', async () => {
    const { alice, bob, space } = await sharedWithBob();
    // An app of Bob's, writing under a note Bob signed for its key.
    const pair = await provider.generateKeyPair();
    const appDid = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
    const note = await createLocalRootSigner(bob.me, bob.manager.getProvider()).delegate({
      audience: appDid,
      capabilities: [{ with: `space:${space}`, can: 'expression/write' }],
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    const store = createStorageProvider(await bob.stores(`spaces/${space}`));
    const heads = (await store.getExpression((await bob.node.records.put(space, 'app.note', { text: 'Bob' })).version))!.seen ?? [];
    const sign = (text: string) =>
      createSigner(provider).sign(createExpression({ author: appDid, collection: 'app.note', space, body: { text }, proof: note.encoded, seen: heads }), pair.privateKey);
    const early = await sign('early');
    await letGo(bob.node, space);
    await store.addExpression(early);
    await hold(bob.node, space);
    await until(async () => (await alice.node.records.get(space, early.key)) !== null, 4000, 'the app’s note');

    await bob.node.spaces.revoke(space, note.encoded);
    const late = await sign('late');
    const refused: string[] = [];
    alice.node.subscribe((event) => {
      if (event.type === 'rejected') refused.push(event.reason);
    });
    await letGo(bob.node, space);
    await createStorageProvider(await bob.stores(`spaces/${space}`)).addExpression(late);
    await hold(bob.node, space);
    // Refused on arrival if the revoke got there first; stored, and then not counted, if not.
    const aliceStore = createStorageProvider(await alice.stores(`spaces/${space}`));
    await until(async () => refused.some((r) => /revoked/.test(r)) || (await aliceStore.getExpression(late.id)) !== null, 4000, 'the late note to reach Alice');
    await until(async () => (await alice.node.records.get(space, late.key)) === null, 4000, 'Alice to stop counting it');
    assert.equal((await alice.node.records.get(space, early.key))?.verified, true);
  });
});
