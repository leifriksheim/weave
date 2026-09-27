/**
 * Versioned records: the ordering rule, and a store that applies it the same
 * way whatever order versions arrive in.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supersedes, nextVersion, checkVersionShape, newRecordKey, RECORD_KEY_PATTERN } from '../src/records/version.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import type { Expression } from '../src/types.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';
import { hold } from './helpers/hold.js';

const provider = createP256Provider();
const signer = createSigner(provider);
const author = await (async () => {
  const pair = await provider.generateKeyPair();
  return { did: publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC), key: pair.privateKey };
})();

/** Signs a version of `key` with the given fields. */
async function version(
  key: string,
  seq: number,
  body: unknown,
  extra: { prev?: string; genesis?: string; retain?: boolean; deleted?: boolean; createdAt?: string; collection?: string } = {},
): Promise<Expression> {
  return signer.sign(
    createExpression({
      author: author.did,
      collection: extra.collection ?? 'app.test',
      body: extra.deleted ? null : body,
      ...(extra.createdAt ? { createdAt: extra.createdAt } : {}),
      version: { key, seq, ...(extra.prev ? { prev: extra.prev } : {}), ...(extra.genesis ? { genesis: extra.genesis } : {}) },
      ...(extra.retain ? { retain: true } : {}),
      ...(extra.deleted ? { deleted: true } : {}),
    }),
    author.key,
  );
}

/** A chain of versions of one record: 0, 1, 2, … */
async function chain(key: string, length: number, options: { retain?: boolean } = {}): Promise<Expression[]> {
  const versions: Expression[] = [await version(key, 0, { n: 0 }, options)];
  for (let n = 1; n < length; n++) {
    versions.push(await version(key, n, { n }, { ...nextVersion(versions[n - 1]!), ...options }));
  }
  return versions;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

async function storeOf(versions: Expression[]) {
  const storage = createStorageProvider(createMemoryAdapter());
  for (const v of versions) await storage.addExpression(v);
  return storage;
}

describe('the ordering rule', () => {
  test('higher seq wins; a tie goes to the lower id; time decides nothing', () => {
    assert.equal(supersedes({ id: 'b', seq: 2 }, { id: 'a', seq: 1 }), true);
    assert.equal(supersedes({ id: 'a', seq: 1 }, { id: 'b', seq: 2 }), false);
    assert.equal(supersedes({ id: 'a', seq: 3 }, { id: 'b', seq: 3 }), true);
    assert.equal(supersedes({ id: 'b', seq: 3 }, { id: 'a', seq: 3 }), false);
  });

  test('a version dated a year ahead still loses to a higher seq', async () => {
    const key = newRecordKey();
    const [first, second] = await chain(key, 2);
    const forged = await version(key, 1, { forged: true }, { ...nextVersion(first!), createdAt: '2099-01-01T00:00:00.000Z' });
    const third = await version(key, 2, { n: 2 }, nextVersion(second!));
    const storage = await storeOf([first!, forged, third]);
    assert.equal((await storage.getCurrent(key))?.id, third.id);
  });

  test('keys are 26 characters of lower-case base32 and fit the chosen-key pattern', () => {
    const key = newRecordKey();
    assert.equal(key.length, 26);
    assert.match(key, RECORD_KEY_PATTERN);
  });
});

describe('a store of versions', () => {
  test('the same versions in every order give the same tree', async () => {
    const key = newRecordKey();
    const [v0, v1, v2] = await chain(key, 3);
    // A concurrent edit: another seq 2, made from v1 on another device.
    const rival = await version(key, 2, { rival: true }, nextVersion(v1!));
    const roots = new Set<string | null>();
    for (const order of permutations([v0!, v1!, v2!, rival])) roots.add(await (await storeOf(order)).fingerprint());
    assert.equal(roots.size, 1);
  });

  test('replaying an old version changes nothing', async () => {
    const key = newRecordKey();
    const versions = await chain(key, 4);
    const storage = await storeOf(versions);
    const before = await storage.fingerprint();
    await storage.addExpression(versions[1]!);
    assert.equal(await storage.fingerprint(), before);
    assert.equal((await storage.getCurrent(key))?.seq, 3);
  });

  test('a delete stays deleted when an older version turns up', async () => {
    const key = newRecordKey();
    const [v0, v1, v2] = await chain(key, 3);
    const deleted = await version(key, 3, null, { ...nextVersion(v2!), deleted: true });
    const storage = await storeOf([v0!, deleted, v1!, v2!]);
    assert.equal((await storage.getCurrent(key))?.deleted, true);
  });

  test('1,000 edits keep the current and first versions — not 1,000', async () => {
    const key = newRecordKey();
    const versions = await chain(key, 1000);
    const storage = await storeOf(versions);
    const kept = new Set(await storage.versionIds());
    assert.deepEqual([...kept].sort(), [versions[0]!.id, versions[999]!.id].sort());
    assert.equal(await storage.getExpression(versions[500]!.id), null);
  });

  test('retained versions form a verifiable chain', async () => {
    const key = newRecordKey();
    const versions = await chain(key, 50, { retain: true });
    const storage = await storeOf([...versions].reverse());
    const history = await storage.history(key);
    assert.equal(history.length, 50);
    for (let i = 0; i < history.length - 1; i++) {
      assert.equal(history[i]!.prev, history[i + 1]!.id, `version ${history[i]!.seq} links to the one before`);
    }
    for (const v of history) {
      const publicKey = await provider.importPublicKey((await import('../src/identity/did.js')).didToPublicKey(v.author).publicKeyBytes);
      assert.equal(await signer.verify(v, publicKey), true);
    }
  });

  test('the first version is kept as proof of who created the record', async () => {
    const key = newRecordKey();
    const [v0, v1] = await chain(key, 2);
    const storage = await storeOf([v1!, v0!]);
    assert.equal((await storage.getGenesis(key))?.id, v0!.id);
  });
});

describe('the shape check', () => {
  test('refuses versions that do not make sense on their own', async () => {
    const key = newRecordKey();
    const [v0] = await chain(key, 1);
    assert.equal(checkVersionShape(v0!), null);
    assert.match(checkVersionShape({ ...v0!, prev: 'x' }) ?? '', /first version/);
    assert.match(checkVersionShape({ ...v0!, seq: 2 }) ?? '', /later version/);
    assert.match(checkVersionShape({ ...v0!, deleted: true }) ?? '', /no body/);
    assert.match(checkVersionShape({ ...v0!, key: 'Has Spaces' }) ?? '', /malformed/);
  });
});

describe('versioned records through the node', () => {
  const open: P2PNode[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((node) => node.close()));
  });

  async function person(hub = createFakeHub({ latencyMs: 1 })) {
    const manager = createIdentityManager();
    const me = await manager.fromSeed(generateSeed());
    const node = await createNode({
      signer: createLocalRootSigner(me, manager.getProvider()),
      stores: memoryStores(),
      watchIntervalMs: 0,
      network: { transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)] },
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

  test('an edit keeps the key and advances the version', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Todos', visibility: 'private' });
    const made = await me.records.put(space, 'app.todo.item', { text: 'milk', done: false });
    const ticked = await me.records.update(space, made.key, { text: 'milk', done: true });

    assert.equal(ticked.key, made.key);
    assert.equal(ticked.seq, 1);
    assert.notEqual(ticked.version, made.version);
    assert.equal(ticked.createdBy, me.did);
    assert.deepEqual((await me.records.list(space)).map((r) => [r.key, (r.body as { done: boolean }).done]), [[made.key, true]]);
  });

  test('two members editing apart converge on the same version', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.spaces.create({ name: 'Shared', ...team, visibility: 'private' });
    await bob.spaces.join(await alice.spaces.invite(space));
    const made = await alice.records.put(space, 'app.todo.item', { text: 'milk', done: false });
    await hold(bob, space);
    await until(async () => (await bob.records.get(space, made.key)) !== null, 3000, 'bob to see it');

    // Both edit before hearing from each other.
    await Promise.all([
      alice.records.update(space, made.key, { text: 'milk', done: true }),
      bob.records.update(space, made.key, { text: 'oat milk', done: false }),
    ]);
    await until(
      async () => (await alice.records.get(space, made.key))?.version === (await bob.records.get(space, made.key))?.version,
      3000,
      'the same winner on both',
    );
  });

  test('a collection with history "all" keeps every version; nodes that disagree about it still converge', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.spaces.create({ name: 'Ledger', ...team, visibility: 'public' });
    await alice.collections.define(space, { name: 'app.ledger.entry', schema: { type: 'object' }, history: 'all' });

    const made = await alice.records.put(space, 'app.ledger.entry', { amount: 1 });
    for (let n = 2; n <= 5; n++) await alice.records.update(space, made.key, { amount: n });
    assert.deepEqual((await alice.records.history<{ amount: number }>(space, made.key)).map((r) => r.body?.amount), [5, 4, 3, 2, 1]);

    await bob.spaces.join(await alice.spaces.invite(space));
    await hold(bob, space);
    await until(async () => (await alice.spaces.status(space)).fingerprint === (await bob.spaces.status(space)).fingerprint, 3000, 'the stores to match');
    assert.equal((await bob.records.history(space, made.key)).length, 5);
  });

  test('a deleted key can be written again, and comes back as its next version', async () => {
    const me = await person();
    const { id: space } = await me.spaces.create({ name: 'Todos', visibility: 'public' });
    const made = await me.records.put(space, 'app.note', { text: 'first' }, { key: 'pinned' });
    await me.records.delete(space, 'pinned');
    assert.equal(await me.records.get(space, 'pinned'), null);
    const back = await me.records.put(space, 'app.note', { text: 'again' }, { key: 'pinned' });
    assert.equal(back.seq, 2);
    assert.equal(back.key, made.key);
    await assert.rejects(me.records.put(space, 'app.note', { text: 'twice' }, { key: 'pinned' }), /already exists/);
  });
});
