/**
 * @module indexeddb-adapter
 * IndexedDB implementation of StorageAdapter for P2P network.
 */

import type { StorageAdapter, BatchOp, Expression } from '../types.js';

/**
 * Bumped to 2 when MST nodes gained a `height` field. Opening an older
 * database wipes it rather than reading nodes the tree can no longer parse.
 */
const DB_VERSION = 2;

/**
 * Promisify an IDBRequest.
 * @param request The IDBRequest to promisify
 * @returns A promise that resolves with the request result
 */
function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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
  mode: IDBTransactionMode
): { tx: IDBTransaction; complete: Promise<void> } {
  const tx = db.transaction(stores, mode);
  const complete = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new Error('Transaction aborted'));
  });
  return { tx, complete };
}

/**
 * Creates an IndexedDB backed storage adapter.
 * @param dbName The name of the database (defaults to 'weave-storage')
 * @returns A promise resolving to the StorageAdapter
 */
export async function createIndexedDBAdapter(dbName: string = 'weave-storage'): Promise<StorageAdapter> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(dbName, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const previousVersion = (event as IDBVersionChangeEvent).oldVersion;

      // v1 stored MST nodes without a height, which the current tree cannot
      // read. There is no way to migrate them — the old structure was a single
      // flat node with no tree to recover — so the local cache is dropped and
      // rebuilt by syncing with peers.
      if (previousVersion > 0 && previousVersion < 2) {
        for (const name of ['kv', 'expressions']) {
          if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        }
      }

      // Store for key-value (MST nodes, root cid, etc)
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
    request.onerror = () => reject(request.error);
  });

  return Object.freeze({
    async get(key: string): Promise<Uint8Array | null> {
      const { tx } = idbTransaction(db, ['kv'], 'readonly');
      const store = tx.objectStore('kv');
      const result = await idbRequest(store.get(key));
      return result ? new Uint8Array(result) : null;
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

    async list(prefix: string = ''): Promise<string[]> {
      const { tx } = idbTransaction(db, ['kv'], 'readonly');
      const store = tx.objectStore('kv');
      const keys: string[] = [];
      
      let request;
      if (prefix) {
        const bound = prefix + '\uFFFF';
        request = store.openCursor(IDBKeyRange.bound(prefix, bound, false, false));
      } else {
        request = store.openCursor();
      }

      await new Promise<void>((resolve, reject) => {
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            keys.push(cursor.key as string);
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      });
      return keys;
    },

    async queryExpressions(collection: string, limit: number = 50, cursor?: string): Promise<Expression[]> {
      const { tx } = idbTransaction(db, ['expressions'], 'readonly');
      const store = tx.objectStore('expressions');
      const index = store.index('collection');
      
      const range = IDBKeyRange.only(collection);
      const request = index.openCursor(range);
      
      const results: Expression[] = [];
      let advanced = !cursor;

      await new Promise<void>((resolve, reject) => {
        request.onsuccess = (event) => {
          const idbCursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (!idbCursor || results.length >= limit) {
            resolve();
            return;
          }
          
          if (!advanced && cursor && idbCursor.primaryKey === cursor) {
            advanced = true;
            idbCursor.continue();
            return;
          }
          
          if (advanced) {
            results.push(idbCursor.value);
          }
          idbCursor.continue();
        };
        request.onerror = () => reject(request.error);
      });

      return results;
    },

    async putExpression(expression: Expression): Promise<void> {
      const { tx, complete } = idbTransaction(db, ['expressions'], 'readwrite');
      const store = tx.objectStore('expressions');
      store.put(expression);
      await complete;
    },

    async getExpression(id: string): Promise<Expression | null> {
      const { tx } = idbTransaction(db, ['expressions'], 'readonly');
      const store = tx.objectStore('expressions');
      const result = await idbRequest(store.get(id));
      return result || null;
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
    }
  });
}
