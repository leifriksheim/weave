/**
 * @module storage-provider
 * Orchestrator combining StorageAdapter and Merkle Search Tree (MST).
 */

import type { StorageAdapter, Expression } from '../types.js';
import { insertIntoMST, deleteFromMST } from './mst.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';

export interface StorageProvider {
  /** Add an expression and update the MST. */
  addExpression(expression: Expression): Promise<string>;
  /** Remove an expression and update the MST. */
  removeExpression(id: string): Promise<string | null>;
  /** Retrieve an expression by ID. */
  getExpression(id: string): Promise<Expression | null>;
  /** Query expressions in a collection. */
  queryExpressions(collection: string, limit?: number, cursor?: string): Promise<Expression[]>;
  /** Get the current MST root CID. */
  getRootCid(): Promise<string | null>;
  /** Get the underlying storage adapter. */
  getAdapter(): StorageAdapter;
  /** Close the storage adapter. */
  close(): Promise<void>;
}

const ROOT_KEY = '__mst_root';

/**
 * Creates a StorageProvider wrapping an adapter.
 * @param adapter The initialized storage adapter.
 * @returns The StorageProvider orchestrator.
 */
export function createStorageProvider(adapter: StorageAdapter): StorageProvider {
  async function getRootCid(): Promise<string | null> {
    const bytes = await adapter.get(ROOT_KEY);
    return bytes ? utf8Decode(bytes) : null;
  }

  async function setRootCid(cid: string | null): Promise<void> {
    if (cid) {
      await adapter.put(ROOT_KEY, utf8Encode(cid));
    } else {
      await adapter.delete(ROOT_KEY);
    }
  }

  return Object.freeze({
    async addExpression(expression: Expression): Promise<string> {
      await adapter.putExpression(expression);
      const currentRoot = await getRootCid();
      const newRoot = await insertIntoMST(adapter, currentRoot, expression.id, expression.id);
      await setRootCid(newRoot);
      return newRoot;
    },

    async removeExpression(id: string): Promise<string | null> {
      const currentRoot = await getRootCid();
      const newRoot = await deleteFromMST(adapter, currentRoot, id);
      await adapter.deleteExpression(id);
      await setRootCid(newRoot);
      return newRoot;
    },

    async getExpression(id: string): Promise<Expression | null> {
      return adapter.getExpression(id);
    },

    async queryExpressions(collection: string, limit?: number, cursor?: string): Promise<Expression[]> {
      return adapter.queryExpressions(collection, limit, cursor);
    },

    async getRootCid(): Promise<string | null> {
      return getRootCid();
    },

    getAdapter(): StorageAdapter {
      return adapter;
    },

    async close(): Promise<void> {
      await adapter.close();
    }
  });
}
