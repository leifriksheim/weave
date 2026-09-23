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
  copyAccountData,
  renamePasskey,
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
} from 'weave-protocol';
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
import { storesFor } from './storage-backend';
import { forgetRemembered, recallSeed, rememberSeed } from './remember';

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

const LAST_ACCOUNT_KEY = 'weave.last-account';

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
  return usePod(await pickPod());
}

/**
 * Asks for a pod without switching to it yet — so a signed-in person can be
 * asked what should happen to their data first, and cancelling changes nothing.
 * Must be called from a click.
 */
export async function pickPod(): Promise<Home> {
  const directory = await pickDataFolder({ id: 'weave-pod' });
  return { kind: 'folder', store: createFolderAccountStore(directory), directory };
}

/** Makes a picked pod the one in use, and remembers it for next time. */
export async function usePod(pod: Home): Promise<Home> {
  if (!pod.directory) throw new Error('That is not a folder.');
  await rememberDataFolder(pod.directory);
  _home = pod;
  return _home;
}

/** What a pod holds, for deciding what to do before switching to it. */
export interface PodContents {
  /** This account's copy in the pod, when it has one */
  readonly account: AccountSummary | null;
  /** Other accounts in the pod — never touched by a move */
  readonly others: number;
  /** It is the pod already in use */
  readonly same: boolean;
}

export async function inspectPod(pod: Home, current: Home, did: string): Promise<PodContents> {
  const accounts = await listAccounts(pod);
  const same =
    current.kind === 'folder' &&
    !!current.directory &&
    !!pod.directory &&
    (await (pod.directory as { isSameEntry?: (other: unknown) => Promise<boolean> }).isSameEntry?.(current.directory).catch(() => false)) === true;
  return {
    account: accounts.find((account) => account.did === did) ?? null,
    others: accounts.filter((account) => account.did !== did).length,
    same,
  };
}

/**
 * Switches to the pod's own copy of the open account, bringing nothing over.
 * What was only in the old place stays there.
 */
export async function switchToPodCopy(pod: Home, existing: AccountSummary, source: SessionSource): Promise<Session> {
  await usePod(pod);
  const summary = { ...existing, lastUsedAt: new Date().toISOString() };
  const vault = await pod.store.read(existing.id);
  if (vault) await pod.store.write(summary, vault).catch(() => {});
  rememberLastAccount(summary.id);
  const session = await startSession(summary, source, { directory: pod.directory! });
  await rememberSeedHere(summary.id);
  return session;
}

/** "Stay signed in" names the account and where it lives; after a move it must name the pod. */
async function rememberSeedHere(accountId: string): Promise<void> {
  const seed = getSessionSeed();
  if (seed) await rememberSeed(accountId, 'folder', seed).catch(() => {});
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
): Promise<{ credentialId: string; userHandle?: string }> {
  const preferPlatform = mode === 'create' ? await hasPlatformAuthenticator() : false;
  const steer = preferPlatform ? { hints: ['client-device'] as const } : {};

  if (mode === 'create') {
    const registration = await registerPasskey({
      rpId,
      rpName: 'Weave',
      userName: options.label ?? 'Weave',
      ...steer,
      ...(preferPlatform ? { attachment: 'platform' as const } : {}),
    });
    return { credentialId: registration.credentialId, userHandle: registration.userHandle };
  }

  const auth = await authenticatePasskey(options.credentialId, { rpId, ...steer });
  return { credentialId: auth.credentialId };
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
  const session = await startSession(used, await localSource(seed), home.directory ? { directory: home.directory } : undefined);
  // So a refresh does not ask again — for as long as the security setting allows.
  await rememberSeed(summary.id, home.kind === 'folder' ? 'folder' : 'browser', seed).catch(() => {});
  return session;
}

/**
 * Picks up where this device left off, without asking to unlock — when it was
 * told to stay signed in and that has not run out.
 * @returns The session, or null when there is nothing to resume
 */
export async function resumeSession(home: Home): Promise<Session | null> {
  const kept = await recallSeed(home.kind === 'folder' ? 'folder' : 'browser');
  if (!kept) return null;
  const summary = (await listAccounts(home)).find((account) => account.id === kept.accountId);
  return summary ? begin(home, summary, kept.seed) : null;
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
  const session = await begin(home, summary, seed);
  // The name travels with the account, so the next app it is opened in shows
  // it instead of "My account". Only at creation and on rename — never on a
  // plain start, where a device that has not synced yet would publish a stale
  // name as the newest.
  await session.node.account.setName(name).catch(() => {});
  return { session, code: seedToRecoveryCode(seed) };
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
  const { credentialId, userHandle } = await passkeyGate('create', { label: session.account.name });

  const deviceKey = await createDeviceKey();
  const wrap = await wrapSeedWithDeviceKey(seed, deviceKey, {
    rpId,
    credentialId,
    ...(userHandle ? { userHandle } : {}),
    label: rpId,
  });

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

export interface BroughtToFolder {
  readonly session: Session;
  /** The folder already held this account, and the two copies were combined */
  readonly merged: boolean;
  readonly spacesAdded: number;
  readonly recordsAdded: number;
}

/**
 * Brings the open account into a folder: moves it if the folder has never seen
 * it, merges it if the folder already holds it. Then carries on from the folder.
 *
 * Merging needs no rules. Every record is signed and named by its content, and
 * deletes are records too, so two copies of one account combine by keeping
 * everything from both — nothing conflicts, nothing doubles, and whatever
 * either side deleted stays deleted. The folder's ways of unlocking are kept,
 * and this site's are added.
 *
 * The copy in this browser is left alone. Removing it is a separate, deliberate
 * step ({@link forgetBrowserCopy}), so a copy that fails halfway loses nothing.
 *
 * @param from Where the account is now
 * @param to The folder
 * @param session The open session
 * @param source What unlocked it — the same key opens the folder copy
 */
export async function bringAccountToFolder(
  from: Home,
  to: Home,
  session: Session,
  source: SessionSource,
  onProgress?: (done: number, total: number) => void,
): Promise<BroughtToFolder> {
  if (!to.directory) throw new Error('That is not a folder.');

  const existing = (await listAccounts(to)).find((account) => account.did === session.account.did) ?? null;
  const id = existing?.id ?? newAccountId();
  const summary: AccountSummary = existing
    ? { ...existing, lastUsedAt: new Date().toISOString() }
    : { ...session.account, id, dataPath: accountDataPath(id), lastUsedAt: new Date().toISOString() };

  // Ways of unlocking: the folder's, plus any from here it lacks.
  const here = await from.store.read(session.account.id);
  let vault =
    (existing ? await to.store.read(existing.id) : null) ??
    createVault({ did: session.account.did, label: session.account.name, wraps: [] });
  for (const wrap of here?.wraps ?? []) {
    if (!vault.wraps.some((kept) => kept.id === wrap.id)) vault = withWrap(vault, wrap);
  }
  await to.store.write(summary, vault);

  const copied = await copyAccountData({
    from: storesFor(session.account, from.directory && source.vaultKey ? { directory: from.directory, vaultKey: source.vaultKey } : undefined),
    to: storesFor(summary, source.vaultKey ? { directory: to.directory, vaultKey: source.vaultKey } : undefined),
    did: session.account.did,
    ...(source.accountKey ? { accountKey: source.accountKey } : {}),
    ...(onProgress ? { onProgress } : {}),
  });

  rememberLastAccount(summary.id);
  await usePod(to);
  const started = await startSession(summary, source, { directory: to.directory });
  await rememberSeedHere(summary.id);
  return {
    session: started,
    merged: existing !== null,
    spacesAdded: copied.spacesAdded,
    recordsAdded: copied.recordsAdded,
  };
}

/**
 * Removes this browser's own copy of an account, after it has been brought
 * into a folder. The account itself — and its passkey here, which the folder
 * now carries — keeps working from the folder.
 */
export async function forgetBrowserCopy(account: AccountSummary): Promise<void> {
  const browser = await createBrowserAccountStore();
  const copy = (await browser.list()).find((entry) => entry.did === account.did);
  if (!copy) return;
  await browser.remove(copy.id);

  const prefix = `weave:${copy.dataPath.replace(/\//g, ':')}`;
  const databases = (await globalThis.indexedDB.databases?.()) ?? [];
  await Promise.all(
    databases
      .map((db) => db.name)
      .filter((name): name is string => typeof name === 'string' && name.startsWith(prefix))
      .map(
        (name) =>
          new Promise<void>((resolve) => {
            const request = globalThis.indexedDB.deleteDatabase(name);
            request.onsuccess = request.onerror = request.onblocked = () => resolve();
          }),
      ),
  );
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
  const renamed = await adoptAccountName(home, session, name);
  // Every other device and app that opens the account follows.
  await session.node.account.setName(renamed.name).catch(() => {});
  return renamed;
}

/**
 * Takes a name for the open account here: the label this home files it under,
 * and the label of this site's passkey for it.
 *
 * What a rename elsewhere arrives as, and half of what a rename here does.
 * The passkey is relabelled by asking the passkey provider — a site cannot
 * edit a password manager — which recent browsers support and older ones
 * ignore. A passkey made before its handle was recorded cannot be relabelled.
 */
export async function adoptAccountName(home: Home, session: Session, name: string): Promise<AccountSummary> {
  const renamed: AccountSummary = { ...session.account, name: name.trim() || session.account.name };

  const vault = await home.store.read(session.account.id);
  if (!vault) throw new Error('That account is no longer here.');
  await home.store.write(renamed, { ...vault, label: renamed.name });

  for (const wrap of deviceWrapsFor(vault, rpId)) {
    if (wrap.userHandle) await renamePasskey({ rpId, userHandle: wrap.userHandle, name: renamed.name });
  }
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
  void forgetRemembered();
  endSession();
}
