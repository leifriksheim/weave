/**
 * @module device-key
 * The key that unlocks an account on one device.
 *
 * A passkey can only hand back a secret through the PRF extension, and several
 * widely used providers — Bitwarden among them — store passkeys without it. So
 * the shortcut does not ask the passkey for key material at all. It keeps a
 * random key here, and uses the passkey as the gate in front of it.
 *
 * ```
 * random key, non-extractable, in this origin's storage
 *   └─ wraps the account seed, which lives in the vault
 * a passkey assertion decides whether we reach for it
 * ```
 *
 * **Be clear about what that is.** The gate is enforced by this code, not by
 * cryptography: anything that can reach this origin's storage can use the key
 * without ever touching the passkey. What it does protect against is the case
 * that motivates the vault in the first place — someone holding a copy of the
 * folder, who has the wrapped seed and none of this.
 *
 * The key is generated non-extractable, so script can use it in place but
 * cannot copy it out. Malware on the machine can decrypt; it cannot walk away
 * with something that keeps working elsewhere.
 */

import { base64UrlEncode } from '../utils/encoding.js';

const DB_NAME = 'weave-device-keys';
const STORE = 'keys';

/** A local key, and the id a wrap records to find it again. */
export interface DeviceKey {
  readonly id: string;
  readonly key: CryptoKey;
}

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  dbName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb(dbName);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Makes a key for this device and remembers it.
 *
 * Non-extractable on purpose: a CryptoKey survives being stored and fetched
 * from IndexedDB, and staying non-extractable the whole time means no code
 * path — ours or anyone's — can turn it back into bytes.
 *
 * @param dbName Overridable for tests
 * @returns The key, and the id a wrap should record
 */
export async function createDeviceKey(dbName: string = DB_NAME): Promise<DeviceKey> {
  const key = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  const id = base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(12)));
  await withStore(dbName, 'readwrite', (store) => store.put(key, id));

  return { id, key };
}

/**
 * Finds a device key by id.
 *
 * Absent is a normal answer, not a failure: it means this wrap was made in
 * another browser, or storage has been cleared since. The account is still
 * openable by its password.
 *
 * @param id The id recorded in the wrap
 * @param dbName Overridable for tests
 * @returns The key, or null when this device does not have it
 */
export async function getDeviceKey(
  id: string,
  dbName: string = DB_NAME,
): Promise<CryptoKey | null> {
  try {
    return (await withStore<CryptoKey | undefined>(dbName, 'readonly', (store) => store.get(id))) ?? null;
  } catch {
    return null;
  }
}

/**
 * Forgets a device key, which makes its wrap permanently unopenable.
 * @param id The id recorded in the wrap
 * @param dbName Overridable for tests
 */
export async function deleteDeviceKey(id: string, dbName: string = DB_NAME): Promise<void> {
  try {
    await withStore(dbName, 'readwrite', (store) => store.delete(id));
  } catch {
    // Already gone.
  }
}
