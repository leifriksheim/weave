import { useCallback, useEffect, useState } from 'react';
import { isProtocolError, type AccountSummary, type ProtocolErrorCode } from 'weave-protocol';
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
  resumeSession,
  walletAvailable,
  addPasskeyHere,
  removeShortcut,
  renameAccount,
  linkAccountToSnap,
  bringAccountToFolder,
  forgetBrowserCopy,
  adoptAccountName,
  type BroughtToFolder,
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
 * Onboarding asks two questions, in this order: where should Weave keep your
 * data — a pod (a folder you choose) or just this browser — and do you already
 * have a Weave account. Where comes first because it decides which accounts
 * there are to sign in to: a pod may already hold yours.
 *
 * `where` is asked once per browser; after that the choice is remembered, and
 * a pod is reopened without asking.
 *
 * Showing the new password is not a stage of its own — `freshCode` being set
 * already says the create screen is on its second step.
 */
export type Stage = 'starting' | 'where' | 'welcome' | 'signIn' | 'create' | 'ready';

/** Remembers that this browser chose to keep data in the browser, so `where` is not asked again */
const BROWSER_CHOSEN = 'weave.storage-choice';
const choseBrowser = () => {
  try {
    return globalThis.localStorage.getItem(BROWSER_CHOSEN) === 'browser';
  } catch {
    return false;
  }
};
const rememberBrowser = () => {
  try {
    globalThis.localStorage.setItem(BROWSER_CHOSEN, 'browser');
  } catch {
    /* private mode: it will simply ask again */
  }
};

/** After storage is settled: accounts to sign in to, or the have-an-account question */
const afterStorage = (accounts: ReadonlyArray<unknown>): Stage => (accounts.length > 0 ? 'signIn' : 'welcome');

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
  // MetaMask sign-in is parked for now; the Snap and its code stay in place.
  // const walletHere = walletAvailable();
  const walletHere = false;
  void walletAvailable;

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

        // Told to stay signed in on this device, and still in date: straight in.
        if (listed.length > 0) {
          const resumed = await resumeSession(next).catch(() => null);
          if (resumed) {
            setSession(resumed);
            setStage('ready');
            return;
          }
        }

        // Nothing here yet and the storage question never answered: ask it first.
        const undecided = !recalled && listed.length === 0 && folderAvailable && !choseBrowser();
        setStage(undecided ? 'where' : afterStorage(listed));
      } catch (e) {
        setError(describeAuthError(e));
        setStage('welcome');
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

        void before;
        setStage('ready');
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

  /** The code has been saved. Where the data lives was settled before the account existed. */
  const codeSaved = useCallback(() => {
    setFreshCode(null);
    setStage('ready');
  }, []);

  const chooseFolder = useCallback(() => {
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const from = home;
        const folder = await chooseFolderHome();
        const source = getSessionSource();

        // Signed in — mid-signup or long after: the open account comes with
        // it, moved if the folder has never seen it and merged if it has.
        // Keyed on the source rather than the seed, so an account whose key is
        // in a wallet takes this path too.
        if (session && source && from && from.directory !== folder.directory) {
          const brought = await bringAccountToFolder(from, folder, session, source);
          setSession(brought.session);
          setHome(folder);
          setAccounts(await listAccountsIn(folder));
          setMoved(from.kind === 'browser' ? brought : null);
          setStage('ready');
          return;
        }

        const listed = await refresh(folder);
        setStage(afterStorage(listed));
      } catch (e) {
        setError(describeAuthError(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [session, stage, refresh, home]);

  /** What the last move into a folder did, while its notice is showing */
  const [moved, setMoved] = useState<BroughtToFolder | null>(null);

  /** Removes the copy the browser kept after a move into a folder. */
  const forgetBrowser = useCallback(async () => {
    if (!session) return;
    await forgetBrowserCopy(session.account);
    setMoved(null);
  }, [session]);

  // The account's name follows it: a rename on another device or app arrives
  // through the account registry and is taken here too.
  useEffect(() => {
    if (!session || !home) return;
    let live = true;
    const adopt = async () => {
      const profile = await session.node.account.profile().catch(() => null);
      if (!live || !profile || profile.name === session.account.name) return;
      const renamed = await adoptAccountName(home, session, profile.name);
      if (!live) return;
      setSession({ ...session, account: renamed });
      setAccounts(await listAccountsIn(home));
    };
    void adopt();
    const stop = session.node.subscribe((event) => {
      if (event.type === 'account') void adopt();
    });
    return () => {
      live = false;
      stop();
    };
  }, [session, home]);

  /** Keep data in this browser. */
  const stayLocal = useCallback(() => {
    rememberBrowser();
    setError(null);
    setStage(afterStorage(accounts));
  }, [accounts]);

  /** Back to the storage question, from the account question. */
  const changeStorage = useCallback(() => {
    setError(null);
    setStage('where');
  }, []);

  const useBrowserAccounts = useCallback(() => {
    setLoading(true);
    void (async () => {
      try {
        rememberBrowser();
        const listed = await refresh(await forgetFolderHome());
        setStage(afterStorage(listed));
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

  const backToWelcome = useCallback(() => {
    setError(null);
    setStage(afterStorage(accounts));
  }, [accounts]);

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
    if (home) void refresh(home).then((listed) => setStage(afterStorage(listed)));
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
    moved,
    forgetBrowser,
    dismissMoved: () => setMoved(null),
    stayLocal,
    changeStorage,
    useBrowserAccounts,
    startCreating,
    backToSignIn,
    backToWelcome,
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
