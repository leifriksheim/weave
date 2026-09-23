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
 * All of that is the node's job now (`createNode`): the session key, the
 * hourly renewal, the spaces and their sync. What stays here is which account
 * is open and where its data lives. Accounts and how to open them live in
 * `accounts.ts`; a list as the screens see it in `space-session.ts`.
 */
import {
  createIdentityManager,
  createLocalRootSigner,
  createNode,
  validateDelegationChain,
  publicKeyToDid,
  deriveVaultKey,
  P256_MULTICODEC,
  inspectPasskeyPrf,
  type RootSigner,
  type P2PNode,
  type UCANToken,
  type PasskeyDiagnostics,
  type AccountSummary,
  type DirectoryHandleLike,
} from '@p2p-web/protocol';
import { storesFor } from './storage-backend';
import { relayUrls } from './relay';
import { TODO_COLLECTION } from './todos';

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

/** An open account: who it is, and the node doing its work */
export interface Session {
  readonly rootDid: string;
  /** Whether the root key is in this tab or somewhere that will not hand it over */
  readonly custody: 'local' | 'remote';
  readonly account: AccountSummary;
  /** The session key's DID — what peers see */
  readonly sessionDid: string;
  readonly node: P2PNode;
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
  void _session?.node.close();
  _session = null;
  _seed = null;
  _source = null;
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
  folder?: { directory: DirectoryHandleLike },
): Promise<Session> {
  // A restart — moving an account into a folder, say — must not leave the old
  // node syncing behind the new one.
  await _session?.node.close();

  const node = await createNode({
    signer: source.signer,
    stores: storesFor(account, folder && source.vaultKey ? { directory: folder.directory, vaultKey: source.vaultKey } : undefined),
    collections: [TODO_COLLECTION],
    network: { relays: relayUrls() },
  });

  _seed = source.seed;
  _source = source;
  _session = Object.freeze({
    rootDid: source.rootDid,
    custody: source.signer.custody,
    account,
    sessionDid: node.sessionDid,
    node,
  });

  return _session;
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
  const { node } = requireSession();
  const provider = createIdentityManager().getProvider();

  const guestKeys = await provider.generateKeyPair();
  const guestDid = publicKeyToDid(await provider.exportPublicKey(guestKeys.publicKey), P256_MULTICODEC);

  const { token, proofs } = await node.delegate({
    audience: guestDid,
    capabilities: [{ with: `space:${spaceId}`, can: 'expression/read' }],
  });

  const chain = await validateDelegationChain(token.encoded, proofs, provider);
  return { guestDid, token, chainValid: chain.valid, ...(chain.reason ? { reason: chain.reason } : {}) };
}
