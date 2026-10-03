/**
 * @module identity/idb
 * The little of IndexedDB the small browser stores need: one object store per
 * database, and requests as promises.
 */

/** Opens a database, creating its one object store the first time */
export function openDb(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Could not open ${dbName}`));
  });
}

/** What a request gives back */
export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Settles when a transaction commits */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

/**
 * One request against an open database's store. Whatever this origin stored
 * comes back unchecked, so the caller checks it; a write settles once committed.
 */
export async function idbRun(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  const tx = db.transaction(storeName, mode);
  const [value]: [unknown, void] = await Promise.all([
    requestResult<unknown>(run(tx.objectStore(storeName))),
    mode === 'readwrite' ? transactionDone(tx) : undefined,
  ]);
  return value;
}

/** `idbRun`, opening the database around it */
export async function idbOnce(
  dbName: string,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  const db = await openDb(dbName, storeName);
  try {
    return await idbRun(db, storeName, mode, run);
  } finally {
    db.close();
  }
}
