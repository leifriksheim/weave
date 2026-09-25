/**
 * `weave host`: a hosting service in one process.
 *
 * A host node (`src/node/host.ts`) carrying every subscription's spaces, served
 * the way `weave run` serves: sockets at `/peer?space=`, the relay on every
 * other path. Plus a small API under `/host`, where every call about a
 * subscription is signed with its key (`src/session/hosting.ts`):
 *
 *   GET    /host                                  who the host is, what it offers
 *   GET    /host/subscriptions/:id                paid until, carrying, how many spaces
 *   PUT    /host/subscriptions/:id/carry          { account, invite } — the account's carry space
 *   DELETE /host/subscriptions/:id/carry
 *   POST   /host/subscriptions/:id/checkout       { plan, returnUrl } → a payment page
 *   POST   /host/subscriptions/:id/manage         { returnUrl } → the provider's billing page
 *   POST   /host/billing/webhook                  the payment provider, telling us someone paid
 *
 * Payment is behind one small interface (`Billing`), so the host only ever
 * learns "this subscription is paid until …". Without one, and with `free`,
 * every subscription counts as paid — someone hosting only themselves.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHostNode, NotAllowedError, verifyRequest, createP256Provider, type BlobStore, type HostNode, type HostStatus, type StoreFactory } from '../../src/index.js';
import { createInboundPeers, serve, type Served } from './serve.js';

/** What the host needs from a payment provider */
export interface Billing {
  readonly plans: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  /** A payment page for a subscription; paying it leads to a webhook call */
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
  readonly billing?: Billing | null;
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
const SUBSCRIPTION_PATH = /^\/host\/subscriptions\/(did%3Akey%3Az[1-9A-HJ-NP-Za-km-z]{1,120}|did:key:z[1-9A-HJ-NP-Za-km-z]{1,120})(\/(carry|checkout|manage))?$/;

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

/** Where a payment page may send someone back to: an https page, or one on this machine */
function checkReturnUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2000) throw new Refusal(400, 'A return address is needed');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Refusal(400, 'The return address is not a URL');
  }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Refusal(400, 'The return address must be https://');
  return url.toString();
}

export async function startHost(options: HostOptions): Promise<RunningHost> {
  const log = options.log ?? (() => {});
  const provider = createP256Provider();
  const inbound = createInboundPeers();
  const billing = options.billing ?? null;
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
    if (!subscription) return { subscription: id, state: 'none', paidUntil: 0, carrying: false, spaces: 0 };
    return {
      subscription: id,
      state: node.state(subscription),
      paidUntil: subscription.paidUntil,
      carrying: subscription.carry !== undefined,
      spaces: await node.carriedFor(id),
    };
  };

  async function routes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://host');
    if (!url.pathname.startsWith('/host')) return false;
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
    if (url.pathname === '/host' && method === 'GET') {
      return send(res, 200, { did: node.did, free: !!options.free, plans: billing?.plans ?? [] });
    }

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
    const action = match[3] ?? null;
    const body = await readBody(req);
    // Only the subscription's own key may ask about it or change it.
    const signer = await verifyRequest(req.headers.authorization, method, `${url.pathname}${url.search}`, body, provider);
    if (signer !== id) throw new Refusal(401, 'That call is not signed by the subscription');
    const input = (body ? JSON.parse(body) : {}) as Record<string, unknown>;

    if (action === null && method === 'GET') return send(res, 200, await statusOf(id));

    if (action === 'carry' && method === 'PUT') {
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
      return send(res, 200, await statusOf(id));
    }

    if (action === 'carry' && method === 'DELETE') {
      await node.detach(id);
      return send(res, 200, await statusOf(id));
    }

    if (action === 'checkout' && method === 'POST') {
      if (!billing) throw new Refusal(404, 'This host takes no payments');
      if (typeof input.plan !== 'string' || !billing.plans.some((plan) => plan.id === input.plan)) throw new Refusal(400, 'No such plan');
      const subscription = await node.subscribe(id);
      const url = await billing.checkout({
        subscription: id,
        plan: input.plan,
        returnUrl: checkReturnUrl(input.returnUrl),
        ...(subscription.customer ? { customer: subscription.customer } : {}),
      });
      return send(res, 200, { url });
    }

    if (action === 'manage' && method === 'POST') {
      if (!billing) throw new Refusal(404, 'This host takes no payments');
      const customer = (await node.get(id))?.customer;
      if (!customer) throw new Refusal(404, 'Nothing has been paid for this subscription yet');
      return send(res, 200, { url: await billing.manage({ customer, returnUrl: checkReturnUrl(input.returnUrl) }) });
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

  const who = options.allow ? `, only for ${options.allow.length} account${options.allow.length === 1 ? '' : 's'}` : '';
  log(`host ${node.did} listening on port ${served.port}${options.free ? ' (free: every subscription counts as paid)' : ''}${who}${options.mirror ? ', kept in its bucket' : ', on this disk alone'}`);
  return {
    node,
    port: served.port,
    async close() {
      clearInterval(sweeping);
      await served.close();
      await node.close();
    },
  };
}
