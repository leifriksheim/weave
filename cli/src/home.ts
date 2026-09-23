/**
 * Where the CLI keeps accounts: a data folder, in exactly the layout a browser
 * uses. Point the CLI at the folder you picked in Chrome and both see the same
 * account and the same spaces.
 *
 * Nothing here ever writes the seed in the clear. An account is unlocked with
 * its recovery code or with a passphrase wrap — from a flag, an environment
 * variable, or a prompt — every time a process starts.
 */
import os from 'node:os';
import path from 'node:path';
import {
  accountDataPath,
  createFolderAccountStore,
  createIdentityManager,
  createLocalRootSigner,
  createVault,
  deriveVaultKey,
  deriveVaultKeyBytes,
  folderStores,
  generateSeed,
  newAccountId,
  recoveryCodeToSeed,
  seedToRecoveryCode,
  unwrapSeedWithPassphrase,
  withWrap,
  wrapSeedWithPassphrase,
  type AccountStore,
  type AccountSummary,
  type DirectoryHandleLike,
  type PassphraseWrap,
  type RootSigner,
  type StoreFactory,
} from '../../src/index.js';
import { openFsDirectory } from './fs-directory.js';

export interface Home {
  readonly path: string;
  readonly directory: DirectoryHandleLike;
  readonly accounts: AccountStore;
}

/** `--home`, then `$P2P_HOME`, then `~/.p2p`. */
export function homePath(flag?: string): string {
  return path.resolve(flag ?? process.env.P2P_HOME ?? path.join(os.homedir(), '.p2p'));
}

export async function openHome(flag?: string): Promise<Home> {
  const where = homePath(flag);
  const directory = await openFsDirectory(where);
  return { path: where, directory, accounts: createFolderAccountStore(directory) };
}

export interface Created {
  readonly account: AccountSummary;
  /** Present when the seed was generated here — shown once, stored nowhere */
  readonly code: string | null;
}

/**
 * Creates an account in the home, or adds an existing one from its code.
 * @param options.passphrase Also lock it with a passphrase, for unattended unlocking
 */
export async function createAccount(
  home: Home,
  options: { readonly name: string; readonly code?: string; readonly passphrase?: string },
): Promise<Created> {
  const seed = options.code ? recoveryCodeToSeed(options.code) : generateSeed();
  const { did } = await createIdentityManager().fromSeed(seed);

  if ((await home.accounts.list()).some((account) => account.did === did)) {
    throw new Error(`This home already has an account for ${did}`);
  }

  let vault = createVault({ did, label: options.name, wraps: [] });
  if (options.passphrase) vault = withWrap(vault, await wrapSeedWithPassphrase(seed, options.passphrase, 'CLI passphrase'));

  const id = newAccountId();
  const account: AccountSummary = {
    id,
    name: options.name,
    did,
    createdAt: new Date().toISOString(),
    dataPath: accountDataPath(id),
  };
  await home.accounts.write(account, vault);
  return { account, code: options.code ? null : seedToRecoveryCode(seed) };
}

/** Picks an account by id, name or DID (`--account`, then `$P2P_ACCOUNT`); the only one when there is exactly one. */
export async function chooseAccount(home: Home, flag?: string): Promise<AccountSummary> {
  const which = flag ?? process.env.P2P_ACCOUNT;
  const accounts = await home.accounts.list();
  if (accounts.length === 0) throw new Error(`No account in ${home.path}. Run "p2p init" first.`);
  if (which) {
    const found = accounts.find((account) => account.id === which || account.name === which || account.did === which);
    if (!found) throw new Error(`No account called "${which}" in ${home.path}`);
    return found;
  }
  if (accounts.length > 1) {
    throw new Error(`Several accounts in ${home.path}; pick one with --account (${accounts.map((a) => a.name).join(', ')})`);
  }
  return accounts[0]!;
}

export interface Unlocked {
  readonly account: AccountSummary;
  readonly signer: RootSigner;
  readonly stores: StoreFactory;
  /** Lets the node follow the account registry, so it joins every space the account does */
  readonly accountKey: Uint8Array;
}

/**
 * Opens an account with its code or passphrase.
 * @throws When neither is given, or neither opens it
 */
export async function unlock(
  home: Home,
  account: AccountSummary,
  secret: { readonly code?: string; readonly passphrase?: string },
): Promise<Unlocked> {
  let seed: Uint8Array | null = null;

  if (secret.code) {
    seed = recoveryCodeToSeed(secret.code);
  } else if (secret.passphrase) {
    const vault = await home.accounts.read(account.id);
    const wraps = (vault?.wraps ?? []).filter((wrap): wrap is PassphraseWrap => wrap.kind === 'passphrase');
    if (wraps.length === 0) throw new Error(`"${account.name}" has no passphrase; unlock it with its recovery code`);
    for (const wrap of wraps) {
      try {
        seed = await unwrapSeedWithPassphrase(wrap, secret.passphrase);
        break;
      } catch {
        // Not this one.
      }
    }
    if (!seed) throw new Error('That passphrase does not open this account');
  } else {
    throw new Error('Unlocking needs the recovery code (P2P_RECOVERY_CODE) or a passphrase (P2P_PASSPHRASE)');
  }

  const manager = createIdentityManager();
  const identity = await manager.fromSeed(seed);
  if (identity.did !== account.did) throw new Error(`That code belongs to a different account than "${account.name}"`);

  return {
    account,
    signer: createLocalRootSigner(identity, manager.getProvider()),
    stores: folderStores(home.directory, { basePath: account.dataPath, vaultKey: await deriveVaultKey(seed) }),
    accountKey: await deriveVaultKeyBytes(seed),
  };
}
