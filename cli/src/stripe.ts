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
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Billing } from './host.js';

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
export function verifyStripeSignature(body: string, header: string | undefined, secret: string, now = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const parts = header.split(',').map((part) => part.split('=') as [string, string]);
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

interface StripeSubscription {
  readonly id: string;
  readonly customer: string;
  readonly metadata?: Record<string, string>;
  /** Older API versions */
  readonly current_period_end?: number;
  /** Newer ones keep the period on each item */
  readonly items?: { readonly data: ReadonlyArray<{ readonly current_period_end?: number }> };
}

export function createStripeBilling(config: StripeConfig): Billing {
  const call = config.fetch ?? fetch;
  const api = config.api ?? 'https://api.stripe.com';
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));

  async function stripe<T>(method: 'GET' | 'POST', path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const response = await call(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(method === 'POST' ? { body: form(params) } : {}),
    });
    const answer = (await response.json()) as T & { error?: { message?: string } };
    if (!response.ok) throw new Error(`Stripe: ${answer.error?.message ?? response.status}`);
    return answer;
  }

  const plans = [
    ...(config.monthlyPrice ? [{ id: 'monthly', label: 'Monthly', price: config.monthlyPrice }] : []),
    ...(config.yearlyPrice ? [{ id: 'yearly', label: 'Yearly', price: config.yearlyPrice }] : []),
  ];

  /** What a Stripe subscription says: whose it is here, and paid until when */
  async function paidBy(subscriptionId: string) {
    const subscription = await stripe<StripeSubscription>('GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
    const ours = subscription.metadata?.[METADATA_KEY];
    const until = subscription.items?.data[0]?.current_period_end ?? subscription.current_period_end;
    if (!ours || !until) return null;
    return { subscription: ours, until, customer: subscription.customer };
  }

  const billing: Billing = {
    plans: plans.map(({ id, label }) => ({ id, label })),

    async checkout({ subscription, plan, returnUrl, customer }) {
      const price = plans.find((known) => known.id === plan)?.price;
      if (!price) throw new Error(`No such plan: ${plan}`);
      const session = await stripe<{ url: string }>('POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        'line_items[0][price]': price,
        'line_items[0][quantity]': '1',
        success_url: returnUrl,
        cancel_url: returnUrl,
        client_reference_id: subscription,
        'subscription_data[metadata][weave_subscription]': subscription,
        customer,
      });
      return session.url;
    },

    async manage({ customer, returnUrl }) {
      const session = await stripe<{ url: string }>('POST', '/v1/billing_portal/sessions', { customer, return_url: returnUrl });
      return session.url;
    },

    async webhook(body: string, headers: IncomingMessage['headers']) {
      const signature = headers['stripe-signature'];
      if (!verifyStripeSignature(body, Array.isArray(signature) ? signature[0] : signature, config.webhookSecret, now())) return null;
      const event = JSON.parse(body) as { type?: string; data?: { object?: Record<string, unknown> } };
      const object = event.data?.object ?? {};
      // Paying the first time, and every renewal: both lead to the subscription, whose period says until when.
      if (event.type === 'checkout.session.completed' && typeof object.subscription === 'string') return paidBy(object.subscription);
      if (event.type === 'invoice.paid') {
        const parent = object.parent as { subscription_details?: { subscription?: unknown } } | undefined;
        const id = typeof object.subscription === 'string' ? object.subscription : parent?.subscription_details?.subscription;
        if (typeof id === 'string') return paidBy(id);
      }
      return null;
    },
  };
  return Object.freeze(billing);
}
