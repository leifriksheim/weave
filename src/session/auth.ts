/**
 * @module session/auth
 * Signing in, as one object any UI can draw.
 *
 * `createWeaveAuth` holds the whole flow — where the data lives, which account,
 * the ways into it, creating one, arriving from a phone-pairing link — as a
 * state you read and actions you call. The `<weave-auth>` element draws it, a
 * React hook follows it, and an app that wants its own screens can draw it
 * itself. None of them see the seed: it stays inside this object.
 *
 * The credential is a generated 26-character code. It is the seed, written out,
 * which is what makes it work on a domain that has never heard of you — there is
 * nothing stored for it to unlock. A password manager holds it exactly as it
 * holds any generated password. The passkey and the short password are
 * conveniences layered on top, local to one site, so the code only has to be
 * fetched once per site.
 *
 * The identity key never signs a record. Signing in starts a node, which makes
 * a throwaway session key and asks the identity for one note saying that key
 * may write for it; everything after is signed by the session key.
 */
import { createIdentityManager } from '../identity/identity-manager.js';
import { createLocalRootSigner } from '../identity/root-signer.js';
import { AGENT_FACT } from '../identity/agent-note.js';
import { accountDataPath, newAccountId, createBrowserAccountStore } from '../identity/account-store.js';
import type { AccountStore, AccountSummary } from '../identity/account-store.js';
import { createVault } from '../identity/folder-account.js';
import {
  withWrap,
  wrapSeedWithDeviceKey,
  unwrapSeedWithDeviceKey,
  unwrapSeedWithPassphrase,
  deviceWrapsFor,
  deriveVaultKey,
  deriveVaultKeyBytes,
  type AccountVault,
  type DeviceWrap,
} from '../identity/account-vault.js';
import { deriveContactKeyBytes, deriveMemberKeyBytes } from '../identity/contact-key.js';
import { createDeviceKey, getDeviceKey, deleteDeviceKey } from '../identity/device-key.js';
import { registerPasskey, authenticatePasskey, hasPlatformAuthenticator, renamePasskey } from '../identity/webauthn.js';
import { generateSeed, seedToRecoveryCode, recoveryCodeToSeed, isValidRecoveryCode } from '../identity/recovery-code.js';
import type { PairingTicket } from '../identity/pairing.js';
import { isFolderStorageAvailable } from '../storage/directory-access.js';
import { base64UrlEncode } from '../utils/encoding.js';
import { createNode } from '../node/node.js';
import { copyAccountData } from '../node/copy.js';
import type { StoreFactory } from '../node/stores.js';
import type { NodeNetworkConfig, P2PNode } from '../node/types.js';
import { isProtocolError, protocolError, type ProtocolErrorCode } from '../utils/errors.js';
import {
  deleteBrowserData,
  forgetPod,
  inspectPod,
  listAccounts,
  pickPod,
  recallPod,
  rememberPod,
  storesFor,
  type Place,
  type PodContents,
} from './places.js';
import { createStaySignedIn, type KeyValueStore, type StaySignedIn } from './stay-signed-in.js';
import { grantCapabilities, MAX_GRANT_DAYS, type CarryGrant, type ConnectRequest, type Grant, type GrantedSpace } from './connect.js';
import {
  clearPairingTicket,
  collectFromDesktop,
  offerToPhone as offerPairing,
  readPairingTicket,
  type PairingOffer,
  type PairingStage,
} from './pairing.js';

export interface WeaveAuthConfig {
  /** What passkey prompts call this app. Default "Weave". */
  readonly appName?: string;
  /** Relays and always-on nodes the signed-in node connects to. Omit to stay offline. */
  readonly network?: NodeNetworkConfig;
  /** The site passkeys belong to. Default: this page's hostname. */
  readonly rpId?: string;
  /** Where small choices are remembered — which account, stay signed in. Default `localStorage`. */
  readonly storage?: KeyValueStore | null;
  /** Namespaces those choices, so two apps on one origin keep their own. Default "weave". */
  readonly storageKey?: string;
  /** The page a phone-pairing QR opens. Default: this page. */
  readonly pairingLink?: string;
  /**
   * Accounts kept in this browser, and their data. Defaults to IndexedDB;
   * swap both for tests or for a host with no IndexedDB.
   */
  readonly browser?: {
    readonly accounts: () => Promise<AccountStore>;
    readonly stores: (account: AccountSummary) => StoreFactory;
  };
}

/**
 * Which screen the flow is on.
 *
 * `where` — where should your data live (a pod, or this browser); asked once.
 * `welcome` — the place holds no accounts: new here, or not?
 * `signIn` — choose an account and unlock it.
 * `create` — name a new account; then, with `freshCode` set, save its password.
 * `pair` — opened from a phone-pairing QR code.
 * `ready` — signed in; `session` is set.
 */
export type AuthStage = 'starting' | 'where' | 'welcome' | 'signIn' | 'create' | 'pair' | 'ready';

/** A failure, in the shape a screen needs to explain it */
export interface AuthError {
  readonly message: string;
  /** What the person can do about it, when that is known */
  readonly hint?: string;
  readonly code?: ProtocolErrorCode;
}

/** Which ways into an account exist on this site */
export interface AccountEntry {
  readonly summary: AccountSummary;
  readonly vault: AccountVault;
  /**
   * Passkey shortcuts this device can actually use. A wrap names a key in this
   * site's storage, so one made on another site — or before storage was
   * cleared — is listed by the vault but unopenable here.
   */
  readonly shortcuts: ReadonlyArray<DeviceWrap>;
  /** Whether a short password was set here */
  readonly hasPassword: boolean;
}

/** An open account: who it is, and the node doing its work */
export interface WeaveSession {
  readonly account: AccountSummary;
  /** The account's identity */
  readonly did: string;
  /** The session key's DID — what peers see */
  readonly sessionDid: string;
  readonly node: P2PNode;
}

/** What the last move into a pod did */
export interface MovedToPod {
  /** The pod already held this account, and the two copies were combined */
  readonly merged: boolean;
  readonly spacesAdded: number;
  readonly recordsAdded: number;
  /** The old pod's name, or null when the old place was this browser */
  readonly from: string | null;
}

/** An app this account gave access to, as the home remembers it */
export interface Connection {
  /** Where the app lives — as the browser reported it, not as the app named itself */
  readonly origin: string;
  /** What the app called itself */
  readonly name: string | null;
  /** The app's key */
  readonly audience: string;
  /** `carry` for a carrier, which holds passes and no keys */
  readonly access: 'read' | 'write' | 'carry';
  /** `account` when the app was given the whole account, not chosen spaces */
  readonly scope: 'spaces' | 'account';
  /** A carrier's carry space — what disconnecting takes away */
  readonly carrySpace?: string;
  readonly spaces: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly grantedAt: string;
  /** Unix seconds */
  readonly expiresAt: number;
  /** The note the app writes under — what disconnecting revokes */
  readonly token?: string;
  /** Present, and true, for an agent connected through the app at `origin` — its own key, kept apart from the app's own connection */
  readonly agent?: true;
}

/** What the person chose on the approval screen */
export interface GrantChoice {
  readonly origin: string;
  readonly request: ConnectRequest;
  /** Existing spaces to give the app */
  readonly spaceIds: ReadonlyArray<string>;
  /** How long the note lasts, overriding what the request asked for. Default: the request's `days`, or 7. */
  readonly days?: number;
}

export interface AuthState {
  readonly stage: AuthStage;
  /** Where accounts are being read from */
  readonly place: Place | null;
  readonly accounts: ReadonlyArray<AccountSummary>;
  readonly selectedId: string | null;
  /** Ways into the selected account */
  readonly entry: AccountEntry | null;
  readonly session: WeaveSession | null;
  /** A new account's password, shown once until `codeSaved()` */
  readonly freshCode: string | null;
  /** Something is in progress; buttons should wait */
  readonly busy: boolean;
  readonly error: AuthError | null;
  /** Whether this browser can open a pod at all */
  readonly folderAvailable: boolean;
  /** The phone-pairing link this page was opened with */
  readonly pairing: PairingTicket | null;
  readonly pairingStage: PairingStage | null;
  /** A pod picked while signed in, waiting on what should happen to the data */
  readonly podChoice: { readonly pod: Place; readonly contents: PodContents; readonly from: Place } | null;
  readonly moved: MovedToPod | null;
}

export interface WeaveAuth {
  getState(): AuthState;
  /** Called after every change. Returns a function that stops it. */
  subscribe(listener: (state: AuthState) => void): () => void;
  /** Looks for accounts and resumes a kept sign-in. Safe to call more than once. */
  start(): Promise<void>;

  // Where the data lives
  /** Opens a pod. Needs a click. Signed in, it asks what should happen to the data first (`podChoice`). */
  choosePod(): Promise<void>;
  /** Keeps accounts in this browser, and stops using a pod if one was open */
  useBrowser(): Promise<void>;
  /** Back to the where-should-your-data-live question */
  changeStorage(): void;

  // Getting in
  select(accountId: string): Promise<void>;
  signInWithCode(code: string): Promise<void>;
  signInWithPassword(password: string): Promise<void>;
  signInWithPasskey(): Promise<void>;
  startCreating(): void;
  showSignIn(): void;
  createAccount(name: string): Promise<void>;
  /** The new password has been saved; carry on in */
  codeSaved(): void;
  acceptPairing(): Promise<void>;
  dismissPairing(): void;
  clearError(): void;

  // Once in
  rename(name: string): Promise<boolean>;
  addPasskey(): Promise<boolean>;
  removeShortcut(kind: 'passkey' | 'passphrase'): Promise<boolean>;
  confirmPod(how: 'combine' | 'switch'): Promise<void>;
  cancelPod(): void;
  /** Removes the copy this browser kept after a move into a pod */
  forgetBrowserCopy(): Promise<void>;
  dismissMoved(): void;
  /** The account password, for handing back to a password manager. Null when signed out. */
  accountPassword(): string | null;
  /** Starts offering this account to a phone */
  offerToPhone(onStage: (stage: PairingStage) => void): Promise<PairingOffer>;
  /**
   * Gives an app access, as the account home: makes any spaces it asked for,
   * signs a note from the account to the app's key for these spaces, and
   * remembers the app as connected. The seed signs here and goes nowhere.
   */
  grant(choice: GrantChoice): Promise<Omit<Grant, 'home'>>;
  /**
   * Starts using a carrier, as the account home: makes its carry space, fills
   * it with a pass for every space, and remembers it as connected. The
   * carrier gets no key that reads or writes a space.
   */
  grantCarry(choice: { readonly origin: string; readonly request: ConnectRequest }): Promise<Omit<CarryGrant, 'home'>>;
  /** Apps this account is connected to from this home, newest first */
  connections(): ReadonlyArray<Connection>;
  /**
   * Other accounts in this place that `origin` is connected to from this home.
   * One browser extension carries one account, so connecting it here moves it
   * off theirs — worth saying before it happens.
   */
  connectedElsewhere(origin: string): ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /**
   * Disconnects an app: revokes its note in every space it could write in —
   * and, for a whole-account app, in the account registry — so nothing it
   * writes from now on counts, and forgets it. What this home had
   * seen it write stays. What it could already read, it keeps — reading is
   * holding a space's key, and that is not taken back.
   *
   * Disconnecting an app disconnects the agents connected through it too.
   * `{ agent: true }` disconnects only those agents; `{ audience }` only the
   * one with that key.
   */
  disconnect(origin: string, options?: { readonly agent?: boolean; readonly audience?: string }): Promise<void>;
  readonly staySignedIn: {
    choice(): StaySignedIn;
    setChoice(choice: StaySignedIn): Promise<void>;
    until(): Date | null;
  };
  signOut(): Promise<void>;
}

/** Turns a thrown value into something worth showing, ignoring a dismissed prompt. */
function describe(error: unknown): AuthError | null {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return null; // the person dismissed a passkey or folder prompt
  }
  if (isProtocolError(error)) {
    return { message: error.message, code: error.code, ...(error.hint ? { hint: error.hint } : {}) };
  }
  return { message: error instanceof Error ? error.message : 'Something went wrong' };
}

const afterStorage = (accounts: ReadonlyArray<unknown>): AuthStage => (accounts.length > 0 ? 'signIn' : 'welcome');

/**
 * Creates the sign-in flow for this page.
 * @param config Where to connect once signed in, and what to call the app
 */
export function createWeaveAuth(config: WeaveAuthConfig = {}): WeaveAuth {
  const rpId = config.rpId ?? globalThis.location?.hostname ?? 'localhost';
  const appName = config.appName ?? 'Weave';
  const prefix = config.storageKey ?? 'weave';
  const storage: KeyValueStore | null =
    config.storage !== undefined ? config.storage : ((globalThis as { localStorage?: KeyValueStore }).localStorage ?? null);
  const stay = createStaySignedIn(storage, rpId, prefix);
  const browserAccounts = config.browser?.accounts ?? createBrowserAccountStore;
  const browserStores = config.browser?.stores ?? ((account: AccountSummary) => storesFor(account));

  const LAST_ACCOUNT = `${prefix}.last-account`;
  const BROWSER_CHOSEN = `${prefix}.storage-choice`;
  const get = (key: string) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const set = (key: string, value: string) => {
    try {
      storage?.setItem(key, value);
    } catch {
      // Remembering is a convenience, never a requirement.
    }
  };

  let state: AuthState = Object.freeze({
    stage: 'starting',
    place: null,
    accounts: [],
    selectedId: null,
    entry: null,
    session: null,
    freshCode: null,
    busy: false,
    error: null,
    folderAvailable: isFolderStorageAvailable(),
    pairing: readPairingTicket(),
    pairingStage: null,
    podChoice: null,
    moved: null,
  });
  const listeners = new Set<(state: AuthState) => void>();
  const update = (patch: Partial<AuthState>) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener(state);
  };

  /** The seed behind the open session. Never leaves this closure except as the account password. */
  let seed: Uint8Array | null = null;
  let vaultKey: CryptoKey | null = null;
  let stopFollowingName: (() => void) | null = null;
  let started: Promise<void> | null = null;

  const browserPlace = async (): Promise<Place> => ({ kind: 'browser', store: await browserAccounts(), directory: null });

  const storesOf = (place: Place, account: AccountSummary, key: CryptoKey): StoreFactory =>
    place.directory ? storesFor(account, { directory: place.directory, vaultKey: key }) : browserStores(account);

  // ─── Accounts in a place ───────────────────────────────────────────

  async function openEntry(place: Place, id: string): Promise<AccountEntry | null> {
    const [summary, vault] = await Promise.all([
      listAccounts(place).then((accounts) => accounts.find((account) => account.id === id)),
      place.store.read(id),
    ]);
    if (!summary || !vault) return null;

    // A wrap whose key is missing from this browser cannot be offered, however
    // confidently the vault lists it.
    const usable = await Promise.all(
      deviceWrapsFor(vault, rpId).map(async (wrap) => ((await getDeviceKey(wrap.deviceKeyId).catch(() => null)) ? wrap : null)),
    );
    return {
      summary,
      vault,
      shortcuts: usable.filter((wrap): wrap is DeviceWrap => wrap !== null),
      hasPassword: vault.wraps.some((wrap) => wrap.kind === 'passphrase'),
    };
  }

  /** Re-reads the accounts in a place and picks one to expand. */
  async function refresh(place: Place): Promise<ReadonlyArray<AccountSummary>> {
    const accounts = await listAccounts(place);
    const remembered = get(LAST_ACCOUNT);
    const chosen = accounts.find((account) => account.id === remembered) ?? accounts[0] ?? null;
    update({
      place,
      accounts,
      selectedId: chosen?.id ?? null,
      entry: chosen ? await openEntry(place, chosen.id) : null,
    });
    return accounts;
  }

  async function refreshEntry(): Promise<void> {
    if (state.place && state.session) update({ entry: await openEntry(state.place, state.session.account.id) });
  }

  // ─── Sessions ──────────────────────────────────────────────────────

  /**
   * Stops the open session's node. The session stays in the state until
   * something replaces it — a restart swaps one session for the next, and
   * signing out moves off the signed-in screens in the same change — so a
   * screen never sees "ready" with no session.
   */
  async function stopNode(node = state.session?.node): Promise<void> {
    stopFollowingName?.();
    stopFollowingName = null;
    seed = null;
    vaultKey = null;
    await node?.close();
  }

  /** Starts the node for an unlocked account. */
  async function startSession(place: Place, account: AccountSummary, unlocked: Uint8Array): Promise<WeaveSession> {
    await stopNode();

    const manager = createIdentityManager();
    const identity = await manager.fromSeed(unlocked);
    const key = await deriveVaultKey(unlocked);
    const node = await createNode({
      signer: createLocalRootSigner(identity, manager.getProvider()),
      accountKey: await deriveVaultKeyBytes(unlocked),
      contactKey: await deriveContactKeyBytes(unlocked),
      stores: storesOf(place, account, key),
      ...(config.network ? { network: config.network } : {}),
    });

    seed = unlocked;
    vaultKey = key;
    const session: WeaveSession = Object.freeze({ account, did: identity.did, sessionDid: node.sessionDid, node });

    // The account's name follows it: a rename on another device or site
    // arrives through the account registry and is taken here too.
    const adopt = async () => {
      const profile = await node.account.profile().catch(() => null);
      const current = state.session;
      if (!profile || !current || current.node !== node || profile.name === current.account.name) return;
      await adoptName(profile.name).catch(() => {});
    };
    stopFollowingName = node.subscribe((event) => {
      if (event.type === 'account') void adopt();
    });
    void adopt();

    return session;
  }

  /** Records that an account was just used, and starts its session. */
  async function begin(place: Place, summary: AccountSummary, unlocked: Uint8Array): Promise<WeaveSession> {
    const used: AccountSummary = { ...summary, lastUsedAt: new Date().toISOString() };
    try {
      const vault = await place.store.read(summary.id);
      if (vault) await place.store.write(used, vault);
    } catch {
      // The order the picker opens in is not worth failing a sign-in over.
    }
    set(LAST_ACCOUNT, summary.id);
    const session = await startSession(place, used, unlocked);
    // So a refresh does not ask again — for as long as the setting allows.
    await stay.remember(summary.id, place.kind, unlocked).catch(() => {});
    return session;
  }

  /** Runs something that may fail, showing the failure; true when it worked. */
  async function run(work: () => Promise<void>): Promise<boolean> {
    update({ busy: true, error: null });
    try {
      await work();
      return true;
    } catch (error) {
      update({ error: describe(error) });
      return false;
    } finally {
      update({ busy: false });
    }
  }

  /** Runs a way in, and goes to the app when it ends in a session. */
  const enter = (open: () => Promise<WeaveSession>) =>
    run(async () => {
      const session = await open();
      update({ session, stage: 'ready' });
    }).then(() => undefined);

  // ─── Passkeys ──────────────────────────────────────────────────────

  /**
   * Runs a passkey ceremony as a gate.
   *
   * Nothing is read out of it. The ceremony proves a person with the
   * authenticator is present, and the key that actually opens the account
   * lives in this site's storage — which is why every passkey provider works,
   * including the ones that store passkeys without the PRF extension.
   *
   * Steers to this device's own authenticator when it has one: the key this
   * gates never leaves the browser, so a passkey synced by a manager gates
   * nothing anywhere else.
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
        rpName: appName,
        userName: options.label ?? appName,
        ...steer,
        ...(preferPlatform ? { attachment: 'platform' as const } : {}),
      });
      return { credentialId: registration.credentialId, userHandle: registration.userHandle };
    }
    const auth = await authenticatePasskey(options.credentialId, { rpId, ...steer });
    return { credentialId: auth.credentialId };
  }

  /** Rewrites the open account's vault. */
  async function updateVault(make: (vault: AccountVault) => Promise<AccountVault>): Promise<void> {
    const { place, session } = state;
    if (!place || !session) throw new Error('Not signed in.');
    const current = await place.store.read(session.account.id);
    if (!current) throw new Error('That account is no longer here.');
    await place.store.write(session.account, await make(current));
  }

  /** Takes a name for the open account here: the label it is filed under, and its passkey's label. */
  async function adoptName(name: string): Promise<AccountSummary> {
    const { place, session } = state;
    if (!place || !session) throw new Error('Not signed in.');
    const renamed: AccountSummary = { ...session.account, name: name.trim() || session.account.name };

    const vault = await place.store.read(session.account.id);
    if (!vault) throw new Error('That account is no longer here.');
    await place.store.write(renamed, { ...vault, label: renamed.name });

    // Recent browsers let a site relabel its passkey; older ones ignore it.
    for (const wrap of deviceWrapsFor(vault, rpId)) {
      if (wrap.userHandle) await renamePasskey({ rpId, userHandle: wrap.userHandle, name: renamed.name }).catch(() => false);
    }
    update({ session: Object.freeze({ ...session, account: renamed }), accounts: await listAccounts(place) });
    return renamed;
  }

  /** Changes to the open account's shortcuts, then re-reads them. */
  const changeShortcut = (apply: (unlocked: Uint8Array) => Promise<void>) =>
    run(async () => {
      if (!seed) throw new Error('Not signed in.');
      await apply(seed);
      await refreshEntry();
    });

  /** Connected apps are remembered per account, on this device */
  function writeConnections(connections: ReadonlyArray<Connection>): void {
    const account = state.session?.account.id;
    if (account) set(`${prefix}.connections:${account}`, JSON.stringify(connections));
    update({});
  }

  // ─── The flow ──────────────────────────────────────────────────────

  const auth: WeaveAuth = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      started ??= (async () => {
        try {
          // Asks nothing of the person: only whether what was granted before is still live.
          const pod = await recallPod(false).catch(() => null);
          const place = pod ?? (await browserPlace());
          const accounts = await refresh(place);

          if (accounts.length > 0) {
            const kept = await stay.recall(place.kind).catch(() => null);
            const summary = kept && accounts.find((account) => account.id === kept.accountId);
            if (kept && summary) {
              update({ session: await begin(place, summary, kept.seed), stage: 'ready' });
              return;
            }
          }

          if (state.pairing) {
            update({ stage: 'pair' });
            return;
          }
          // Nothing here yet and the storage question never answered: ask it first.
          const undecided = !pod && accounts.length === 0 && state.folderAvailable && get(BROWSER_CHOSEN) !== 'browser';
          update({ stage: undecided ? 'where' : afterStorage(accounts) });
        } catch (error) {
          update({ error: describe(error), stage: 'welcome' });
        }
      })();
      return started;
    },

    async choosePod() {
      await run(async () => {
        const pod = await pickPod();
        const { session, place } = state;
        // Signed in: look before leaping. The picker needed the click, but
        // switching waits for an answer.
        if (session && place) {
          const contents = await inspectPod(pod, place, session.account.did);
          if (contents.same) throw new Error('That is the pod you are already using.');
          update({ podChoice: { pod, contents, from: place } });
          return;
        }
        await rememberPod(pod);
        update({ stage: afterStorage(await refresh(pod)) });
      });
    },

    async useBrowser() {
      set(BROWSER_CHOSEN, 'browser');
      await run(async () => {
        if (state.place?.kind === 'folder') await forgetPod();
        const place = state.place?.kind === 'browser' ? state.place : await browserPlace();
        update({ stage: afterStorage(await refresh(place)) });
      });
    },

    changeStorage() {
      update({ error: null, stage: 'where' });
    },

    async select(accountId) {
      update({ selectedId: accountId, error: null });
      if (state.place) update({ entry: await openEntry(state.place, accountId) });
    },

    signInWithCode(code) {
      return enter(async () => {
        const place = state.place;
        if (!place) throw new Error('No place to sign in to yet.');
        if (!isValidRecoveryCode(code)) {
          throw protocolError(
            'VAULT_UNLOCK_FAILED',
            'That does not look like an account password.',
            'It is 26 letters and digits, usually shown in groups of four.',
          );
        }
        const unlocked = recoveryCodeToSeed(code);
        const identity = await createIdentityManager().fromSeed(unlocked);
        const expected = state.accounts.find((account) => account.id === state.selectedId);

        if (expected && identity.did !== expected.did) {
          throw protocolError(
            'VAULT_UNLOCK_FAILED',
            `That password opens a different account, not ${expected.name}.`,
            'With more than one account saved for this site, a password manager fills whichever it saw last ' +
              `unless you pick. Choose the entry named ${expected.name}, or open the account it did fill.`,
          );
        }

        const known = (await listAccounts(place)).find((account) => account.did === identity.did);
        if (known) return begin(place, known, unlocked);

        // New to this place — the second-site case. File it, so next time there
        // is something to add a passkey to.
        const id = newAccountId();
        const summary: AccountSummary = {
          id,
          name: expected?.name ?? 'My account',
          did: identity.did,
          createdAt: new Date().toISOString(),
          dataPath: accountDataPath(id),
        };
        await place.store.write(summary, createVault({ did: identity.did, label: summary.name, wraps: [] }));
        return begin(place, summary, unlocked);
      });
    },

    signInWithPassword(password) {
      return enter(async () => {
        const { place, entry } = state;
        const wrap = entry?.vault.wraps.find((candidate) => candidate.kind === 'passphrase');
        if (!place || !entry || !wrap || wrap.kind !== 'passphrase') {
          throw protocolError(
            'VAULT_UNLOCK_FAILED',
            'No password is set for this account here.',
            'Use your account password instead.',
          );
        }
        return begin(place, entry.summary, await unwrapSeedWithPassphrase(wrap, password));
      });
    },

    signInWithPasskey() {
      return enter(async () => {
        const { place, entry } = state;
        const target = entry?.shortcuts[entry.shortcuts.length - 1];
        if (!place || !entry || !target) {
          throw protocolError(
            'VAULT_UNLOCK_FAILED',
            'No passkey on this device can open that account.',
            'Use your account password, and you can set one up afterwards.',
          );
        }
        // The gate first, so the key is never reached for without someone present.
        if (target.credentialId) await passkeyGate('get', { credentialId: target.credentialId });

        const key = await getDeviceKey(target.deviceKeyId);
        if (!key) {
          throw protocolError(
            'VAULT_UNLOCK_FAILED',
            'The key for that passkey is not in this browser any more.',
            'Clearing site data removes it. Your account password still works, and a new passkey can be set up afterwards.',
          );
        }
        return begin(place, entry.summary, await unwrapSeedWithDeviceKey(target, key));
      });
    },

    startCreating() {
      update({ error: null, stage: 'create' });
    },

    showSignIn() {
      update({ error: null, stage: 'signIn' });
    },

    async createAccount(name) {
      await run(async () => {
        const place = state.place;
        if (!place) throw new Error('No place to keep the account yet.');

        // The seed is random, and the password shown afterwards is that seed
        // written out — not a backup of it.
        const unlocked = generateSeed();
        const identity = await createIdentityManager().fromSeed(unlocked);
        const id = newAccountId();
        const summary: AccountSummary = {
          id,
          name: name.trim(),
          did: identity.did,
          createdAt: new Date().toISOString(),
          dataPath: accountDataPath(id),
        };

        // No wraps yet: the password is the way in, and it needs none.
        await place.store.write(summary, createVault({ did: identity.did, label: summary.name, wraps: [] }));
        const session = await begin(place, summary, unlocked);
        // The name travels with the account, so the next site it is opened on
        // shows it. Only at creation and on rename — never on a plain start,
        // where a device that has not synced yet would publish a stale name.
        await session.node.account.setName(summary.name).catch(() => {});
        update({ session, freshCode: seedToRecoveryCode(unlocked), accounts: await listAccounts(place) });
      });
    },

    codeSaved() {
      update({ freshCode: null, stage: 'ready' });
    },

    async acceptPairing() {
      const ticket = state.pairing;
      if (!ticket) return;
      if (!state.place) update({ place: await browserPlace() });
      await auth.signInWithCode(ticket.code);
      const session = state.session;
      if (!session) return;
      clearPairingTicket();
      await collectFromDesktop(session.node, ticket, (stage) => update({ pairingStage: stage }));
      update({ pairing: null });
    },

    dismissPairing() {
      clearPairingTicket();
      update({ pairing: null, pairingStage: null, stage: state.session ? 'ready' : afterStorage(state.accounts) });
    },

    clearError() {
      update({ error: null });
    },

    async rename(name) {
      const session = state.session;
      if (!session) return false;
      return run(async () => {
        const renamed = await adoptName(name);
        // Every other device and site that opens the account follows.
        await session.node.account.setName(renamed.name).catch(() => {});
      });
    },

    addPasskey: () =>
      changeShortcut(async (unlocked) => {
        const session = state.session!;
        const place = state.place!;
        const { credentialId, userHandle } = await passkeyGate('create', { label: session.account.name });
        const deviceKey = await createDeviceKey();
        const wrap = await wrapSeedWithDeviceKey(unlocked, deviceKey, {
          rpId,
          credentialId,
          ...(userHandle ? { userHandle } : {}),
          label: rpId,
        });
        // Replacing an older passkey leaves its key behind, opening nothing.
        const previous = deviceWrapsFor((await place.store.read(session.account.id))!, rpId);
        await updateVault(async (vault) => withWrap(vault, wrap));
        for (const stale of previous) await deleteDeviceKey(stale.deviceKeyId);
      }),

    removeShortcut: (kind) =>
      changeShortcut(async () => {
        const session = state.session!;
        if (kind === 'passkey') {
          const vault = await state.place!.store.read(session.account.id);
          for (const wrap of vault ? deviceWrapsFor(vault, rpId) : []) await deleteDeviceKey(wrap.deviceKeyId);
        }
        // Removing every shortcut leaves the account as a new one starts:
        // openable by its password. Another site's passkey is not this one's to remove.
        await updateVault(async (vault) => ({
          ...vault,
          wraps: vault.wraps.filter((wrap) =>
            kind === 'passkey' ? !(wrap.kind === 'device' && wrap.rpId === rpId) : wrap.kind !== 'passphrase',
          ),
        }));
      }),

    async confirmPod(how) {
      const choice = state.podChoice;
      const session = state.session;
      if (!choice || !session || !seed || !vaultKey) return;
      const unlocked = seed;
      const key = vaultKey;

      await run(async () => {
        const { pod, contents, from } = choice;
        if (!pod.directory) throw new Error('That is not a folder.');

        if (how === 'switch' && contents.account) {
          // Use the pod's own copy and bring nothing; what was only here stays here.
          await rememberPod(pod);
          const started = await begin(pod, contents.account, unlocked);
          update({ session: started, place: pod, accounts: await listAccounts(pod), podChoice: null, moved: null });
          return;
        }

        // Combine: every record is signed and named by its content, and deletes
        // are records too, so two copies merge by keeping everything from both.
        const existing = contents.account;
        const id = existing?.id ?? newAccountId();
        const summary: AccountSummary = existing
          ? { ...existing, lastUsedAt: new Date().toISOString() }
          : { ...session.account, id, dataPath: accountDataPath(id), lastUsedAt: new Date().toISOString() };

        // Ways of unlocking: the pod's, plus any from here it lacks.
        const here = await from.store.read(session.account.id);
        let vault =
          (existing ? await pod.store.read(existing.id) : null) ??
          createVault({ did: session.account.did, label: session.account.name, wraps: [] });
        for (const wrap of here?.wraps ?? []) {
          if (!vault.wraps.some((kept) => kept.id === wrap.id)) vault = withWrap(vault, wrap);
        }
        await pod.store.write(summary, vault);

        const copied = await copyAccountData({
          from: storesOf(from, session.account, key),
          to: storesOf(pod, summary, key),
          did: session.account.did,
          accountKey: await deriveVaultKeyBytes(unlocked),
        });

        await rememberPod(pod);
        const started = await begin(pod, summary, unlocked);
        update({
          session: started,
          place: pod,
          accounts: await listAccounts(pod),
          podChoice: null,
          moved: {
            merged: existing !== null,
            spacesAdded: copied.spacesAdded,
            recordsAdded: copied.recordsAdded,
            from: from.kind === 'folder' ? (from.directory?.name ?? 'your old pod') : null,
          },
        });
      });
    },

    cancelPod() {
      update({ podChoice: null, error: null });
    },

    async forgetBrowserCopy() {
      const session = state.session;
      if (!session) return;
      await run(async () => {
        const browser = await browserAccounts();
        const copy = (await browser.list()).find((entry) => entry.did === session.account.did);
        if (copy) {
          await browser.remove(copy.id);
          await deleteBrowserData(copy);
        }
        update({ moved: null });
      });
    },

    dismissMoved() {
      update({ moved: null });
    },

    accountPassword() {
      return seed ? seedToRecoveryCode(seed) : null;
    },

    offerToPhone(onStage) {
      const session = state.session;
      if (!session || !seed) return Promise.reject(new Error('Sign in first.'));
      const location = globalThis.location;
      return offerPairing(
        {
          node: session.node,
          seed,
          relays: config.network?.relays ?? [],
          link: config.pairingLink ?? (location ? `${location.origin}${location.pathname}` : ''),
        },
        onStage,
      );
    },

    async grant(choice) {
      const session = state.session;
      if (!session || !seed) throw new Error('Sign in first.');
      const { node } = session;
      const { request } = choice;

      if (request.access === 'carry') throw new Error('A carrier is given passes, not a note — use grantCarry.');
      const access = request.access;
      const agent = request.agent === true;
      if (agent && request.create?.length) throw new Error('An agent works in spaces that exist — none are made for it.');
      if (agent && request.contacts) throw new Error('An agent is not given your contacts.');
      const whole = request.scope === 'account';
      const created = [];
      for (const params of request.create ?? []) created.push(await node.spaces.create(params));
      // With the whole account the app derives the contacts space itself; otherwise it is one more space it is given.
      const contactsSpace = request.contacts && !whole ? await node.contacts.space() : null;
      const ids = [...new Set([...choice.spaceIds, ...created.map((space) => space.id), ...(contactsSpace ? [contactsSpace] : [])])];

      const spaces: GrantedSpace[] = [];
      for (const id of ids) {
        const space = await node.spaces.get(id);
        if (!space) throw new Error(`No space ${id} in this account.`);
        // Read-only: what lets the app write is the note, under this account's own role — never a secret of the space's.
        const invite = await node.spaces.invite(id, { write: false });
        // Only for the spaces granted: each opens that space's next key and nothing else.
        const memberKey = !whole && space.visibility === 'private' ? base64UrlEncode(await deriveMemberKeyBytes(await deriveVaultKeyBytes(seed), id)) : null;
        spaces.push({ id, name: space.name, invite, ...(memberKey ? { memberKey } : {}) });
      }

      const days = Math.min(Math.max(choice.days ?? request.days ?? 7, 1 / 24), MAX_GRANT_DAYS);
      const expiresAt = Math.floor(Date.now() / 1000) + Math.round(days * 24 * 3600);
      const manager = createIdentityManager();
      const root = createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider());
      const token = await root.delegate({
        audience: request.audience,
        capabilities: grantCapabilities(access, whole ? 'all' : ids),
        expiration: expiresAt,
        ...(agent ? { facts: [AGENT_FACT] } : {}),
      });

      const connection: Connection = {
        origin: choice.origin,
        name: request.name?.slice(0, 80) ?? null,
        audience: request.audience,
        access,
        scope: whole ? 'account' : 'spaces',
        spaces: spaces.map(({ id, name }) => ({ id, name })),
        grantedAt: new Date().toISOString(),
        expiresAt,
        token: token.encoded,
        ...(agent ? { agent: true as const } : {}),
      };
      // Connecting again replaces the old note. An agent is its own key: connecting one replaces only that one.
      const replaced = (known: Connection) => (agent ? known.audience === request.audience : known.origin === choice.origin && !known.agent);
      writeConnections([connection, ...auth.connections().filter((known) => !replaced(known))]);

      return {
        v: 1,
        did: session.did,
        name: session.account.name,
        token: token.encoded,
        access,
        scope: whole ? 'account' : 'spaces',
        spaces,
        ...(whole ? { accountKey: base64UrlEncode(await deriveVaultKeyBytes(seed)) } : {}),
        ...(whole || request.contacts ? { contactKey: base64UrlEncode(await deriveContactKeyBytes(seed)) } : {}),
        ...(contactsSpace ? { contactsSpace } : {}),
        ...(config.network?.relays?.length ? { relays: [...config.network.relays] } : {}),
        expiresAt,
        ...(agent ? { agent: true as const } : {}),
      };
    },

    async grantCarry({ origin, request }) {
      const session = state.session;
      if (!session || !seed) throw new Error('Sign in first.');
      const { node } = session;
      // Connecting again replaces the old one: one carrier per origin.
      const previous = auth.connections().find((known) => known.origin === origin);
      if (previous?.carrySpace) await node.carriers.remove(previous.carrySpace).catch(() => {});

      const name = request.name?.slice(0, 80) || 'Browser extension';
      const carry = await node.carriers.add({ did: request.audience, name });
      const connection: Connection = {
        origin,
        name,
        audience: request.audience,
        access: 'carry',
        scope: 'account',
        spaces: [],
        grantedAt: new Date().toISOString(),
        // Carrying has no end date: a pass reads nothing, and the carrier writes nothing.
        expiresAt: 0,
        carrySpace: carry.space,
      };
      writeConnections([connection, ...auth.connections().filter((known) => known.origin !== origin)]);

      const place = state.place;
      return {
        v: 1,
        kind: 'carry',
        did: session.did,
        name: session.account.name,
        carry,
        pod: place?.kind === 'folder' ? { dataPath: session.account.dataPath, folder: place.directory?.name ?? 'your pod' } : null,
        ...(config.network?.relays?.length ? { relays: [...config.network.relays] } : {}),
      };
    },

    connections() {
      const account = state.session?.account.id;
      if (!account) return [];
      try {
        return JSON.parse(get(`${prefix}.connections:${account}`) ?? '[]') as Connection[];
      } catch {
        return [];
      }
    },

    connectedElsewhere(origin) {
      const current = state.session?.account.id;
      return state.accounts
        .filter((account) => account.id !== current)
        .filter((account) => {
          try {
            const known = JSON.parse(get(`${prefix}.connections:${account.id}`) ?? '[]') as Connection[];
            return known.some((connection) => connection.origin === origin);
          } catch {
            return false;
          }
        })
        .map((account) => ({ id: account.id, name: account.name }));
    },

    async disconnect(origin, options = {}) {
      // The app goes with the agents connected through it; an agent can go alone.
      const goes = (known: Connection) =>
        options.audience !== undefined
          ? known.audience === options.audience
          : known.origin === origin && (!options.agent || !!known.agent);
      const going = auth.connections().filter(goes);
      const node = state.session?.node;
      for (const connection of going) {
        if (connection.carrySpace && node) await node.carriers.remove(connection.carrySpace);
        if (connection.token && connection.access === 'write' && node) {
          const contactsSpace = await node.contacts.space();
          const covered =
            connection.scope === 'account'
              ? [...(await node.spaces.list()).filter((space) => space.writable).map((space) => space.id), ...(contactsSpace ? [contactsSpace] : [])]
              : connection.spaces.map((space) => space.id);
          for (const spaceId of covered) {
            // A space that is gone, or that this account no longer writes in, has nothing to revoke.
            await node.spaces.revoke(spaceId, connection.token).catch(() => {});
          }
          // A whole-account app could also add spaces to the account's list, and rename it.
          if (connection.scope === 'account') await node.account.revoke(connection.token).catch(() => {});
        }
      }
      writeConnections(auth.connections().filter((known) => !goes(known)));
    },

    staySignedIn: {
      choice: () => stay.choice(),
      setChoice: (choice) => stay.setChoice(choice),
      until: () => stay.until(),
    },

    async signOut() {
      await stay.forget();
      const leaving = state.session?.node;
      update({ stage: 'starting', session: null, entry: null, freshCode: null, podChoice: null, moved: null });
      await stopNode(leaving).catch(() => {});
      const place = state.place;
      update({ stage: place ? afterStorage(await refresh(place)) : 'welcome' });
    },
  };

  return auth;
}
