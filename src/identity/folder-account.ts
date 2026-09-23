/**
 * @module folder-account
 * The account file at the root of a data folder.
 *
 * Once the folder is the store, the account belongs in it too — otherwise you
 * have data that travels between origins and a key that does not, which is the
 * problem the folder was meant to solve. Choosing the folder becomes most of
 * signing in; unlocking it is the rest.
 *
 * The seed is never written in the clear. What the file holds is a set of
 * wrapped copies of it, one per way of unlocking — see {@link module:account-vault},
 * which owns the cryptography. This module owns the file: reading it, writing
 * it, and recognising the older format that kept the seed in plain sight.
 */

import type { DirectoryHandleLike } from '../storage/folder-adapter.js';
import { readFolderFile, writeFolderFile } from '../storage/folder-adapter.js';
import type { AccountVault, SeedWrap } from './account-vault.js';
import { isValidRecoveryCode, recoveryCodeToSeed } from './recovery-code.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';
import { protocolError } from '../utils/errors.js';

export const ACCOUNT_FILE = 'weave-account.json';
const README_FILE = 'README.txt';

const README = `This folder is your data.

  weave-account.json    your identity, locked
  stores/             your spaces, their contents, and the index over them

Any app that can open this folder — and unlock it — is a view on what is in it.
Point a second app at this same folder and it sees the same lists, signed by the
same key, with no account to create.

The account file does not contain your seed. It contains that seed encrypted,
once per way of unlocking it: under each app's passkey, and under your
passphrase if you set one. Adding an app adds an entry. Copying this folder
somewhere is not enough to read it; you need one of those too.

Your recovery code is the exception, and it is deliberately not in here. It is
the seed itself, written out, and it opens this folder anywhere — including on a
phone, or in Safari or Firefox, which cannot open folders at all. Keep it
somewhere you would keep a spare key.

Nothing here is a database. Every file under stores/*/expressions is one signed
record named after its own hash, so two copies of this folder merge by keeping
the union of their files.

What is not encrypted, so you know: the author, timestamp and collection of
every record, and the contents of any space you made public. Locking those too
would mean you could no longer open this folder and see what is in it.
`;

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

/**
 * Reads whatever account a folder holds.
 *
 * @param dir The data folder
 * @returns Its account, the legacy seed if it predates locking, or an empty state
 */
export async function readFolderVault(dir: DirectoryHandleLike): Promise<FolderState> {
  const bytes = await readFolderFile(dir, ACCOUNT_FILE);
  if (!bytes) return EMPTY;

  // Deliberately loose: version 1 and version 2 are different shapes, and an
  // intersection of the two is uninhabited. Narrowing happens below.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(utf8Decode(bytes)) as Record<string, unknown>;
  } catch {
    throw protocolError(
      'FOLDER_ACCOUNT_UNREADABLE',
      `${ACCOUNT_FILE} in that folder is not valid JSON.`,
      'Either the file was edited by hand, or this is not a data folder. Choose a ' +
        'different folder, or move the broken file aside to start fresh.',
    );
  }

  const label = typeof parsed.label === 'string' ? parsed.label : 'My data';
  const did = typeof parsed.did === 'string' ? parsed.did : null;

  if (parsed.version === 2 && Array.isArray(parsed.wraps)) {
    return { vault: parsed as unknown as AccountVault, unlockedSeed: null, label, did };
  }

  // The first format kept the seed as a recovery code, in the clear.
  if (typeof parsed.recoveryCode === 'string' && isValidRecoveryCode(parsed.recoveryCode)) {
    return { vault: null, unlockedSeed: recoveryCodeToSeed(parsed.recoveryCode), label, did };
  }

  throw protocolError(
    'FOLDER_ACCOUNT_UNREADABLE',
    `${ACCOUNT_FILE} in that folder is not an account this version understands.`,
    'It may have been written by a newer build. Update the app, or move the file ' +
      'aside and sign in with your recovery code to write a new one.',
  );
}

/**
 * Writes the account file, replacing whatever was there.
 *
 * @param dir The data folder
 * @param vault The locked account to record
 */
export async function writeFolderVault(dir: DirectoryHandleLike, vault: AccountVault): Promise<void> {
  await writeFolderFile(dir, ACCOUNT_FILE, utf8Encode(`${JSON.stringify(vault, null, 2)}\n`));
  // Rewritten each time, so a folder that predates it picks it up on first save.
  await writeFolderFile(dir, README_FILE, utf8Encode(README));
}

/**
 * Assembles a fresh locked account.
 *
 * Pure — it neither generates the seed nor touches the disk, so a caller stays
 * in charge of both the entropy and when it lands.
 *
 * @param params.did The DID the seed derives
 * @param params.wraps Shortcuts for getting in. May be empty: the account code
 *   is the seed written out, so it opens the account with nothing stored —
 *   which is exactly what a brand new account has.
 * @param params.label What to call this account
 * @returns The account, ready for {@link writeFolderVault}
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
