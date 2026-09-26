/**
 * @module encrypted-adapter
 * Encryption at rest for the parts of a store that would otherwise give the
 * whole folder away.
 *
 * A private space encrypts every body before signing, which protects it from
 * the relay and from peers who were never invited. It does not protect it from
 * anyone holding the folder, because the AES key for that space is written into
 * the same store as the ciphertext it opens. This closes that: the space key and
 * the space record go in sealed under a key derived from the account seed, so
 * they are readable only once the folder has actually been unlocked.
 *
 * Scoped deliberately narrowly. Expressions and their index entries pass
 * straight through: bodies are already encrypted where it matters, files are
 * content addressed, and sealing them would cost the property that makes a folder worth
 * having — that you can open it and see what is in it. What stays legible is
 * each record's author, timestamp and collection, plus anything in a space its
 * owner made public.
 */

import type { StorageAdapter, BatchOp } from '../types.js';
import { concatBytes } from '../utils/encoding.js';

/**
 * Marks a value this module wrote.
 *
 * Without it there is no way to tell ciphertext from a value stored before the
 * folder had a lock, and "try to decrypt, fall back to raw on failure" turns
 * every genuine key mismatch into silently wrong data.
 */
const MAGIC = new Uint8Array([0x77, 0x65, 0x61, 0x76, 0x65, 0x65, 0x02, 0x00]); // "weavee\x02\x00" — Weave, encrypted, v2
const IV_BYTES = 12;

/**
 * What gets sealed by default: the space registry — each space, its key, and
 * the write secret of a shared one — and nothing else.
 *
 * A prefix match, so each must end in its colon: `space:` does not cover
 * `spaceinvite:`, and an invite secret left out here is anyone-with-the-folder
 * joining a space in your place.
 */
export const DEFAULT_ENCRYPTED_PREFIXES: ReadonlyArray<string> = ['space:', 'spacekey:', 'spaceinvite:', 'spacerole:'];

export interface EncryptedAdapterOptions {
  /** Key prefixes whose values are sealed. Defaults to {@link DEFAULT_ENCRYPTED_PREFIXES}. */
  readonly prefixes?: ReadonlyArray<string>;
}

/** Whether these bytes were written sealed. */
function isSealed(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length + IV_BYTES) return false;
  return MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * Wraps a storage adapter so that selected values are encrypted on the way in
 * and decrypted on the way out.
 *
 * Each value is bound to its storage key (it is the AES-GCM additional data),
 * so sealed values cannot be swapped between entries. A value under a sealed
 * prefix that was not sealed is refused, not trusted: anyone who can write the
 * folder could otherwise plant a space, or a key, in the clear.
 *
 * @param inner The adapter doing the actual storing
 * @param key An AES-GCM key, from `deriveVaultKey`
 * @param options Which keys to seal
 * @returns An adapter with the same contract
 */
export function createEncryptedAdapter(
  inner: StorageAdapter,
  key: CryptoKey,
  options?: EncryptedAdapterOptions,
): StorageAdapter {
  const prefixes = options?.prefixes ?? DEFAULT_ENCRYPTED_PREFIXES;

  const shouldSeal = (storageKey: string): boolean =>
    prefixes.some((prefix) => storageKey.startsWith(prefix));

  const bound = (storageKey: string) => new TextEncoder().encode(storageKey) as BufferSource;

  async function seal(storageKey: string, value: Uint8Array): Promise<Uint8Array> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: bound(storageKey) },
      key,
      value as BufferSource,
    );
    return concatBytes(MAGIC, iv, new Uint8Array(ciphertext));
  }

  async function unseal(storageKey: string, bytes: Uint8Array): Promise<Uint8Array> {
    if (!isSealed(bytes)) throw new Error(`${storageKey} should be sealed, and is not — refusing it`);

    const iv = bytes.slice(MAGIC.length, MAGIC.length + IV_BYTES);
    const ciphertext = bytes.slice(MAGIC.length + IV_BYTES);
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: bound(storageKey) },
      key,
      ciphertext as BufferSource,
    );
    return new Uint8Array(plain);
  }

  return Object.freeze({
    async get(storageKey: string): Promise<Uint8Array | null> {
      const bytes = await inner.get(storageKey);
      if (!bytes || !shouldSeal(storageKey)) return bytes;
      return unseal(storageKey, bytes);
    },

    async put(storageKey: string, value: Uint8Array): Promise<void> {
      return inner.put(storageKey, shouldSeal(storageKey) ? await seal(storageKey, value) : value);
    },

    async batch(ops: ReadonlyArray<BatchOp>): Promise<void> {
      const prepared = await Promise.all(
        ops.map(async (op): Promise<BatchOp> =>
          op.type === 'put' && shouldSeal(op.key)
            ? { type: 'put', key: op.key, value: await seal(op.key, op.value) }
            : op,
        ),
      );
      return inner.batch(prepared);
    },

    // Key names are not sealed, so listing, deleting and existence checks are
    // unchanged. A space id is a content hash and gives nothing away; its name
    // and its key live in the value, which is sealed.
    delete: (storageKey: string) => inner.delete(storageKey),
    has: (storageKey: string) => inner.has(storageKey),
    list: (prefix?: string) => inner.list(prefix),

    // Expressions carry their own encryption where the space calls for it.
    queryExpressions: (collection: string, limit?: number, cursor?: string) =>
      inner.queryExpressions(collection, limit, cursor),
    putExpression: inner.putExpression.bind(inner),
    getExpression: (id: string) => inner.getExpression(id),
    deleteExpression: (id: string) => inner.deleteExpression(id),
    close: () => inner.close(),
  });
}
