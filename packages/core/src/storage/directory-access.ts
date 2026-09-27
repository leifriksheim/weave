/**
 * @module directory-access
 * Getting hold of the user's data folder, and getting it back on the next visit.
 *
 * A directory handle is the one capability a web page can hold that outlives the
 * origin sandbox, so the browser guards it carefully: it can only be obtained
 * from a user gesture, and permission has to be re-confirmed when a new session
 * starts. The handle itself is structured-cloneable, which means it can be kept
 * in IndexedDB — origin-local storage of a *pointer* to origin-independent data.
 */

import type { DirectoryHandleLike } from './folder-adapter.js';
import { protocolError } from '../utils/errors.js';

/** Read or read-write, in the browser's vocabulary */
export type FolderAccessMode = 'read' | 'readwrite';

/** The permission methods the spec puts on a handle but `lib.dom` does not */
interface PermissionAwareHandle {
  queryPermission?(descriptor: { mode: FolderAccessMode }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: FolderAccessMode }): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  readonly id?: string;
  readonly mode?: FolderAccessMode;
  readonly startIn?: string;
}

const HANDLE_DB = 'weave-folder';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'data-folder';

/**
 * Whether this browser can hand out a directory at all.
 *
 * Chrome, Edge and Opera on the desktop can. Firefox and Safari cannot, and
 * neither can any mobile browser, so a caller has to have something else to
 * offer — this returning false is a normal state, not a broken one.
 *
 * @returns Whether {@link pickDataFolder} will work here
 */
export function isFolderStorageAvailable(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/**
 * Asks the user to choose their data folder. Must be called from a click.
 *
 * @param options.id Groups the picker's memory of where it last opened. Keeping
 *   this stable across apps means the second view of the same data opens the
 *   picker already pointing at the right folder.
 * @returns The chosen directory
 */
export async function pickDataFolder(options?: { id?: string }): Promise<DirectoryHandleLike> {
  const picker = (globalThis as {
    showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<DirectoryHandleLike>;
  }).showDirectoryPicker;

  if (!picker) {
    throw protocolError(
      'FOLDER_UNAVAILABLE',
      'This browser cannot open a data folder.',
      'The File System Access API is available in Chrome, Edge and Opera on the ' +
        'desktop. Elsewhere, sign in with a recovery code and this device will ' +
        'keep its own copy that syncs with your peers.',
    );
  }

  return picker({ id: options?.id ?? 'weave-pod', mode: 'readwrite', startIn: 'documents' });
}

/**
 * Asks what this origin is currently allowed to do with a folder.
 * @param handle The directory in question
 * @param mode The access being asked about
 * @returns `granted`, `denied`, or `prompt` when the user has yet to be asked
 */
export async function queryFolderPermission(
  handle: DirectoryHandleLike,
  mode: FolderAccessMode = 'readwrite',
): Promise<PermissionState> {
  const query = (handle as PermissionAwareHandle).queryPermission;
  if (!query) return 'granted'; // a handle from a runtime without the extension
  return query.call(handle, { mode });
}

/**
 * Makes sure this origin may use a folder, prompting if it has to.
 *
 * The prompt needs a user gesture, so `request` should only be true on a path
 * that began with a click — call it with `false` on page load to find out
 * whether a button needs showing at all.
 *
 * @param handle The directory to check
 * @param options.request Whether to prompt when permission is not already given
 * @param options.mode The access needed
 * @returns Whether the folder is usable
 */
export async function ensureFolderPermission(
  handle: DirectoryHandleLike,
  options?: { request?: boolean; mode?: FolderAccessMode },
): Promise<boolean> {
  const mode = options?.mode ?? 'readwrite';
  if ((await queryFolderPermission(handle, mode)) === 'granted') return true;
  if (!options?.request) return false;

  const request = (handle as PermissionAwareHandle).requestPermission;
  if (!request) return false;
  return (await request.call(handle, { mode })) === 'granted';
}

/**
 * Opens the tiny database that remembers which folder this origin was pointed at.
 * @returns The database
 */
function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(HANDLE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(HANDLE_STORE)) {
        request.result.createObjectStore(HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Remembers a folder so the next visit can skip the picker.
 *
 * Only the handle is stored, never the contents — this origin keeps a pointer,
 * and the data stays where the user put it.
 *
 * @param handle The directory to remember
 */
export async function rememberDataFolder(handle: DirectoryHandleLike): Promise<void> {
  const db = await openHandleDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * The folder this origin used last, if the browser still has it.
 *
 * Says nothing about permission — a recalled handle usually needs
 * {@link ensureFolderPermission} with a gesture before it can be read.
 *
 * @returns The remembered directory, or null
 */
export async function recallDataFolder(): Promise<DirectoryHandleLike | null> {
  try {
    const db = await openHandleDb();
    try {
      return await new Promise<DirectoryHandleLike | null>((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, 'readonly');
        const request = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
        request.onsuccess = () => resolve((request.result as DirectoryHandleLike) ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Forgets the remembered folder. The folder and everything in it stay put. */
export async function forgetDataFolder(): Promise<void> {
  try {
    const db = await openHandleDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // Nothing to forget.
  }
}
