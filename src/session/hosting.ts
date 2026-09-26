/**
 * @module session/hosting
 * Talking to a host (`node/host.ts`): a subscription key, requests signed with
 * it, and the few calls a device makes.
 *
 * A **subscription key** is a key pair made from a random seed when someone
 * first asks for hosting. The seed is kept in the account registry
 * (`sys.hosting`, sealed like every registry record), so every device of the
 * account signs as the same subscription. It is not the account's key: the
 * host learns a subscription, not who pays for it, and a stolen subscription
 * key can only point the host at spaces it cannot read anyway.
 *
 * Every call is signed over what it asks — method, path, time and body — the
 * way a signed HTTP request is (AWS SigV4, RFC 9421), and a host refuses one
 * more than five minutes off.
 */
import type { CryptoProvider } from '../types.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { didToPublicKey, publicKeyToDid, P256_MULTICODEC } from '../identity/did.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../utils/encoding.js';
import { sha256 } from '../utils/hash.js';

/** Where the account keeps the hosts it uses, in its registry: one record each */
export const HOSTING_COLLECTION = 'sys.hosting';

/** A hosting record's body */
export interface Hosting {
  /** The host's address, https:// */
  readonly url: string;
  /** The host's own key, as it appears to peers — what the carry space is shared with */
  readonly host: string;
  /** The subscription key's seed, base64url */
  readonly seed: string;
  readonly since: string;
}

/** A subscription key, ready to sign with */
export interface SubscriptionKey {
  readonly did: string;
  readonly privateKey: CryptoKey;
}

/** How far a signed request's time may be from the host's, in seconds */
export const REQUEST_WINDOW_SECONDS = 300;

/** A fresh seed for a subscription key */
export function newSubscriptionSeed(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

/** The subscription key a seed stands for */
export async function subscriptionKey(seed: Uint8Array, provider: CryptoProvider = createP256Provider()): Promise<SubscriptionKey> {
  const pair = await provider.deriveKeyPairFromSeed(seed);
  return { did: publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC), privateKey: pair.privateKey };
}

async function requestText(method: string, path: string, at: number, body: string): Promise<Uint8Array> {
  const bodyHash = base64UrlEncode(await sha256(utf8Encode(body)));
  return utf8Encode(`weave-host/v1\n${method.toUpperCase()}\n${path}\n${at}\n${bodyHash}`);
}

/**
 * The `Authorization` header for a request.
 * @param path The path and query, as the host will see it
 */
export async function signRequest(
  key: SubscriptionKey,
  method: string,
  path: string,
  body = '',
  provider: CryptoProvider = createP256Provider(),
  at = Math.floor(Date.now() / 1000),
): Promise<string> {
  const sig = base64UrlEncode(await provider.sign(key.privateKey, await requestText(method, path, at, body)));
  return `Weave did=${key.did}, at=${at}, sig=${sig}`;
}

/**
 * Which subscription signed a request, or null when it isn't signed, is
 * signed by someone else, or too far from now.
 */
export async function verifyRequest(
  header: string | undefined,
  method: string,
  path: string,
  body: string,
  provider: CryptoProvider = createP256Provider(),
  now = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const match = /^Weave did=(did:key:z[1-9A-HJ-NP-Za-km-z]{1,120}), at=(\d{1,12}), sig=([A-Za-z0-9_-]{1,200})$/.exec(header ?? '');
  if (!match) return null;
  const [, did, atText, sig] = match as unknown as [string, string, string, string];
  const at = Number(atText);
  if (Math.abs(now - at) > REQUEST_WINDOW_SECONDS) return null;
  try {
    const publicKey = await provider.importPublicKey(didToPublicKey(did).publicKeyBytes);
    return (await provider.verify(publicKey, base64UrlDecode(sig), await requestText(method, path, at, body))) ? did : null;
  } catch {
    return null;
  }
}

/** What a host says about a subscription */
export interface HostStatus {
  readonly subscription: string;
  readonly state: 'active' | 'grace' | 'lapsed' | 'none';
  /** Unix seconds; 0 before it was ever paid */
  readonly paidUntil: number;
  /** Whether it carries an account's spaces now */
  readonly carrying: boolean;
  /** How many spaces it carries for this subscription */
  readonly spaces: number;
  /** Paid through a provider that renews it by itself (a card); false for time paid up front */
  readonly renews: boolean;
}

/**
 * What a host takes from a crypto wallet: USDC, sent straight to the host's
 * own address on one network, for a plan of time paid up front.
 */
export interface WalletOffer {
  /** The network, as wallets name it (EIP-155): 8453 for Base */
  readonly chainId: number;
  readonly chainName: string;
  /** A public address a wallet may use to reach the network, if it doesn't know it yet */
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  /** The token's contract, and its decimals */
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Where payments go: the host's own address */
  readonly to: string;
  /** Each plan's price, in whole units of the token ("36") */
  readonly plans: ReadonlyArray<{ readonly id: string; readonly label: string; readonly price: string }>;
}

/**
 * One payment to make: send exactly `amount` of the token to `to`. The amount
 * is the plan's price plus a fraction of a cent that no other open payment
 * has, which is how the host knows the transfer is this subscription's.
 */
export interface WalletPayment {
  readonly plan: string;
  readonly chainId: number;
  readonly token: string;
  readonly to: string;
  /** In the token's smallest unit, as a decimal string */
  readonly amount: string;
  readonly decimals: number;
}

/** What a host says about itself, to anyone */
export interface HostInfo {
  /** Its own key, as it appears to peers */
  readonly did: string;
  /** Whether every subscription counts as paid — someone hosting themselves */
  readonly free: boolean;
  readonly plans: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  /** Present when it also takes payments from a crypto wallet */
  readonly wallet?: WalletOffer;
}

/** A host's calls, signed as one subscription */
export interface HostClient {
  /** The host's own key and what it offers — asked without a subscription */
  info(): Promise<HostInfo>;
  status(): Promise<HostStatus>;
  /** Hands the host the account's carry space */
  attach(account: string, invite: string): Promise<HostStatus>;
  detach(): Promise<void>;
  /** A payment page's address; paying moves the subscription's date */
  checkout(plan: string, returnUrl: string): Promise<{ readonly url: string }>;
  /** The payment provider's page for changing the card, cancelling, receipts */
  manage(returnUrl: string): Promise<{ readonly url: string }>;
  /** What to send from a wallet for a plan. Asked again within a week, the same amount. */
  walletPayment(plan: string): Promise<WalletPayment>;
  /**
   * Tells the host a wallet sent the payment: the transaction's hash. Null
   * while the network hasn't confirmed it yet — ask again in a few seconds.
   */
  walletClaim(tx: string): Promise<HostStatus | null>;
}

/** Why a host said no: its status code, and what it said */
export class HostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A client for one host, signing as one subscription.
 * @param url The host's address, https://
 */
export function createHostClient(url: string, key: SubscriptionKey, provider: CryptoProvider = createP256Provider()): HostClient {
  const base = url.replace(/\/+$/, '');
  async function call<T>(method: string, path: string, body?: unknown, signed = true): Promise<T> {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' };
    if (signed) headers.authorization = await signRequest(key, method, path, text, provider);
    const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: text }) });
    const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new HostError(response.status, answer.error ?? `The host answered ${response.status}`);
    return answer;
  }
  const mine = `/host/subscriptions/${encodeURIComponent(key.did)}`;
  return Object.freeze({
    info: () => call<HostInfo>('GET', '/host', undefined, false),
    status: () => call<HostStatus>('GET', mine),
    attach: (account: string, invite: string) => call<HostStatus>('PUT', `${mine}/carry`, { account, invite }),
    detach: async () => void (await call('DELETE', `${mine}/carry`)),
    checkout: (plan: string, returnUrl: string) => call<{ url: string }>('POST', `${mine}/checkout`, { plan, returnUrl }),
    manage: (returnUrl: string) => call<{ url: string }>('POST', `${mine}/manage`, { returnUrl }),
    walletPayment: (plan: string) => call<WalletPayment>('POST', `${mine}/wallet`, { plan }),
    walletClaim: async (tx: string) => {
      const answer = await call<HostStatus | { waiting: true }>('POST', `${mine}/wallet/claim`, { tx });
      return 'waiting' in answer ? null : answer;
    },
  });
}
