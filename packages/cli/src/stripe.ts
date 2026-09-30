/**
 * Payments through Stripe: Checkout for paying, the Customer Portal for
 * changing a card or cancelling, and a webhook that says who paid until when.
 *
 * Plain `fetch` against Stripe's REST API — four calls, no SDK. Card, Apple
 * Pay and Google Pay show up in Checkout by themselves; stablecoin payments
 * too, where they are turned on in the Stripe dashboard. Nothing here stores
 * anything about the payer: the host keeps Stripe's customer id and a date.
 *
 * Paid-until comes from Stripe's own billing period, not from adding a month
 * on each event — so a webhook delivered twice, late or out of order moves the
 * date to the same place.
 *
 * A community's fund takes any amount instead, from whoever chips in: Checkout
 * with the amount inline (`price_data`), once, or every month as a
 * subscription of the contributor's own. Its webhook says how much reached
 * which fund, with the session's or invoice's id, which the host counts once.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Billing } from './host.js';
import { isRecord } from './json.js';

export interface StripeConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  /** Price ids, from the Stripe dashboard */
  readonly monthlyPrice?: string;
  readonly yearlyPrice?: string;
  /** For tests */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly api?: string;
}

/** Where the subscription's id travels inside Stripe */
const METADATA_KEY = 'weave_subscription';
/** Where the fund a payment goes into travels inside Stripe */
const FUND_KEY = 'weave_fund';
/** How old a webhook's signature may be, as Stripe's own libraries allow */
const TOLERANCE_SECONDS = 300;

/** Stripe's form encoding: nested keys in brackets */
function form(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

/**
 * Whether a webhook body is Stripe's: `Stripe-Signature: t=…,v1=…`, an
 * HMAC-SHA256 of `t.body` under the webhook secret, made recently.
 */
export function verifyStripeSignature(
  body: string,
  header: string | undefined,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = header.split(',').map((part) => part.split('='));
  const at = Number(parts.find(([key]) => key === 't')?.[1]);
  if (!Number.isFinite(at) || Math.abs(now - at) > TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${at}.${body}`).digest();
  return parts
    .filter(([key]) => key === 'v1')
    .some(([, value]) => {
      const given = Buffer.from(value ?? '', 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

export function createStripeBilling(config: StripeConfig): Billing {
  const call = config.fetch ?? fetch;
  const api = config.api ?? 'https://api.stripe.com';
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));

  async function stripe(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | undefined> = {},
  ): Promise<Record<string, unknown>> {
    const response = await call(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(method === 'POST' ? { body: form(params) } : {}),
    });
    const answer: unknown = await response.json();
    if (!response.ok) {
      const message = isRecord(answer) && isRecord(answer.error) ? answer.error.message : undefined;
      throw new Error(`Stripe: ${typeof message === 'string' ? message : response.status}`);
    }
    if (!isRecord(answer)) throw new Error('Stripe: an answer that is not an object');
    return answer;
  }

  /** Where Checkout or the Customer Portal sends the person */
  async function sessionUrl(path: string, params: Record<string, string | undefined>): Promise<string> {
    const { url } = await stripe('POST', path, params);
    if (typeof url !== 'string') throw new Error('Stripe: a session without a url');
    return url;
  }

  const plans = [
    ...(config.monthlyPrice ? [{ id: 'monthly', label: 'Monthly', price: config.monthlyPrice }] : []),
    ...(config.yearlyPrice ? [{ id: 'yearly', label: 'Yearly', price: config.yearlyPrice }] : []),
  ];

  /** What a Stripe subscription says: whose it is here, and paid until when */
  async function paidBy(subscriptionId: string) {
    const subscription = await stripe('GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
    const { metadata, items, customer } = subscription;
    const ours = isRecord(metadata) ? metadata[METADATA_KEY] : undefined;
    // Newer API versions keep the period on each item, older ones on the subscription.
    const item: unknown = isRecord(items) && Array.isArray(items.data) ? items.data[0] : undefined;
    const until = (isRecord(item) ? item.current_period_end : undefined) ?? subscription.current_period_end;
    if (typeof ours !== 'string' || !ours || typeof until !== 'number' || !until) return null;
    return { subscription: ours, until, ...(typeof customer === 'string' ? { customer } : {}) };
  }

  /** A price as Stripe keeps it, as people read it: "$4 a month" */
  async function priceText(price: string): Promise<string | null> {
    const found = await stripe('GET', `/v1/prices/${encodeURIComponent(price)}`);
    const { unit_amount: cents, currency, recurring } = found;
    if (typeof cents !== 'number' || typeof currency !== 'string') return null;
    const amount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(cents / 100);
    const interval = isRecord(recurring) ? recurring.interval : undefined;
    return typeof interval === 'string' ? `${amount} a ${interval}` : amount;
  }

  const billing: Billing = {
    plans: plans.map(({ id, label }) => ({ id, label })),

    async labels() {
      const found: Record<string, string> = {};
      for (const plan of plans) {
        const text = await priceText(plan.price).catch(() => null);
        if (text) found[plan.id] = text;
      }
      return found;
    },

    async checkout({ subscription, plan, returnUrl, customer }) {
      const price = plans.find((known) => known.id === plan)?.price;
      if (!price) throw new Error(`No such plan: ${plan}`);
      return sessionUrl('/v1/checkout/sessions', {
        mode: 'subscription',
        'line_items[0][price]': price,
        'line_items[0][quantity]': '1',
        success_url: returnUrl,
        cancel_url: returnUrl,
        client_reference_id: subscription,
        'subscription_data[metadata][weave_subscription]': subscription,
        customer,
      });
    },

    async fund({ fund, cents, monthly, returnUrl }) {
      const recurring = monthly ? { 'line_items[0][price_data][recurring][interval]': 'month' } : {};
      return sessionUrl('/v1/checkout/sessions', {
        mode: monthly ? 'subscription' : 'payment',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(cents),
        'line_items[0][price_data][product_data][name]': 'Community fund',
        ...recurring,
        'line_items[0][quantity]': '1',
        success_url: returnUrl,
        cancel_url: returnUrl,
        client_reference_id: fund,
        // Where Stripe keeps it: on the session when paid once, on the contributor's subscription when monthly.
        ...(monthly ? { 'subscription_data[metadata][weave_fund]': fund } : { 'metadata[weave_fund]': fund }),
      });
    },

    async manage({ customer, returnUrl }) {
      return sessionUrl('/v1/billing_portal/sessions', { customer, return_url: returnUrl });
    },

    async webhook(body: string, headers: IncomingMessage['headers']) {
      const signature = headers['stripe-signature'];
      if (
        !verifyStripeSignature(
          body,
          Array.isArray(signature) ? signature[0] : signature,
          config.webhookSecret,
          now(),
        )
      )
        return null;
      const event: unknown = JSON.parse(body);
      if (!isRecord(event)) return null;
      const object = isRecord(event.data) && isRecord(event.data.object) ? event.data.object : {};
      // Into a fund, once: how much, and the session, so the host adds it once.
      if (event.type === 'checkout.session.completed' && object.mode === 'payment') {
        const metadata = isRecord(object.metadata) ? object.metadata : {};
        const fund = metadata[FUND_KEY];
        if (
          object.payment_status !== 'paid' ||
          typeof fund !== 'string' ||
          typeof object.amount_total !== 'number' ||
          typeof object.id !== 'string'
        )
          return null;
        return { subscription: fund, cents: object.amount_total, id: object.id };
      }
      // Paying the first time, and every renewal: both lead to the subscription, whose period says until when.
      if (event.type === 'checkout.session.completed' && typeof object.subscription === 'string')
        return paidBy(object.subscription);
      if (event.type === 'invoice.paid') {
        const { parent } = object;
        // Into a fund, every month: the contributor's subscription says which fund, the invoice how much.
        const details =
          isRecord(parent) && isRecord(parent.subscription_details) ? parent.subscription_details : null;
        const older = isRecord(object.subscription_details) ? object.subscription_details : null;
        const metadata = [details?.metadata, older?.metadata].find(isRecord);
        const fund = metadata?.[FUND_KEY];
        if (typeof fund === 'string') {
          if (typeof object.amount_paid !== 'number' || typeof object.id !== 'string') return null;
          return { subscription: fund, cents: object.amount_paid, id: object.id };
        }
        const id =
          typeof object.subscription === 'string'
            ? object.subscription
            : isRecord(parent) && isRecord(parent.subscription_details)
              ? parent.subscription_details.subscription
              : undefined;
        if (typeof id === 'string') return paidBy(id);
      }
      return null;
    },
  };
  return Object.freeze(billing);
}
