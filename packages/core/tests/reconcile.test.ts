/**
 * Reconciliation — Negentropy itself, the store's sets and sums, and two
 * sync engines finding their differences one collection at a time.
 */
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createReconciler, fingerprintOf, ItemSet, type Item } from '../src/sync/negentropy.js';
import { createStorageProvider, type StorageProvider } from '../src/storage/storage-provider.js';
import { createSyncEngine, type Holds } from '../src/sync/sync-engine.js';
import type { SyncMessage } from '../src/sync/sync-messages.js';
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
    assert.equal(
      hex(await fingerprintOf({ sum: (halves.sum + rest.sum) % (1n << 256n), count: 100 })),
      hex(whole),
    );
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
    validate?: (e: Expression) => Promise<{ valid: boolean; reason?: string; later?: boolean }>;
    holdsA?: () => Holds;
    holdsB?: () => Holds;
    /** Lose this message on the way */
    drop?: (message: SyncMessage) => boolean;
    heartbeatInterval?: number;
  } = {},
) {
  const inFlight: Promise<void>[] = [];
  const sent = { bytes: 0, reconciles: new Map<string, number>() };
  const make = (self: string, deliver: (message: unknown) => void, holds?: () => Holds) => {
    const storage = createStorageProvider(createMemoryAdapter());
    const sync = createSyncEngine({
      storageProvider: storage,
      self,
      ...(holds ? { holds } : {}),
      ...(options.heartbeatInterval ? { heartbeatInterval: options.heartbeatInterval } : {}),
      sendToPeer: (_peer, message) => {
        if (options.drop?.(message)) return;
        sent.bytes += JSON.stringify(message).length;
        if (message.type === 'reconcile')
          sent.reconciles.set(message.collection, (sent.reconciles.get(message.collection) ?? 0) + 1);
        deliver(message);
      },
      ...(options.validate ? { validate: options.validate } : {}),
    });
    return { storage, sync };
  };
  const a = make('a', (m) => inFlight.push(b.sync.handleMessage('a', m)), options.holdsA);
  const b = make('b', (m) => inFlight.push(a.sync.handleMessage('b', m)), options.holdsB);
  a.sync.addPeer('b');
  b.sync.addPeer('a');
  // A short heartbeat never lets the pair go quiet: pass fewer rounds to stop waiting sooner.
  const settle = async (rounds = 500) => {
    let idle = 0;
    for (let round = 0; round < rounds && idle < 2; round++) {
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
    const { b, settle } = pair({
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

  test('a superseded version stays in the set as a stub; its replacement joins it', async () => {
    const storage = createStorageProvider(createMemoryAdapter());
    const first = await version('app.note');
    const second: Expression = await version('app.note', {
      key: first.key,
      seq: 1,
      prev: first.id,
      genesis: first.id,
    });
    await storage.addExpression(first);
    await storage.addExpression(second);
    assert.deepEqual((await storage.versionIds()).sort(), [first.id, second.id].sort());
    const third: Expression = await version('app.note', {
      key: first.key,
      seq: 2,
      prev: second.id,
      genesis: first.id,
    });
    await storage.addExpression(third);
    assert.deepEqual((await storage.versionIds()).sort(), [first.id, second.id, third.id].sort());
    assert.equal((await storage.items('app.note')).size, 3);
    // What they said is gone; that they were is not.
    assert.equal('body' in (await storage.getExpression(second.id))!, false);
    assert.equal('body' in (await storage.getExpression(first.id))!, false);
    assert.deepEqual((await storage.getExpression(third.id))?.body, third.body);
  });

  test('joining, a deleted record never shows as it once was', async () => {
    // Waits, as a peer's gatekeeper does, for the first version a later one names.
    let b: StorageProvider | null = null;
    const synced = pair({
      validate: async (e) =>
        e.seq > 0 && e.genesis && !(await b!.getExpression(e.genesis))
          ? { valid: false, reason: 'first version not here', later: true }
          : { valid: true },
    });
    b = synced.b.storage;
    // 300 records written and then deleted, then 100 that stay: many rounds' worth.
    const gone = [];
    for (let i = 0; i < 300; i++) gone.push(await version('app.pixel'));
    for (const first of gone) {
      await synced.a.storage.addExpression(first);
      await synced.a.storage.addExpression(
        await version('app.pixel', {
          key: first.key,
          seq: 1,
          prev: first.id,
          genesis: first.id,
          deleted: true,
          body: null,
        }),
      );
    }
    for (let i = 0; i < 100; i++) await synced.a.storage.addExpression(await version('app.pixel'));

    // What b would show after each message, from what it took in: a record whose newest version is not a delete.
    const newest = new Map<string, Expression>();
    let most = 0;
    synced.b.sync.on('received', (versions: Expression[]) => {
      for (const v of versions) if ((newest.get(v.key)?.seq ?? -1) < v.seq) newest.set(v.key, v);
      most = Math.max(most, [...newest.values()].filter((v) => !v.deleted).length);
    });
    synced.b.sync.notifyPeers(['a']);
    await synced.settle();

    assert.equal(await b.fingerprint(), await synced.a.storage.fingerprint());
    assert.equal(most, 100, 'never more than the records that stay');
  });

  test('a version that waits for its first version asks for it at once, and is acknowledged once in', async () => {
    let b: StorageProvider | null = null;
    const synced = pair({
      validate: async (e) =>
        e.seq > 0 && e.genesis && !(await b!.getExpression(e.genesis))
          ? { valid: false, reason: 'first version not here', later: true }
          : { valid: true },
    });
    b = synced.b.storage;
    await synced.settle();
    const stored: string[] = [];
    synced.a.sync.on('stored', (_peer: string, ids: string[]) => stored.push(...ids));
    const first = await version('app.note');
    const edit = await version('app.note', { key: first.key, seq: 1, prev: first.id, genesis: first.id });
    await synced.a.storage.addExpression(first);
    await synced.a.storage.addExpression(edit);
    // Only the edit is pushed, and no round of sync runs: the first version comes because b asks for it.
    synced.a.sync.onLocalChange(edit);
    await synced.settle();
    assert.equal((await b.getCurrent(first.key))?.id, edit.id);
    assert.notEqual(await b.getExpression(first.id), null);
    assert.ok(stored.includes(edit.id), 'the pushed edit, though it went in after its first version');
  });

  test('a want whose answer is lost is given up, and the peer is synced again', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
    let lost = false;
    const synced = pair({
      // b's first answer to a want never reaches a.
      drop: (message) =>
        !lost && message.type === 'versions' && typeof message.id === 'number' && (lost = true),
      heartbeatInterval: 10,
    });
    try {
      const onlyB = await version('app.note');
      await synced.b.storage.addExpression(onlyB);
      let syncedWithB = 0;
      synced.a.sync.on('synced', (peer: string) => peer === 'b' && syncedWithB++);
      synced.a.sync.start();
      await synced.settle(40);
      assert.equal(lost, true);
      // The next hello asked again and got it; the lost want still counts as in flight.
      assert.notEqual(await synced.a.storage.getExpression(onlyB.id), null);
      syncedWithB = 0;
      await synced.settle(40);
      assert.equal(syncedWithB, 0, 'not synced while a want is in flight');

      mock.timers.tick(31_000);
      await synced.settle(40);
      assert.ok(syncedWithB > 0, 'synced once the lost want is given up');
    } finally {
      synced.a.sync.stop();
      mock.timers.reset();
    }
  });

  test('changes that come in while one lands land together; one that fails leaves nothing', async () => {
    const adapter = createMemoryAdapter();
    let batches = 0;
    let broken: string | null = null;
    const counted = {
      ...adapter,
      batch: (ops: Parameters<typeof adapter.batch>[0]) => {
        batches++;
        return adapter.batch(ops);
      },
      getExpression: (id: string) =>
        id === broken ? Promise.reject(new Error('unreadable')) : adapter.getExpression(id),
    };
    const storage = createStorageProvider(counted);
    const versions = await Promise.all(Array.from({ length: 16 }, () => version('app.note')));
    await Promise.all(versions.map((v) => storage.addExpression(v)));
    assert.ok(batches <= 2, `${batches} writes for 16 changes`);
    for (const v of versions) assert.equal((await storage.getCurrent(v.key))?.id, v.id);

    // A fresh store over the same adapter, so it must read the current version it replaces.
    const fresh = createStorageProvider(counted);
    const target = versions[0]!;
    broken = target.id;
    const edit = await version('app.note', { key: target.key, seq: 1, prev: target.id, genesis: target.id });
    const other = await version('app.note');
    const [failed, landed] = await Promise.allSettled([
      fresh.addExpression(edit),
      fresh.addExpression(other),
    ]);
    assert.equal(failed.status, 'rejected');
    assert.equal(landed.status, 'fulfilled');
    broken = null;
    const reread = createStorageProvider(counted);
    assert.equal((await reread.getCurrent(target.key))?.id, target.id, 'the failed change left nothing');
    assert.equal((await reread.getCurrent(other.key))?.id, other.id);
  });
});

describe('holding part of a space', () => {
  const ids = async (storage: StorageProvider, collection: string) =>
    (await storage.queryExpressions(collection)).map((v) => v.id).sort();

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
    const { a, b, sent, settle } = pair({
      holdsA: () => new Set(['app.x', 'app.y']),
      holdsB: () => new Set(['app.y', 'app.z']),
    });
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
