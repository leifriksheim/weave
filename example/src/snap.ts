/**
 * Talking to the identity Snap.
 *
 * A Snap runs inside MetaMask rather than inside this origin, which makes it
 * the one place a browser will let an identity live that every app can reach.
 * So this is the only way in that needs nothing stored and no handoff: open the
 * app on a domain it has never seen, connect, and you are yourself.
 *
 * The page never sees the seed. It generates a session key like always and asks
 * the Snap to sign a permission note for it — the same delegation the local
 * path does, with the signature happening somewhere this code cannot reach.
 */
import {
  base64UrlDecode,
  parseUCAN,
  type Capability,
  type RootSigner,
  type UCANToken,
} from '@p2p-web/protocol';
import type { SessionSource } from './protocol';

/** The published Snap. Point at a local build while developing. */
export const SNAP_ID: string =
  import.meta.env.VITE_SNAP_ID ?? 'npm:@p2p-web/identity-snap';

/** The minimum of EIP-1193 this needs. */
interface Ethereum {
  isMetaMask?: boolean;
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/** How a wallet announces itself under EIP-6963 */
interface AnnouncedProvider {
  readonly info: { readonly uuid: string; readonly name: string; readonly rdns: string };
  readonly provider: Ethereum;
}

/** Flask and release MetaMask, as they identify themselves. */
const FLASK_RDNS = 'io.metamask.flask';

let announced: AnnouncedProvider[] = [];

/**
 * Collects the wallets in this browser.
 *
 * `window.ethereum` is a single slot, so two wallets — or MetaMask and Flask in
 * one profile — overwrite each other and whichever injected last wins. EIP-6963
 * exists because of that: every wallet announces itself separately, and the page
 * picks. Without this, "install Flask" is advice that appears not to work.
 */
export function discoverWallets(): void {
  const collect = (event: Event) => {
    const detail = (event as CustomEvent<AnnouncedProvider>).detail;
    if (!detail?.info?.rdns) return;
    if (!announced.some((entry) => entry.info.uuid === detail.info.uuid)) {
      announced = [...announced, detail];
    }
  };

  globalThis.addEventListener('eip6963:announceProvider', collect);
  globalThis.dispatchEvent(new Event('eip6963:requestProvider'));
}

/** Whether a wallet identifies itself as Flask. */
function isFlask(entry: AnnouncedProvider): boolean {
  return entry.info.rdns === FLASK_RDNS || /flask/i.test(entry.info.name);
}

/**
 * The wallet to talk to.
 *
 * Flask wins whenever it is installed. Release MetaMask only installs Snaps on
 * its allowlist — getting onto which means submitting for review — and it
 * refuses a local URL outright, so for anything not yet allowlisted Flask is
 * the only build that can do the job at all. Preferring it is the difference
 * between working and a mystifying error.
 */
function ethereum(): Ethereum | null {
  const flask = announced.find(isFlask);
  if (flask) return flask.provider;

  return announced[0]?.provider ?? (globalThis as { ethereum?: Ethereum }).ethereum ?? null;
}

/** Whether there is a wallet here at all. */
export function walletPresent(): boolean {
  return ethereum() !== null;
}

/** Whether a Flask build is installed, which is what local Snaps need. */
export function flaskPresent(): boolean {
  return announced.some(isFlask);
}

/** What the Snap says about the account it holds */
export interface SnapAccount {
  readonly did: string;
  /** Derived from the wallet's recovery phrase, or imported from a code */
  readonly kind: 'derived' | 'imported';
}

/**
 * Asks MetaMask to install or connect the Snap.
 *
 * Safe to call more than once: MetaMask only prompts when something actually
 * needs granting.
 *
 * @returns The account it holds
 */
export async function connectSnap(): Promise<SnapAccount> {
  const provider = ethereum();
  if (!provider) {
    throw new Error('No wallet found in this browser.');
  }

  // Worth saying before trying. MetaMask's own refusals — "fetching local snaps
  // is disabled", "the snap is not on the allowlist" — name neither the cause
  // nor what to do, and both have the same fix.
  if (!flaskPresent()) {
    throw new Error(
      'This Snap is not on MetaMask\u2019s allowlist, and the release build only installs ' +
        'Snaps that are. Use MetaMask Flask from metamask.io/flask, which installs any ' +
        'Snap — the release build needs the Snap submitted for review first.',
    );
  }

  try {
    await provider.request({ method: 'wallet_requestSnaps', params: { [SNAP_ID]: {} } });
  } catch (error) {
    throw new Error(describeSnapFailure(error), { cause: error });
  }

  return invoke<SnapAccount>('getAccount');
}

/**
 * Turns a wallet rejection into something that names the actual problem.
 *
 * These failures look alike from the outside and have completely different
 * fixes — a missing package, a wallet that cannot run Snaps at all, and someone
 * simply saying no. Reporting the wrong one sends people to fix the wrong
 * thing.
 *
 * @param error Whatever the wallet threw
 * @returns A sentence worth showing
 */
function describeSnapFailure(error: unknown): string {
  const code = (error as { code?: number })?.code;
  const message = (error as { message?: string })?.message ?? '';

  // The wallet has no such method: not MetaMask, or a version before Snaps.
  if (code === -32601 || /unsupported method|method not found/i.test(message)) {
    return (
      'This wallet cannot install Snaps. MetaMask 11 or later supports them; ' +
      'most other wallets do not yet.'
    );
  }

  if (code === 4001 || /user rejected|denied/i.test(message)) {
    return 'The request was declined in the wallet.';
  }

  // The two ways release MetaMask says no. Neither names the cause, and both
  // have the same fix.
  if (/allowlist/i.test(message)) {
    return (
      'Release MetaMask only installs Snaps on its allowlist, which means submitting ' +
      'this one for review. Until then use MetaMask Flask, which installs any Snap.'
    );
  }

  if (/local snaps/i.test(message)) {
    return (
      'This is release MetaMask, which only installs Snaps from npm. Loading one from ' +
      'a local address needs MetaMask Flask — install it from metamask.io/flask and reload.'
    );
  }

  // The usual one during development: the package is not on npm, because it has
  // not been published — and does not need to be.
  if (/404|not found|failed to fetch/i.test(message)) {
    return SNAP_ID.startsWith('local:')
      ? `Could not reach the Snap at ${SNAP_ID.slice('local:'.length)}. Is \`npm run serve\` ` +
          'running in the snap directory, and are you using MetaMask Flask?'
      : `${SNAP_ID} is not published to npm. To run it locally, serve the snap directory ` +
          'and set VITE_SNAP_ID=local:http://localhost:8080 — that needs MetaMask Flask, ' +
          'since ordinary MetaMask only installs Snaps from npm.';
  }

  return message || 'The wallet refused the request.';
}

/** Calls a method on the Snap. */
async function invoke<T>(method: string, params?: unknown): Promise<T> {
  const provider = ethereum();
  if (!provider) throw new Error('No wallet found in this browser.');

  return (await provider.request({
    method: 'wallet_invokeSnap',
    params: { snapId: SNAP_ID, request: { method, ...(params ? { params } : {}) } },
  })) as T;
}

/** The account the Snap holds, without prompting to install it. */
export async function snapAccount(): Promise<SnapAccount | null> {
  try {
    return await invoke<SnapAccount>('getAccount');
  } catch {
    return null;
  }
}

/**
 * Every account the wallet holds, and which is active.
 *
 * A wallet holds several keys. Asking which one it is acting as — rather than
 * assuming there is only one — is the difference between signing in as the
 * account you clicked and signing in as whichever the wallet saw last.
 */
export async function listSnapAccounts(): Promise<{
  accounts: ReadonlyArray<SnapAccount>;
  selected: string;
}> {
  return invoke<{ accounts: ReadonlyArray<SnapAccount>; selected: string }>('listAccounts');
}

/**
 * Tells the wallet which of its accounts to act as.
 * @param did The account to switch to
 * @returns What it is acting as now
 */
export async function selectSnapAccount(did: string): Promise<SnapAccount> {
  return invoke<SnapAccount>('selectAccount', { did });
}

/**
 * A root signer backed by the Snap.
 *
 * Every delegation is a round trip into the extension. The seed stays there,
 * which is the whole point — so this signer can prove who you are and cannot
 * be persuaded to reveal it.
 */
export function createSnapRootSigner(did: string): RootSigner {
  return Object.freeze({
    did,
    custody: 'remote' as const,

    async delegate(params: {
      audience: string;
      capabilities: ReadonlyArray<Capability>;
      expiration: number;
    }): Promise<UCANToken> {
      const result = await invoke<{ did: string; token: string; cid: string }>('signDelegation', {
        audience: params.audience,
        capabilities: params.capabilities,
        expiration: params.expiration,
      });

      const parsed = parseUCAN(result.token);

      // The Snap decides the real expiry — a site asking for a year gets an
      // hour — so the token is read back rather than assumed.
      if (parsed.payload.aud !== params.audience) {
        throw new Error('The Snap signed a delegation for a different key.');
      }
      if (parsed.payload.iss !== did) {
        throw new Error('The Snap signed as a different identity than it reported.');
      }

      return Object.freeze({
        header: parsed.header,
        payload: parsed.payload,
        signature: result.token.split('.')[2] ?? '',
        encoded: result.token,
        cid: result.cid,
      });
    },
  });
}

/**
 * Everything a session needs, with the key staying in the wallet.
 *
 * @param account The account the Snap holds
 * @returns A source whose seed is deliberately absent
 */
export async function snapSource(account: SnapAccount): Promise<SessionSource> {
  const { key } = await invoke<{ key: string }>('getVaultKey');

  return {
    rootDid: account.did,
    signer: createSnapRootSigner(account.did),
    // Not the seed: a key derived from it, and useless without the data it
    // belongs to. A site trusted to act as this identity cannot read its own
    // folder without it.
    vaultKey: await globalThis.crypto.subtle.importKey(
      'raw',
      base64UrlDecode(key) as BufferSource,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    ),
    seed: null,
  };
}

/**
 * Asks the Snap to show the account code.
 *
 * Prompts inside MetaMask, so the answer is a decision the user made in a
 * window this page does not control.
 */
export async function exportSnapCode(): Promise<string> {
  const { code } = await invoke<{ code: string }>('exportCode');
  return code;
}

/**
 * Hands an existing account to the wallet.
 *
 * @param code The account's password, when this app already holds it. Omitted,
 *   the user types it into MetaMask's own window instead. Either way MetaMask
 *   confirms, showing which identity the wallet would end up holding.
 */
export async function importIntoSnap(code?: string): Promise<SnapAccount> {
  return invoke<SnapAccount>('importAccount', code ? { code } : undefined);
}
