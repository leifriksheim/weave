/**
 * A MetaMask Snap that holds a Weave identity.
 *
 * The point is what it refuses to do: **the seed never leaves.** An app asks for
 * a short-lived permission note for a key it just generated, and gets back a
 * signed token. It never sees the identity key, so connecting an app is not
 * handing it your account — and disconnecting one actually means something.
 *
 * Why here rather than in the page: a Snap runs inside the extension, not inside
 * an origin. That makes it the one place a browser will let an identity live
 * that every app can reach. Same idea as an "identity origin", except it is on
 * the user's own machine, so nobody's server becomes load-bearing.
 *
 * ## Two kinds of account, and why the derivation matters
 *
 * - **Derived** — the seed comes from the wallet's own recovery phrase, at the
 *   BIP-32 path below. Nothing is stored, and it is the same on every device
 *   where that phrase is restored.
 * - **Imported** — an existing account, pasted in once and kept in Snap state.
 *
 * The derived kind deliberately uses `snap_getBip32Entropy` rather than the
 * friendlier `snap_getEntropy`. `snap_getEntropy` folds in the Snap's own id,
 * so nothing outside this Snap could ever reproduce it — which would make the
 * Snap load-bearing for the identity, the exact thing this design avoids. A
 * BIP-32 path is reproducible by anyone holding the recovery phrase with any
 * standard library, so the Snap stays a convenience.
 *
 * **The path is part of the spec, not an implementation detail:**
 *
 *     m / 44' / 7343' / 0' / 0 / 0        (secp256k1)
 *
 * Those bytes are entropy, not a key — they are run through HKDF to a P-256
 * key, the same as every other way into an account.
 */

import { deriveKeyPair } from '../../src/identity/keys.js';
import { createP256Provider } from '../../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../../src/identity/did.js';
import { issueUCAN, type Capability } from '../../src/identity/ucan.js';
import { deriveVaultKeyBytes } from '../../src/identity/account-vault.js';
import {
  recoveryCodeToSeed,
  seedToRecoveryCode,
  isValidRecoveryCode,
} from '../../src/identity/recovery-code.js';
import { base64UrlEncode, utf8Encode, concatBytes } from '../../src/utils/encoding.js';

/** The derivation path, documented so an identity survives this Snap. */
const BIP32_PATH = ['m', "44'", "7343'", "0'", '0', '0'] as const;

/** Separates the wallet-derived entropy from anything else using the same path. */
const DERIVATION_INFO = utf8Encode('weave-identity-v1');

/** Nothing gets a permission note for longer than this, whatever it asks for. */
const MAX_SESSION_SECONDS = 3600;

const provider = createP256Provider();

/** What the Snap keeps between calls */
interface SnapState {
  /**
   * Accounts pasted in, keyed by DID.
   *
   * The account derived from the recovery phrase is not in here — it needs no
   * storage and is always available, so it is added to any listing rather than
   * kept.
   */
  readonly imported?: Record<string, { readonly code: string; readonly addedAt: string }>;
  /** Which account is being acted as. Absent means the derived one. */
  readonly selected?: string;
  /** Sites the user let act as an account, keyed `origin did` (`consentKey`) */
  readonly known?: Record<string, string>;
}

async function readState(): Promise<SnapState> {
  const state = (await snap.request({
    method: 'snap_manageState',
    params: { operation: 'get' },
  })) as SnapState | null;
  return state ?? {};
}

async function writeState(state: SnapState): Promise<void> {
  await snap.request({
    method: 'snap_manageState',
    params: { operation: 'update', newState: state },
  });
}

/** Asks the user something, in MetaMask's own window rather than the page's. */
async function confirm(heading: string, body: string): Promise<boolean> {
  return (await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: {
        type: 'panel',
        children: [
          { type: 'heading', value: heading },
          { type: 'text', value: body },
        ],
      },
    },
  })) as boolean;
}

/** Asks the user to type something. */
async function prompt(heading: string, body: string, placeholder: string): Promise<string | null> {
  return (await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'prompt',
      content: {
        type: 'panel',
        children: [
          { type: 'heading', value: heading },
          { type: 'text', value: body },
        ],
      },
      placeholder,
    },
  })) as string | null;
}

/** The seed the wallet's recovery phrase produces, which needs no storage. */
async function derivedSeed(): Promise<Uint8Array> {
  const node = (await snap.request({
    method: 'snap_getBip32Entropy',
    params: { path: BIP32_PATH, curve: 'secp256k1' },
  })) as { privateKey?: string; chainCode?: string };

  if (!node?.privateKey) {
    throw new Error('MetaMask returned no key material for the identity path.');
  }

  // The node's private key is entropy here, not a key: it is mixed with a
  // version label and cut to the 16 bytes an account seed is, so the identity
  // is a P-256 key of this protocol's own rather than a reused wallet key.
  const material = concatBytes(hexToBytes(node.privateKey), DERIVATION_INFO);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material as BufferSource));
  return digest.slice(0, 16);
}

/**
 * The seed for the account currently being acted as.
 *
 * A wallet holds several keys and people expect that, so this one holds several
 * accounts: the one its recovery phrase derives, plus any that were imported.
 * Which is active is remembered, because a site asking "who am I" must not get
 * a different answer than the one the person just chose.
 *
 * @returns 16 bytes, and where they came from
 */
async function accountSeed(): Promise<{ seed: Uint8Array; kind: 'derived' | 'imported' }> {
  const state = await readState();
  const chosen = state.selected ? state.imported?.[state.selected] : undefined;

  if (chosen && isValidRecoveryCode(chosen.code)) {
    return { seed: recoveryCodeToSeed(chosen.code), kind: 'imported' };
  }

  return { seed: await derivedSeed(), kind: 'derived' };
}

/** The DID a seed produces. */
async function didFor(seed: Uint8Array): Promise<string> {
  const keyPair = await deriveKeyPair(seed, provider);
  return publicKeyToDid(keyPair.publicKeyBytes, P256_MULTICODEC);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** The identity the current seed produces. */
async function identity() {
  const { seed, kind } = await accountSeed();
  const keyPair = await deriveKeyPair(seed, provider);
  return {
    seed,
    kind,
    did: publicKeyToDid(keyPair.publicKeyBytes, P256_MULTICODEC),
    privateKey: keyPair.privateKey,
  };
}

/** Where a site's consent to act as one account is remembered */
const consentKey = (origin: string, did: string) => `${origin} ${did}`;

/**
 * Handles a call from a site.
 *
 * Every method that touches the key either asks the user first or hands back
 * something that is useless on its own.
 */
export async function onRpcRequest({ origin, request }: OnRpcRequestArgs): Promise<unknown> {
  switch (request.method) {
    /** Who am I? Public, so it needs no confirmation. */
    case 'getAccount': {
      const me = await identity();
      return { did: me.did, kind: me.kind };
    }

    /**
     * Every account this wallet holds.
     *
     * The derived one is always present; imported ones are additions. A site
     * with several accounts of its own needs this to know which of them the
     * wallet can actually open, rather than assuming there is only one.
     */
    case 'listAccounts': {
      const state = await readState();
      const derived = await didFor(await derivedSeed());

      const imported = Object.entries(state.imported ?? {}).map(([did, entry]) => ({
        did,
        kind: 'imported' as const,
        addedAt: entry.addedAt,
      }));

      return {
        accounts: [{ did: derived, kind: 'derived' as const }, ...imported],
        selected: state.selected ?? derived,
      };
    }

    /**
     * Chooses which account to act as.
     *
     * No dialog: it changes nothing about what any site may do, and the site
     * asking has to name an account the wallet already holds. Acting as it
     * still goes through the delegation prompt.
     */
    case 'selectAccount': {
      const wanted = (request.params as { did?: string } | undefined)?.did;
      if (!wanted) throw new Error('Which account? A DID is needed.');

      const state = await readState();
      const derived = await didFor(await derivedSeed());

      if (wanted === derived) {
        const { selected: _cleared, ...rest } = state;
        await snap.request({
          method: 'snap_manageState',
          params: { operation: 'update', newState: rest },
        });
      } else {
        if (!state.imported?.[wanted]) {
          throw new Error('This wallet does not hold that account.');
        }
        await writeState({ ...state, selected: wanted });
      }

      const me = await identity();
      return { did: me.did, kind: me.kind };
    }

    /**
     * Signs a permission note for a key the site just generated.
     *
     * This is the only reason an app needs the identity, and the note is
     * narrow and expiring — so approving it is nothing like handing over an
     * account. The first time a site asks, the user is told what it is asking
     * for; after that the note's own expiry is the limit.
     */
    case 'signDelegation': {
      const params = request.params as {
        audience?: string;
        capabilities?: ReadonlyArray<Capability>;
        expiration?: number;
      };

      if (!params?.audience || !Array.isArray(params.capabilities)) {
        throw new Error('A delegation needs an audience and a list of capabilities.');
      }

      const now = Math.floor(Date.now() / 1000);
      // The site asks for an expiry; the Snap decides. A site that asks for a
      // year gets an hour.
      const expiration = Math.min(params.expiration ?? now + MAX_SESSION_SECONDS, now + MAX_SESSION_SECONDS);

      // Consent is per site *and* per account: approving a site for one
      // account says nothing about another it can switch to.
      const me = await identity();
      const state = await readState();
      const consent = consentKey(origin, me.did);
      if (!state.known?.[consent]) {
        const granted = await confirm(
          'Let this site act as you?',
          `${origin} is asking to sign as ${me.did} for up to one hour at a time.\n\n` +
            `It is asking for: ${params.capabilities.map((c) => `${c.can} on ${c.with}`).join(', ')}\n\n` +
            'Your key stays in MetaMask. The site only ever gets a note that expires.',
        );
        if (!granted) throw new Error('The user declined.');
        await writeState({ ...state, known: { ...state.known, [consent]: new Date().toISOString() } });
      }

      const token = await issueUCAN(
        {
          issuer: { did: me.did, privateKey: me.privateKey },
          audience: params.audience,
          capabilities: params.capabilities,
          expiration,
        },
        provider,
      );

      return { did: me.did, token: token.encoded, cid: token.cid, expiration };
    }

    /**
     * The key that encrypts this account's data at rest.
     *
     * Not the seed, but it opens the account's list of spaces and their keys,
     * so only a site already trusted to act as this identity gets it — the
     * user said yes to that site, for this account, in `signDelegation`.
     */
    case 'getVaultKey': {
      const me = await identity();
      if (!(await readState()).known?.[consentKey(origin, me.did)]) {
        throw new Error('Sign in with this account first: the site has not been allowed to act as it.');
      }
      // Derived as bytes rather than exported from a key: the key the protocol
      // hands a page is deliberately not extractable.
      return { key: base64UrlEncode(await deriveVaultKeyBytes(me.seed)) };
    }

    /**
     * Shows the account code, behind a confirmation.
     *
     * The escape hatch, and the reason this Snap is a convenience rather than a
     * dependency: the code opens the account anywhere, with or without MetaMask.
     */
    case 'exportCode': {
      const granted = await confirm(
        'Show your account password?',
        `${origin} is asking to display the password for this account.\n\n` +
          'Anyone who sees it has the account. Only continue if you asked for this, ' +
          'and are somewhere private.',
      );
      if (!granted) throw new Error('The user declined.');

      const me = await identity();
      return { code: seedToRecoveryCode(me.seed) };
    }

    /**
     * Takes over an account that already exists.
     *
     * Two ways in. A site the user is already signed into can pass the code it
     * holds — it is the user's own account and the site has it either way, so
     * making them export and retype it buys nothing. Any other site gets the
     * prompt, and types into MetaMask's window rather than the page.
     *
     * Both confirm, showing which identity the wallet would end up holding,
     * because this replaces whatever is kept here.
     */
    case 'importAccount': {
      const offered = (request.params as { code?: string } | undefined)?.code;

      let code: string;
      if (offered) {
        if (!isValidRecoveryCode(offered)) {
          throw new Error('That is not a valid account password.');
        }

        // Show which identity this would become, so "replace what is in my
        // wallet" is a decision made against something legible.
        const incoming = await deriveKeyPair(recoveryCodeToSeed(offered), provider);
        const incomingDid = publicKeyToDid(incoming.publicKeyBytes, P256_MULTICODEC);

        const granted = await confirm(
          'Hold this account in your wallet?',
          `${origin} is asking this wallet to hold:\n\n${incomingDid}\n\n` +
            'It replaces whatever account is kept here. The one derived from your ' +
            'recovery phrase is always recoverable, so nothing is lost by trying.',
        );
        if (!granted) throw new Error('The user declined.');
        code = offered;
      } else {
        const typed = await prompt(
          'Import an existing account',
          'Paste the account password you want this wallet to hold. It replaces any ' +
            'account currently kept here — the one derived from your recovery phrase ' +
            'is always recoverable, so nothing is lost by trying.',
          'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX',
        );
        if (!typed) throw new Error('The user declined.');
        if (!isValidRecoveryCode(typed)) {
          throw new Error('That is not a valid account password.');
        }
        code = typed;
      }

      // Added alongside whatever is already here, not on top of it — a wallet
      // that forgot the last account every time one was added would be a poor
      // place to keep them.
      const state = await readState();
      const did = await didFor(recoveryCodeToSeed(code));
      await writeState({
        ...state,
        imported: { ...state.imported, [did]: { code, addedAt: new Date().toISOString() } },
        selected: did,
      });

      const me = await identity();
      return { did: me.did, kind: me.kind };
    }

    /** Drops one imported account. The derived one cannot be dropped. */
    case 'forgetAccount': {
      const wanted = (request.params as { did?: string } | undefined)?.did;
      const state = await readState();

      if (!wanted || !state.imported?.[wanted]) {
        throw new Error('This wallet does not hold that account.');
      }

      const granted = await confirm(
        'Forget this account?',
        `${wanted}\n\nThis wallet will stop holding it. It is not deleted anywhere ` +
          'else — but if its password is not written down, this is the last copy.',
      );
      if (!granted) throw new Error('The user declined.');

      const { [wanted]: _dropped, ...remaining } = state.imported;
      const next: SnapState = { ...state, imported: remaining };
      if (state.selected === wanted) delete (next as { selected?: string }).selected;

      await snap.request({
        method: 'snap_manageState',
        params: { operation: 'update', newState: next },
      });
      return { ok: true };
    }

    default:
      throw new Error(`Unknown method: ${request.method}`);
  }
}
