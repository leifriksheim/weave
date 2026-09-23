/**
 * Accounts, and the ways into them.
 *
 * Two questions that the old flow ran together, now kept apart:
 *
 * - **Where does my data live?** A folder you picked, or this browser. Called a
 *   *home* here, because "storage" invites confusion with the account itself.
 * - **Who am I?** An account in that home. A home can hold several.
 *
 * The credential is a generated 26-character code. It is the seed, written out,
 * which is what makes it work on a domain that has never heard of you — there is
 * nothing stored for it to unlock. That is the whole reason it is the primary
 * way in rather than a backup: a password that *unlocks* something needs that
 * something to be present, and on a new origin it is not.
 *
 * A password manager holds it exactly as it holds any generated password. The
 * short password and the passkey below are conveniences layered on top, local to
 * one origin, so that the code only has to be fetched once per app.
 */
import {
  createFolderAccountStore,
  createBrowserAccountStore,
  listFolderAccounts,
  accountDataPath,
  newAccountId,
  createVault,
  withWrap,
  wrapSeedWithDeviceKey,
  unwrapSeedWithDeviceKey,
  wrapSeedWithPassphrase,
  unwrapSeedWithPassphrase,
  deviceWrapsFor,
  createDeviceKey,
  getDeviceKey,
  deleteDeviceKey,
  createIdentityManager,
  generateSeed,
  seedToRecoveryCode,
  recoveryCodeToSeed,
  isValidRecoveryCode,
  registerPasskey,
  authenticatePasskey,
  hasPlatformAuthenticator,
  pickDataFolder,
  recallDataFolder,
  rememberDataFolder,
  forgetDataFolder,
  ensureFolderPermission,
  isFolderStorageAvailable,
  protocolError,
  type AccountStore,
  type AccountSummary,
  type AccountVault,
  type DirectoryHandleLike,
  type DeviceWrap,
} from '@p2p-web/protocol';
import {
  startSession,
  localSource,
  endSession,
  getSessionSeed,
  type Session,
  type SessionSource,
} from './protocol';
import {
  connectSnap,
  snapSource,
  importIntoSnap,
  listSnapAccounts,
  selectSnapAccount,
  walletPresent,
  type SnapAccount,
} from './snap';

/** Where accounts and their data are kept */
export interface Home {
  readonly kind: 'folder' | 'browser';
  readonly store: AccountStore;
  /** The folder, when there is one — for its name, and for opening stores */
  readonly directory: DirectoryHandleLike | null;
}

/** Whether this browser can open a data folder at all. */
export const folderStorageAvailable = isFolderStorageAvailable;

/**
 * The relying party a passkey here belongs to.
 *
 * PRF output is bound to one credential and a credential to one domain, which
 * is why a passkey can never be the portable way in — and why each app adds its
 * own rather than sharing.
 */
const rpId = globalThis.location.hostname;

const LAST_ACCOUNT_KEY = 'p2p-todo.last-account';

let _home: Home | null = null;

// ─── Homes ─────────────────────────────────────────────────────────────

/** Accounts kept in this browser. Always available; never shared with another app. */
export async function browserHome(): Promise<Home> {
  const store = await createBrowserAccountStore();
  _home = { kind: 'browser', store, directory: null };
  return _home;
}

/** Accounts kept in a folder, from the picker. Must be called from a click. */
export async function chooseFolderHome(): Promise<Home> {
  const directory = await pickDataFolder({ id: 'p2p-data' });
  await rememberDataFolder(directory);
  _home = { kind: 'folder', store: createFolderAccountStore(directory), directory };
  return _home;
}

/**
 * Re-opens the folder this origin used last.
 *
 * @param request Whether to prompt for permission. Needs a click when true; use
 *   false on page load to find out whether a button has to be shown.
 * @returns The folder home, or null when there is none or access was declined
 */
export async function recallFolderHome(request: boolean): Promise<Home | null> {
  const directory = await recallDataFolder();
  if (!directory) return null;
  if (!(await ensureFolderPermission(directory, { request }))) return null;

  _home = { kind: 'folder', store: createFolderAccountStore(directory), directory };
  return _home;
}

/** Stops using the folder. Nothing in it is touched. */
export async function forgetFolderHome(): Promise<Home> {
  await forgetDataFolder();
  return browserHome();
}

/** The home currently in use, or the browser if nothing has been chosen. */
export async function currentHome(): Promise<Home> {
  return _home ?? browserHome();
}

/** Every account in a home, most recently used first. */
export async function listAccounts(home: Home): Promise<ReadonlyArray<AccountSummary>> {
  return home.directory
    ? listFolderAccounts(home.directory, home.store)
    : home.store.list();
}

/** The account this browser signed into last, if it is still there. */
export function lastAccountId(): string | null {
  try {
    return globalThis.localStorage.getItem(LAST_ACCOUNT_KEY);
  } catch {
    return null;
  }
}

function rememberLastAccount(id: string): void {
  try {
    globalThis.localStorage.setItem(LAST_ACCOUNT_KEY, id);
  } catch {
    // Remembering is a convenience, never a requirement.
  }
}

// ─── Ways in ───────────────────────────────────────────────────────────

/** Which ways into an account exist on this origin */
export interface AccountEntry {
  readonly summary: AccountSummary;
  readonly vault: AccountVault;
  /**
   * Shortcuts this device can actually use.
   *
   * A wrap names a key in this origin's storage, so one made in another app —
   * or before storage was cleared — is listed by the vault but unopenable here.
   * Only the ones whose key is present count as a way in.
   */
  readonly shortcuts: ReadonlyArray<DeviceWrap>;
  /** Whether a short password was set here */
  readonly hasPassword: boolean;
}

/**
 * Looks at what an account offers before asking for anything.
 * @param home Where the account lives
 * @param id Which account
 * @returns Its ways in, or null when it is not there
 */
export async function openAccount(home: Home, id: string): Promise<AccountEntry | null> {
  const [summary, vault] = await Promise.all([
    listAccounts(home).then((accounts) => accounts.find((account) => account.id === id)),
    home.store.read(id),
  ]);
  if (!summary || !vault) return null;

  // A wrap whose key is missing from this browser cannot be offered, however
  // confidently the vault lists it.
  const candidates = deviceWrapsFor(vault, rpId);
  const usable = await Promise.all(
    candidates.map(async (wrap) => ((await getDeviceKey(wrap.deviceKeyId)) ? wrap : null)),
  );

  return {
    summary,
    vault,
    shortcuts: usable.filter((wrap): wrap is DeviceWrap => wrap !== null),
    hasPassword: vault.wraps.some((wrap) => wrap.kind === 'passphrase'),
  };
}

/**
 * Runs a passkey ceremony as a gate.
 *
 * Nothing is read out of it. The ceremony proves a person with the
 * authenticator is present, and the key that actually opens the account lives
 * in this origin's storage — which is why every passkey provider works here,
 * including the ones that store passkeys without the PRF extension.
 *
 * Steers to this device's own authenticator when it has one. A credential
 * manager usually registers itself as the default passkey provider and takes
 * the prompt first, which means being dismissed before Touch ID is offered —
 * and since the key this gates never leaves the browser, a passkey synced by a
 * manager gates nothing anywhere else. There is nothing to choose between,
 * so this decides rather than asking.
 *
 * On a machine with no built-in authenticator it asks for nothing in
 * particular, because `platform` is a filter rather than a preference and
 * requesting it there fails outright.
 *
 * @param mode Create a passkey, or assert an existing one
 * @returns The credential that answered
 */
async function passkeyGate(
  mode: 'create' | 'get',
  options: { credentialId?: string; label?: string } = {},
): Promise<string> {
  const preferPlatform = mode === 'create' ? await hasPlatformAuthenticator() : false;
  const steer = preferPlatform ? { hints: ['client-device'] as const } : {};

  if (mode === 'create') {
    const registration = await registerPasskey({
      rpId,
      rpName: 'P2P Todos',
      userName: options.label ?? 'P2P Todos',
      ...steer,
      ...(preferPlatform ? { attachment: 'platform' as const } : {}),
    });
    return registration.credentialId;
  }

  const auth = await authenticatePasskey(options.credentialId, { rpId, ...steer });
  return auth.credentialId;
}

/** Records that an account was just used, and starts its session. */
async function begin(home: Home, summary: AccountSummary, seed: Uint8Array): Promise<Session> {
  const used: AccountSummary = { ...summary, lastUsedAt: new Date().toISOString() };

  // Best effort: a read-only folder, or one whose keys have gone missing,
  // should still let someone sign in with their code.
  try {
    const vault = await home.store.read(summary.id);
    if (vault) await home.store.write(used, vault);
  } catch {
    // The order the picker opens in is not worth failing a sign-in over.
  }

  rememberLastAccount(summary.id);
  return startSession(used, await localSource(seed), home.directory ? { directory: home.directory } : undefined);
}

/**
 * Creates an account.
 *
 * The seed is random, and the code shown afterwards is that seed written out —
 * not a backup of it. There is nothing else to lose.
 *
 * @param home Where to keep it
 * @param name What to call it
 * @returns The session, and the code to show once
 */
export async function createAccount(
  home: Home,
  name: string,
): Promise<{ session: Session; code: string }> {
  const seed = generateSeed();
  const identity = await createIdentityManager().fromSeed(seed);
  const id = newAccountId();

  const summary: AccountSummary = {
    id,
    name,
    did: identity.did,
    createdAt: new Date().toISOString(),
    dataPath: accountDataPath(id),
  };

  // No wraps yet: the code is the way in, and it needs none. A password or a
  // passkey can be added afterwards, on whichever devices want the shortcut.
  const vault = createVault({ did: identity.did, label: name, wraps: [] });

  await home.store.write(summary, vault);
  return { session: await begin(home, summary, seed), code: seedToRecoveryCode(seed) };
}

/**
 * Signs in with the code — the way that works anywhere, including on a domain
 * that has never seen this account.
 *
 * @param home Where the account lives, for its data
 * @param code The code as the user pasted it
 * @param expected The account this is meant to be, when one was chosen
 */
export async function signInWithCode(
  home: Home,
  code: string,
  expected?: AccountSummary,
): Promise<Session> {
  if (!isValidRecoveryCode(code)) {
    throw protocolError(
      'VAULT_UNLOCK_FAILED',
      'That does not look like an account code.',
      'It is 26 letters and digits, usually shown in groups of four.',
    );
  }

  const seed = recoveryCodeToSeed(code);
  const identity = await createIdentityManager().fromSeed(seed);

  if (expected && identity.did !== expected.did) {
    throw protocolError(
      'VAULT_UNLOCK_FAILED',
      `That password opens a different account, not ${expected.name}.`,
      'With more than one account saved for this site, a password manager fills ' +
        'whichever it saw last unless you pick. Choose the entry named ' +
        `${expected.name}, or open the account it did fill.`,
    );
  }

  // Known here already: sign in as that account, keeping its data.
  const known = (await listAccounts(home)).find((account) => account.did === identity.did);
  if (known) return begin(home, known, seed);

  // New to this home — the second-domain case. File it, so next time there is
  // something to add a password or a passkey to.
  const id = newAccountId();
  const summary: AccountSummary = {
    id,
    name: expected?.name ?? 'My account',
    did: identity.did,
    createdAt: new Date().toISOString(),
    dataPath: accountDataPath(id),
  };
  await home.store.write(summary, createVault({ did: identity.did, label: summary.name, wraps: [] }));

  return begin(home, summary, seed);
}

/**
 * Signs in with the short password set on this device.
 * @param home Where the account lives
 * @param entry The account, from {@link openAccount}
 * @param password What the user typed
 */
export async function signInWithPassword(
  home: Home,
  entry: AccountEntry,
  password: string,
): Promise<Session> {
  const wrap = entry.vault.wraps.find((candidate) => candidate.kind === 'passphrase');
  if (!wrap || wrap.kind !== 'passphrase') {
    throw protocolError(
      'VAULT_UNLOCK_FAILED',
      'No password is set for this account here.',
      'Use your account code, and you can set one afterwards.',
    );
  }

  return begin(home, entry.summary, await unwrapSeedWithPassphrase(wrap, password));
}

/**
 * Signs in with the shortcut set up on this device.
 * @param home Where the account lives
 * @param entry The account, from {@link openAccount}
 * @param wrap Which shortcut; defaults to the most recently added
 */
export async function signInWithPasskey(
  home: Home,
  entry: AccountEntry,
  wrap?: DeviceWrap,
): Promise<Session> {
  const target = wrap ?? entry.shortcuts[entry.shortcuts.length - 1];
  if (!target) {
    throw protocolError(
      'VAULT_UNLOCK_FAILED',
      'No shortcut on this device can open that account.',
      'Use your account password, and this app can set one up afterwards.',
    );
  }

  // The gate first, so the key is never reached for without someone present.
  if (target.credentialId) {
    await passkeyGate('get', { credentialId: target.credentialId });
  }

  const key = await getDeviceKey(target.deviceKeyId);
  if (!key) {
    throw protocolError(
      'VAULT_UNLOCK_FAILED',
      'The key for that shortcut is not in this browser any more.',
      'Clearing site data removes it. Your account password still works, and a new ' +
        'shortcut can be set up afterwards.',
    );
  }

  return begin(home, entry.summary, await unwrapSeedWithDeviceKey(target, key));
}

// ─── Shortcuts, added once you are in ──────────────────────────────────

/** Rewrites the open account's vault. */
async function updateVault(
  home: Home,
  session: Session,
  make: (vault: AccountVault) => Promise<AccountVault>,
): Promise<void> {
  const current = await home.store.read(session.account.id);
  if (!current) throw new Error('That account is no longer in this folder.');
  await home.store.write(session.account, await make(current));
}

/**
 * Sets a short password for this account, so the code need not be fetched again.
 *
 * Nothing offers this any more. Once the account password is saved in a
 * password manager it fills itself in, and a second password for the same
 * account — a different secret, on the same origin, that a manager files
 * separately — was more to keep straight than it saved. Kept because an
 * existing one still unlocks, and because an app without a passkey path may
 * want it.
 *
 * @param home Where the account lives
 * @param session The open session, which holds the seed
 * @param password What the user chose
 */
export async function setLocalPassword(
  home: Home,
  session: Session,
  seed: Uint8Array,
  password: string,
): Promise<void> {
  const wrap = await wrapSeedWithPassphrase(seed, password, 'Password');

  // One password per account, so setting a new one replaces the old rather
  // than leaving a second, older way in that nobody remembers.
  await updateVault(home, session, async (vault: AccountVault) =>
    withWrap({ ...vault, wraps: vault.wraps.filter((w) => w.kind !== 'passphrase') }, wrap),
  );
}

/**
 * Adds a passkey on this domain to the open account.
 *
 * This is what makes a second app a second door rather than a second account:
 * the same seed, encrypted again under a credential that only exists here.
 */
export async function addPasskeyHere(
  home: Home,
  session: Session,
  seed: Uint8Array,
): Promise<void> {
  const credentialId = await passkeyGate('create', { label: session.account.name });

  const deviceKey = await createDeviceKey();
  const wrap = await wrapSeedWithDeviceKey(seed, deviceKey, { rpId, credentialId, label: rpId });

  // Replacing an older shortcut leaves its key behind, which would sit in
  // storage opening nothing.
  const previous = deviceWrapsFor((await home.store.read(session.account.id))!, rpId);
  await updateVault(home, session, async (vault) => withWrap(vault, wrap));
  for (const stale of previous) await deleteDeviceKey(stale.deviceKeyId);
}

/**
 * Drops a shortcut from the open account.
 *
 * Removing every shortcut is allowed and leaves the account exactly as a new
 * one starts: openable by its code. They are conveniences for one device, not
 * the keys to the building.
 *
 * @param home Where the account lives
 * @param session The open session
 * @param kind Which shortcut to drop. Passkeys are dropped for this domain
 *   only — another app's passkey is not this app's to remove.
 */
export async function removeShortcut(
  home: Home,
  session: Session,
  kind: 'passkey' | 'passphrase',
): Promise<void> {
  if (kind === 'passkey') {
    const vault = await home.store.read(session.account.id);
    // Forget the key too, or it lingers in storage opening nothing.
    for (const wrap of vault ? deviceWrapsFor(vault, rpId) : []) {
      await deleteDeviceKey(wrap.deviceKeyId);
    }
  }

  await updateVault(home, session, async (vault) => ({
    ...vault,
    wraps: vault.wraps.filter((wrap) =>
      kind === 'passkey'
        ? !(wrap.kind === 'device' && wrap.rpId === rpId)
        : wrap.kind !== 'passphrase',
    ),
  }));
}

/**
 * Moves a freshly made account into a folder.
 *
 * Takes the source rather than the seed, so it works whoever holds the key —
 * this page, or a wallet that will sign but not hand it over. Depending on the
 * seed meant wallet accounts fell out of the signup flow entirely and were
 * asked to introduce themselves again.
 *
 * Only safe while the account is new. An established one would need every file
 * under its data path copied too, which the File System Access API can only do
 * one at a time — worth building when someone asks for it, not before.
 *
 * @param to The folder home to move it into
 * @param session The open session
 * @param source What unlocked it, to restart against the folder
 * @returns The session, now reading and writing the folder
 */
export async function moveNewAccountToFolder(
  to: Home,
  session: Session,
  source: SessionSource,
): Promise<Session> {
  const id = newAccountId();
  const summary: AccountSummary = {
    ...session.account,
    id,
    dataPath: accountDataPath(id),
    lastUsedAt: new Date().toISOString(),
  };

  // Carry any wraps across: a passkey added before picking a folder should
  // still open the account afterwards.
  const existing = await currentHome().then((from) => from.store.read(session.account.id));
  await to.store.write(
    summary,
    existing ?? createVault({ did: session.account.did, label: session.account.name, wraps: [] }),
  );

  rememberLastAccount(id);
  return startSession(summary, source, to.directory ? { directory: to.directory } : undefined);
}

// ─── The wallet ────────────────────────────────────────────────────────

/** Names the custodian in an account summary. */
export const SNAP_CUSTODIAN = 'metamask-snap';

/**
 * What a password manager should file the account password under.
 *
 * The account's own name, so the vault entry says which account it opens —
 * useful the moment there is more than one.
 */
export function accountCredentialName(name: string): string {
  return name;
}

/**
 * What a password manager should file a device password under.
 *
 * Deliberately different from {@link accountCredentialName}. They are two
 * different secrets on the same origin: one opens the account anywhere, the
 * other only here. Filed under the same name, a manager would offer whichever
 * it saw last and quietly fill the wrong one.
 */
export function deviceCredentialName(name: string): string {
  return `${name} (this device)`;
}

/** Whether a wallet that might hold an identity is present. */
export const walletAvailable = walletPresent;

/**
 * Signs in with the identity Snap.
 *
 * The one way in that needs nothing stored and no handoff: the Snap lives in
 * the extension rather than in this origin, so it answers on a domain that has
 * never seen this account. The seed stays inside it — this page gets a
 * delegation and never the key.
 *
 * @param home Where this account's data should live
 * @param did Which of the wallet's accounts to act as. Omitted, whichever it
 *   is already acting as — which is only ever the right answer when it holds
 *   one, so a picker should say which.
 * @returns The session
 */
export async function signInWithSnap(home: Home, did?: string): Promise<Session> {
  await connectSnap();

  // Tell the wallet which account before asking who it is, or it answers with
  // whichever it was last acting as and signs you in as someone else.
  const account: SnapAccount = did ? await selectSnapAccount(did) : await connectSnap();

  const known = (await listAccounts(home)).find((entry) => entry.did === account.did);
  const summary: AccountSummary =
    known ??
    (() => {
      const id = newAccountId();
      return {
        id,
        // A placeholder until the user says otherwise — which the account
        // menu lets them do, because nobody wants to be called this.
        name: 'My account',
        did: account.did,
        createdAt: new Date().toISOString(),
        dataPath: accountDataPath(id),
        custodian: SNAP_CUSTODIAN,
      };
    })();

  if (!known) {
    // No wraps: there is nothing here to unlock, and nothing here worth
    // stealing. The wallet is the way in.
    await home.store.write(summary, createVault({ did: account.did, label: summary.name, wraps: [] }));
  }

  const used: AccountSummary = {
    ...summary,
    custodian: SNAP_CUSTODIAN,
    lastUsedAt: new Date().toISOString(),
  };

  try {
    const vault = await home.store.read(summary.id);
    if (vault) await home.store.write(used, vault);
  } catch {
    // The order the picker opens in is not worth failing a sign-in over.
  }

  rememberLastAccount(used.id);
  return startSession(
    used,
    await snapSource(account),
    home.directory ? { directory: home.directory } : undefined,
  );
}

/**
 * Renames an account.
 *
 * The name is a label and nothing else — it is not part of any key, so this
 * changes what the picker says and not what the account is.
 *
 * @param home Where the account lives
 * @param session The open session
 * @param name What to call it
 * @returns The renamed summary
 */
export async function renameAccount(
  home: Home,
  session: Session,
  name: string,
): Promise<AccountSummary> {
  const renamed: AccountSummary = { ...session.account, name: name.trim() || session.account.name };

  const vault = await home.store.read(session.account.id);
  if (!vault) throw new Error('That account is no longer here.');
  await home.store.write(renamed, { ...vault, label: renamed.name });

  return renamed;
}

/**
 * Hands the open account to the wallet, so it works on apps that have never
 * seen it.
 *
 * The seed goes to the Snap, not to any page — and MetaMask confirms, naming
 * the identity it would hold. Afterwards the account is portable: a domain with
 * nothing stored can still open it.
 *
 * @param home Where the account lives
 * @param session The open session
 * @param seed Its seed, which this app is holding
 * @returns The summary, now marked as held by the wallet
 */
export async function linkAccountToSnap(
  home: Home,
  session: Session,
  seed: Uint8Array,
): Promise<AccountSummary> {
  await connectSnap();
  const held = await importIntoSnap(seedToRecoveryCode(seed));

  if (held.did !== session.account.did) {
    throw protocolError(
      'VAULT_UNLOCK_FAILED',
      'The wallet ended up holding a different account than this one.',
    );
  }

  const linked: AccountSummary = { ...session.account, custodian: SNAP_CUSTODIAN };
  const vault = await home.store.read(session.account.id);
  if (vault) await home.store.write(linked, vault);

  return linked;
}

/**
 * Every account the wallet holds, for offering a choice.
 * @returns What it holds, or an empty list when there is no wallet or no Snap
 */
export async function walletAccounts(): Promise<ReadonlyArray<SnapAccount>> {
  try {
    return (await listSnapAccounts()).accounts;
  } catch {
    return [];
  }
}

/**
 * The open account's password, when this page is the one holding the seed.
 *
 * Only for handing back to a password manager — nothing else should need it,
 * and a wallet-held account returns null because the seed is not here to give.
 *
 * @returns The account password, or null
 */
export function openAccountPassword(): string | null {
  const seed = getSessionSeed();
  return seed ? seedToRecoveryCode(seed) : null;
}

/** Signs out. The account and its data stay exactly where they are. */
export function signOut(): void {
  endSession();
}
