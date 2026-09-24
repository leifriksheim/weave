/**
 * @module account-store
 * The accounts that live somewhere — in a folder, or in this browser.
 *
 * A folder is a disk, not a person. Several people can keep accounts in one, and
 * one person can keep several: work and personal, or a spare for testing. So the
 * folder holds a list of who has an account in it, and a subtree per account.
 *
 * ```
 * <folder>/
 *   accounts.json                  name, DID and id of each account
 *   accounts/<id>/account.json     that account's keys, locked
 *   accounts/<id>/stores/...       that account's spaces
 * ```
 *
 * **The list is readable without unlocking anything**, which it has to be — you
 * cannot offer someone a choice of accounts without knowing their names. So
 * whoever holds the folder can see how many accounts are in it and what they
 * are called. What they cannot do is open one.
 *
 * A browser with no folder keeps the same shape in IndexedDB, so the app above
 * has one model rather than two.
 */

import type { DirectoryHandleLike } from '../storage/folder-adapter.js';
import { readFolderFile, writeFolderFile } from '../storage/folder-adapter.js';
import type { AccountVault } from './account-vault.js';
import { readFolderVault } from './folder-account.js';
import { base64UrlEncode, utf8Encode, utf8Decode } from '../utils/encoding.js';
import { protocolError } from '../utils/errors.js';

/** What can be known about an account without unlocking it */
export interface AccountSummary {
  /** Stable, random, and the name of this account's subtree */
  readonly id: string;
  /** What the person called it. A label — never part of any key. */
  readonly name: string;
  readonly did: string;
  readonly createdAt: string;
  /**
   * Where this account's spaces live, relative to the store root.
   *
   * Carried rather than computed so that an account written before folders
   * held more than one keeps its data exactly where it already is, instead of
   * needing every file moved.
   */
  readonly dataPath: string;
  readonly lastUsedAt?: string;
}

export interface AccountStore {
  readonly kind: 'folder' | 'browser';
  /**
   * Every account here, most recently used first.
   *
   * At most one entry per identity. Two rows for one DID is always a mistake —
   * they would appear as separate accounts in a picker while being the same
   * person — so a duplicate is collapsed onto the most recently used.
   */
  list(): Promise<ReadonlyArray<AccountSummary>>;
  /** One account's locked keys */
  read(id: string): Promise<AccountVault | null>;
  /** Adds or replaces an account */
  write(summary: AccountSummary, vault: AccountVault): Promise<void>;
  /** Forgets an account, and everything it owns */
  remove(id: string): Promise<void>;
}

const LIST_FILE = 'accounts.json';
const ACCOUNTS_DIR = 'accounts';
const VAULT_FILE = 'account.json';
/** Where a single-account folder kept its spaces, before there was a list. */
const LEGACY_DATA_PATH = 'stores';

/** Where a brand new account keeps its spaces. */
export function accountDataPath(id: string): string {
  return `${ACCOUNTS_DIR}/${id}/stores`;
}

/** A short, stable, filename-safe id for a new account. */
export function newAccountId(): string {
  return base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(8)))
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 12);
}

/**
 * Whether an id has the shape {@link newAccountId} gives one.
 *
 * An id names a directory, and `remove` deletes that directory with everything
 * in it. The list it comes from is a plain file in a folder that may be synced
 * or shared, so an id is checked before it is trusted with a path.
 */
export function isAccountId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9]{1,12}$/.test(id);
}

/**
 * Whether a row points somewhere this store could have put it.
 *
 * `dataPath` is carried, not computed, but there are only two shapes it can
 * honestly have: an account subtree, or the folder's root store from before
 * there was a list. Usually the subtree is the row's own — though a row filed
 * again under a fresh id keeps the one its data already lives in. Anything
 * else, `../../elsewhere` above all, is someone editing the list to aim an
 * account at files outside the folder.
 */
function isTrustworthy(account: AccountSummary): boolean {
  if (!isAccountId(account?.id) || typeof account.dataPath !== 'string') return false;
  if (account.dataPath === LEGACY_DATA_PATH) return true;
  const [accounts, id, stores, ...more] = account.dataPath.split('/');
  return accounts === ACCOUNTS_DIR && isAccountId(id) && stores === 'stores' && more.length === 0;
}

function checkId(id: string): void {
  if (!isAccountId(id)) throw new TypeError(`Not an account id: ${JSON.stringify(id)}`);
}

/** Most recently used first, so the picker opens on the likely one. */
function byRecency(a: AccountSummary, b: AccountSummary): number {
  return (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt);
}

/**
 * Most recently used first, one row per identity.
 *
 * A summary is a label on an identity, so two of them for one DID means the
 * same person listed twice — which is confusing at best and, once they point
 * at different data paths, a way to lose track of where anything is.
 *
 * @param accounts Whatever the store had
 * @returns The list to show
 */
function collapse(accounts: ReadonlyArray<AccountSummary>): AccountSummary[] {
  const seen = new Set<string>();
  return [...accounts].sort(byRecency).filter((account) => {
    if (seen.has(account.did)) return false;
    seen.add(account.did);
    return true;
  });
}

function parseList(bytes: Uint8Array | null): AccountSummary[] {
  if (!bytes) return [];
  try {
    const parsed = JSON.parse(utf8Decode(bytes)) as { accounts?: AccountSummary[] };
    // A row that fails the check is skipped, not repaired: it was not written
    // by this store, so there is no telling what it was meant to be.
    return Array.isArray(parsed?.accounts) ? parsed.accounts.filter(isTrustworthy) : [];
  } catch {
    throw protocolError(
      'FOLDER_ACCOUNT_UNREADABLE',
      `${LIST_FILE} in that folder is not valid JSON.`,
      'Move it aside and sign in with your code to write a fresh one — no account ' +
        'data is lost, only the list of which accounts exist.',
    );
  }
}

/**
 * Opens the accounts kept in a folder.
 *
 * @param dir The data folder
 * @returns A store over it
 */
export function createFolderAccountStore(dir: DirectoryHandleLike): AccountStore {
  async function readList(): Promise<AccountSummary[]> {
    return parseList(await readFolderFile(dir, LIST_FILE));
  }

  async function writeList(accounts: ReadonlyArray<AccountSummary>): Promise<void> {
    await writeFolderFile(
      dir,
      LIST_FILE,
      utf8Encode(`${JSON.stringify({ version: 1, accounts }, null, 2)}\n`),
    );
  }

  /** The directory holding one account's keys. */
  async function accountDir(id: string, create: boolean): Promise<DirectoryHandleLike | null> {
    try {
      const accounts = await dir.getDirectoryHandle(ACCOUNTS_DIR, { create });
      return await accounts.getDirectoryHandle(id, { create });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') return null;
      throw error;
    }
  }

  return Object.freeze({
    kind: 'folder' as const,

    async list(): Promise<ReadonlyArray<AccountSummary>> {
      return collapse(await readList());
    },

    async read(id: string): Promise<AccountVault | null> {
      if (!isAccountId(id)) return null;
      const home = await accountDir(id, false);
      if (!home) return null;

      const bytes = await readFolderFile(home, VAULT_FILE);
      if (!bytes) return null;

      try {
        return JSON.parse(utf8Decode(bytes)) as AccountVault;
      } catch {
        throw protocolError(
          'FOLDER_ACCOUNT_UNREADABLE',
          `The keys for that account could not be read.`,
          'The file may have been edited by hand. Sign in with your code to write a new one.',
        );
      }
    },

    async write(summary: AccountSummary, vault: AccountVault): Promise<void> {
      if (!isTrustworthy(summary)) {
        throw new TypeError(`Account ${JSON.stringify(summary.id)} does not have a valid id and data path`);
      }
      const home = await accountDir(summary.id, true);
      if (!home) throw new Error(`Could not open a home for account ${summary.id}`);

      await writeFolderFile(home, VAULT_FILE, utf8Encode(`${JSON.stringify(vault, null, 2)}\n`));

      // Drops any row for the same identity as well as the same id: the caller
      // has just said which account this is.
      const accounts = (await readList()).filter(
        (account) => account.id !== summary.id && account.did !== summary.did,
      );
      await writeList([...accounts, summary]);
    },

    async remove(id: string): Promise<void> {
      checkId(id);
      await writeList((await readList()).filter((account) => account.id !== id));

      try {
        const accounts = await dir.getDirectoryHandle(ACCOUNTS_DIR);
        await accounts.removeEntry(id, { recursive: true });
      } catch (error) {
        // Already gone, or the browser will not recurse. The list no longer
        // mentions it either way.
        if (!(error instanceof Error) || error.name !== 'NotFoundError') throw error;
      }
    },
  });
}

// ─── Accounts kept in this browser ─────────────────────────────────────

const DB_NAME = 'weave-accounts';
const STORE = 'accounts';
const LIST_KEY = '__list';

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

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    request.onsuccess = () => resolve((request.result as T) ?? null);
    request.onerror = () => reject(request.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Opens the accounts kept in this browser, for when there is no folder.
 *
 * Same shape as a folder store, so nothing above has to know which it got —
 * the difference is only that no other origin can read this one.
 *
 * @param dbName Overridable for tests
 * @returns A store over this origin's database
 */
export async function createBrowserAccountStore(dbName: string = DB_NAME): Promise<AccountStore> {
  const db = await openDb(dbName);

  return Object.freeze({
    kind: 'browser' as const,

    async list(): Promise<ReadonlyArray<AccountSummary>> {
      return collapse((await idbGet<AccountSummary[]>(db, LIST_KEY)) ?? []);
    },

    async read(id: string): Promise<AccountVault | null> {
      return idbGet<AccountVault>(db, id);
    },

    async write(summary: AccountSummary, vault: AccountVault): Promise<void> {
      await idbPut(db, summary.id, vault);
      const accounts = ((await idbGet<AccountSummary[]>(db, LIST_KEY)) ?? []).filter(
        (account) => account.id !== summary.id && account.did !== summary.did,
      );
      await idbPut(db, LIST_KEY, [...accounts, summary]);
    },

    async remove(id: string): Promise<void> {
      await idbDelete(db, id);
      const accounts = ((await idbGet<AccountSummary[]>(db, LIST_KEY)) ?? []).filter(
        (account) => account.id !== id,
      );
      await idbPut(db, LIST_KEY, accounts);
    },
  });
}

// ─── Folders written before they could hold more than one account ──────

/**
 * Finds the account in a folder that predates the list, so it can join it.
 *
 * Its data stays exactly where it is. Moving it would mean copying every file
 * by hand — the File System Access API cannot rename across directories — for
 * no benefit, so the summary records where the spaces already live instead.
 *
 * @param dir The data folder
 * @param existing Accounts already listed, so one is not adopted twice
 * @returns What to write into the list, or null when there is nothing to adopt
 */
export async function adoptLegacyFolderAccount(
  dir: DirectoryHandleLike,
  existing: ReadonlyArray<AccountSummary>,
): Promise<{ summary: AccountSummary; vault: AccountVault } | null> {
  const legacy = await readFolderVault(dir);

  // Nothing there, or a folder from before locking existed — that one cannot
  // be adopted silently, because it has no keys to copy. The app asks the user
  // to put a password on it instead.
  if (!legacy.vault) return null;

  if (existing.some((account) => account.did === legacy.vault!.did)) return null;

  return {
    summary: {
      id: newAccountId(),
      name: legacy.label,
      did: legacy.vault.did,
      createdAt: legacy.vault.createdAt,
      dataPath: LEGACY_DATA_PATH,
    },
    vault: legacy.vault,
  };
}

/**
 * Lists a folder's accounts, adopting a pre-list one if it finds it.
 *
 * @param dir The data folder
 * @param store The store over it
 * @returns Every account, including one just adopted
 */
export async function listFolderAccounts(
  dir: DirectoryHandleLike,
  store: AccountStore,
): Promise<ReadonlyArray<AccountSummary>> {
  const listed = await store.list();
  const adopted = await adoptLegacyFolderAccount(dir, listed);
  if (!adopted) return listed;

  await store.write(adopted.summary, adopted.vault);
  return store.list();
}
