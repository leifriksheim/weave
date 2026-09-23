/**
 * The session: an identity, and the short-lived key that acts for it.
 *
 * Nothing here knows how you signed in. Something upstream produced a seed —
 * from a code, a password, a passkey — and hands it over; this turns that into
 * a working session and gets out of the way.
 *
 * The important part is that **the identity key never signs a todo.** Signing in
 * generates a throwaway keypair in memory, and the identity signs one permission
 * note saying that key may write on its behalf for the next hour. Everything
 * after that is signed by the session key. So unlocking happens once, not once
 * per write — which is what makes a wallet, a passkey or a password prompt
 * tolerable as a way in.
 *
 * Accounts and how to open them live in `accounts.ts`. Per-space storage, sync
 * and networking live in `space-session.ts`.
 */
import {
  createIdentityManager,
  createLocalRootSigner,
  createSigner,
  createSpaceManager,
  createIndexedDBAdapter,
  validateDelegationChain,
  delegateCapabilities,
  publicKeyToDid,
  deriveVaultKey,
  P256_MULTICODEC,
  inspectPasskeyPrf,
  type RootSigner,
  type Signer,
  type CryptoProvider,
  type SpaceManager,
  type UCANToken,
  type Capability,
  type PasskeyDiagnostics,
  type AccountSummary,
} from '@p2p-web/protocol';
import { openStore, useFolderBackend, useLocalBackend } from './storage-backend';

/** Everything a session key is allowed to do, across every space it holds */
export const SESSION_CAPABILITY: Capability = { with: '*', can: 'expression/*' };

/** What writing a todo into a given space requires */
export const writeCapability = (spaceId: string): Capability => ({
  with: `space:${spaceId}`,
  can: 'expression/write',
});

/** Sessions live an hour, like the UCAN that authorizes them */
const SESSION_TTL_SECONDS = 3600;

/**
 * Where a session's root key is, and what it can do for us.
 *
 * The seed is present when this page unlocked it, and absent when something
 * else holds it — a Snap, an extension. Everything that needs the seed rather
 * than a signature has to cope with `null`, which is the point: it makes the
 * places that reach for the raw key obvious.
 */
export interface SessionSource {
  readonly rootDid: string;
  readonly signer: RootSigner;
  /** Encrypts this account's registry at rest, when there is a folder */
  readonly vaultKey: CryptoKey | null;
  /** The seed, when this page is the one holding it */
  readonly seed: Uint8Array | null;
}

/**
 * Builds a source for a seed this page has unlocked.
 * @param seed The account seed
 * @returns A local source, key and all
 */
export async function localSource(seed: Uint8Array): Promise<SessionSource> {
  const manager = createIdentityManager();
  const identity = await manager.fromSeed(seed);

  return {
    rootDid: identity.did,
    signer: createLocalRootSigner(identity, manager.getProvider()),
    vaultKey: await deriveVaultKey(seed),
    seed,
  };
}

/** A root identity plus the delegated key that actually signs expressions */
export interface Session {
  readonly rootDid: string;
  /** Whether the root key is in this tab or somewhere that will not hand it over */
  readonly custody: 'local' | 'remote';
  readonly account: AccountSummary;
  readonly sessionDid: string;
  readonly sessionKey: CryptoKey;
  readonly ucan: UCANToken;
  readonly provider: CryptoProvider;
  readonly signer: Signer;
  /** Registry of the spaces this identity knows about */
  readonly spaces: SpaceManager;
}

let _session: Session | null = null;

/**
 * The seed behind the current session, when this page holds it.
 *
 * Kept in memory so a second way in can be added later — "also unlock with
 * Touch ID here" means encrypting this same seed under a new key. It is never
 * written anywhere, and it goes when the tab does.
 *
 * Null when something else has custody. A Snap will sign for you but will not
 * hand the seed over, so anything that wants the raw bytes has to ask it and
 * accept being refused.
 */
let _seed: Uint8Array | null = null;

/**
 * What produced the current session.
 *
 * Kept so a session can be restarted — moving an account into a folder, say —
 * without knowing how it was unlocked. Reaching for the seed instead only works
 * for accounts this page holds the key to, which is exactly the coupling that
 * broke wallet accounts.
 */
let _source: SessionSource | null = null;

/** The seed behind this session, or null before sign-in. */
export function getSessionSeed(): Uint8Array | null {
  return _seed;
}

/** What unlocked this session, whoever holds the key. */
export function getSessionSource(): SessionSource | null {
  return _source;
}

/** The current session, or null before sign-in. */
export function getSession(): Session | null {
  return _session;
}

/** The current session, or a thrown error if there is none. */
export function requireSession(): Session {
  if (!_session) throw new Error('Not signed in — start a session first');
  return _session;
}

/** Ends the session. The account and its data stay where they are. */
export function endSession(): void {
  _session = null;
  _seed = null;
  _source = null;
  useLocalBackend();
}

/**
 * Brings up a session for an unlocked account.
 *
 * @param account Which account this is
 * @param seed Its seed, already recovered by whatever unlocked it
 * @param folder The data folder, when the account lives in one
 * @returns The live session
 */
export async function startSession(
  account: AccountSummary,
  source: SessionSource,
  folder?: { directory: Parameters<typeof useFolderBackend>[0] },
): Promise<Session> {
  const provider = createIdentityManager().getProvider();

  // The backend has to be pointed at the right place before anything opens a
  // store, or the registry lands somewhere else entirely.
  if (folder && source.vaultKey) {
    useFolderBackend(folder.directory, source.vaultKey);
  } else {
    useLocalBackend();
  }

  const sessionKeys = await provider.generateKeyPair();
  const sessionDid = publicKeyToDid(await provider.exportPublicKey(sessionKeys.publicKey), P256_MULTICODEC);

  // The one thing the root key is for. When it lives in a Snap this is a round
  // trip into the extension; the page is none the wiser either way.
  const ucan = await source.signer.delegate({
    audience: sessionDid,
    capabilities: [SESSION_CAPABILITY],
    expiration: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });

  const spaces = createSpaceManager(await openStore(`${account.dataPath}/registry`, { seal: true }));

  _seed = source.seed;
  _source = source;
  _session = Object.freeze({
    rootDid: source.rootDid,
    custody: source.signer.custody,
    account,
    sessionDid,
    sessionKey: sessionKeys.privateKey,
    ucan,
    provider,
    signer: createSigner(provider),
    spaces,
  });

  return _session;
}

/** Where the open session's spaces live, for opening one of them. */
export function spacePath(spaceId: string): string {
  return `${requireSession().account.dataPath}/spaces/${spaceId}`;
}

/**
 * Asks the browser what it actually does with the PRF extension.
 * @param credentialId Test this credential instead of creating a throwaway one
 */
export async function diagnosePasskeys(credentialId?: string): Promise<PasskeyDiagnostics> {
  return inspectPasskeyPrf({
    rpName: 'P2P Todos',
    userName: 'PRF diagnostic',
    ...(credentialId ? { credentialId } : {}),
  });
}

// ─── Sub-delegation demo ───────────────────────────────────────────────

/** A read-only capability handed down from the session key to a guest key */
export interface GuestDelegation {
  readonly guestDid: string;
  readonly token: UCANToken;
  /** Whether root → session → guest validates as a chain */
  readonly chainValid: boolean;
  readonly reason?: string;
}

/**
 * Attenuates the session's capability down to read-only and hands it to a fresh
 * key, then validates the resulting two-link chain back to the root identity.
 */
export async function delegateToGuest(spaceId: string): Promise<GuestDelegation> {
  const session = requireSession();

  const guestKeys = await session.provider.generateKeyPair();
  const guestDid = publicKeyToDid(
    await session.provider.exportPublicKey(guestKeys.publicKey),
    P256_MULTICODEC,
  );

  const token = await delegateCapabilities(
    {
      parent: session.ucan,
      issuer: { did: session.sessionDid, privateKey: session.sessionKey },
      audience: guestDid,
      capabilities: [{ with: `space:${spaceId}`, can: 'expression/read' }],
    },
    session.provider,
  );

  const chain = await validateDelegationChain(token.encoded, [session.ucan.encoded], session.provider);
  return { guestDid, token, chainValid: chain.valid, ...(chain.reason ? { reason: chain.reason } : {}) };
}

// Re-exported so callers do not need a second import for the common case.
export { createIndexedDBAdapter };
