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
 *
 * What a device knows about paying is nothing (spec/06-nodes-and-sessions.md, Hosts). A host describes
 * itself at a well-known address (like a Nostr relay's NIP-11 document), signs
 * every status it gives, and takes payments on its own page, which the device
 * opens with a link signed by the subscription key — the way an S3 link is
 * pre-signed.
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
  /** The host's name, as it described itself */
  readonly name?: string;
  /** Where the host takes peers, `wss://…`, as its description said: every device of the account connects there */
  readonly peer?: string;
  /** The latest status the host signed — what every device shows, and the person's proof */
  readonly receipt?: SignedStatus;
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
export async function subscriptionKey(
  seed: Uint8Array,
  provider: CryptoProvider = createP256Provider(),
): Promise<SubscriptionKey> {
  const pair = await provider.deriveKeyPairFromSeed(seed);
  return {
    did: publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC),
    privateKey: pair.privateKey,
  };
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
  return headerSigner(
    header,
    /^Weave did=(did:key:z[1-9A-HJ-NP-Za-km-z]{1,120}), at=(\d{1,12}), sig=([A-Za-z0-9_-]{1,200})$/,
    (at) => Math.abs(now - at) <= REQUEST_WINDOW_SECONDS,
    (_did, at) => requestText(method, path, at, body),
    provider,
  );
}

/**
 * The key that signed a header of `pattern`'s form — its groups the key, the
 * time and the signature — when the time is in `inWindow` and the signature
 * is over `signed`. Null otherwise.
 */
async function headerSigner(
  header: string | undefined,
  pattern: RegExp,
  inWindow: (at: number) => boolean,
  signed: (did: string, at: number) => Uint8Array | Promise<Uint8Array>,
  provider: CryptoProvider,
): Promise<string | null> {
  const [, did, atText, sig] = pattern.exec(header ?? '') ?? [];
  if (did === undefined || atText === undefined || sig === undefined) return null;
  const at = Number(atText);
  if (!inWindow(at)) return null;
  try {
    const publicKey = await provider.importPublicKey(didToPublicKey(did).publicKeyBytes);
    return (await provider.verify(publicKey, base64UrlDecode(sig), await signed(did, at))) ? did : null;
  } catch {
    return null;
  }
}

/** What a host says about a subscription, signed with its own key */
export interface HostStatus {
  readonly subscription: string;
  /** The host's key, which signed it */
  readonly host: string;
  readonly state: 'active' | 'grace' | 'lapsed' | 'none';
  /** Unix seconds; 0 before it was ever paid */
  readonly paidUntil: number;
  /** Paid through something that renews by itself (a card); false for time paid up front */
  readonly renews: boolean;
  /** Whether it carries an account's spaces now */
  readonly carrying: boolean;
  /** How many spaces it carries for this subscription */
  readonly spaces: number;
  /** For a space's own subscription, a private one: the read key it carries the space with, as a DID */
  readonly readKey?: string;
  /** When the host said it, unix seconds */
  readonly at: number;
}

/** A status as the host sent it: the exact bytes, and its signature over them */
export interface SignedStatus {
  /** A `HostStatus`, as JSON */
  readonly payload: string;
  /** base64url P-256 signature over `weave-host-status/v1\n<payload>` */
  readonly sig: string;
}

/**
 * What a host says about itself, to anyone, at `/.well-known/weave-host`.
 * Nothing in it is about how the host is paid: that's on its pay page.
 */
export interface HostDescription {
  readonly weave: 'host/1';
  /** Its own key, as it appears to peers, and what signs its statuses */
  readonly did: string;
  readonly name: string;
  /** Every subscription counts as paid — someone hosting themselves */
  readonly free: boolean;
  /** For people, as the host puts it: "$4 a month or $36 a year" */
  readonly price?: string;
  /** Its pay page, relative to the host's address or absolute; absent when it takes no payments */
  readonly pay?: string;
  /** Its terms, for people */
  readonly terms?: string;
  /** Where it takes peers: a WebSocket address, relative to the host's address or absolute */
  readonly peer?: string;
}

/**
 * The socket address a host takes peers at, from its description: `peer`
 * resolved against the host's address, with https:// read as wss://. Null
 * when it names none, or one that isn't wss:// (ws:// only on this machine).
 * @param url The host's address
 */
export function hostPeerAddress(url: string, description: Pick<HostDescription, 'peer'>): string | null {
  if (typeof description.peer !== 'string') return null;
  try {
    const address = new URL(description.peer, `${url.replace(/\/+$/, '')}/`);
    if (address.protocol === 'https:') address.protocol = 'wss:';
    else if (address.protocol === 'http:') address.protocol = 'ws:';
    const local = ['localhost', '127.0.0.1'].includes(address.hostname);
    if (address.protocol !== 'wss:' && !(address.protocol === 'ws:' && local)) return null;
    address.hash = '';
    return address.toString();
  } catch {
    return null;
  }
}

/** Where a host's description is */
export const HOST_DESCRIPTION_PATH = '/.well-known/weave-host';

/** How long a pay link works, in seconds */
export const PAY_LINK_SECONDS = 3600;

const statusText = (payload: string) => utf8Encode(`weave-host-status/v1\n${payload}`);
const payText = (host: string, subscription: string, at: number) =>
  utf8Encode(`weave-pay/v1\n${host}\n${subscription}\n${at}`);

/** Signs a status with the host's key */
export async function signStatus(
  status: HostStatus,
  privateKey: CryptoKey,
  provider: CryptoProvider = createP256Provider(),
): Promise<SignedStatus> {
  const payload = JSON.stringify(status);
  return { payload, sig: base64UrlEncode(await provider.sign(privateKey, statusText(payload))) };
}

/** The status a signed one says, when `host` signed it; null when it didn't */
export async function readStatus(
  signed: SignedStatus,
  host: string,
  provider: CryptoProvider = createP256Provider(),
): Promise<HostStatus | null> {
  try {
    const publicKey = await provider.importPublicKey(didToPublicKey(host).publicKeyBytes);
    if (!(await provider.verify(publicKey, base64UrlDecode(signed.sig), statusText(signed.payload))))
      return null;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the host signed it, and it names the host
    const status = JSON.parse(signed.payload) as HostStatus;
    return status.host === host ? status : null;
  } catch {
    return null;
  }
}

/**
 * A link to a host's pay page that lets whoever opens it pay for one
 * subscription, at that host only, for an hour. The signature is in the
 * fragment, which browsers never send to a server.
 * @param pay The pay page's address, absolute
 * @param host The host's key
 */
export async function payLink(
  pay: string,
  host: string,
  key: SubscriptionKey,
  provider: CryptoProvider = createP256Provider(),
  at = Math.floor(Date.now() / 1000),
): Promise<string> {
  const sig = base64UrlEncode(await provider.sign(key.privateKey, payText(host, key.did, at)));
  const url = new URL(pay);
  url.hash = new URLSearchParams({ s: key.did, at: String(at), sig }).toString();
  return url.toString();
}

/** A space id as it may appear in a pay link or a host's path */
const SPACE_ID = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * A link to a host's pay page for a space's own subscription. Anyone may pay
 * for a space, so it needs no signature and never runs out.
 * @param pay The pay page's address, absolute
 */
export function spacePayLink(pay: string, spaceId: string): string {
  const url = new URL(pay);
  url.hash = new URLSearchParams({ space: spaceId }).toString();
  return url.toString();
}

/**
 * The subscription a pay page's call is for: from `Authorization: WeavePay
 * s=…, at=…, sig=…`, a pay link to this host (`host`, its key) less than an
 * hour old; or from `WeavePay space=<id>`, that space's own subscription
 * (`space:<id>`), which anyone may pay for. Null otherwise.
 */
export async function verifyPayLink(
  header: string | undefined,
  host: string,
  provider: CryptoProvider = createP256Provider(),
  now = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const space = /^WeavePay space=([A-Za-z0-9_-]{1,120})$/.exec(header ?? '')?.[1];
  if (space) return `space:${space}`;
  return headerSigner(
    header,
    /^WeavePay s=(did:key:z[1-9A-HJ-NP-Za-km-z]{1,120}), at=(\d{1,12}), sig=([A-Za-z0-9_-]{1,200})$/,
    (at) => now - at <= PAY_LINK_SECONDS && at - now <= REQUEST_WINDOW_SECONDS,
    (did, at) => payText(host, did, at),
    provider,
  );
}

/** Why a host said no: its status code, and what it said */
export class HostError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function answerOf<T>(response: Response): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- callers check what they rely on: describeHost its fields, readStatus a status's signature
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok)
    throw new HostError(response.status, answer.error ?? `The host answered ${response.status}`);
  return answer;
}

/**
 * What a host at an address says about itself.
 * @param url The host's address, https://
 */
export async function describeHost(url: string): Promise<HostDescription> {
  const description = await answerOf<HostDescription>(
    await fetch(`${url.replace(/\/+$/, '')}${HOST_DESCRIPTION_PATH}`),
  );
  if (
    description.weave !== 'host/1' ||
    typeof description.did !== 'string' ||
    !description.did.startsWith('did:key:')
  ) {
    throw new Error("That address doesn't answer as a Weave host");
  }
  return description;
}

/** A host's calls about a space's own subscription: open to anyone, as paying for a space is */
export interface SpaceHostClient {
  /** How the space's subscription stands, checked as signed by the host */
  status(spaceId: string): Promise<{ readonly status: HostStatus; readonly receipt: SignedStatus }>;
  /** Hands the host the space's pass, to carry it with; 402 when nobody has paid */
  hand(
    spaceId: string,
    pass: unknown,
  ): Promise<{ readonly status: HostStatus; readonly receipt: SignedStatus }>;
}

/**
 * A client for one host's calls about spaces paying for themselves.
 * @param url The host's address, https://
 * @param host The host's key: every status must be signed by it
 */
export function createSpaceHostClient(
  url: string,
  host: string,
  provider: CryptoProvider = createP256Provider(),
): SpaceHostClient {
  const base = url.replace(/\/+$/, '');
  const path = (spaceId: string) => {
    if (!SPACE_ID.test(spaceId)) throw new Error('That is not a space id');
    return `${base}/host/spaces/${encodeURIComponent(spaceId)}`;
  };
  const checked = async (spaceId: string, receipt: SignedStatus) => {
    const status = await readStatus(receipt, host, provider);
    if (!status || status.subscription !== `space:${spaceId}`)
      throw new Error("The host's answer isn't signed by the host this space uses");
    return { status, receipt };
  };
  return Object.freeze({
    status: async (spaceId: string) =>
      checked(spaceId, await answerOf<SignedStatus>(await fetch(path(spaceId)))),
    hand: async (spaceId: string, pass: unknown) =>
      checked(
        spaceId,
        await answerOf<SignedStatus>(
          await fetch(`${path(spaceId)}/pass`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pass }),
          }),
        ),
      ),
  });
}

/** A host's calls, signed as one subscription */
export interface HostClient {
  /** How the subscription stands, checked as signed by the host; and the signed original, to keep */
  status(): Promise<{ readonly status: HostStatus; readonly receipt: SignedStatus }>;
  /** Hands the host the account's carry space */
  attach(
    account: string,
    invite: string,
  ): Promise<{ readonly status: HostStatus; readonly receipt: SignedStatus }>;
  detach(): Promise<void>;
}

/**
 * A client for one host, signing as one subscription.
 * @param url The host's address, https://
 * @param host The host's key: every status must be signed by it
 */
export function createHostClient(
  url: string,
  host: string,
  key: SubscriptionKey,
  provider: CryptoProvider = createP256Provider(),
): HostClient {
  const base = url.replace(/\/+$/, '');
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      authorization: await signRequest(key, method, path, text, provider),
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return answerOf<T>(
      await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: text }) }),
    );
  }
  const checked = async (receipt: SignedStatus) => {
    const status = await readStatus(receipt, host, provider);
    if (!status || status.subscription !== key.did)
      throw new Error("The host's answer isn't signed by the host this account uses");
    return { status, receipt };
  };
  const mine = `/host/subscriptions/${encodeURIComponent(key.did)}`;
  return Object.freeze({
    status: async () => checked(await call<SignedStatus>('GET', mine)),
    attach: async (account: string, invite: string) =>
      checked(await call<SignedStatus>('PUT', `${mine}/carry`, { account, invite })),
    detach: async () => void (await call('DELETE', `${mine}/carry`)),
  });
}
