/**
 * `weave host`: a hosting service in one process.
 *
 * A host node (`packages/core/src/node/host.ts`) carrying every subscription's spaces, served
 * the way `weave run` serves: sockets at `/peer?space=`, the relay on every
 * other path. Plus what a home and a person need (spec/06-nodes-and-sessions.md, Hosts):
 *
 *   GET    /.well-known/weave-host                who the host is: key, name, plans, where it takes peers
 *   GET    /host/subscriptions/:id                its status, signed by the host
 *   PUT    /host/subscriptions/:id/carry          { account, invite } — the account's carry space
 *   DELETE /host/subscriptions/:id/carry
 *   POST   /host/subscriptions/:id/pay            { plan } → { checkout } or { request }
 *   POST   /host/subscriptions/:id/manage         → { checkout }: the card provider's portal
 *   POST   /host/subscriptions/:id/remind         { email } — a mail to confirm reminders with
 *   GET    /host/spaces/:space                    a space's own subscription: its status, to anyone
 *   PUT    /host/spaces/:space/pass               { pass } — carry the space, once someone paid for it
 *   POST   /host/spaces/:space/pay                { plan } — anyone may chip in
 *   POST   /host/spaces/:space/remind             { email }
 *   POST   /host/bots                             { name, invite } — run a bot in a space this host carries
 *   GET    /host/spaces/:space/bots               the bots it runs there, each with its signed status
 *   GET    /host/bots/:did                        a bot's subscription: its status, to anyone
 *   POST   /host/bots/:did/pay                    { plan } — anyone may pay for a bot
 *   POST   /host/billing/webhook                  the payment provider, telling us someone paid
 *   GET    /host/paid                             where a checkout page sends people back to
 *   GET    /host/remind/confirm?t=…, /host/remind/stop?t=…   the links in reminder mails
 *
 * `/host/subscriptions` calls are signed with the subscription key. A home
 * shows the plans and what `pay` answers itself: a page at the payment
 * provider to open, or a payment request for a wallet, which the host sees
 * arrive by watching its address. So the host has no pages of its own but
 * two that say "done". Payment providers are behind small interfaces
 * (`Billing`, `WalletPayments`), so the host only ever learns "this
 * subscription is paid until …". Without either, and with `free`, every
 * subscription counts as paid — someone hosting only themselves.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createHostNode,
  createP256Provider,
  HOST_DESCRIPTION_PATH,
  NotAllowedError,
  parseSpaceInvite,
  signStatus,
  verifyRequest,
  type BlobStore,
  type HostDescription,
  type HostPlan,
  type HostNode,
  type HostStatus,
  type PayAnswer,
  type StoreFactory,
} from '@weaveprotocol/core';
import { isRecord, messageOf } from './json.js';
import { createInboundPeers, serve, type Served } from './serve.js';
import type { WalletPayments } from './wallet.js';
import { isEmail, type Reminders } from './reminders.js';
import { createHostedBots, type BotModel } from './hosted-bots.js';
import { createFunds } from './fund.js';

/** What the host needs from a payment provider */
export interface Billing {
  readonly plans: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  /** A payment page for a subscription; paying it leads to a webhook call. `returnUrl` is where it sends people back. */
  checkout(params: {
    subscription: string;
    plan: string;
    returnUrl: string;
    customer?: string;
  }): Promise<string>;
  /** The provider's page for managing what a customer pays */
  manage(params: { customer: string; returnUrl: string }): Promise<string>;
  /** Each plan's price as people read it ("$4 a month"), by plan id. Asked once, at start. */
  labels?(): Promise<Record<string, string>>;
  /** A payment page for adding `cents` to a community's fund, once or every month; paying leads to a webhook call */
  fund(params: { fund: string; cents: number; monthly: boolean; returnUrl: string }): Promise<string>;
  /** What a webhook call, checked as the provider's, says was paid; null for anything else */
  webhook(
    body: string,
    headers: IncomingMessage['headers'],
  ): Promise<
    | { subscription: string; until: number; customer?: string }
    /** Money into a community's fund, counted once by `id` */
    | { subscription: string; cents: number; id: string }
    | null
  >;
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
  readonly billing?: Billing | null;
  /** Payments straight from a crypto wallet, next to (or instead of) `billing` */
  readonly wallet?: WalletPayments | null;
  /** Reminders by email before paid time runs out, for those who ask (`remind`). Needs `publicUrl`. */
  readonly reminders?: Reminders | null;
  /** The bucket every carried space, and the subscription list, are kept in too */
  readonly mirror?: BlobStore | null;
  /** Every subscription counts as paid */
  readonly free?: boolean;
  /** Only these accounts are carried for */
  readonly allow?: ReadonlyArray<string>;
  readonly graceDays?: number;
  /** Bytes an account's spaces may take before it takes no new space: a soft limit, shown in every status. Needs `measure`. */
  readonly quotaBytes?: number;
  /** How many bytes a carried space takes on the host's disk: what `bytes` in a status adds up */
  readonly measure?: (spaceId: string) => Promise<number>;
  /** How often lapsed subscriptions are dropped. Default hourly. */
  readonly sweepMs?: number;
  /** How often the network is read for wallet payments, while any is open. Default 10 s. */
  readonly watchMs?: number;
  /** Bots for the spaces it carries, each an account of its own under `folder`, thinking with `model` */
  readonly bots?: { readonly folder: string; readonly model: BotModel } | null;
  /** Bots one space may have here, paid or not. Default 5. */
  readonly botsPerSpace?: number;
  /** What keeping a community online takes from its fund a month, in dollars. Default "4". */
  readonly fundMonthly?: string;
  /** What a bot's AI use costs its fund, as a multiple of what the host pays for it. Default 1.5. */
  readonly botMarkup?: number;
  /** The payment provider's page where someone stops adding to a fund every month */
  readonly manageFunds?: string;
  /** How often each fund pays for the time since, and its bots start or stop. Default a minute. */
  readonly fundMs?: number;
  readonly log?: (line: string) => void;
}

export interface RunningHost {
  readonly node: HostNode;
  readonly port: number;
  close(): Promise<void>;
}

/** Largest request body the API reads */
const MAX_BODY = 64 * 1024;
const SUBSCRIPTION_PATH =
  /^\/host\/subscriptions\/(did%3Akey%3Az[1-9A-HJ-NP-Za-km-z]{1,120}|did:key:z[1-9A-HJ-NP-Za-km-z]{1,120})(?:\/(carry|pay|manage|remind))?$/;
/** A space's own subscription, open to anyone */
const SPACE_PATH = /^\/host\/spaces\/([A-Za-z0-9_-]{1,120})(?:\/(pass|pay|remind))?$/;
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
/** Where the last block read for wallet payments is kept */
const SCANNED_KEY = 'scanned';

/** The status each refusal is answered with: what the caller got wrong, said to them, never a 500 */
const refusals = new WeakMap<Error, number>();
function refusal(status: number, message: string): Error {
  const error = new Error(message);
  refusals.set(error, status);
  return error;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(refusal(413, 'That request is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** A request body's fields; anything but a JSON object has none, and each call checks the ones it needs */
function jsonFields(body: string): Record<string, unknown> {
  const parsed: unknown = body ? JSON.parse(body) : {};
  return isRecord(parsed) ? parsed : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendText(
  res: ServerResponse,
  type: string,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
): void {
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

/** A page that says one thing: that a payment went through, or what a link in a reminder mail did */
function noticeHtml(name: string, said: string): string {
  const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(name)}</title><style>:root{color-scheme:light dark}body{margin:0;font:15px/1.5 system-ui,sans-serif}main{max-width:480px;margin:0 auto;padding:48px 16px}h1{font-size:22px;margin:0 0 12px}</style></head><body><main><h1>${escape(name)}</h1><p>${escape(said)}</p></main></body></html>`;
}

/** "$4 a month or $36 a year", from the wallet's prices */
function priceText(wallet: WalletPayments | null): string | undefined {
  const plans = (wallet?.offer.plans ?? []).filter((plan) => plan.id !== 'bot');
  const parts = plans.map((plan) => `$${plan.price} a ${plan.id === 'yearly' ? 'year' : 'month'}`);
  return parts.length ? parts.reverse().join(' or ') : undefined;
}

export async function startHost(options: HostOptions): Promise<RunningHost> {
  const log = options.log ?? (() => {});
  const provider = createP256Provider();
  const inbound = createInboundPeers();
  const billing = options.billing ?? null;
  const wallet = options.wallet ?? null;
  const reminders = options.reminders && options.publicUrl ? options.reminders : null;
  if (options.reminders && !options.publicUrl)
    throw new Error('Reminders by email need the host’s public address (WEAVE_HOST_URL) for their links');
  // The transactions already counted, so none pays twice — on disk, and in the bucket when there is one.
  const spentStore = wallet || billing ? await options.stores('host-wallet') : null;
  const isSpent = async (tx: string) =>
    !!(await spentStore?.get(`spent:${tx}`)) || !!(await options.mirror?.get(`${SPENT_PREFIX}${tx}`));
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
  /** Carry spaces whose account's spaces take all the room it has: they take no new space */
  const full = new Set<string>();
  const node = await createHostNode({
    full: (carrySpace) => full.has(carrySpace),
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

  /** Each space's size, measured at most every ten minutes: a disk walk is not free */
  const sizes = new Map<string, { bytes: number; at: number }>();
  const MEASURE_EVERY_SECONDS = 600;
  const sizeOf = async (measure: (spaceId: string) => Promise<number>, spaceId: string): Promise<number> => {
    const known = sizes.get(spaceId);
    if (known && now() - known.at < MEASURE_EVERY_SECONDS) return known.bytes;
    const bytes = await measure(spaceId).catch(() => known?.bytes ?? 0);
    sizes.set(spaceId, { bytes, at: now() });
    return bytes;
  };
  /** What a subscription's spaces take, and its limit: null when this host doesn't measure */
  const usageOf = async (id: string): Promise<{ bytes: number; quota?: number } | null> => {
    const measure = options.measure;
    if (!measure) return null;
    let bytes = 0;
    for (const spaceId of await node.spacesOf(id)) bytes += await sizeOf(measure, spaceId);
    const carry = (await node.get(id))?.carry?.space;
    if (carry && options.quotaBytes && bytes >= options.quotaBytes) full.add(carry);
    else if (carry) full.delete(carry);
    return { bytes, ...(options.quotaBytes ? { quota: options.quotaBytes } : {}) };
  };
  /** Measures every subscription, and lets a carry space that has room again take the spaces it waited with */
  const measureAll = async (): Promise<void> => {
    if (!options.measure || !options.quotaBytes) return;
    const before = [...full].sort().join(' ');
    for (const subscription of await node.list()) await usageOf(subscription.id);
    if ([...full].sort().join(' ') !== before) await node.recheck();
  };

  const statusOf = async (id: string): Promise<HostStatus> => {
    const subscription = await node.get(id);
    const base = { subscription: id, host: node.did, at: now() };
    if (!subscription)
      return { ...base, state: 'none', paidUntil: 0, renews: false, carrying: false, spaces: 0 };
    const state = node.state(subscription);
    const known = {
      ...base,
      state,
      paidUntil: subscription.paidUntil,
      renews: subscription.customer !== undefined,
    };
    if (!id.startsWith('space:'))
      return {
        ...known,
        carrying: subscription.carry !== undefined,
        spaces: await node.carriedFor(id),
        ...(await usageOf(id)),
      };
    const readKey = node.readKeyOf(id);
    const carrying = subscription.pass !== undefined && state !== 'lapsed';
    return {
      ...known,
      carrying,
      spaces: carrying ? 1 : 0,
      ...(readKey ? { readKey } : {}),
      ...(await usageOf(id)),
      ...(await fundOf(id)),
    };
  };
  /** A community's fund and bots, as its status says them: nothing of a fund on a free host */
  const fundOf = async (id: string) => {
    const spaceId = id.slice('space:'.length);
    const running = bots
      ? (await bots.list(spaceId)).map((bot) => ({
          bot: bot.did,
          name: bot.name,
          running: bots.running(bot.did),
        }))
      : [];
    if (options.free) return running.length ? { bots: running } : {};
    const state = await funds.get(id);
    // What each bot spent a day this last week: what people see the fund pays for.
    const priced = running.map((bot) => ({ ...bot, daily: Math.round(funds.botDaily(state, bot.bot)) }));
    return {
      balance: Math.max(0, Math.round(state.balance)),
      daily: Math.round(funds.daily(state)),
      ...(priced.length ? { bots: priced } : {}),
    };
  };
  /** A status as the home gets it: signed with the host's key, so the person holds the host's word */
  const signedStatusOf = async (id: string) =>
    signStatus(await statusOf(id), options.key.privateKey, provider);

  const name = options.name?.trim() || 'Weave host';
  // Card prices as people read them, asked of the provider once; its plan names without them.
  const labels: Record<string, string> = (await billing?.labels?.().catch(() => ({}))) ?? {};
  const period = (id: string) => (id === 'yearly' ? 'a year' : 'a month');
  const plans: ReadonlyArray<HostPlan> = options.free
    ? []
    : [
        ...(billing?.plans ?? []).map((plan): HostPlan => ({
          id: `card-${plan.id}`,
          label: `${labels[plan.id] ?? plan.label}, by card`,
          method: 'checkout',
          renews: true,
          for: ['account'],
        })),
        ...(wallet ? wallet.offer.plans : []).map((plan): HostPlan => ({
          id: `wallet-${plan.id}`,
          label: `$${plan.price} ${period(plan.id)}, from a wallet (${wallet?.offer.symbol} on ${wallet?.offer.chainName})`,
          method: 'request',
          renews: false,
          for: ['account'],
        })),
      ];
  /** Communities pay through a fund: what online costs a month, and how money goes in */
  const monthly = options.fundMonthly ?? '4';
  const markup = options.botMarkup ?? 1.5;
  const fundOffer =
    !options.free && (billing || wallet)
      ? {
          monthly,
          min: '1',
          methods: [...(billing ? (['checkout'] as const) : []), ...(wallet ? (['request'] as const) : [])],
          recurring: !!billing,
          ...(options.manageFunds ? { manage: options.manageFunds } : {}),
          ...(options.bots ? { botDailyCap: (options.bots.model.dailyCap * markup).toFixed(2) } : {}),
        }
      : null;
  const funds = createFunds({
    store: await options.stores('host-funds'),
    monthly: Number(monthly) * 1e6,
    mirror: options.mirror ?? null,
  });
  const description: HostDescription = {
    weave: 'host/1',
    did: node.did,
    name,
    free: !!options.free,
    ...((options.price ?? priceText(wallet)) ? { price: options.price ?? priceText(wallet)! } : {}),
    // Where devices hold a socket to it: the one `serve` takes peers at.
    peer: '/peer',
    ...(plans.length ? { plans } : {}),
    ...(fundOffer ? { fund: fundOffer } : {}),
    ...(reminders ? { remind: true } : {}),
    // Only where a bot can be paid for, from a fund, or costs nothing.
    ...(options.bots && (options.free || fundOffer) ? { bots: true } : {}),
    ...(options.terms ? { terms: options.terms } : {}),
  };

  // Bots reach the spaces this host carries through its own socket, known once it listens.
  let listening = 0;
  const bots =
    options.bots && description.bots
      ? createHostedBots({
          folder: options.bots.folder,
          store: await options.stores('host-bots'),
          peer: () => `ws://127.0.0.1:${listening}/peer`,
          carries: async (spaceId) =>
            (await node.spaces()).some((space) => space.id === spaceId && !space.carry),
          model: options.bots.model,
          // What a bot spends is taken from its community's fund, with the host's markup.
          charge: async (spaceId, usd, bot) => {
            if (options.free) return;
            const state = await funds.charge(`space:${spaceId}`, usd * markup * 1e6, bot);
            if (state.balance <= 0) await refreshFund(`space:${spaceId}`);
          },
          log,
        })
      : null;
  /** Whether a community's fund has money in it: on a free host, always */
  const funded = async (spaceId: string) => options.free || (await funds.get(`space:${spaceId}`)).balance > 0;
  const syncBots = () => bots?.sync(funded).catch((error: unknown) => log(`bots: ${messageOf(error)}`));
  /**
   * Takes the hosting fee from a fund for the time since, and moves its
   * paid-until date to what it lasts at the rate it is spent: later after a
   * payment, earlier as its bots spend. Bots stop when it is empty.
   */
  let refreshing: Promise<unknown> = Promise.resolve();
  const refreshFund = (id: string): Promise<void> => {
    if (options.free) return Promise.resolve();
    // One at a time: a timer's refresh read before a payment must not write its date after it.
    const next = refreshing.then(async () => {
      const state = await funds.settle(id);
      const until = funds.until(state);
      // An empty fund never moves its date later: its grace runs from when it ran out, or never starts.
      const was = (await node.get(id))?.paidUntil ?? 0;
      await node.setPaidUntil(id, state.balance > 0 ? until : Math.min(until, was));
    });
    refreshing = next.catch(() => {});
    void next.then(syncBots, () => {});
    return next;
  };

  /** Adds a wallet payment to what it paid for, once: its transaction is counted first */
  const credit = async (id: string, tx: string, plan: string, amount: string): Promise<void> => {
    if (!wallet) return;
    const subscription = await node.get(id);
    if (!subscription) return;
    // Counted first: should anything after fail, the payment is lost to a restart, never counted twice.
    await markSpent(tx, id);
    await node.setInvoice(id, null);
    if (plan === 'fund') {
      await funds.add(id, Number(amount));
      await refreshFund(id);
      log(`fund ${id} got ${(Number(amount) / 1e6).toFixed(2)} USDC from a wallet`);
      return;
    }
    const until = wallet.extend(plan, Math.max(now(), subscription.paidUntil));
    await node.extend(id, until);
    log(`subscription ${id} paid from a wallet until ${new Date(until * 1000).toISOString()}`);
  };

  /**
   * Reads the network for transfers to the host's address, and counts each
   * one whose amount an open payment asked for, made while it was open. Only
   * while some payment is open: otherwise nothing could match.
   */
  const watch = () =>
    oneAtATime(async () => {
      if (!wallet || !spentStore) return;
      const open = (await node.list()).filter(
        (subscription) => subscription.invoice && now() - subscription.invoice.at < INVOICE_SECONDS,
      );
      if (open.length === 0) return;
      const kept = await spentStore.get(SCANNED_KEY);
      const { upTo, transfers } = await wallet.scan(kept ? BigInt(new TextDecoder().decode(kept)) : null);
      for (const transfer of transfers) {
        if (await isSpent(transfer.tx)) continue;
        const paying = open.find(
          (subscription) =>
            subscription.invoice?.amount === transfer.amount &&
            transfer.at >= subscription.invoice.at - CLOCK_SKEW_SECONDS &&
            transfer.at <= subscription.invoice.at + INVOICE_SECONDS,
        );
        if (paying?.invoice) await credit(paying.id, transfer.tx, paying.invoice.plan, paying.invoice.amount);
      }
      await spentStore.put(SCANNED_KEY, new TextEncoder().encode(upTo.toString()));
    });

  /** Where a payment provider's page sends people back to */
  const returnUrl = (req: IncomingMessage) => `${originOf(req, options.publicUrl)}/host/paid`;

  /**
   * A payment request for a wallet: the one still open when `same` says it
   * asks for this, so a payment already on its way still counts (a reload, a
   * second try); otherwise a new one, for an amount no other open one has.
   */
  async function walletRequest(
    id: string,
    plan: string,
    same: (open: { readonly amount: string }) => boolean,
    payment: (wallet: WalletPayments, taken: ReadonlySet<string>) => { readonly amount: string },
  ): Promise<PayAnswer> {
    if (!wallet) throw refusal(400, 'This host takes no such payment');
    const open = (await node.subscribe(id)).invoice;
    const fresh = async () => {
      const taken = new Set(
        (await node.list()).flatMap((other) =>
          other.invoice && now() - other.invoice.at < INVOICE_SECONDS ? [other.invoice.amount] : [],
        ),
      );
      const made = { plan, amount: payment(wallet, taken).amount, at: now() };
      await node.setInvoice(id, made);
      return made;
    };
    const { amount, at } =
      open && open.plan === plan && same(open) && now() - open.at < INVOICE_SECONDS ? open : await fresh();
    const { chainId, chainName, token, to } = wallet.offer;
    return {
      request: {
        ...wallet.request(amount),
        expires: at + INVOICE_SECONDS,
        evm: { chainId, chainName, token, to, units: amount },
      },
    };
  }

  /** Starts one of the host's plans for a subscription: a checkout page to open, or a payment request */
  async function startPayment(req: IncomingMessage, id: string, planId: unknown): Promise<PayAnswer> {
    const plan = plans.find((known) => known.id === planId);
    if (!plan) throw refusal(400, 'This host has no such plan for this');
    const [kind, period] = [plan.id.slice(0, plan.id.indexOf('-')), plan.id.slice(plan.id.indexOf('-') + 1)];
    const subscription = await node.subscribe(id);
    if (kind === 'card' && billing) {
      const checkout = await billing.checkout({
        subscription: id,
        plan: period,
        returnUrl: returnUrl(req),
        ...(subscription.customer ? { customer: subscription.customer } : {}),
      });
      return { checkout };
    }
    if (kind !== 'wallet' || !wallet) throw refusal(400, 'This host has no such plan for this');
    return walletRequest(
      id,
      period,
      () => true,
      (w, taken) => w.payment(period, taken),
    );
  }

  /**
   * Starts adding to a community's fund: an amount in dollars, by card (once,
   * or every month) or from a wallet. The fund's subscription is made on the
   * way, so a community's first payment is also how it starts.
   */
  async function startFund(
    req: IncomingMessage,
    id: string,
    input: Record<string, unknown>,
  ): Promise<PayAnswer> {
    if (!fundOffer) throw refusal(404, 'This host takes no payments for communities');
    const amount = typeof input.amount === 'string' ? input.amount.trim() : '';
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(amount) || Number(amount) < Number(fundOffer.min))
      throw refusal(400, `An amount in dollars is needed, at least ${fundOffer.min}`);
    const cents = Math.round(Number(amount) * 100);
    const monthly = input.monthly === true;
    await node.subscribe(id);
    if (input.method === 'checkout' && billing)
      return { checkout: await billing.fund({ fund: id, cents, monthly, returnUrl: returnUrl(req) }) };
    if (input.method !== 'request' || monthly) throw refusal(400, 'This host takes no such payment');
    return walletRequest(
      id,
      'fund',
      (open) => Math.floor(Number(open.amount) / 10_000) === cents,
      (w, taken) => w.fundPayment(BigInt(cents) * 10_000n, taken),
    );
  }

  /** Keeps an address for reminders about a subscription, and mails it a link to confirm; what it now says */
  async function askReminders(req: IncomingMessage, id: string, email: unknown) {
    if (!reminders) throw refusal(404, 'This host sends no reminders');
    if (!isEmail(email)) throw refusal(400, 'That doesn’t look like an email address');
    await reminders.ask(id, email, originOf(req, options.publicUrl));
    return { reminders: await reminders.state(id) };
  }

  /** A subscription someone has paid for; on a free host every one is, made on the way */
  async function mustBePaid(id: string, otherwise: string): Promise<void> {
    if (options.free) await node.subscribe(id);
    const subscription = await node.get(id);
    if (!subscription || node.state(subscription) === 'lapsed') throw refusal(402, otherwise);
  }

  async function routes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://host');
    const open = url.pathname === HOST_DESCRIPTION_PATH || url.pathname.startsWith('/host');
    if (!open) return false;
    {
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
      const status = error instanceof Error ? refusals.get(error) : undefined;
      if (error instanceof Error && status) send(res, status, { error: error.message });
      else {
        log(`host API failed: ${messageOf(error)}`);
        send(res, 500, { error: 'Something went wrong on the host' });
      }
    }
    return true;
  }

  async function answer(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    if (url.pathname === HOST_DESCRIPTION_PATH && method === 'GET') return send(res, 200, description);

    const page = { 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
    if (url.pathname === '/host/paid' && method === 'GET') {
      const said = 'Done. You can close this tab: your Weave app shows the new date when you go back to it.';
      return sendText(res, 'text/html; charset=utf-8', noticeHtml(name, said), page);
    }
    // The links in a reminder mail: whoever holds the mail holds the token.
    if (
      (url.pathname === '/host/remind/confirm' || url.pathname === '/host/remind/stop') &&
      method === 'GET'
    ) {
      if (!reminders) throw refusal(404, 'This host sends no reminders');
      const token = url.searchParams.get('t') ?? '';
      const confirming = url.pathname.endsWith('/confirm');
      const done = confirming ? await reminders.confirm(token) : await reminders.stop(token);
      const said = !done
        ? 'This link has run out.'
        : confirming
          ? 'Done: you’ll get a reminder before the time runs out, and a link in each to stop them.'
          : 'Done: no more reminders go to this address.';
      return sendText(res, 'text/html; charset=utf-8', noticeHtml(name, said), page);
    }

    if (url.pathname === '/host/billing/webhook' && method === 'POST') {
      if (!billing) throw refusal(404, 'This host takes no payments');
      const paid = await billing.webhook(await readBody(req), req.headers);
      if (paid && 'until' in paid) {
        await node.extend(paid.subscription, paid.until, paid.customer);
        log(`subscription ${paid.subscription} paid until ${new Date(paid.until * 1000).toISOString()}`);
      } else if (paid) {
        // Into a fund: added once, however often the webhook comes.
        await oneAtATime(async () => {
          if (await isSpent(`card:${paid.id}`)) return;
          await markSpent(`card:${paid.id}`, paid.subscription);
          await node.subscribe(paid.subscription);
          await funds.add(paid.subscription, paid.cents * 10_000);
          log(`fund ${paid.subscription} got $${(paid.cents / 100).toFixed(2)} by card`);
        });
        await refreshFund(paid.subscription);
      }
      return send(res, 200, { received: true });
    }

    if (url.pathname === '/host/bots') return answerBot(req, res, method);

    const spaceMatch = SPACE_PATH.exec(url.pathname);
    if (spaceMatch) return answerSpace(req, res, method, spaceMatch[1]!, spaceMatch[2] ?? null);

    const match = SUBSCRIPTION_PATH.exec(url.pathname);
    if (!match) throw refusal(404, 'No such call');
    const id = decodeURIComponent(match[1]!);
    const action = match[2] ?? null;
    const carry = action === 'carry';
    const body = await readBody(req);
    // Only the subscription's own key may ask about it or change it.
    const signer = await verifyRequest(
      req.headers.authorization,
      method,
      `${url.pathname}${url.search}`,
      body,
      provider,
    );
    if (signer !== id) throw refusal(401, 'That call is not signed by the subscription');
    const input = jsonFields(body);

    if (action === null && method === 'GET') return send(res, 200, await signedStatusOf(id));

    if (action === 'pay' && method === 'POST') return send(res, 200, await startPayment(req, id, input.plan));

    if (action === 'manage' && method === 'POST') {
      const customer = (await node.get(id))?.customer;
      if (!billing || !customer) throw refusal(404, 'Nothing has been paid by card for this subscription');
      return send(res, 200, { checkout: await billing.manage({ customer, returnUrl: returnUrl(req) }) });
    }

    if (action === 'remind' && method === 'POST')
      return send(res, 200, await askReminders(req, id, input.email));

    if (carry && method === 'PUT') {
      if (
        typeof input.account !== 'string' ||
        typeof input.invite !== 'string' ||
        input.invite.length > 16_000
      ) {
        throw refusal(400, 'An account and a carry invite are needed');
      }
      // Asked before anything is kept: a stranger at a free host leaves nothing behind.
      if (options.allow && !options.allow.includes(input.account))
        throw refusal(403, new NotAllowedError().message);
      await mustBePaid(id, 'This subscription is not paid for');
      try {
        await node.attach(id, input.account, input.invite);
      } catch (error) {
        if (error instanceof NotAllowedError) throw refusal(403, error.message);
        throw refusal(400, error instanceof Error ? error.message : 'That invite could not be used');
      }
      log(`subscription ${id} carries ${input.account}'s spaces`);
      return send(res, 200, await signedStatusOf(id));
    }

    if (carry && method === 'DELETE') {
      await node.detach(id);
      return send(res, 200, await signedStatusOf(id));
    }

    throw refusal(405, 'That call does not take that method');
  }

  /**
   * Bots: anyone holding an invite to a space this host carries may ask for
   * one, as the invite's role is all it may do there. It runs from the
   * space's fund, and the answer is the space's status, which lists it.
   */
  async function answerBot(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
    if (!bots) throw refusal(404, 'This host runs no bots');
    if (method !== 'POST') throw refusal(405, 'That call does not take that method');
    const input = jsonFields(await readBody(req));
    if (typeof input.name !== 'string' || typeof input.invite !== 'string' || input.invite.length > 16_000)
      throw refusal(400, 'A name and an invite are needed');
    let spaceId: string;
    try {
      spaceId = parseSpaceInvite(input.invite).space.id;
    } catch {
      throw refusal(400, 'That invite could not be read');
    }
    if ((await bots.list(spaceId)).length >= (options.botsPerSpace ?? 5))
      throw refusal(409, 'This space has as many bots here as it may');
    let bot: { did: string; name: string };
    try {
      bot = await bots.start(input.name, input.invite);
    } catch (error) {
      throw refusal(409, error instanceof Error ? error.message : 'The bot could not start');
    }
    await syncBots();
    return send(res, 200, { bot: bot.did, receipt: await signedStatusOf(`space:${spaceId}`) });
  }

  /**
   * A space's own subscription. Nothing is signed: anyone may see how it
   * stands and pay for it, and a pass proves itself, so anyone holding one may
   * hand it over; the host carries it only once someone has paid.
   */
  async function answerSpace(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    space: string,
    action: string | null,
  ): Promise<void> {
    const id = `space:${space}`;
    if (action === null && method === 'GET') return send(res, 200, await signedStatusOf(id));
    // A host carrying only named accounts carries no space for itself, so takes nothing for one.
    if (options.allow && action !== null) throw refusal(403, new NotAllowedError().message);
    if (action === 'pay' && method === 'POST')
      return send(res, 200, await startFund(req, id, jsonFields(await readBody(req))));
    if (action === 'remind' && method === 'POST')
      return send(res, 200, await askReminders(req, id, jsonFields(await readBody(req)).email));
    if (action === 'pass' && method === 'PUT') {
      const input = jsonFields(await readBody(req));
      if (input.pass === undefined) throw refusal(400, 'A pass is needed');
      await mustBePaid(id, 'Nobody has paid for this space yet');
      try {
        await node.carrySpace(id, input.pass);
      } catch (error) {
        throw refusal(400, error instanceof Error ? error.message : 'That pass could not be used');
      }
      log(`space ${space} carried for itself`);
      return send(res, 200, await signedStatusOf(id));
    }
    throw refusal(405, 'That call does not take that method');
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

  listening = served.port;
  void syncBots();
  // Every minute, each community's fund pays for the time since, and its date and bots follow.
  const fundTick = async () => {
    if (!options.free)
      for (const subscription of await node.list())
        if (subscription.id.startsWith('space:')) await refreshFund(subscription.id);
    await syncBots();
  };
  void fundTick().catch(() => {});
  const botSweeping = setInterval(
    () => void fundTick().catch((error: unknown) => log(`funds: ${messageOf(error)}`)),
    options.fundMs ?? 60_000,
  );
  botSweeping.unref();

  // Who is over their room, known before the first account adds a space.
  void measureAll().catch((error: unknown) => log(`measuring failed: ${messageOf(error)}`));
  const sweeping = setInterval(() => {
    void node
      .sweep()
      .then(async (dropped) => {
        for (const id of dropped) log(`subscription ${id} lapsed past its grace period, and was dropped`);
        await measureAll();
        if (reminders && options.publicUrl)
          await reminders.send(
            await node.list(),
            (subscription) => node.state(subscription),
            options.publicUrl,
          );
      })
      .catch((error: unknown) => log(`sweep failed: ${messageOf(error)}`));
  }, options.sweepMs ?? 3600_000);
  sweeping.unref();
  const watching = wallet
    ? setInterval(() => {
        void watch().catch((error: unknown) => log(`reading the network failed: ${messageOf(error)}`));
      }, options.watchMs ?? 10_000)
    : null;
  watching?.unref();

  if (wallet) log(`taking ${wallet.offer.symbol} on ${wallet.offer.chainName} at ${wallet.offer.to}`);
  const who = options.allow
    ? `, only for ${options.allow.length} account${options.allow.length === 1 ? '' : 's'}`
    : '';
  log(
    `host ${node.did} listening on port ${served.port}${options.free ? ' (free: every subscription counts as paid)' : ''}${who}${options.mirror ? ', kept in its bucket' : ', on this disk alone'}`,
  );
  return {
    node,
    port: served.port,
    async close() {
      clearInterval(sweeping);
      if (watching) clearInterval(watching);
      clearInterval(botSweeping);
      await bots?.close();
      await claiming;
      await served.close();
      await node.close();
      await spentStore?.close();
    },
  };
}
