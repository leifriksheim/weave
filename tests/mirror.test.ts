/**
 * Mirrors: a space kept in a dumb, slow, untrusted file store, synced like a
 * peer — and the S3 driver behind a host's bucket. Every store here sits
 * behind a fixture that adds latency and counts calls, because a mirror's
 * real cost is requests.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { nextVersion } from '../src/records/version.js';
import { createStorageProvider, type StorageProvider } from '../src/storage/storage-provider.js';
import type { BlobStore } from '../src/storage/blob-store.js';
import { createMemoryBlobStore } from '../src/storage/blob/memory.js';
import { createS3BlobStore } from '../src/storage/blob/s3.js';
import { createMirror, deleteMirrored, type Taken } from '../src/storage/mirror.js';
import { packSegment, unpackSegment } from '../src/storage/segment.js';
import type { Expression } from '../src/types.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';

const provider = createP256Provider();
const signer = createSigner(provider);
const SPACE = 'space-1';

/** A store that is slow and counts what it is asked */
function counted(inner: BlobStore, delayMs = 2) {
  const calls = { get: 0, put: 0, delete: 0, list: 0 };
  const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  const writes = new Map<string, number>();
  const store: BlobStore = {
    get: async (key) => (calls.get++, await wait(), inner.get(key)),
    put: async (key, bytes) => {
      calls.put++;
      writes.set(key, (writes.get(key) ?? 0) + 1);
      await wait();
      return inner.put(key, bytes);
    },
    delete: async (key) => (calls.delete++, await wait(), inner.delete(key)),
    list: async (prefix) => (calls.list++, await wait(), inner.list(prefix)),
  };
  return { store, calls, writes };
}

async function author() {
  const pair = await provider.generateKeyPair();
  return { did: publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC), key: pair.privateKey };
}
type Author = Awaited<ReturnType<typeof author>>;

const note = (who: Author, text: string, version?: Parameters<typeof createExpression>[0]['version']) =>
  signer.sign(createExpression({ author: who.did, collection: 'app.note', space: SPACE, body: { text }, ...(version ? { version } : {}) }), who.key);

/** A device: its own store, and a mirror onto the shared one */
async function device(store: BlobStore, refuse: (version: Expression) => boolean = () => false) {
  const storage = createStorageProvider(createMemoryAdapter());
  const accept = async (version: Expression): Promise<Taken> => {
    if (refuse(version)) return 'refused';
    await storage.addExpression(version);
    return 'stored';
  };
  const mirror = await createMirror({ store, space: SPACE, storage, accept, state: createMemoryAdapter(), flushMs: 5 });
  return { storage, mirror };
}

const texts = async (storage: StorageProvider) =>
  (await storage.listCurrent()).map((version) => (version.body as { text: string }).text).sort();

describe('a mirror', () => {
  test('two devices never online together meet through it — and no file is written twice', async () => {
    const shared = counted(createMemoryBlobStore());
    const who = await author();
    const laptop = await device(shared.store);
    const phone = await device(shared.store);

    await laptop.storage.addExpression(await note(who, 'from the laptop'));
    await laptop.mirror.flush();
    await phone.mirror.pull();
    await phone.storage.addExpression(await note(who, 'from the phone'));
    await phone.mirror.flush();
    await laptop.mirror.pull();

    assert.deepEqual(await texts(laptop.storage), ['from the laptop', 'from the phone']);
    assert.deepEqual(await texts(phone.storage), ['from the laptop', 'from the phone']);
    assert.ok([...shared.writes.values()].every((count) => count === 1), 'every file written once');
    // The phone uploaded only its own note: what it read from the laptop's segment was known already.
    assert.equal((await shared.store.list(`${SPACE}/`)).length, 2);
  });

  test('a segment is read once; a second pull with nothing new fetches nothing', async () => {
    const shared = counted(createMemoryBlobStore());
    const who = await author();
    const laptop = await device(shared.store);
    const phone = await device(shared.store);
    for (let i = 0; i < 20; i += 1) await laptop.storage.addExpression(await note(who, `n${i}`));
    await laptop.mirror.flush();

    assert.equal((await phone.mirror.pull()).added, 20);
    const gets = shared.calls.get;
    assert.equal((await phone.mirror.pull()).added, 0);
    assert.equal(shared.calls.get, gets, 'no segment fetched again');
    // Nothing new to upload either: the phone knows the store holds all of it.
    const puts = shared.calls.put;
    await phone.mirror.flush();
    assert.equal(shared.calls.put, puts);
  });

  test('what the gates refuse stays out, and the rest of the segment goes in', async () => {
    const shared = counted(createMemoryBlobStore());
    const who = await author();
    const writer = await device(shared.store);
    await writer.storage.addExpression(await note(who, 'fine'));
    await writer.storage.addExpression(await note(who, 'junk'));
    await writer.mirror.flush();

    const reader = await device(shared.store, (version) => (version.body as { text?: string }).text === 'junk');
    await reader.mirror.pull();
    assert.deepEqual(await texts(reader.storage), ['fine']);
  });

  test('compaction: fewer segments, only what is still kept, and a fresh device still gets every record', async () => {
    const shared = counted(createMemoryBlobStore());
    const who = await author();
    const writer = await device(shared.store);
    let current = await note(who, 'v0');
    await writer.storage.addExpression(current);
    await writer.mirror.flush();
    for (let i = 1; i <= 10; i += 1) {
      current = await note(who, `v${i}`, nextVersion(current));
      await writer.storage.addExpression(current);
      await writer.mirror.flush();
    }
    const other = await note(who, 'another record');
    await writer.storage.addExpression(other);
    await writer.mirror.flush();
    const before = (await shared.store.list(`${SPACE}/`)).length;
    assert.equal(before, 12);

    await writer.mirror.compact();
    const after = await shared.store.list(`${SPACE}/`);
    assert.equal(after.length, 1);
    const kept = unpackSegment((await shared.store.get(after[0]!))!);
    assert.ok(kept.length < 12, 'superseded versions the store dropped are not carried forward');

    const fresh = await device(shared.store);
    await fresh.mirror.pull();
    assert.deepEqual(await texts(fresh.storage), ['another record', 'v10']);
  });

  test('changes go out on their own, soon after', async () => {
    const shared = counted(createMemoryBlobStore());
    const who = await author();
    const laptop = await device(shared.store);
    await laptop.storage.addExpression(await note(who, 'soon'));
    laptop.mirror.changed();
    laptop.mirror.changed();
    const deadline = Date.now() + 2000;
    while ((await shared.store.list(`${SPACE}/`)).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await shared.store.list(`${SPACE}/`)).length, 1, 'one segment for two changes close together');
    await laptop.mirror.close();
  });

  test('a space can be taken out of a store whole, and other spaces stay', async () => {
    const store = createMemoryBlobStore();
    await store.put(`${SPACE}/a/000001-x.seg`, packSegment([]));
    await store.put(`${SPACE}/b/000001-y.seg`, packSegment([]));
    await store.put('other/a/000001-z.seg', packSegment([]));
    await deleteMirrored(store, SPACE);
    assert.deepEqual(await store.list(''), ['other/a/000001-z.seg']);
  });

  test('a segment that is not one opens as nothing', () => {
    assert.deepEqual(unpackSegment(new TextEncoder().encode('not json')), []);
    assert.deepEqual(unpackSegment(new TextEncoder().encode('{"v":2,"versions":[]}')), []);
  });
});

describe('the S3 driver', () => {
  /** A bucket answering the way S3 does, one listing page at a time */
  function fakeS3(pageSize = 2) {
    const objects = new Map<string, Uint8Array>();
    const seen: Request[] = [];
    let busyOnce = true;
    const fetchS3 = (async (request: Request) => {
      seen.push(request);
      const url = new URL(request.url);
      const [, bucket, ...rest] = url.pathname.split('/');
      assert.equal(bucket, 'weave');
      const key = rest.map(decodeURIComponent).join('/');
      if (request.method === 'PUT') {
        // The first write is turned away, as a busy bucket does: the driver waits and tries again.
        if (busyOnce) {
          busyOnce = false;
          return new Response('slow down', { status: 503, headers: { 'retry-after': '0' } });
        }
        objects.set(key, new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      if (request.method === 'DELETE') {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (url.searchParams.get('list-type') === '2') {
        const all = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get('prefix') ?? '')).sort();
        const start = Number(url.searchParams.get('continuation-token') ?? 0);
        const page = all.slice(start, start + pageSize);
        const more = start + pageSize < all.length;
        const xml = `<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ''}</ListBucketResult>`;
        return new Response(xml, { status: 200 });
      }
      const found = objects.get(key);
      return found ? new Response(found, { status: 200 }) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchS3, objects, seen };
  }

  test('puts, gets, lists every page, deletes — every request signed, a busy bucket waited out', async () => {
    const bucket = fakeS3();
    const store = createS3BlobStore({
      endpoint: 'https://account.r2.test',
      bucket: 'weave',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      prefix: 'host-1',
      fetch: bucket.fetchS3,
    });
    await store.put('space/w/000001-a&b.seg', new Uint8Array([1, 2, 3]));
    for (const name of ['b', 'c', 'd', 'e']) await store.put(`space/w/${name}.seg`, new Uint8Array([4]));
    assert.deepEqual([...(await store.get('space/w/000001-a&b.seg'))!], [1, 2, 3]);
    assert.equal(await store.get('space/missing'), null);
    assert.deepEqual((await store.list('space/')).sort(), ['space/w/000001-a&b.seg', 'space/w/b.seg', 'space/w/c.seg', 'space/w/d.seg', 'space/w/e.seg']);
    assert.ok([...bucket.objects.keys()].every((key) => key.startsWith('host-1/')), 'everything under the prefix');
    await store.delete('space/w/b.seg');
    await store.delete('space/w/b.seg');
    assert.equal((await store.list('space/')).length, 4);
    assert.ok(bucket.seen.every((request) => /^AWS4-HMAC-SHA256 Credential=AKID\//.test(request.headers.get('authorization') ?? '')));
  });

  test('a host’s whole mirror works over it', async () => {
    const bucket = fakeS3(3);
    const store = createS3BlobStore({ endpoint: 'https://account.r2.test', bucket: 'weave', accessKeyId: 'A', secretAccessKey: 'S', fetch: bucket.fetchS3 });
    const who = await author();
    const a = await device(store);
    const b = await device(store);
    for (let i = 0; i < 5; i += 1) await a.storage.addExpression(await note(who, `n${i}`));
    await a.mirror.flush();
    await b.mirror.pull();
    assert.equal((await texts(b.storage)).length, 5);
  });
});
