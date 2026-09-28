/**
 * @module indexeddb-adapter
 * IndexedDB implementation of StorageAdapter for P2P network.
 */

import type { StorageAdapter, BatchOp, Expression } from '../types.js';
import { isStoredExpression } from '../utils/narrow.js';

/**
 * Bumped to 3 when the Merkle tree gave way to plain entries and sync by
 * reconciliation. Opening an older database wipes it: it is a local copy,
 * rebuilt by syncing with peers.
 */
const DB_VERSION = 3;

/**
 * Promisify an IDBRequest.
 * @param request The IDBRequest to promisify
 * @returns A promise that resolves with the request result
 */
function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** A stored expression, or null for a miss */
async function readExpression(request: IDBRequest<unknown>): Promise<Expression | null> {
  const value = await idbRequest(request);
  return isStoredExpression(value) ? value : null;
}

/**
 * Helper to manage IDBTransactions.
 * @param db The IDB database instance
 * @param stores The stores to include in the transaction
 * @param mode The transaction mode ('readonly' | 'readwrite')
 * @returns The transaction and a promise that resolves when it completes
 */
function idbTransaction(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
): { tx: IDBTransaction; complete: Promise<void> } {
  const tx = db.transaction(stores, mode);
  const complete = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(new Error('Transaction aborted'));
  });
  return { tx, complete };
}

/**
 * Creates an IndexedDB backed storage adapter.
 * @param dbName The name of the database (defaults to 'weave-storage')
 * @returns A promise resolving to the StorageAdapter
 */
export async function createIndexedDBAdapter(dbName = 'weave-storage'): Promise<StorageAdapter> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(dbName, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const previousVersion = event.oldVersion;

      // Older versions indexed records in a Merkle tree this store no longer
      // has. The local copy is dropped and rebuilt by syncing with peers.
      if (previousVersion > 0 && previousVersion < 3) {
        for (const name of ['kv', 'expressions']) {
          if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        }
      }

      // Store for key-value: which version is current, what sync compares, space records
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }

      // Store for expressions
      if (!db.objectStoreNames.contains('expressions')) {
        const expStore = db.createObjectStore('expressions', { keyPath: 'id' });
        expStore.createIndex('collection', 'collection', { unique: false });
        expStore.createIndex('author', 'author', { unique: false });
        expStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Could not open ${dbName}`));
  });

  return Object.freeze({
    async get(key: string): Promise<Uint8Array | null> {
      const { tx } = idbTransaction(db, ['kv'], 'readonly');
      const store = tx.objectStore('kv');
      const result = await idbRequest<unknown>(store.get(key));
      return result instanceof ArrayBuffer ? new Uint8Array(result) : null;
    },

    async put(key: string, value: Uint8Array): Promise<void> {
      const { tx, complete } = idbTransaction(db, ['kv'], 'readwrite');
      const store = tx.objectStore('kv');
      store.put(value.buffer, key);
      await complete;
    },

    async delete(key: string): Promise<void> {
      const { tx, complete } = idbTransaction(db, ['kv'], 'readwrite');
      const store = tx.objectStore('kv');
      store.delete(key);
      await complete;
    },

    async has(key: string): Promise<boolean> {
      const { tx } = idbTransaction(db, ['kv'], 'readonly');
      const store = tx.objectStore('kv');
      const count = await idbRequest(store.count(key));
      return count > 0;
    },

    async list(prefix = ''): Promise<string[]> {
      const { tx } = idbTransaction(db, ['kv'], 'readonly');
      const store = tx.objectStore('kv');
      const keys: string[] = [];

      const request = prefix
        ? store.openCursor(IDBKeyRange.bound(prefix, prefix + '\uFFFF', false, false))
        : store.openCursor();

      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            if (typeof cursor.key === 'string') keys.push(cursor.key);
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      });
      return keys;
    },

    async queryExpressions(collection: string, limit = 50, cursor?: string): Promise<Expression[]> {
      const { tx } = idbTransaction(db, ['expressions'], 'readonly');
      const store = tx.objectStore('expressions');
      const index = store.index('collection');

      const range = IDBKeyRange.only(collection);
      const request = index.openCursor(range);

      const results: Expression[] = [];
      let advanced = !cursor;

      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const idbCursor = request.result;
          if (!idbCursor || results.length >= limit) {
            resolve();
            return;
          }

          if (!advanced && cursor && idbCursor.primaryKey === cursor) {
            advanced = true;
            idbCursor.continue();
            return;
          }

          const value: unknown = idbCursor.value;
          if (advanced && isStoredExpression(value)) {
            results.push(value);
          }
          idbCursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      });

      return results;
    },

    async entries(prefix: string): Promise<ReadonlyArray<readonly [string, Uint8Array]>> {
      const { tx } = idbTransaction(db, ['kv'], 'readonly');
      const store = tx.objectStore('kv');
      const range = IDBKeyRange.bound(prefix, prefix + '\uFFFF', false, false);
      // Both in key order, from one transaction: they line up.
      const [keys, values] = await Promise.all([
        idbRequest(store.getAllKeys(range)),
        idbRequest(store.getAll(range)),
      ]);
      return keys.flatMap((key, i) => {
        const value: unknown = values[i];
        return typeof key === 'string' && value instanceof ArrayBuffer
          ? [[key, new Uint8Array(value)] as const]
          : [];
      });
    },

    async commit(write: {
      readonly store: ReadonlyArray<Expression>;
      readonly ops: ReadonlyArray<BatchOp>;
      readonly remove: ReadonlyArray<string>;
    }): Promise<void> {
      const { tx, complete } = idbTransaction(db, ['kv', 'expressions'], 'readwrite');
      const expressions = tx.objectStore('expressions');
      const kv = tx.objectStore('kv');
      for (const expression of write.store) expressions.put(expression);
      for (const op of write.ops) {
        if (op.type === 'put') kv.put(op.value.buffer, op.key);
        else kv.delete(op.key);
      }
      for (const id of write.remove) expressions.delete(id);
      await complete;
    },

    async getExpressions(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Expression | null>> {
      if (ids.length === 0) return [];
      const { tx } = idbTransaction(db, ['expressions'], 'readonly');
      const store = tx.objectStore('expressions');
      return Promise.all(ids.map((id) => readExpression(store.get(id))));
    },

    async putExpression(expression: Expression): Promise<void> {
      const { tx, complete } = idbTransaction(db, ['expressions'], 'readwrite');
      const store = tx.objectStore('expressions');
      store.put(expression);
      await complete;
    },

    async getExpression(id: string): Promise<Expression | null> {
      const { tx } = idbTransaction(db, ['expressions'], 'readonly');
      return readExpression(tx.objectStore('expressions').get(id));
    },

    async deleteExpression(id: string): Promise<void> {
      const { tx, complete } = idbTransaction(db, ['expressions'], 'readwrite');
      const store = tx.objectStore('expressions');
      store.delete(id);
      await complete;
    },

    async batch(ops: ReadonlyArray<BatchOp>): Promise<void> {
      const { tx, complete } = idbTransaction(db, ['kv'], 'readwrite');
      const store = tx.objectStore('kv');
      for (const op of ops) {
        if (op.type === 'put') {
          store.put(op.value.buffer, op.key);
        } else if (op.type === 'delete') {
          store.delete(op.key);
        }
      }
      await complete;
    },

    async close(): Promise<void> {
      db.close();
    },
  });
}
