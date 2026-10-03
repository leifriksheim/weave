/**
 * @module folder-account
 * The account file at the root of a folder written before it held more than
 * one account: read only, including the older format that kept the seed in
 * the clear (spec 05 §14.1).
 */

import type { DirectoryHandleLike } from '../storage/folder-adapter.js';
import { readFolderFile } from '../storage/folder-adapter.js';
import { isAccountVault, type AccountVault, type SeedWrap } from './account-vault.js';
import { isValidRecoveryCode, recoveryCodeToSeed } from './recovery-code.js';
import { utf8Decode } from '../utils/encoding.js';
import { protocolError } from '../utils/errors.js';
import { isRecord } from '../utils/guards.js';

export const ACCOUNT_FILE = 'weave-account.json';

/** What a folder turned out to hold */
export interface FolderState {
  /** The locked account, or null when the folder has no account yet */
  readonly vault: AccountVault | null;
  /**
   * The seed, when the folder still uses the format that stored it in the clear.
   *
   * Present means the folder opens without asking for anything, which is the
   * situation the vault exists to end: a caller that finds this should get the
   * user to put a lock on it rather than carrying on quietly.
   */
  readonly unlockedSeed: Uint8Array | null;
  readonly label: string;
  readonly did: string | null;
}

/** An empty folder, ready to have an account started in it. */
const EMPTY: FolderState = { vault: null, unlockedSeed: null, label: 'My data', did: null };

/** Reads whatever account a folder holds. */
export async function readFolderVault(dir: DirectoryHandleLike): Promise<FolderState> {
  const bytes = await readFolderFile(dir, ACCOUNT_FILE);
  if (!bytes) return EMPTY;

  // Deliberately loose: version 1 and version 2 are different shapes, and an
  // intersection of the two is uninhabited. Narrowing happens below.
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(bytes));
  } catch {
    throw protocolError(
      'FOLDER_ACCOUNT_UNREADABLE',
      `${ACCOUNT_FILE} in that folder is not valid JSON.`,
      'Either the file was edited by hand, or this is not a data folder. Choose a ' +
        'different folder, or move the broken file aside to start fresh.',
    );
  }

  const fields = isRecord(parsed) ? parsed : {};
  const label = typeof fields.label === 'string' ? fields.label : 'My data';
  const did = typeof fields.did === 'string' ? fields.did : null;

  if (isAccountVault(parsed)) {
    return { vault: parsed, unlockedSeed: null, label, did };
  }

  // The first format kept the seed as a recovery code, in the clear.
  if (typeof fields.recoveryCode === 'string' && isValidRecoveryCode(fields.recoveryCode)) {
    return { vault: null, unlockedSeed: recoveryCodeToSeed(fields.recoveryCode), label, did };
  }

  throw protocolError(
    'FOLDER_ACCOUNT_UNREADABLE',
    `${ACCOUNT_FILE} in that folder is not an account this version understands.`,
    'It may have been written by a newer build. Update the app, or move the file ' +
      'aside and sign in with your recovery code to write a new one.',
  );
}

/**
 * Assembles a fresh locked account.
 *
 * Pure — it neither generates the seed nor touches the disk, so a caller stays
 * in charge of both the entropy and when it lands.
 *
 * @param params.wraps Shortcuts for getting in. May be empty: the account code
 *   is the seed written out, so it opens the account with nothing stored —
 *   which is exactly what a brand new account has.
 */
export function createVault(params: {
  did: string;
  wraps: ReadonlyArray<SeedWrap>;
  label?: string;
}): AccountVault {
  return {
    version: 2,
    label: params.label ?? 'My data',
    did: params.did,
    createdAt: new Date().toISOString(),
    wraps: params.wraps,
  };
}
