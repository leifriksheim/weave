/**
 * `weave host`: a hosting service in one process.
 *
 * A host node (`src/node/host.ts`) carrying every subscription's spaces, served
 * the way `weave run` serves: sockets at `/peer?space=`, the relay on every
 * other path. Plus what a home and a person need (BLOCK-23):
 *
 *   GET    /.well-known/weave-host                who the host is: key, name, price, pay page
 *   GET    /host/subscriptions/:id                its status, signed by the host
 *   PUT    /host/subscriptions/:id/carry          { account, invite } — the account's carry space
 *   DELETE /host/subscriptions/:id/carry
 *   POST   /host/billing/webhook                  the payment provider, telling us someone paid
 *
 *   GET    /pay                                   the pay page, opened from a home with a signed link
 *   GET    /pay/api                               status and what can be paid with
 *   POST   /pay/api/card                          { plan } → Stripe Checkout
 *   POST   /pay/api/manage                        → Stripe's portal: change the card, cancel
 *   POST   /pay/api/wallet                        { plan } → the exact amount to send
 *   POST   /pay/api/wallet/claim                  { tx } → counted, or 202 while unconfirmed
 *
 * `/host/subscriptions` calls are signed with the subscription key; `/pay/api`
 * calls carry the pay link's signature instead. Homes know nothing about how
 * a host is paid: they open its pay page. Payment providers are behind small
 * interfaces (`Billing`, `WalletPayments`), so the host only ever learns
 * "this subscription is paid until …". Without either, and with `free`, every
 * subscription counts as paid — someone hosting only themselves.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  createHostNode,
  createP256Provider,
  HOST_DESCRIPTION_PATH,
  NotAllowedError,
  signStatus,
  verifyPayLink,
  verifyRequest,
  type BlobStore,
  type HostDescription,
  type HostNode,
  type HostStatus,
  type StoreFactory,
} from '../../src/index.js';
import { PAY_PAGE_CSP, PAY_SCRIPT, payPageHtml } from './pay-page.js';
import { createInboundPeers, serve, type Served } from './serve.js';
import type { WalletPayments } from './wallet.js';

/** What the host needs from a payment provider */
export interface Billing {
  readonly plans: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  /** A payment page for a subscription; paying it leads to a webhook call. `returnUrl` is the host's own pay page. */
  checkout(params: { subscription: string; plan: string; returnUrl: string; customer?: string }): Promise<string>;
  /** The provider's page for managing what a customer pays */
  manage(params: { customer: string; returnUrl: string }): Promise<string>;
  /**
   * A webhook call, checked as the provider's. What it says about a
   * subscription: paid until when, and by which customer. Null for anything
   * else — and for a call that isn't really the provider's.
   */
  webhook(body: string, headers: IncomingMessage['headers']): Promise<{ subscription: string; until: number; customer?: string } | null>;
}

export interface HostOptions {
  readonly key: CryptoKeyPair;
  readonly stores: StoreFactory;
  readonly port: number;
  readonly host?: string;
  /** What it calls itself; default "Weave host" */
  readonly name?: string;
  /** Its price, for people ("$4 a month or $36 a year"); default from the wallet prices */
  readonly price?: string;
  /** Its terms, for people: an address */
  readonly terms?: string;
  /** Its address as people reach it, https:// — where Stripe sends people back to. Default: from each request. */
  readonly publicUrl?: string;
  /** A WalletConnect project id: the pay page then reaches every wallet, not only the browser's */
  readonly walletConnectProjectId?: string | null;
  readonly billing?: Billing | null;
  /** Payments straight from a crypto wallet, next to (or instead of) `billing` */
  readonly wallet?: WalletPayments | null;
  /** The bucket every carried space, and the subscription list, are kept in too */
  readonly mirror?: BlobStore | null;
  /** Every subscription counts as paid */
  readonly free?: boolean;
  /** Only these accounts are carried for */
  readonly allow?: ReadonlyArray<string>;
  readonly graceDays?: number;
  /** How often lapsed subscriptions are dropped. Default hourly. */
  readonly sweepMs?: number;
  readonly log?: (line: string) => void;
}

export interface RunningHost {
  readonly node: HostNode;
  readonly port: number;
  close(): Promise<void>;
}

/** Largest request body the API reads */
const MAX_BODY = 64 * 1024;
const SUBSCRIPTION_PATH = /^\/host\/subscriptions\/(did%3Akey%3Az[1-9A-HJ-NP-Za-km-z]{1,120}|did:key:z[1-9A-HJ-NP-Za-km-z]{1,120})(\/carry)?$/;
const PAY_API = /^\/pay\/api(\/(card|manage|wallet|wallet\/claim))?$/;
/** The WalletConnect bundle, next to this file both in the source tree and in the published package */
const WALLETCONNECT_BUNDLE = new URL('../pay/dist/walletconnect.js', import.meta.url);
/**
 * How long a wallet payment stays open: asked again within it, the same
 * amount; its amount isn't given to anyone else; and only a transfer made
 * within it pays it.
 */
const INVOICE_SECONDS = 7 * 24 * 3600;
/** How far the network's clock may be behind the host's */
const CLOCK_SKEW_SECONDS = 60;
/** Where the transactions already counted are kept in the bucket */
const SPENT_PREFIX = 'host/wallet/spent/';

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Refusal(413, 'That request is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, type: string, body: string | Uint8Array, headers: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}

/** The address a request reached, as the person sees it (behind a proxy that terminates TLS, too) */
function originOf(req: IncomingMessage, configured?: string): string {
  if (configured) return configured.replace(/\/+$/, '');
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || 'http';
  return `${proto}://${req.headers.host ?? 'localhost'}`;
}

/** "$4 a month or $36 a year", from the wallet's prices */
function priceText(wallet: WalletPayments | null): string | undefined {
  const plans = wallet?.offer.plans ?? [];
  const parts = plans.map((plan) => `$${plan.price} a ${plan.id === 'yearly' ? 'year' : 'month'}`);
  return parts.length ? parts.reverse().join(' or ') : undefined;
}

export async function startHost(options: HostOptions): Promise<RunningHost> {
  const log = options.log ?? (() => {});
  const provider = createP256Provider();
  const inbound = createInboundPeers();
  const billing = options.billing ?? null;
  const wallet = options.wallet ?? null;
  // The transactions already counted, so none pays twice — on disk, and in the bucket when there is one.
  const spentStore = wallet ? await options.stores('host-wallet') : null;
  const isSpent = async (tx: string) => !!(await spentStore?.has(`spent:${tx}`)) || !!(await options.mirror?.get(`${SPENT_PREFIX}${tx}`));
  const markSpent = async (tx: string, subscription: string) => {
    const bytes = new TextEncoder().encode(subscription);
    await spentStore?.put(`spent:${tx}`, bytes);
    await options.mirror?.put(`${SPENT_PREFIX}${tx}`, bytes);
  };
  const now = () => Math.floor(Date.now() / 1000);
  // Claims one at a time, so one transaction can't be counted twice by two calls at once.
  let claiming: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const next = claiming.then(work, work);
    claiming = next.catch(() => {});
    return next;
  };
  const node = await createHostNode({
    key: options.key,
    stores: options.stores,
    provider,
    // No relays: WebRTC needs a browser. Peers reach the host over sockets.
    network: { transports: inbound.transports },
    ...(options.free ? { free: true } : {}),
    ...(options.allow ? { allow: options.allow } : {}),
    ...(options.graceDays !== undefined ? { graceDays: options.graceDays } : {}),
    ...(options.mirror ? { mirror: options.mirror } : {}),
  });

  const statusOf = async (id: string): Promise<HostStatus> => {
    const subscription = await node.get(id);
    const at = now();
    if (!subscription) return { subscription: id, host: node.did, state: 'none', paidUntil: 0, renews: false, carrying: false, spaces: 0, at };
    return {
      subscription: id,
      host: node.did,
      state: node.state(subscription),
      paidUntil: subscription.paidUntil,
      renews: subscription.customer !== undefined,
      carrying: subscription.carry !== undefined,
      spaces: await node.carriedFor(id),
      at,
    };
  };
  /** A status as the home gets it: signed with the host's key, so the person holds the host's word */
  const signedStatusOf = async (id: string) => signStatus(await statusOf(id), options.key.privateKey, provider);

  const name = options.name?.trim() || 'Weave host';
  const pays = billing !== null || wallet !== null;
  const description: HostDescription = {
    weave: 'host/1',
    did: node.did,
    name,
    free: !!options.free,
    ...((options.price ?? priceText(wallet)) ? { price: options.price ?? priceText(wallet)! } : {}),
    ...(pays ? { pay: '/pay' } : {}),
    ...(options.terms ? { terms: options.terms } : {}),
  };

  // Reaching every wallet needs the WalletConnect bundle, built by `npm run bundle:pay`.
  const walletConnectBundle = wallet && options.walletConnectProjectId ? await readFile(WALLETCONNECT_BUNDLE).catch(() => null) : null;
  if (wallet && options.walletConnectProjectId && !walletConnectBundle) {
    log('WalletConnect is off: its bundle is missing (run `npm run bundle:pay` in cli/). Browser wallets still work.');
  }
  const walletConnect = walletConnectBundle ? options.walletConnectProjectId! : null;

  async function routes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://host');
    const open = url.pathname === HOST_DESCRIPTION_PATH || url.pathname.startsWith('/host');
    if (!open && url.pathname !== '/pay' && !url.pathname.startsWith('/pay/')) return false;
    if (open) {
      // Signed calls carry no cookie and no ambient authority, so any page may make them.
      res.setHeader('access-control-allow-origin', '*');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-methods': 'GET, PUT, POST, DELETE',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '600',
        });
        res.end();
        return true;
      }
    }
    try {
      await answer(req, res, url);
    } catch (error) {
      if (error instanceof Refusal) send(res, error.status, { error: error.message });
      else {
        log(`host API failed: ${error instanceof Error ? error.message : String(error)}`);
        send(res, 500, { error: 'Something went wrong on the host' });
      }
    }
    return true;
  }

  async function answer(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    if (url.pathname === HOST_DESCRIPTION_PATH && method === 'GET') return send(res, 200, description);

    if (url.pathname.startsWith('/pay')) return answerPay(req, res, url, method);

    if (url.pathname === '/host/billing/webhook' && method === 'POST') {
      if (!billing) throw new Refusal(404, 'This host takes no payments');
      const paid = await billing.webhook(await readBody(req), req.headers);
      if (paid) {
        await node.extend(paid.subscription, paid.until, paid.customer);
        log(`subscription ${paid.subscription} paid until ${new Date(paid.until * 1000).toISOString()}`);
      }
      return send(res, 200, { received: true });
    }

    const match = SUBSCRIPTION_PATH.exec(url.pathname);
    if (!match) throw new Refusal(404, 'No such call');
    const id = decodeURIComponent(match[1]!);
    const carry = match[2] !== undefined;
    const body = await readBody(req);
    // Only the subscription's own key may ask about it or change it.
    const signer = await verifyRequest(req.headers.authorization, method, `${url.pathname}${url.search}`, body, provider);
    if (signer !== id) throw new Refusal(401, 'That call is not signed by the subscription');
    const input = (body ? JSON.parse(body) : {}) as Record<string, unknown>;

    if (!carry && method === 'GET') return send(res, 200, await signedStatusOf(id));

    if (carry && method === 'PUT') {
      if (typeof input.account !== 'string' || typeof input.invite !== 'string' || input.invite.length > 16_000) {
        throw new Refusal(400, 'An account and a carry invite are needed');
      }
      // Asked before anything is kept: a stranger at a free host leaves nothing behind.
      if (options.allow && !options.allow.includes(input.account)) throw new Refusal(403, new NotAllowedError().message);
      if (options.free) await node.subscribe(id);
      const subscription = await node.get(id);
      if (!subscription || node.state(subscription) === 'lapsed') throw new Refusal(402, 'This subscription is not paid for');
      try {
        await node.attach(id, input.account, input.invite);
      } catch (error) {
        if (error instanceof NotAllowedError) throw new Refusal(403, error.message);
        throw new Refusal(400, error instanceof Error ? error.message : 'That invite could not be used');
      }
      log(`subscription ${id} carries ${input.account}'s spaces`);
      return send(res, 200, await signedStatusOf(id));
    }

    if (carry && method === 'DELETE') {
      await node.detach(id);
      return send(res, 200, await signedStatusOf(id));
    }

    throw new Refusal(405, 'That call does not take that method');
  }

  /** The pay page, its script, and its API — every call there carries a pay link a home signed */
  async function answerPay(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    if (!pays) throw new Refusal(404, 'This host takes no payments');
    const page = { 'content-security-policy': PAY_PAGE_CSP, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
    if (url.pathname === '/pay' && method === 'GET') return sendText(res, 'text/html; charset=utf-8', payPageHtml(name), page);
    if (url.pathname === '/pay/pay.js' && method === 'GET') return sendText(res, 'text/javascript; charset=utf-8', PAY_SCRIPT, page);
    if (url.pathname === '/pay/walletconnect.js' && method === 'GET' && walletConnectBundle) {
      return sendText(res, 'text/javascript; charset=utf-8', walletConnectBundle, { 'cache-control': 'public, max-age=3600' });
    }

    const match = PAY_API.exec(url.pathname);
    if (!match) throw new Refusal(404, 'No such page');
    const action = match[2] ?? null;
    const id = await verifyPayLink(req.headers.authorization, node.did, provider);
    if (!id) throw new Refusal(401, 'This pay link has run out, or is not for this host');
    const body = await readBody(req);
    const input = (body ? JSON.parse(body) : {}) as Record<string, unknown>;

    if (action === null && method === 'GET') {
      return send(res, 200, {
        name,
        status: await statusOf(id),
        card: billing?.plans ?? [],
        wallet: wallet?.offer ?? null,
        walletConnect,
      });
    }

    if (action === 'card' && method === 'POST') {
      if (!billing) throw new Refusal(404, 'This host takes no card payments');
      if (typeof input.plan !== 'string' || !billing.plans.some((plan) => plan.id === input.plan)) throw new Refusal(400, 'No such plan');
      const subscription = await node.subscribe(id);
      const checkout = await billing.checkout({
        subscription: id,
        plan: input.plan,
        // Back to this page, never to anything the person didn't open: the home stays in its own tab.
        returnUrl: `${originOf(req, options.publicUrl)}/pay?paid=card`,
        ...(subscription.customer ? { customer: subscription.customer } : {}),
      });
      return send(res, 200, { url: checkout });
    }

    if (action === 'manage' && method === 'POST') {
      if (!billing) throw new Refusal(404, 'This host takes no card payments');
      const customer = (await node.get(id))?.customer;
      if (!customer) throw new Refusal(404, 'Nothing has been paid by card for this subscription');
      return send(res, 200, { url: await billing.manage({ customer, returnUrl: `${originOf(req, options.publicUrl)}/pay` }) });
    }

    if (action === 'wallet' && method === 'POST') {
      if (!wallet) throw new Refusal(404, 'This host takes no wallet payments');
      if (typeof input.plan !== 'string' || !wallet.offer.plans.some((plan) => plan.id === input.plan)) throw new Refusal(400, 'No such plan');
      const subscription = await node.subscribe(id);
      const open = subscription.invoice;
      // Asked again — a reload, a second try — the same amount, so a payment already on its way still counts.
      if (open && open.plan === input.plan && now() - open.at < INVOICE_SECONDS) {
        const { chainId, token, to, decimals } = wallet.offer;
        return send(res, 200, { plan: open.plan, chainId, token, to, amount: open.amount, decimals });
      }
      const taken = new Set(
        (await node.list()).flatMap((other) => (other.invoice && now() - other.invoice.at < INVOICE_SECONDS ? [other.invoice.amount] : [])),
      );
      const payment = wallet.payment(input.plan, taken);
      await node.setInvoice(id, { plan: payment.plan, amount: payment.amount, at: now() });
      return send(res, 200, payment);
    }

    if (action === 'wallet/claim' && method === 'POST') {
      if (!wallet) throw new Refusal(404, 'This host takes no wallet payments');
      if (typeof input.tx !== 'string') throw new Refusal(400, 'A transaction hash is needed');
      const tx = input.tx.toLowerCase();
      return oneAtATime(async () => {
        const subscription = await node.get(id);
        const invoice = subscription?.invoice;
        if (!subscription || !invoice) throw new Refusal(409, 'No wallet payment was asked for');
        if (await isSpent(tx)) throw new Refusal(409, 'That transaction was already counted');
        const check = await wallet.check(tx);
        if (check.state === 'waiting') return send(res, 202, { waiting: true });
        if (check.state === 'failed') throw new Refusal(400, check.reason);
        if (!check.amounts.includes(invoice.amount)) throw new Refusal(400, 'That transaction sent a different amount than was asked for');
        if (check.at < invoice.at - CLOCK_SKEW_SECONDS || check.at > invoice.at + INVOICE_SECONDS) {
          throw new Refusal(400, 'That transaction was not made while this payment was open');
        }
        // Counted first: should anything after fail, the payment is lost to a restart, never counted twice.
        await markSpent(tx, id);
        const until = wallet.extend(invoice.plan, Math.max(now(), subscription.paidUntil));
        await node.extend(id, until);
        await node.setInvoice(id, null);
        log(`subscription ${id} paid from a wallet until ${new Date(until * 1000).toISOString()}`);
        return send(res, 200, await statusOf(id));
      });
    }

    throw new Refusal(405, 'That call does not take that method');
  }

  const served: Served = await serve({
    node: {
      sessionDid: node.did,
      spaces: {
        authenticator: (spaceId) => node.authenticator(spaceId),
        // Everything carried is open already; anything else is refused by the authenticator first.
        hold: async () => {},
      },
    },
    inbound,
    routes,
    port: options.port,
    ...(options.host ? { host: options.host } : {}),
  }).catch(async (error: unknown) => {
    await node.close();
    throw error;
  });

  const sweeping = setInterval(() => {
    void node
      .sweep()
      .then((dropped) => {
        for (const id of dropped) log(`subscription ${id} lapsed past its grace period, and was dropped`);
      })
      .catch((error: unknown) => log(`sweep failed: ${error instanceof Error ? error.message : String(error)}`));
  }, options.sweepMs ?? 3600_000);
  (sweeping as { unref?: () => void }).unref?.();

  if (wallet) log(`taking ${wallet.offer.symbol} on ${wallet.offer.chainName} at ${wallet.offer.to}`);
  const who = options.allow ? `, only for ${options.allow.length} account${options.allow.length === 1 ? '' : 's'}` : '';
  log(`host ${node.did} listening on port ${served.port}${options.free ? ' (free: every subscription counts as paid)' : ''}${who}${options.mirror ? ', kept in its bucket' : ', on this disk alone'}`);
  return {
    node,
    port: served.port,
    async close() {
      clearInterval(sweeping);
      await served.close();
      await node.close();
      await spentStore?.close();
    },
  };
}
