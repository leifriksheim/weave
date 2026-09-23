import { useCallback, useEffect, useState } from 'react';
import { isProtocolError, type AccountSummary, type ProtocolErrorCode } from '@p2p-web/protocol';
import {
  browserHome,
  chooseFolderHome,
  recallFolderHome,
  forgetFolderHome,
  listAccounts as listAccountsIn,
  lastAccountId,
  openAccount,
  createAccount,
  signInWithCode,
  signInWithPassword,
  signInWithPasskey,
  signInWithSnap,
  walletAvailable,
  addPasskeyHere,
  removeShortcut,
  renameAccount,
  linkAccountToSnap,
  moveNewAccountToFolder,
  folderStorageAvailable,
  signOut,
  type AccountEntry,
  type Home,
} from '../accounts';
import { getSessionSeed, getSessionSource, diagnosePasskeys, type Session } from '../protocol';
import {
  readPairingTicket,
  clearPairingTicket,
  collectFromDesktop,
  type PairingStage,
} from '../pairing';

/** A sign-in failure, in the shape the screens need to explain it. */
export interface AuthError {
  readonly message: string;
  /** What the user can do about it, when we know */
  readonly hint?: string;
  readonly code?: ProtocolErrorCode;
}

/** Turns a thrown value into something worth showing, ignoring user cancellation. */
function describeAuthError(error: unknown): AuthError | null {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return null; // the user dismissed a passkey or folder prompt
  }
  if (isProtocolError(error)) {
    return { message: error.message, code: error.code, ...(error.hint ? { hint: error.hint } : {}) };
  }
  return { message: error instanceof Error ? error.message : 'Sign-in failed' };
}

/**
 * Which screen the app is on.
 *
 * Three questions in order, and each one only asked when it has an answer worth
 * giving: who are you, keep this password, and where should the data live.
 *
 * Showing the new password is not a stage of its own — `freshCode` being set
 * already says the create screen is on its second step, and having both was a
 * second thing to keep in step with the first.
 */
export type Stage = 'starting' | 'signIn' | 'create' | 'chooseStorage' | 'ready';

/** Accounts, the ways into them, and where they live. */
export function useSession() {
  const [home, setHome] = useState<Home | null>(null);
  const [accounts, setAccounts] = useState<ReadonlyArray<AccountSummary>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entry, setEntry] = useState<AccountEntry | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [stage, setStage] = useState<Stage>('starting');
  const [freshCode, setFreshCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);

  const [pairing, setPairing] = useState(() => readPairingTicket());
  const [pairingStage, setPairingStage] = useState<PairingStage | null>(null);

  const folderAvailable = folderStorageAvailable();
  const walletHere = walletAvailable();

  /** Re-reads the accounts in a home and picks one to expand. */
  const refresh = useCallback(async (next: Home): Promise<ReadonlyArray<AccountSummary>> => {
    const listed = await listAccountsIn(next);
    setHome(next);
    setAccounts(listed);

    const remembered = lastAccountId();
    const chosen = listed.find((account) => account.id === remembered) ?? listed[0] ?? null;
    setSelectedId(chosen?.id ?? null);
    setEntry(chosen ? await openAccount(next, chosen.id) : null);

    return listed;
  }, []);

  // Where things were left. The folder permission check asks nothing of the
  // user — it only reports whether what was granted before is still live.
  useEffect(() => {
    void (async () => {
      try {
        const recalled = await recallFolderHome(false);
        const next = recalled ?? (await browserHome());
        const listed = await refresh(next);
        setStage(listed.length > 0 ? 'signIn' : 'create');
      } catch (e) {
        setError(describeAuthError(e));
        setStage('create');
      }
    })();
  }, [refresh]);

  /** Runs something that ends in a session. */
  const run = useCallback(async (start: () => Promise<Session>) => {
    setLoading(true);
    setError(null);
    try {
      setSession(await start());
      setStage('ready');
    } catch (e) {
      setError(describeAuthError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      setError(null);
      if (home) void openAccount(home, id).then(setEntry);
    },
    [home],
  );

  // ─── Ways in ─────────────────────────────────────────────────────────

  const withCode = useCallback(
    (code: string) => {
      if (!home) return;
      const expected = accounts.find((account) => account.id === selectedId);
      void run(() => signInWithCode(home, code, expected));
    },
    [home, accounts, selectedId, run],
  );

  const withPassword = useCallback(
    (password: string) => {
      if (home && entry) void run(() => signInWithPassword(home, entry, password));
    },
    [home, entry, run],
  );

  const withPasskey = useCallback(() => {
    if (home && entry) void run(() => signInWithPasskey(home, entry));
  }, [home, entry, run]);

  /**
   * Connects the wallet's Snap, installing it if this is the first time.
   *
   * A wallet account that is new here still has to be told where its lists
   * live, the same as one created by hand — it was skipping that and silently
   * landing in browser storage.
   */
  const withWallet = useCallback((did?: string) => {
    if (!home) return;

    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const before = (await listAccountsIn(home)).length;
        const started = await signInWithSnap(home, did);
        setSession(started);

        const isNew = (await listAccountsIn(home)).length > before;
        setStage(isNew && home.kind !== 'folder' ? 'chooseStorage' : 'ready');
      } catch (e) {
        setError(describeAuthError(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [home]);

  /** Renames the open account. */
  const rename = useCallback(
    async (name: string): Promise<boolean> => {
      if (!home || !session) return false;
      setError(null);
      try {
        const renamed = await renameAccount(home, session, name);
        setSession({ ...session, account: renamed });
        setAccounts(await listAccountsIn(home));
        return true;
      } catch (e) {
        setError(describeAuthError(e));
        return false;
      }
    },
    [home, session],
  );

  /** Hands the open account to the wallet, making it portable. */
  const linkToWallet = useCallback(async (): Promise<boolean> => {
    const seed = getSessionSeed();
    if (!home || !session || !seed) return false;

    setLoading(true);
    setError(null);
    try {
      const linked = await linkAccountToSnap(home, session, seed);
      setSession({ ...session, account: linked });
      setAccounts(await listAccountsIn(home));
      return true;
    } catch (e) {
      setError(describeAuthError(e));
      return false;
    } finally {
      setLoading(false);
    }
  }, [home, session]);

  // ─── Making one ──────────────────────────────────────────────────────

  const create = useCallback(
    (name: string) => {
      if (!home) return;
      setLoading(true);
      setError(null);
      void (async () => {
        try {
          const made = await createAccount(home, name);
          setSession(made.session);
          setFreshCode(made.code);
        } catch (e) {
          setError(describeAuthError(e));
        } finally {
          setLoading(false);
        }
      })();
    },
    [home],
  );

  /** The code has been saved; now decide where the lists go. */
  const codeSaved = useCallback(() => {
    setFreshCode(null);
    setStage('chooseStorage');
  }, []);

  const chooseFolder = useCallback(() => {
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const folder = await chooseFolderHome();
        const source = getSessionSource();

        // Mid-signup: the new account moves into the folder it just chose.
        // Keyed on the source rather than the seed, so an account whose key is
        // in a wallet takes this path too instead of being treated as a
        // stranger and asked to introduce itself again.
        if (session && source && stage === 'chooseStorage') {
          setSession(await moveNewAccountToFolder(folder, session, source));
          setHome(folder);
          setAccounts(await listAccountsIn(folder));
          setStage('ready');
          return;
        }

        const listed = await refresh(folder);
        setStage(listed.length > 0 ? 'signIn' : 'create');
      } catch (e) {
        setError(describeAuthError(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [session, stage, refresh]);

  const stayLocal = useCallback(() => setStage('ready'), []);

  const useBrowserAccounts = useCallback(() => {
    setLoading(true);
    void (async () => {
      try {
        const listed = await refresh(await forgetFolderHome());
        setStage(listed.length > 0 ? 'signIn' : 'create');
      } catch (e) {
        setError(describeAuthError(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  const startCreating = useCallback(() => {
    setError(null);
    setStage('create');
  }, []);

  const backToSignIn = useCallback(() => {
    setError(null);
    setStage('signIn');
  }, []);

  // ─── Shortcuts, once you are in ──────────────────────────────────────

  /**
   * Re-reads the open account's ways in.
   *
   * The entry was loaded before sign-in, so without this the menu keeps
   * offering to add a shortcut that now exists, and keeps hiding one that
   * has just been removed.
   */
  const refreshEntry = useCallback(async () => {
    if (home && session) setEntry(await openAccount(home, session.account.id));
  }, [home, session]);

  /** Runs a change to the open account's shortcuts, then re-reads them. */
  const changeShortcut = useCallback(
    async (apply: (seed: Uint8Array) => Promise<void>): Promise<boolean> => {
      const seed = getSessionSeed();
      if (!home || !session) return false;
      if (!seed) {
        setError({
          message: 'This account\u2019s key is held in your wallet.',
          hint: 'Shortcuts are stored beside the key, so they are managed where the key lives.',
        });
        return false;
      }

      setLoading(true);
      setError(null);
      try {
        await apply(seed);
        await refreshEntry();
        return true;
      } catch (e) {
        setError(describeAuthError(e));
        return false;
      } finally {
        setLoading(false);
      }
    },
    [home, session, refreshEntry],
  );

  /** Adds a passkey for this domain to the open account. */
  const addPasskey = useCallback(
    () => changeShortcut((seed) => addPasskeyHere(home!, session!, seed)),
    [changeShortcut, home, session],
  );

  /** Drops a shortcut. The account stays openable by its code. */
  const removeShortcutHere = useCallback(
    (kind: 'passkey' | 'passphrase') =>
      changeShortcut(async () => removeShortcut(home!, session!, kind)),
    [changeShortcut, home, session],
  );

  // The menu reads live state as soon as a session exists.
  useEffect(() => {
    void refreshEntry();
  }, [refreshEntry]);

  const leave = useCallback(() => {
    signOut();
    setSession(null);
    setEntry(null);
    if (home) void refresh(home).then((listed) => setStage(listed.length > 0 ? 'signIn' : 'create'));
  }, [home, refresh]);

  // ─── Arriving from a QR code ─────────────────────────────────────────

  const acceptPairing = useCallback(async () => {
    if (!pairing || !home) return;
    setLoading(true);
    setError(null);
    try {
      setSession(await signInWithCode(home, pairing.code));
      setStage('ready');
      clearPairingTicket();

      await collectFromDesktop(pairing, setPairingStage);
      setPairing(null);
    } catch (e) {
      setError(describeAuthError(e));
    } finally {
      setLoading(false);
    }
  }, [pairing, home]);

  const dismissPairing = useCallback(() => {
    clearPairingTicket();
    setPairing(null);
    setPairingStage(null);
  }, []);

  return {
    home,
    accounts,
    selectedId,
    entry,
    session,
    stage,
    freshCode,
    folderAvailable,
    walletHere,
    loading,
    error,
    pairing,
    pairingStage,
    select,
    withCode,
    withPassword,
    withPasskey,
    withWallet,
    create,
    codeSaved,
    chooseFolder,
    stayLocal,
    useBrowserAccounts,
    startCreating,
    backToSignIn,
    addPasskey,
    removeShortcut: removeShortcutHere,
    rename,
    linkToWallet,
    leave,
    acceptPairing,
    dismissPairing,
    diagnose: diagnosePasskeys,
  };
}
