/** Vault helpers only tests need: writing the single-account file layout, and inspecting wraps */
import type { DirectoryHandleLike } from '../../src/storage/folder-adapter.js';
import { writeFolderFile } from '../../src/storage/folder-adapter.js';
import type { AccountVault } from '../../src/identity/account-vault.js';
import { ACCOUNT_FILE } from '../../src/identity/folder-account.js';
import { utf8Encode } from '../../src/utils/encoding.js';

/** Writes the account file the way older folders kept it, at the folder's root */
export async function writeFolderVault(dir: DirectoryHandleLike, vault: AccountVault): Promise<void> {
  await writeFolderFile(dir, ACCOUNT_FILE, utf8Encode(`${JSON.stringify(vault, null, 2)}\n`));
}

export function hasPassphraseWrap(vault: AccountVault): boolean {
  return vault.wraps.some((wrap) => wrap.kind === 'passphrase');
}

export function withoutWrap(vault: AccountVault, id: string): AccountVault {
  return { ...vault, wraps: vault.wraps.filter((wrap) => wrap.id !== id) };
}
