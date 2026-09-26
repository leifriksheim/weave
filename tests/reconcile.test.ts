/**
 * Reconciliation — Negentropy itself, the store's sets and sums, and two
 * sync engines finding their differences one collection at a time.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createReconciler, fingerprintOf, ItemSet, type Item } from '../src/sync/negentropy.js';
import { createStorageProvider, type StorageProvider } from '../src/storage/storage-provider.js';
import { createSyncEngine, type Holds, type SyncEngine } from '../src/sync/sync-engine.js';
import { base32Decode, base32Encode, cidDigest, cidFromBytes, cidOfDigest } from '../src/utils/hash.js';
import { bytesToHex } from '../src/utils/encoding.js';
import type { Expression } from '../src/types.js';

const hex = (b: Uint8Array) => bytesToHex(b);

function randomItems(n: number): Item[] {
  return Array.from({ length: n }, () => {
    const id = new Uint8Array(32);
    webcrypto.getRandomValues(id);
    return { timestamp: 1_700_000_000 + Math.floor(Math.random() * 5000), id };
  });
}

/** Runs a whole reconciliation between two sets; what the initiator found each side lacks */
async function reconcile(ours: Item[], theirs: Item[], frameSizeLimit = 0) {
  const a = createReconciler(new ItemSet(ours), { initiator: true, frameSizeLimit });
  const b = createReconciler(new ItemSet(theirs), { initiator: false, frameSizeLimit });
  const have: string[] = [];
  const need: string[] = [];
  let message: Uint8Array | null = await a.initiate();
  let rounds = 0;
  while (message) {
    const answer = await b.reconcile(message);
    const round = await a.reconcile(answer.message!);
    have.push(...round.have.map(hex));
    need.push(...round.need.map(hex));
    message = round.message;
    rounds++;
  }
  // A round cut short by a frame limit can name an id twice; the reference implementation does the same.
  return { have: [...new Set(have)].sort(), need: [...new Set(need)].sort(), rounds };
}

describe('Negentropy', () => {
  test('matches the reference implementation byte for byte', async () => {
    // Made with hoytech/negentropy's JavaScript implementation.
    const items: Item[] = Array.from({ length: 40 }, (_, i) => {
      const id = new Uint8Array(32);
      id[0] = i;
      id[31] = 255 - i;
      return { timestamp: 1_700_000_000 + (i % 7), id };
    });
    const set = new ItemSet(items);
    assert.equal(hex(await set.fingerprint(0, 40)), '0fc7e595db07fda274b7780656316457');
    const first = await createReconciler(set, { initiator: true }).initiate();
    assert.equal(
      hex(first),
      '6186aacfe201011501f1a1bb247738a1f6a84af833c7949a22020001a7bc8b8b3ba35ff2ca22a88a93f72c30010116019b8e2a14223a62ac717c0e5d318d8c1c' +
        '020001bedf9d75b4e8ce6ee276c3454f5cd06101011701caa2e24a64f00e248c413030e56acd6d020001e2c5759dfd0e6efea814c0661be1eb9701011801' +
        '4acad02d67d83da8706e2f4e78987996020001d278f0cb10d267b75adb860349108aed0101120111f10b66e748836759416f398fe2bbb701012001d07fd342' +
        '8d0f14d7cfce6bdc87d9ddd30200013fb4ef7afa21c5e979b67afb87931ef60101130136ce8536fdf00d96d1b359451916873c01012101e2c0c2d3e4617370' +
        'fe7ddf53cb4127fe02010d01099f69560d6dc0f19a89d0880a47cf2f01011b016570e3a2e949308f6d1b9209a68765220000014d66f7f807e6eda20052dce7' +
        '5a8475d0',
    );
  });

  test('finds exactly what each side lacks', async () => {
    for (const [onlyA, onlyB, shared] of [
      [0, 0, 0],
      [3, 0, 0],
      [0, 3, 0],
      [5, 3, 10],
      [1, 0, 5000],
      [300, 200, 3000],
    ] as const) {
      const common = randomItems(shared);
      const a = randomItems(onlyA);
      const b = randomItems(onlyB);
      const result = await reconcile([...common, ...a], [...common, ...b]);
      assert.deepEqual(result.have, a.map((i) => hex(i.id)).sort(), `have, ${onlyA}/${onlyB}/${shared}`);
      assert.deepEqual(result.need, b.map((i) => hex(i.id)).sort(), `need, ${onlyA}/${onlyB}/${shared}`);
    }
  });

  test('equal sets take one round', async () => {
    const items = randomItems(10_000);
    const result = await reconcile(items, [...items]);
    assert.deepEqual(result, { have: [], need: [], rounds: 1 });
  });

  test('a frame limit spreads a big difference over more rounds, and loses nothing', async () => {
    const a = randomItems(3000);
    const b = randomItems(3000);
    const limited = await reconcile(a, b, 4096);
    assert.equal(limited.have.length, 3000);
    assert.equal(limited.need.length, 3000);
    assert.ok(limited.rounds > (await reconcile(a, b)).rounds);
  });

  test('refuses what is not a Negentropy message', async () => {
    const responder = createReconciler(new ItemSet([]), { initiator: false });
    await assert.rejects(() => responder.reconcile(new Uint8Array([0x12, 0x00])), /Not a Negentropy message/);
    await assert.rejects(() => responder.reconcile(new Uint8Array([0x61, 0x00, 0x21])), /too long|too soon/);
  });

  test('a sum taken apart and put together gives the same fingerprint', async () => {
    const items = randomItems(100);
    const set = new ItemSet(items);
    const whole = await set.fingerprint(0, 100);
    const halves = set.sum(0, 50);
    const rest = set.sum(50, 100);
    assert.equal(hex(await fingerprintOf({ sum: (halves.sum + rest.sum) % (1n << 256n), count: 100 })), hex(whole));
  });
});

describe('content ids as Negentropy ids', () => {
  test('a content id and its digest round-trip', async () => {
    const id = await cidFromBytes(new TextEncoder().encode('hello'));
    const digest = cidDigest(id)!;
    assert.equal(digest.length, 32);
    assert.equal(cidOfDigest(digest), id);
    assert.deepEqual(base32Decode(base32Encode(digest)), digest);
  });

  test('anything else is not one', () => {
    assert.equal(cidDigest('v1'), null);
    assert.equal(cidDigest('b' + 'a'.repeat(51)), null);
    assert.equal(cidDigest('b' + '1'.repeat(52)), null);
  });
});

// ─── The store and the engine ─────────────────────────────────────────

let counter = 0;
/** A version with a real content id, no signature: these tests run without a gatekeeper */
async function version(collection: string, overrides: Partial<Expression> = {}): Promise<Expression> {
  const key = `k${++counter}x${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: await cidFromBytes(new TextEncoder().encode(`${key}:${collection}:${JSON.stringify(overrides)}`)),
    author: 'did:key:ztest',
    collection,
    createdAt: new Date(1_700_000_000_000 + counter * 1000).toISOString(),
    body: { n: counter },
    key,
    seq: 0,
    signature: 'x',
    ...overrides,
  };
}

function pair(
  options: {
    validate?: (e: Expression) => Promise<{ valid: boolean; reason?: string }>;
    holdsA?: () => Holds;
    holdsB?: () => Holds;
  } = {},
) {
  const inFlight: Promise<void>[] = [];
  const sent = { bytes: 0, reconciles: new Map<string, number>() };
  let a: { storage: StorageProvider; sync: SyncEngine };
  let b: { storage: StorageProvider; sync: SyncEngine };
  const make = (self: string, deliver: (message: unknown) => void, holds?: () => Holds) => {
    const storage = createStorageProvider(createMemoryAdapter());
    const sync = createSyncEngine({
      storageProvider: storage,
      self,
      ...(holds ? { holds } : {}),
      sendToPeer: (_peer, message) => {
        sent.bytes += JSON.stringify(message).length;
        if (message.type === 'reconcile') sent.reconciles.set(message.collection, (sent.reconciles.get(message.collection) ?? 0) + 1);
        deliver(message);
      },
      ...(options.validate ? { validate: options.validate } : {}),
    });
    return { storage, sync };
  };
  a = make('a', (m) => inFlight.push(b.sync.handleMessage('a', m)), options.holdsA);
  b = make('b', (m) => inFlight.push(a.sync.handleMessage('b', m)), options.holdsB);
  a.sync.addPeer('b');
  b.sync.addPeer('a');
  const settle = async () => {
    let idle = 0;
    for (let round = 0; round < 500 && idle < 2; round++) {
      // Nothing to deliver: wait a little real time too. A hello goes out only after its
      // fingerprints are hashed, which on a busy machine takes longer than a turn or two.
      await new Promise((resolve) => setTimeout(resolve, inFlight.length > 0 ? 0 : 25));
      if (inFlight.length === 0) {
        idle++;
        continue;
      }
      idle = 0;
      await Promise.all(inFlight.splice(0, inFlight.length));
    }
  };
  return { a, b, sent, settle };
}

describe('sync by reconciliation', () => {
  test('two stores differing by one version of 2,000 exchange little', async () => {
    const { a, b, sent, settle } = pair();
    for (let i = 0; i < 2000; i++) {
      const v = await version('app.note');
      await a.storage.addExpression(v);
      await b.storage.addExpression(v);
    }
    const extra = await version('app.note');
    await a.storage.addExpression(extra);

    b.sync.notifyPeers(['a']);
    await settle();

    assert.notEqual(await b.storage.getExpression(extra.id), null);
    assert.equal(await b.storage.fingerprint(), await a.storage.fingerprint());
    // Two hellos, a few rounds of 16 fingerprints, and one version — not 2,000 ids.
    assert.ok(sent.bytes < 8_000, `${sent.bytes} bytes`);
  });

  test('both sides get what they lack, whoever says hello', async () => {
    const { a, b, settle } = pair();
    const onlyA = await version('app.note');
    const onlyB = await version('app.note');
    await a.storage.addExpression(onlyA);
    await b.storage.addExpression(onlyB);

    // b sorts after a, so a does the work either way.
    b.sync.notifyPeers(['a']);
    await settle();
    assert.notEqual(await a.storage.getExpression(onlyB.id), null);
    assert.notEqual(await b.storage.getExpression(onlyA.id), null);

    const later = await version('app.note');
    await b.storage.addExpression(later);
    a.sync.notifyPeers(['b']);
    await settle();
    assert.notEqual(await a.storage.getExpression(later.id), null);
  });

  test('only collections that differ are reconciled', async () => {
    const { a, b, sent, settle } = pair();
    for (const collection of ['app.a', 'app.b', 'app.c']) {
      for (let i = 0; i < 50; i++) {
        const v = await version(collection);
        await a.storage.addExpression(v);
        await b.storage.addExpression(v);
      }
    }
    await a.storage.addExpression(await version('app.b'));
    b.sync.notifyPeers(['a']);
    await settle();
    assert.deepEqual([...sent.reconciles.keys()], ['app.b']);
  });

  test('a collection one side has never seen comes across whole', async () => {
    const { a, b, settle } = pair();
    for (let i = 0; i < 40; i++) await a.storage.addExpression(await version('app.fresh'));
    a.sync.notifyPeers(['b']);
    await settle();
    assert.equal((await b.storage.queryExpressions('app.fresh')).length, 40);
  });

  test('a refused version is not asked for again', async () => {
    let asked = 0;
    const { a, b, settle } = pair({
      validate: async () => {
        asked++;
        return { valid: false, reason: 'no' };
      },
    });
    // b holds the bad version; a (the initiator) refuses it.
    await b.storage.addExpression(await version('app.note'));
    b.sync.notifyPeers(['a']);
    await settle();
    assert.equal(asked, 1);
    b.sync.notifyPeers(['a']);
    await settle();
    assert.equal(asked, 1);
  });

  test('a store written by someone else is read again once told', async () => {
    const adapter = createMemoryAdapter();
    const mine = createStorageProvider(adapter);
    const other = createStorageProvider(adapter);
    await mine.addExpression(await version('app.note'));
    const before = await mine.fingerprint();
    await other.addExpression(await version('app.note'));
    assert.equal(await mine.fingerprint(), before, 'not yet: nothing said the store changed');
    mine.invalidate();
    assert.equal(await mine.fingerprint(), await other.fingerprint());
  });

  test('a superseded version leaves the set; its replacement joins it', async () => {
    const storage = createStorageProvider(createMemoryAdapter());
    const first = await version('app.note');
    const second: Expression = await version('app.note', { key: first.key, seq: 1, prev: first.id, genesis: first.id });
    await storage.addExpression(first);
    await storage.addExpression(second);
    // The first version stays as proof of who created the record.
    assert.deepEqual((await storage.versionIds()).sort(), [first.id, second.id].sort());
    const third: Expression = await version('app.note', { key: first.key, seq: 2, prev: second.id, genesis: first.id });
    await storage.addExpression(third);
    assert.deepEqual((await storage.versionIds()).sort(), [first.id, third.id].sort());
    assert.equal((await storage.items('app.note')).size, 2);
  });
});

describe('holding part of a space', () => {
  const ids = async (storage: StorageProvider, collection: string) => (await storage.queryExpressions(collection)).map((v) => v.id).sort();

  for (const [name, cacheIs] of [
    ['as the initiator', 'a'],
    ['as the responder', 'b'],
  ] as const) {
    test(`a cache takes only what it holds, and gives what it wrote — ${name}`, async () => {
      let held: Holds = new Set(['app.chat']);
      const cache = () => held;
      const { a, b, settle } = pair(cacheIs === 'a' ? { holdsA: cache } : { holdsB: cache });
      const [c, k] = cacheIs === 'a' ? [a, b] : [b, a];
      const level: string[] = [];
      const stored: string[] = [];
      c.sync.on('level', (_peer: string, collection: string) => level.push(collection));
      c.sync.on('stored', (_peer: string, got: string[]) => stored.push(...got));

      for (let i = 0; i < 40; i++) await k.storage.addExpression(await version('app.chat'));
      for (let i = 0; i < 40; i++) await k.storage.addExpression(await version('app.photos'));
      await k.storage.addExpression(await version('sys.member'));
      const mine = await version('app.chat');
      await c.storage.addExpression(mine);

      c.sync.notifyPeers([cacheIs === 'a' ? 'b' : 'a']);
      await settle();

      assert.deepEqual(await ids(c.storage, 'app.chat'), await ids(k.storage, 'app.chat'));
      assert.equal((await ids(c.storage, 'app.chat')).length, 41);
      assert.equal((await ids(c.storage, 'app.photos')).length, 0, 'not held, not taken');
      assert.equal((await ids(c.storage, 'sys.member')).length, 1, 'the space’s own always');
      assert.ok(stored.includes(mine.id), 'the keeper said it has the cache’s write');
      assert.ok(level.includes('app.chat'));

      // A push for a collection it doesn't hold passes it by.
      const photo = await version('app.photos');
      await k.storage.addExpression(photo);
      k.sync.onLocalChange(photo);
      await settle();
      assert.equal(await c.storage.getExpression(photo.id), null);

      // Holding more: the next hello brings it across.
      held = new Set(['app.chat', 'app.photos']);
      c.sync.notifyPeers([cacheIs === 'a' ? 'b' : 'a']);
      await settle();
      assert.equal((await ids(c.storage, 'app.photos')).length, 41);
    });
  }

  test('two caches reconcile only what both hold', async () => {
    const { a, b, sent, settle } = pair({ holdsA: () => new Set(['app.x', 'app.y']), holdsB: () => new Set(['app.y', 'app.z']) });
    for (const c of ['app.x', 'app.y', 'app.z']) {
      await a.storage.addExpression(await version(c));
      await b.storage.addExpression(await version(c));
    }
    b.sync.notifyPeers(['a']);
    await settle();
    assert.deepEqual([...sent.reconciles.keys()], ['app.y']);
    assert.equal((await ids(a.storage, 'app.y')).length, 2);
    assert.equal((await ids(a.storage, 'app.z')).length, 1, 'its own, never the other’s');
  });
});
