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
 * A device never handles a payment (spec/06-nodes-and-sessions.md, Hosts). A host describes itself
 * and its plans at a well-known address (like a Nostr relay's NIP-11
 * document), and signs every status it gives. Asked to start a plan, it
 * answers with a page at a payment provider to open, or a payment request for
 * a wallet, whose arrival it sees by itself; the home shows either, so paying
 * never means visiting the host's own site.
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
  /** Bytes the host keeps for this subscription's spaces, as it last measured; absent when it doesn't say */
  readonly bytes?: number;
  /** Bytes it keeps at most before it takes no more spaces for this subscription; absent: no limit */
  readonly quota?: number;
  /** For a space's own subscription, its fund: what is in it, in millionths of a dollar */
  readonly balance?: number;
  /** For a space's own subscription: what its fund spends a day as things go, in millionths of a dollar */
  readonly daily?: number;
  /** For a space's own subscription: the bots the host runs there, and whether each is running */
  readonly bots?: ReadonlyArray<HostedBot>;
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
 * Its plans say what can be paid for; how a payment is taken is the host's own.
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
  /** Its terms, for people */
  readonly terms?: string;
  /** Where it takes peers: a WebSocket address, relative to the host's address or absolute */
  readonly peer?: string;
  /** What can be paid for, and how: a home offers these itself, and asks the host to start one. Absent: it takes no payments. */
  readonly plans?: ReadonlyArray<HostPlan>;
  /** Whether it sends reminders by email before paid time runs out, to an address given with `remind` */
  readonly remind?: boolean;
  /** Whether it runs bots for the spaces it carries (`startBot`), from their fund */
  readonly bots?: boolean;
  /** How a community pays for itself here: a fund anyone adds to. Absent: communities can't pay here. */
  readonly fund?: FundOffer;
}

/** What a host says about community funds: what keeping one online costs, and how people add to it */
export interface FundOffer {
  /** What keeping a space online takes from its fund a month, in dollars: `"4"` */
  readonly monthly: string;
  /** The least one payment may add, in dollars */
  readonly min: string;
  /** How money is added: at a payment provider, or as a request for a wallet */
  readonly methods: ReadonlyArray<'checkout' | 'request'>;
  /** Whether a card may add the same amount every month */
  readonly recurring: boolean;
  /** Where someone who adds every month stops it: the payment provider's own page */
  readonly manage?: string;
  /** What a bot takes from the fund a day at most, in dollars, when the host runs bots */
  readonly botDailyCap?: string;
}

/** How someone adds to a community's fund */
export interface FundPayment {
  /** Dollars: `"10"` or `"12.50"` */
  readonly amount: string;
  readonly method: 'checkout' | 'request';
  /** The same amount every month, by card */
  readonly monthly?: boolean;
}

/** A bot a host runs in a space, as the host says: its DID, its name, and how its subscription stands */
export interface HostedBot {
  readonly bot: string;
  readonly name: string;
  /** Whether it runs its rules now: while its community's fund has money in it */
  readonly running: boolean;
  /** What it took from the fund a day this last week, in millionths of a dollar; absent on a free host */
  readonly daily?: number;
}

/** One way to pay a host, as its description lists it */
export interface HostPlan {
  /** What a home sends to start it */
  readonly id: string;
  /** For people, with the price: "$4 a month, by card" */
  readonly label: string;
  /** `checkout`: a page at a payment provider. `request`: a payment request to send from a wallet. */
  readonly method: 'checkout' | 'request';
  /** Charged again by itself until cancelled (a card); false for time paid up front */
  readonly renews: boolean;
  /** Who may use it: `account` (a space pays through its fund instead) */
  readonly for: ReadonlyArray<'account'>;
}

/**
 * What a host answers when asked to start a plan: a page to open, at a
 * payment provider; or a request for a wallet to pay, whose arrival the host
 * sees by itself.
 */
export type PayAnswer =
  | { readonly checkout: string }
  | {
      readonly request: {
        /** A payment URI a wallet opens: `ethereum:` (EIP-681) */
        readonly uri: string;
        /** What is asked for, for people: "4.003217 USDC on Base" */
        readonly amount: string;
        /** Until when a payment counts, unix seconds */
        readonly expires: number;
        /** For a wallet in the browser (EIP-1193), the same transfer spelled out */
        readonly evm?: {
          readonly chainId: number;
          readonly chainName: string;
          readonly token: string;
          readonly to: string;
          /** In the token's smallest unit, as a decimal string */
          readonly units: string;
        };
      };
    };

/** A pay answer from a host, or null when it doesn't read as one: a checkout page must be https:// */
export function readPayAnswer(answer: unknown): PayAnswer | null {
  if (typeof answer !== 'object' || answer === null) return null;
  if ('checkout' in answer && typeof answer.checkout === 'string') {
    try {
      const url = new URL(answer.checkout);
      const local = ['localhost', '127.0.0.1'].includes(url.hostname);
      return url.protocol === 'https:' || (url.protocol === 'http:' && local)
        ? { checkout: url.toString() }
        : null;
    } catch {
      return null;
    }
  }
  if (!('request' in answer) || typeof answer.request !== 'object' || answer.request === null) return null;
  const request: { uri?: unknown; amount?: unknown; expires?: unknown; evm?: unknown } = answer.request;
  if (
    typeof request.uri !== 'string' ||
    !/^(ethereum|lightning|bitcoin):/i.test(request.uri) ||
    typeof request.amount !== 'string' ||
    typeof request.expires !== 'number'
  )
    return null;
  const evm = request.evm;
  const spelled =
    typeof evm === 'object' &&
    evm !== null &&
    'chainId' in evm &&
    typeof evm.chainId === 'number' &&
    'chainName' in evm &&
    typeof evm.chainName === 'string' &&
    'token' in evm &&
    typeof evm.token === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(evm.token) &&
    'to' in evm &&
    typeof evm.to === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(evm.to) &&
    'units' in evm &&
    typeof evm.units === 'string' &&
    /^\d{1,40}$/.test(evm.units)
      ? { chainId: evm.chainId, chainName: evm.chainName, token: evm.token, to: evm.to, units: evm.units }
      : undefined;
  return {
    request: {
      uri: request.uri,
      amount: request.amount,
      expires: request.expires,
      ...(spelled ? { evm: spelled } : {}),
    },
  };
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

const statusText = (payload: string) => utf8Encode(`weave-host-status/v1\n${payload}`);

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

/** Why a host said no: its status code, and what it said. Status 0 when it gave no answer at all. */
export class HostError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** How long a host gets to answer, in milliseconds. A device's own patience: a host that is down must not leave it waiting. */
const HOST_TIMEOUT_MS = 15_000;
/** Starting a bot makes an account and joins a space, so it gets longer */
const BOT_TIMEOUT_MS = 60_000;

const NOT_A_HOST = "That address doesn't answer as a Weave host";

/**
 * Asks a host, and gives up when it takes too long. Nothing there, or
 * nothing in time, is a `HostError` with status 0 that names the address.
 */
async function ask(url: string, init: RequestInit = {}, timeoutMs = HOST_TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    let where = url;
    try {
      where = new URL(url).host;
    } catch {
      // Not an address at all: named as it was given.
    }
    const late = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new HostError(0, late ? `${where} took too long to answer` : `Nothing answers at ${where}`);
  }
}

/**
 * @param otherwise What to say when the host refuses without saying why
 */
async function answerOf<T>(
  response: Response,
  otherwise = `The host answered ${response.status}`,
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- callers check what they rely on: describeHost its fields, readStatus a status's signature
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new HostError(response.status, answer.error ?? otherwise);
  return answer;
}

/**
 * What a host at an address says about itself.
 * @param url The host's address, https://
 * @param timeoutMs How long it gets to answer
 */
export async function describeHost(url: string, timeoutMs = HOST_TIMEOUT_MS): Promise<HostDescription> {
  const description = await answerOf<HostDescription>(
    await ask(`${url.replace(/\/+$/, '')}${HOST_DESCRIPTION_PATH}`, {}, timeoutMs),
    NOT_A_HOST,
  );
  if (
    description.weave !== 'host/1' ||
    typeof description.did !== 'string' ||
    !description.did.startsWith('did:key:')
  ) {
    throw new Error(NOT_A_HOST);
  }
  return description;
}

/** A space id as it may appear in a host's path */
const SPACE_ID = /^[A-Za-z0-9_-]{1,120}$/;

const post = async (url: string, body: unknown, timeoutMs = HOST_TIMEOUT_MS): Promise<unknown> =>
  answerOf<unknown>(
    await ask(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeoutMs,
    ),
  );

function payAnswer(answer: unknown): PayAnswer {
  const read = readPayAnswer(answer);
  if (!read) throw new Error("The host's answer isn't a way to pay");
  return read;
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
  /** Starts adding to the space's fund: anyone may */
  pay(spaceId: string, payment: FundPayment): Promise<PayAnswer>;
  /** Asks for reminders by email before the space's fund runs out; the host mails a link to confirm first */
  remind(spaceId: string, email: string): Promise<void>;
  /**
   * Asks the host to run a bot in a space it carries: it makes the bot's
   * account and joins with the invite, whose role is what the bot may do. It
   * runs from the space's fund. Answers the bot's DID and the space's status.
   */
  startBot(
    spaceId: string,
    name: string,
    invite: string,
  ): Promise<{ readonly bot: string; readonly status: HostStatus; readonly receipt: SignedStatus }>;
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
      checked(spaceId, await answerOf<SignedStatus>(await ask(path(spaceId)))),
    hand: async (spaceId: string, pass: unknown) =>
      checked(
        spaceId,
        await answerOf<SignedStatus>(
          await ask(`${path(spaceId)}/pass`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pass }),
          }),
        ),
      ),
    pay: async (spaceId: string, payment: FundPayment) =>
      payAnswer(await post(`${path(spaceId)}/pay`, payment)),
    remind: async (spaceId: string, email: string) => void (await post(`${path(spaceId)}/remind`, { email })),
    startBot: async (spaceId: string, name: string, invite: string) => {
      const answer = await post(`${base}/host/bots`, { name, invite }, BOT_TIMEOUT_MS);
      const fields = typeof answer === 'object' && answer !== null ? answer : {};
      const bot = 'bot' in fields ? fields.bot : undefined;
      const receipt = 'receipt' in fields ? fields.receipt : undefined;
      if (
        typeof bot !== 'string' ||
        typeof receipt !== 'object' ||
        receipt === null ||
        !('payload' in receipt) ||
        !('sig' in receipt) ||
        typeof receipt.payload !== 'string' ||
        typeof receipt.sig !== 'string'
      )
        throw new Error("The host's answer isn't a bot");
      return { bot, ...(await checked(spaceId, { payload: receipt.payload, sig: receipt.sig })) };
    },
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
  /** Starts paying with one of the host's plans */
  pay(plan: string): Promise<PayAnswer>;
  /** The payment provider's page for changing a card or cancelling: a checkout answer */
  manage(): Promise<PayAnswer>;
  /** Asks for reminders by email before paid time runs out; the host mails a link to confirm first */
  remind(email: string): Promise<void>;
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
      await ask(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: text }) }),
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
    pay: async (plan: string) => payAnswer(await call<unknown>('POST', `${mine}/pay`, { plan })),
    manage: async () => payAnswer(await call<unknown>('POST', `${mine}/manage`, {})),
    remind: async (email: string) => void (await call<unknown>('POST', `${mine}/remind`, { email })),
  });
}
