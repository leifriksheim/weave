/**
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
import { isObject } from '../utils/guards.js';
import { idbOnce } from '../identity/idb.js';

/** Read or read-write, in the browser's vocabulary */
export type FolderAccessMode = 'read' | 'readwrite';

/** The permission methods the spec puts on a handle but `lib.dom` does not */
interface PermissionAwareHandle {
  queryPermission(descriptor: { mode: FolderAccessMode }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: FolderAccessMode }): Promise<PermissionState>;
}

/** The picker the spec puts on the window but `lib.dom` does not */
interface DirectoryPicker {
  showDirectoryPicker(options?: DirectoryPickerOptions): Promise<DirectoryHandleLike>;
}

interface DirectoryPickerOptions {
  readonly id?: string;
  readonly mode?: FolderAccessMode;
  readonly startIn?: string;
}

const HANDLE_DB = 'weave-folder';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'data-folder';

function hasPicker(scope: object): scope is DirectoryPicker {
  return 'showDirectoryPicker' in scope && typeof scope.showDirectoryPicker === 'function';
}

function canQuery(handle: object): handle is Pick<PermissionAwareHandle, 'queryPermission'> {
  return 'queryPermission' in handle && typeof handle.queryPermission === 'function';
}

function canRequest(handle: object): handle is Pick<PermissionAwareHandle, 'requestPermission'> {
  return 'requestPermission' in handle && typeof handle.requestPermission === 'function';
}

function isDirectoryHandle(value: unknown): value is DirectoryHandleLike {
  return isObject(value) && typeof value.getDirectoryHandle === 'function';
}

/**
 * Whether this browser can hand out a directory at all.
 *
 * Chrome, Edge and Opera on the desktop can. Firefox and Safari cannot, and
 * neither can any mobile browser, so a caller has to have something else to
 * offer — this returning false is a normal state, not a broken one.
 */
export function isFolderStorageAvailable(): boolean {
  return hasPicker(globalThis);
}

/**
 * Asks the user to choose their data folder. Must be called from a click.
 *
 * @param options.id Groups the picker's memory of where it last opened. Keeping
 *   this stable across apps means the second view of the same data opens the
 *   picker already pointing at the right folder.
 */
export async function pickDataFolder(options?: { id?: string }): Promise<DirectoryHandleLike> {
  const scope: object = globalThis;
  if (!hasPicker(scope)) {
    throw protocolError(
      'FOLDER_UNAVAILABLE',
      'This browser cannot open a data folder.',
      'The File System Access API is available in Chrome, Edge and Opera on the ' +
        'desktop. Elsewhere, sign in with a recovery code and this device will ' +
        'keep its own copy that syncs with your peers.',
    );
  }

  return scope.showDirectoryPicker({
    id: options?.id ?? 'weave-pod',
    mode: 'readwrite',
    startIn: 'documents',
  });
}

/** Asks what this origin is currently allowed to do with a folder. */
export async function queryFolderPermission(
  handle: DirectoryHandleLike,
  mode: FolderAccessMode = 'readwrite',
): Promise<PermissionState> {
  if (!canQuery(handle)) return 'granted'; // a handle from a runtime without the extension
  return handle.queryPermission({ mode });
}

/**
 * Makes sure this origin may use a folder, prompting if it has to.
 *
 * The prompt needs a user gesture, so `request` should only be true on a path
 * that began with a click — call it with `false` on page load to find out
 * whether a button needs showing at all.
 */
export async function ensureFolderPermission(
  handle: DirectoryHandleLike,
  options?: { request?: boolean; mode?: FolderAccessMode },
): Promise<boolean> {
  const mode = options?.mode ?? 'readwrite';
  if ((await queryFolderPermission(handle, mode)) === 'granted') return true;
  if (!options?.request) return false;

  if (!canRequest(handle)) return false;
  return (await handle.requestPermission({ mode })) === 'granted';
}

/**
 * Remembers a folder so the next visit can skip the picker.
 *
 * Only the handle is stored, never the contents — this origin keeps a pointer,
 * and the data stays where the user put it.
 */
export async function rememberDataFolder(handle: DirectoryHandleLike): Promise<void> {
  await idbOnce(HANDLE_DB, HANDLE_STORE, 'readwrite', (store) => store.put(handle, HANDLE_KEY));
}

/**
 * The folder this origin used last, if the browser still has it.
 *
 * Says nothing about permission — a recalled handle usually needs
 * {@link ensureFolderPermission} with a gesture before it can be read.
 */
export async function recallDataFolder(): Promise<DirectoryHandleLike | null> {
  try {
    const value = await idbOnce(HANDLE_DB, HANDLE_STORE, 'readonly', (store) => store.get(HANDLE_KEY));
    return isDirectoryHandle(value) ? value : null;
  } catch {
    return null;
  }
}

/** Forgets the remembered folder. The folder and everything in it stay put. */
export async function forgetDataFolder(): Promise<void> {
  try {
    await idbOnce(HANDLE_DB, HANDLE_STORE, 'readwrite', (store) => store.delete(HANDLE_KEY));
  } catch {
    // Nothing to forget.
  }
}
