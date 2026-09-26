/**
 * @module blob-store
 * A dumb file store. Anything that can keep bytes by name can be one: S3, R2,
 * Backblaze, a Dropbox or OneDrive app folder, a Drive folder, a directory.
 *
 * Deliberately narrower than `StorageAdapter`. Assume it is slow, eventually
 * consistent and without atomic operations — the mirror above
 * (`storage/mirror.ts`) is what turns one into a place a space can live.
 */
export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key under `prefix`, in no particular order */
  list(prefix: string): Promise<string[]>;
  /**
   * Keys that appeared or went away under `prefix` since `cursor`, where the
   * service can say so cheaply. Without it the mirror lists.
   */
  changes?(prefix: string, cursor: string | null): Promise<{ added: string[]; removed: string[]; cursor: string }>;
}
