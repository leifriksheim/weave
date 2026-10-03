/**
 * @module device-key
 * The key that unlocks an account on one device: random, non-extractable, in
 * this origin's storage, with a passkey as the gate in front of it (many
 * passkey providers lack PRF, so the passkey is not the source of the secret).
 * The gate is this code, not cryptography; what it protects against is
 * someone holding a copy of the folder without this storage.
 */

import { base64UrlEncode } from '../utils/encoding.js';
import { idbOnce } from './idb.js';

const DB_NAME = 'weave-device-keys';
const STORE = 'keys';

/** A local key, and the id a wrap records to find it again. */
export interface DeviceKey {
  readonly id: string;
  readonly key: CryptoKey;
}

/**
 * Makes a key for this device and remembers it. Non-extractable on purpose:
 * a CryptoKey survives IndexedDB, and no code path can turn it back into bytes.
 */
export async function createDeviceKey(dbName = DB_NAME): Promise<DeviceKey> {
  const key = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const id = base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(12)));
  await idbOnce(dbName, STORE, 'readwrite', (store) => store.put(key, id));
  return { id, key };
}

/**
 * Finds a device key by id. Absent is a normal answer: the wrap was made in
 * another browser, or storage has been cleared since.
 */
export async function getDeviceKey(id: string, dbName = DB_NAME): Promise<CryptoKey | null> {
  try {
    const key = await idbOnce(dbName, STORE, 'readonly', (store) => store.get(id));
    return key instanceof CryptoKey ? key : null;
  } catch {
    return null;
  }
}

/** Forgets a device key, which makes its wrap permanently unopenable */
export async function deleteDeviceKey(id: string, dbName = DB_NAME): Promise<void> {
  try {
    await idbOnce(dbName, STORE, 'readwrite', (store) => store.delete(id));
  } catch {
    // Already gone.
  }
}
