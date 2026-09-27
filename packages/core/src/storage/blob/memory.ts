/**
 * @module storage/blob/memory
 * A blob store in memory, for tests — and for trying a mirror without a service.
 */
import type { BlobStore } from '../blob-store.js';

export function createMemoryBlobStore(): BlobStore & { readonly size: () => number } {
  const blobs = new Map<string, Uint8Array>();
  return Object.freeze({
    async get(key: string) {
      const found = blobs.get(key);
      return found ? new Uint8Array(found) : null;
    },
    async put(key: string, bytes: Uint8Array) {
      blobs.set(key, new Uint8Array(bytes));
    },
    async delete(key: string) {
      blobs.delete(key);
    },
    async list(prefix: string) {
      return [...blobs.keys()].filter((key) => key.startsWith(prefix));
    },
    size: () => [...blobs.values()].reduce((total, bytes) => total + bytes.length, 0),
  });
}
