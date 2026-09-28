/**
 * What IndexedDB itself costs for the writes a store makes: transactions of
 * 16 puts, and of 16 puts plus 16 deletes, into an object store with the
 * adapter's three indexes, and into one without. Run by `run.mjs`.
 */
const log = (line: string) => console.log(line);
const N = Number(new URLSearchParams(location.search).get('n') ?? 4096);

function open(name: string, indexed: boolean): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('expressions', { keyPath: 'id' });
      if (indexed)
        for (const index of ['collection', 'author', 'createdAt'])
          store.createIndex(index, index, { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const version = (i: number) => ({
  id: `b${i.toString(36).padStart(52, '0')}`,
  collection: 'app.pixels.cell',
  author: 'did:key:zDnaeexample',
  createdAt: new Date(1_700_000_000_000 + i).toISOString(),
  body: { iv: 'x'.repeat(16), ciphertext: 'y'.repeat(120), keyId: 'z'.repeat(43) },
  signature: 's'.repeat(86),
  key: `px.${i}`,
  seq: 0,
});

function write(db: IDBDatabase, put: number[], remove: number[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['expressions'], 'readwrite', { durability: 'relaxed' });
    const store = tx.objectStore('expressions');
    for (const i of put) store.put(version(i));
    for (const i of remove) store.delete(version(i).id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function run(indexed: boolean) {
  const db = await open(`micro-${indexed}-${Date.now()}`, indexed);
  const range = (from: number, n: number) => Array.from({ length: n }, (_, j) => from + j);
  let t = performance.now();
  for (let i = 0; i < N; i += 16) await write(db, range(i, 16), []);
  log(
    `${indexed ? 'indexed' : 'plain  '}: 16 puts per transaction: ${((performance.now() - t) / (N / 16)).toFixed(2)}ms each`,
  );
  t = performance.now();
  for (let i = 0; i < N; i += 16) await write(db, range(N + i, 16), range(i, 16));
  log(
    `${indexed ? 'indexed' : 'plain  '}: 16 puts and 16 deletes per transaction: ${((performance.now() - t) / (N / 16)).toFixed(2)}ms each`,
  );
  db.close();
}

await run(true);
await run(false);
log('done');
