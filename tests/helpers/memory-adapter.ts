import type { StorageAdapter, BatchOp, Expression } from '../../src/types.js';

/**
 * An in-memory StorageAdapter, for tests and headless runtimes without IndexedDB.
 * @returns A StorageAdapter backed by Maps
 */
export function createMemoryAdapter(): StorageAdapter {
  const kv = new Map<string, Uint8Array>();
  const expressions = new Map<string, Expression>();

  return {
    async get(key) {
      return kv.get(key) ?? null;
    },
    async put(key, value) {
      kv.set(key, value);
    },
    async delete(key) {
      kv.delete(key);
    },
    async has(key) {
      return kv.has(key);
    },
    async list(prefix = '') {
      return [...kv.keys()].filter((key) => key.startsWith(prefix));
    },
    async queryExpressions(collection, limit = 50) {
      return [...expressions.values()].filter((e) => e.collection === collection).slice(0, limit);
    },
    async putExpression(expression) {
      expressions.set(expression.id, expression);
    },
    async getExpression(id) {
      return expressions.get(id) ?? null;
    },
    async deleteExpression(id) {
      expressions.delete(id);
    },
    async batch(ops: ReadonlyArray<BatchOp>) {
      for (const op of ops) {
        if (op.type === 'put') kv.set(op.key, op.value);
        else kv.delete(op.key);
      }
    },
    async close() {
      kv.clear();
      expressions.clear();
    },
  };
}
