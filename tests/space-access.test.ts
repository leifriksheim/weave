/**
 * Space access keys: only those given the write key write in a shared space,
 * anyone can check it without a secret, view-only invites, and space ids that
 * vouch for what a space says about itself.
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
import { createCryptoGate } from '../src/validation/crypto-gate.js';
import { createSpaceGate } from '../src/validation/space-gate.js';
import { createSpaceManager, parseSpaceInvite } from '../src/space/space-manager.js';
import {
  checkSpace,
  countersign,
  deriveReadKey,
  deriveWriteKey,
  generateWriteSecret,
  verifyCountersignature,
} from '../src/space/space-access.js';
import type { Expression, Space } from '../src/types.js';
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from '../src/utils/encoding.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';

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

/** A record signed by hand with a valid session and delegation — optionally countersigned by some key */
async function forge(who: Person, space: string, body: unknown, spaceWriteSecret?: Uint8Array): Promise<Expression> {
  const pair = await provider.generateKeyPair();
  const keyDid = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  const ucan = await createLocalRootSigner(who.me, who.manager.getProvider()).delegate({
    audience: keyDid,
    capabilities: [{ with: `space:${space}`, can: 'expression/write' }],
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  const signed = await createSigner(provider).sign(
    createExpression({ author: keyDid, collection: 'app.note', space, body, proof: ucan.encoded }),
    pair.privateKey,
  );
  if (!spaceWriteSecret) return signed;
  return Object.freeze({ ...signed, spaceSignature: await countersign(signed.id, await deriveWriteKey(spaceWriteSecret, provider), provider) });
}

/** Rewrites an invite, as whoever passes it along could */
function tamper(invite: string, change: (parsed: Record<string, any>) => void): string {
  const parsed = JSON.parse(utf8Decode(base64UrlDecode(invite)));
  change(parsed);
  return base64UrlEncode(utf8Encode(JSON.stringify(parsed)));
}

describe('space access: the keys', () => {
  test('derivation is fixed — a known secret gives a known key, and never an account’s', async () => {
    const secret = new Uint8Array(32).map((_, i) => i);
    assert.equal((await deriveWriteKey(secret, provider)).did, 'did:key:zDnaecvpDQbDgyngnMGPSSC6DLDfYSFeXxiZyeV63qGGgavvH');
    const aes = await crypto.subtle.importKey('raw', new Uint8Array(32).map((_, i) => 255 - i), { name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    assert.equal((await deriveReadKey({ id: 'k', key: aes, createdAt: '', version: 1 }, provider)).did, 'did:key:zDnaem2ikLwS3eYm46gspC7nm6dmYYCMHUHU5yvVHNgARcsWf');
    // The same bytes as an account seed give a different key: each use has its own label.
    assert.notEqual((await createIdentityManager().fromSeed(secret)).did, (await deriveWriteKey(secret, provider)).did);
  });

  test('a countersignature verifies for its record only, and only by its key', async () => {
    const secret = generateWriteSecret();
    const writeKey = await deriveWriteKey(secret, provider);
    const record = { id: 'bafyone', spaceSignature: await countersign('bafyone', writeKey, provider) } as Expression;
    assert.equal(await verifyCountersignature(record, writeKey.did, provider), true);
    assert.equal(await verifyCountersignature({ ...record, id: 'bafytwo' }, writeKey.did, provider), false);
    const otherKey = (await deriveWriteKey(generateWriteSecret(), provider)).did;
    assert.equal(await verifyCountersignature(record, otherKey, provider), false);
  });

  test('a countersigned record still passes the crypto gate — the signature is outside the id', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Notes', type: 'shared', visibility: 'public' });
    const written = await alice.node.records.put(space, 'app.note', { text: 'hi' });
    const stored = await createStorageProvider(await alice.stores(`spaces/${space}`)).getExpression(written.version);
    assert.equal(typeof stored?.spaceSignature, 'string');
    const resolve = async (did: string) => provider.importPublicKey((await import('../src/identity/did.js')).didToPublicKey(did).publicKeyBytes);
    assert.equal((await createCryptoGate(provider).validate(stored!, resolve)).passed, true);
    assert.equal((await createSigner(provider).verify(stored!, await resolve(stored!.author))), true);
  });
});

describe('space access: the space vouches for itself', () => {
  test('a created space checks out, and its id does not depend on its name', async () => {
    const registry = createSpaceManager(createMemoryAdapter(), provider);
    const { space } = await registry.create({ name: 'Trip', type: 'shared', visibility: 'private', owner: 'did:key:zAlice' });
    assert.equal(await checkSpace(space), null);
    assert.equal(await checkSpace({ ...space, name: 'Renamed' }), null);
    assert.match(String(await checkSpace({ ...space, owner: 'did:key:zMallory' })), /id does not match/);
    assert.match(String(await checkSpace({ ...space, type: 'personal', writeKey: undefined } as Space)), /id does not match/);
    assert.match(String(await checkSpace({ ...space, writeKey: undefined } as Space)), /must name its write key/);
  });

  test('a forged invite is refused: changed owner, changed type, a key that is not the space’s', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Trip', type: 'shared', visibility: 'private' });
    const invite = await alice.node.spaces.invite(space);

    await assert.rejects(bob.node.spaces.join(tamper(invite, (p) => (p.space.owner = bob.node.did))), /does not describe a real space/);
    await assert.rejects(bob.node.spaces.join(tamper(invite, (p) => (p.space.type = 'personal'))), /does not describe a real space/);
    await assert.rejects(
      bob.node.spaces.join(tamper(invite, (p) => (p.write = base64UrlEncode(generateWriteSecret())))),
      /write key that does not belong/,
    );
    await assert.rejects(
      bob.node.spaces.join(tamper(invite, (p) => (p.key = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))))),
      /key that does not belong/,
    );
    assert.equal((await bob.node.spaces.list()).length, 0);
  });
});

describe('space access: who may write', () => {
  test('a stranger who knows the space cannot write in it — every peer refuses, and nobody stores it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const mallory = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Trip', type: 'shared', visibility: 'public' });
    await alice.node.records.put(space, 'app.note', { text: 'from Alice' });
    // Mallory can follow — she was given a view-only invite — and so can reach the space.
    await mallory.node.spaces.join(await alice.node.spaces.invite(space, { write: false }));
    assert.equal((await mallory.node.spaces.get(space))?.writable, false);
    await assert.rejects(mallory.node.records.put(space, 'app.note', { text: 'spam' }), /shared with you to view/);

    // She forges a record anyway: valid account, valid session, no write key.
    await mallory.node.spaces.close(space);
    const forged = await forge(mallory, space, { text: 'spam' });
    // And one countersigned with a write key she made up.
    const made = await forge(mallory, space, { text: 'more spam' }, generateWriteSecret());
    const malloryStore = createStorageProvider(await mallory.stores(`spaces/${space}`));
    await malloryStore.addExpression(forged);
    await malloryStore.addExpression(made);

    const reasons: string[] = [];
    alice.node.subscribe((event) => {
      if (event.type === 'rejected') reasons.push(event.reason);
    });
    await mallory.node.spaces.open(space);
    await until(async () => reasons.length >= 2, 4000, 'Alice to refuse both');
    assert.ok(reasons.some((r) => /without this space's write key/.test(r)));
    assert.ok(reasons.some((r) => /not by this space's write key/.test(r)));
    const aliceStore = createStorageProvider(await alice.stores(`spaces/${space}`));
    assert.equal(await aliceStore.getExpression(forged.id), null);
    assert.equal(await aliceStore.getExpression(made.id), null);
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
    const { id: space } = await alice.node.spaces.create({ name: 'Trip', type: 'shared', visibility: 'private' });
    const written = await alice.node.records.put(space, 'app.note', { text: 'secret' });
    const member = await createStorageProvider(await alice.stores(`spaces/${space}`)).getExpression(written.version);
    const stranger = await forge(mallory, space, { ciphertext: 'x', iv: 'y' });

    // All a blind node has: the space, as anyone could be handed it.
    const { space: described } = (await createSpaceManager(await alice.stores('registry'), provider).get(space))!;
    const blind = createSpaceGate({ provider, writeKey: described.writeKey! });
    assert.equal((await blind.validate(member!)).passed, true);
    assert.equal((await blind.validate(stranger)).passed, false);
  });

  test('a personal space needs no write key: its owner writes, followers read', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const carol = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Blog', type: 'personal', visibility: 'public' });
    const post = await alice.node.records.put(space, 'app.post', { text: 'hello' });
    const stored = await createStorageProvider(await alice.stores(`spaces/${space}`)).getExpression(post.version);
    assert.equal(stored?.spaceSignature, undefined);
    const invite = await alice.node.spaces.invite(space);
    assert.equal(parseSpaceInvite(invite).write, undefined);
    await carol.node.spaces.join(invite);
    assert.equal((await carol.node.spaces.get(space))?.writable, false);
    await until(async () => (await carol.node.records.get(space, post.key)) !== null, 4000, 'the post');
  });
});

describe('space access: view-only invites', () => {
  test('a view-only invite to a private space reads everything and writes nothing', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Plans', type: 'shared', visibility: 'private' });
    const note = await alice.node.records.put(space, 'app.note', { text: 'meet at 8' });

    const viewOnly = await alice.node.spaces.invite(space, { write: false });
    assert.deepEqual(
      { carriesKey: bob.node.spaces.preview(viewOnly).carriesKey, carriesWrite: bob.node.spaces.preview(viewOnly).carriesWrite },
      { carriesKey: true, carriesWrite: false },
    );
    const joined = await bob.node.spaces.join(viewOnly);
    assert.equal(joined.readable, true);
    assert.equal(joined.writable, false);
    await until(async () => (await bob.node.records.get<{ text: string }>(space, note.key))?.body?.text === 'meet at 8', 4000, 'the note');
    assert.equal(await bob.node.records.can(space, 'create', 'app.note'), false);
    await assert.rejects(bob.node.records.update(space, note.key, { text: 'meet at 9' }), /shared with you to view/);
  });

  test('a full invite after a view-only one lets you write; a view-only one after a full one takes nothing away', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Plans', type: 'shared', visibility: 'public' });

    await bob.node.spaces.join(await alice.node.spaces.invite(space, { write: false }));
    assert.equal((await bob.node.spaces.get(space))?.writable, false);
    await bob.node.spaces.join(await alice.node.spaces.invite(space));
    assert.equal((await bob.node.spaces.get(space))?.writable, true);
    const note = await bob.node.records.put(space, 'app.note', { text: 'from Bob' });
    await until(async () => (await alice.node.records.get(space, note.key)) !== null, 4000, 'Bob’s note to reach Alice');

    await bob.node.spaces.join(await alice.node.spaces.invite(space, { write: false }));
    assert.equal((await bob.node.spaces.get(space))?.writable, true);
  });

  test('someone who can write can pass on a view-only invite', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Plans', type: 'shared', visibility: 'public' });
    await bob.node.spaces.join(await alice.node.spaces.invite(space));
    assert.equal(parseSpaceInvite(await bob.node.spaces.invite(space, { write: false })).write, undefined);
    assert.equal(typeof parseSpaceInvite(await bob.node.spaces.invite(space)).write, 'string');
  });
});
