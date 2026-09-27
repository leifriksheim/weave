/**
 * Folder storage tests — the adapter itself, and the property the whole design
 * rests on: two origins sharing one directory converge without coordinating.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryDirectory } from './helpers/memory-directory.js';
import { createFolderAdapter, type FolderAdapter } from '../src/storage/folder-adapter.js';
import { reconcileFolder } from '../src/storage/folder-reconcile.js';
import { createStorageProvider, type StorageProvider } from '../src/storage/storage-provider.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { utf8Encode, utf8Decode } from '../src/utils/encoding.js';
import type { Expression } from '../src/types.js';

const provider = createP256Provider();
const signer = createSigner(provider);
const COLLECTION = 'app.test.note';

/** A signed expression, so the fixtures look like the real thing. */
async function makeExpression(text: string): Promise<Expression> {
  const keys = await provider.generateKeyPair();
  const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
  const unsigned = createExpression({ author: did, collection: COLLECTION, body: { text } });
  return (await signer.sign(unsigned, keys.privateKey)) as Expression;
}

describe('folder adapter — key/value storage', () => {
  test('round-trips values through files', async () => {
    const folder = createMemoryDirectory();
    const adapter = await createFolderAdapter(folder.handle, 'notes');

    await adapter.put('hello', utf8Encode('world'));

    assert.equal(utf8Decode((await adapter.get('hello'))!), 'world');
    assert.equal(await adapter.has('hello'), true);
    assert.equal(await adapter.get('missing'), null);
    assert.equal(await adapter.has('missing'), false);
  });

  test('survives keys that are not filename-safe', async () => {
    const folder = createMemoryDirectory();
    const adapter = await createFolderAdapter(folder.handle, 'notes');

    // The shapes the space manager and the store actually use.
    const keys = ['space:bafy123', 'spacekey:bafy123', '__mst_root', 'a/b/c', 'w i t h  s p a c e'];
    for (const key of keys) await adapter.put(key, utf8Encode(key));

    for (const key of keys) {
      assert.equal(utf8Decode((await adapter.get(key))!), key, `key ${key} did not round-trip`);
    }
    assert.deepEqual((await adapter.list()).sort(), [...keys].sort());
  });

  test('keeps keys apart that a case-insensitive filesystem would merge', async () => {
    const folder = createMemoryDirectory();
    const adapter = await createFolderAdapter(folder.handle, 'notes');

    await adapter.put('Key', utf8Encode('upper'));
    await adapter.put('key', utf8Encode('lower'));

    assert.equal(utf8Decode((await adapter.get('Key'))!), 'upper');
    assert.equal(utf8Decode((await adapter.get('key'))!), 'lower');
    // On macOS or Windows these must not be one file.
    assert.equal(folder.paths().filter((path) => path.includes('/kv/')).length, 2);
  });

  test('lists by prefix, and deletes', async () => {
    const folder = createMemoryDirectory();
    const adapter = await createFolderAdapter(folder.handle, 'notes');

    await adapter.put('space:one', utf8Encode('1'));
    await adapter.put('space:two', utf8Encode('2'));
    await adapter.put('other', utf8Encode('3'));

    assert.deepEqual((await adapter.list('space:')).sort(), ['space:one', 'space:two']);

    await adapter.delete('space:one');
    assert.equal(await adapter.get('space:one'), null);
    assert.deepEqual(await adapter.list('space:'), ['space:two']);
  });

  test('applies a batch', async () => {
    const folder = createMemoryDirectory();
    const adapter = await createFolderAdapter(folder.handle, 'notes');

    await adapter.put('gone', utf8Encode('x'));
    await adapter.batch([
      { type: 'put', key: 'kept', value: utf8Encode('y') },
      { type: 'delete', key: 'gone' },
    ]);

    assert.equal(utf8Decode((await adapter.get('kept'))!), 'y');
    assert.equal(await adapter.get('gone'), null);
  });
});

describe('folder adapter — expressions', () => {
  test('stores each expression as its own file and queries by collection', async () => {
    const folder = createMemoryDirectory();
    const adapter = await createFolderAdapter(folder.handle, 'notes');

    const first = await makeExpression('one');
    const second = await makeExpression('two');
    await adapter.putExpression(first);
    await adapter.putExpression(second);

    const found = await adapter.queryExpressions(COLLECTION, 50);
    assert.equal(found.length, 2);
    assert.deepEqual(
      found.map((expression) => expression.id).sort(),
      [first.id, second.id].sort(),
    );

    assert.deepEqual(await adapter.getExpression(first.id), first);
    assert.equal(await adapter.getExpression('nope'), null);

    // One file per record, named after its own hash — that is what lets two
    // copies of the folder merge by union.
    const files = folder.paths().filter((path) => path.includes('/expressions/'));
    assert.equal(files.length, 2);
    assert.ok(files.some((path) => path.endsWith(`${first.id}.json`)));
  });

  test('pages with a cursor', async () => {
    const folder = createMemoryDirectory();
    const adapter = await createFolderAdapter(folder.handle, 'notes');

    const written: Expression[] = [];
    for (let i = 0; i < 5; i++) written.push(await makeExpression(`note ${i}`));
    for (const expression of written) await adapter.putExpression(expression);

    const firstPage = await adapter.queryExpressions(COLLECTION, 2);
    assert.equal(firstPage.length, 2);

    const secondPage = await adapter.queryExpressions(COLLECTION, 2, firstPage[1]!.id);
    assert.equal(secondPage.length, 2);

    const ids = new Set([...firstPage, ...secondPage].map((expression) => expression.id));
    assert.equal(ids.size, 4, 'pages should not overlap');
  });

  test('reopening a folder finds what was written before', async () => {
    const folder = createMemoryDirectory();
    const first = await createFolderAdapter(folder.handle, 'notes');
    const expression = await makeExpression('durable');
    await first.putExpression(expression);
    await first.close();

    const reopened = await createFolderAdapter(folder.handle, 'notes');
    assert.deepEqual(await reopened.getExpression(expression.id), expression);
  });
});

describe('two origins, one folder', () => {
  /** Opens an independent view of a folder — a second deployment of the app. */
  async function openOrigin(
    handle: ReturnType<typeof createMemoryDirectory>['handle'],
  ): Promise<{ adapter: FolderAdapter; storage: StorageProvider }> {
    const adapter = await createFolderAdapter(handle, 'spaces/demo');
    return { adapter, storage: createStorageProvider(adapter) };
  }

  test('a key another writer creates after a miss is found by listing', async () => {
    const folder = createMemoryDirectory();
    const a = await openOrigin(folder.open());
    const b = await openOrigin(folder.open());

    // B asks first and finds nothing — and remembers that.
    assert.equal(await b.adapter.get('space:new'), null);
    await a.adapter.put('space:new', new Uint8Array([1, 2, 3]));

    // Listing is how a writer's additions are discovered; the stale miss must not hide them.
    assert.deepEqual(await b.adapter.list('space:'), ['space:new']);
    assert.deepEqual(await b.adapter.get('space:new'), new Uint8Array([1, 2, 3]));
  });

  test('what one origin writes, the other sees — and reconciling reports it', async () => {
    const folder = createMemoryDirectory();
    const a = await openOrigin(folder.open());
    const b = await openOrigin(folder.open());

    const expression = await makeExpression('written on A');
    await a.storage.addExpression(expression);

    // Reconciling notices the file A added. (Both read the same root pointer
    // from disk, so B's lists already include it; reconciling is what repairs
    // a tree whose pointer write was lost.)
    const result = await reconcileFolder(b.storage, b.adapter);
    assert.deepEqual(result.added, [expression.id]);
    assert.equal(result.changed, true);

    const seen = await b.storage.queryExpressions(COLLECTION, 50);
    assert.deepEqual(seen.map((item) => item.id), [expression.id]);
  });

  test('a delete on one origin propagates to the other', async () => {
    const folder = createMemoryDirectory();
    const a = await openOrigin(folder.open());
    const b = await openOrigin(folder.open());

    const expression = await makeExpression('short-lived');
    await a.storage.addExpression(expression);
    await reconcileFolder(b.storage, b.adapter);
    assert.equal((await b.storage.queryExpressions(COLLECTION, 50)).length, 1);

    await a.storage.removeExpression(expression.id);
    await reconcileFolder(b.storage, b.adapter);

    assert.equal((await b.storage.queryExpressions(COLLECTION, 50)).length, 0);
    assert.equal(await b.storage.fingerprint(), await a.storage.fingerprint());
  });

  test('a tree that still indexes a vanished file is repaired from the files', async () => {
    const folder = createMemoryDirectory();
    const a = await openOrigin(folder.open());

    const expression = await makeExpression('deleted behind our back');
    await a.storage.addExpression(expression);

    // Delete the file without going through the provider — another device did
    // it while this one was closed, so the root pointer still indexes it. This
    // is the case the shared root pointer cannot cover, and the reason
    // reconciling reads the directory rather than trusting the pointer.
    const store = await (await folder.open().getDirectoryHandle('spaces')).getDirectoryHandle('demo');
    const expressions = await store.getDirectoryHandle('expressions');
    await expressions.removeEntry(`${expression.id}.json`);

    const result = await reconcileFolder(a.storage, a.adapter);

    assert.deepEqual(result.removed, [expression.id]);
    assert.deepEqual(result.repaired, [expression.id], 'the entries should have been fixed');
    assert.equal((await a.storage.queryExpressions(COLLECTION, 50)).length, 0);
  });

  test('concurrent writes converge on the union, with the same fingerprint', async () => {
    const folder = createMemoryDirectory();
    const a = await openOrigin(folder.open());
    const b = await openOrigin(folder.open());

    // Neither knows about the other: interleaved writes, no coordination, and
    // both write the same folder's entries on the way.
    const fromA = await makeExpression('from A');
    const fromB = await makeExpression('from B');
    await a.storage.addExpression(fromA);
    await b.storage.addExpression(fromB);

    await reconcileFolder(a.storage, a.adapter);
    await reconcileFolder(b.storage, b.adapter);
    // A second pass on A: B's reconcile may have written entries after A had
    // already finished looking.
    await reconcileFolder(a.storage, a.adapter);

    const idsFrom = async (origin: { storage: StorageProvider }) =>
      (await origin.storage.queryExpressions(COLLECTION, 50)).map((item) => item.id).sort();

    assert.deepEqual(await idsFrom(a), [fromA.id, fromB.id].sort());
    assert.deepEqual(await idsFrom(b), [fromA.id, fromB.id].sort());

    // Same files means the same versions kept, which is the whole point of
    // deriving the entries from the files rather than trying to merge them.
    assert.equal(await a.storage.fingerprint(), await b.storage.fingerprint());
  });

  test('reconciling with nothing new reports no change', async () => {
    const folder = createMemoryDirectory();
    const a = await openOrigin(folder.open());
    await a.storage.addExpression(await makeExpression('settled'));

    const result = await reconcileFolder(a.storage, a.adapter);
    assert.equal(result.changed, false);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.repaired, []);
  });
});
