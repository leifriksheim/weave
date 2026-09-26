/**
 * Hosting: a carrier for many accounts that never sleeps. Subscriptions that
 * are paid, in their grace period or lapsed; spaces carried once however many
 * pay for them; an API where every call is signed by the subscription; and
 * a description, signed statuses, and a pay page opened with a signed link,
 * where Stripe and USDC from a wallet (on a fake network) pay.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createNode } from '../src/node/node.js';
import { createHostNode, type HostNode } from '../src/node/host.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import {
  createHostClient,
  describeHost,
  HostError,
  newSubscriptionSeed,
  payLink,
  readStatus,
  signRequest,
  subscriptionKey,
  verifyPayLink,
  verifyRequest,
  type SubscriptionKey,
} from '../src/session/hosting.js';
import { startHost } from '../cli/src/host.js';
import { createStripeBilling, verifyStripeSignature } from '../cli/src/stripe.js';
import { allowList, checkExposure, walletFromEnv } from '../cli/src/host-setup.js';
import { createWalletPayments, NETWORKS, toUnits } from '../cli/src/wallet.js';
import { createMemoryBlobStore } from '../src/storage/blob/memory.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';

const provider = createP256Provider();
const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

const onHub = (hub: FakeHub) => ({ transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] });

async function account() {
  const manager = createIdentityManager();
  const seed = generateSeed();
  const identity = await manager.fromSeed(seed);
  return { did: identity.did, signer: createLocalRootSigner(identity, manager.getProvider()), accountKey: await deriveVaultKeyBytes(seed) };
}
type Account = Awaited<ReturnType<typeof account>>;

async function device(me: Account, hub: FakeHub): Promise<P2PNode> {
  const node = await createNode({ signer: me.signer, stores: memoryStores(), accountKey: me.accountKey, watchIntervalMs: 0, network: onHub(hub) });
  open.push(node);
  return node;
}

async function host(hub: FakeHub, options: { now?: () => number; free?: boolean } = {}): Promise<HostNode> {
  const node = await createHostNode({ key: await provider.generateKeyPair(), stores: memoryStores(), network: onHub(hub), watchIntervalMs: 0, ...options });
  open.push(node);
  return node;
}

async function until(check: () => Promise<boolean>, ms = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const carries = (node: HostNode, spaceId: string) => async () => (await node.spaces()).some((space) => space.id === spaceId);
const subscriptionId = async () => (await subscriptionKey(newSubscriptionSeed())).did;
const YEAR = 365 * 24 * 3600;
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The pay page's calls, made with a pay link the way the page makes them */
async function payPage(base: string, hostDid: string, key: SubscriptionKey) {
  const params = new URLSearchParams(new URL(await payLink(`${base}/pay`, hostDid, key)).hash.slice(1));
  const authorization = `WeavePay s=${params.get('s')}, at=${params.get('at')}, sig=${params.get('sig')}`;
  return async <T = Record<string, unknown>>(method: string, path = '', body?: unknown): Promise<{ status: number; answer: T }> => {
    const response = await fetch(`${base}/pay/api${path}`, {
      method,
      headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, answer: (await response.json()) as T };
  };
}

describe('a host', () => {
  test('carries an account’s spaces once its subscription is paid — and not before', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const me = await account();
    const laptop = await device(me, hub);
    const notes = await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    const node = await host(hub);
    const { invite } = await laptop.carriers.add({ did: node.did, name: 'Weave hosting' });

    const id = await subscriptionId();
    await node.subscribe(id);
    await assert.rejects(node.attach(id, me.did, invite), /not paid/);

    await node.extend(id, nowSeconds() + YEAR);
    await node.attach(id, me.did, invite);
    await until(carries(node, notes.id), 5000, 'the space to be carried');
    assert.ok((await node.carriedFor(id)) >= 1);
  });

  test('two devices never online together meet through it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const me = await account();
    const laptop = await device(me, hub);
    const notes = await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    await laptop.records.put(notes.id, 'note', { text: 'kept online' });
    const node = await host(hub, { free: true });
    const id = await subscriptionId();
    await node.subscribe(id);
    await node.attach(id, me.did, (await laptop.carriers.add({ did: node.did, name: 'Weave hosting' })).invite);
    await until(carries(node, notes.id), 5000, 'the space to be carried');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await laptop.close();

    const phone = await device(me, hub);
    await until(async () => (await phone.spaces.list()).some((space) => space.id === notes.id), 5000, 'the phone to learn of the space');
    await until(async () => (await phone.records.list(notes.id)).length === 1, 5000, 'the note to reach the phone');
    assert.deepEqual((await phone.records.list(notes.id))[0]?.body, { text: 'kept online' });
  });

  test('a space two paying accounts share is carried once, and stays while either pays', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const [alice, bob] = [await account(), await account()];
    const [aliceNode, bobNode] = [await device(alice, hub), await device(bob, hub)];
    const shared = await aliceNode.spaces.create({ name: 'Family', visibility: 'private' });
    await bobNode.spaces.join(await aliceNode.spaces.invite(shared.id));
    const node = await host(hub);
    const [a, b] = [await subscriptionId(), await subscriptionId()];
    for (const id of [a, b]) await node.extend(id, nowSeconds() + YEAR);
    await node.attach(a, alice.did, (await aliceNode.carriers.add({ did: node.did, name: 'Host' })).invite);
    await node.attach(b, bob.did, (await bobNode.carriers.add({ did: node.did, name: 'Host' })).invite);
    await until(carries(node, shared.id), 5000, 'the shared space to be carried');
    assert.equal((await node.spaces()).filter((space) => space.id === shared.id).length, 1);

    await node.detach(a);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await carries(node, shared.id)(), true, 'Bob still pays for it');
    await node.detach(b);
    await until(async () => !(await carries(node, shared.id)()), 5000, 'the space to be let go');
  });

  test('past paid-until: a grace period, still carried; past that, dropped', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const me = await account();
    const laptop = await device(me, hub);
    const notes = await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    let clock = nowSeconds();
    const node = await host(hub, { now: () => clock });
    const id = await subscriptionId();
    await node.extend(id, clock + 10);
    await node.attach(id, me.did, (await laptop.carriers.add({ did: node.did, name: 'Host' })).invite);
    await until(carries(node, notes.id), 5000, 'the space to be carried');

    clock += 20;
    assert.equal(node.state((await node.get(id))!), 'grace');
    assert.deepEqual(await node.sweep(), []);
    assert.equal(await carries(node, notes.id)(), true);

    clock += 31 * 24 * 3600;
    assert.equal(node.state((await node.get(id))!), 'lapsed');
    assert.deepEqual(await node.sweep(), [id]);
    assert.equal(await node.get(id), null);
    await until(async () => !(await carries(node, notes.id)()), 5000, 'the space to be dropped');
  });
});

describe('signed calls', () => {
  test('a request is the subscription’s only if signed by it, over exactly what it asks, recently', async () => {
    const key = await subscriptionKey(newSubscriptionSeed());
    const header = await signRequest(key, 'PUT', '/host/x/carry', '{"a":1}');
    assert.equal(await verifyRequest(header, 'PUT', '/host/x/carry', '{"a":1}'), key.did);
    assert.equal(await verifyRequest(header, 'PUT', '/host/x/carry', '{"a":2}'), null, 'another body');
    assert.equal(await verifyRequest(header, 'DELETE', '/host/x/carry', '{"a":1}'), null, 'another method');
    assert.equal(await verifyRequest(header, 'PUT', '/host/y/carry', '{"a":1}'), null, 'another path');
    const old = await signRequest(key, 'GET', '/host', '', provider, nowSeconds() - 600);
    assert.equal(await verifyRequest(old, 'GET', '/host', ''), null, 'too old');
  });
});

describe('the host API', () => {
  async function running(hub: FakeHub, options: Partial<Parameters<typeof startHost>[0]> = {}) {
    const served = await startHost({ key: await provider.generateKeyPair(), stores: memoryStores(), port: 0, ...options });
    open.push(served);
    return served;
  }

  test('a free host takes any subscription; only the subscription itself may ask about it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const served = await running(hub, { free: true });
    const url = `http://127.0.0.1:${served.port}`;
    const key = await subscriptionKey(newSubscriptionSeed());

    const info = await describeHost(url);
    assert.equal(info.did, served.node.did);
    assert.equal(info.free, true);
    assert.equal(info.pay, undefined, 'a free host has no pay page');
    const client = createHostClient(url, info.did, key);

    const me = await account();
    const laptop = await device(me, hub);
    await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    const { invite } = await laptop.carriers.add({ did: info.did, name: 'Host' });
    const { status, receipt } = await client.attach(me.did, invite);
    assert.equal(status.state, 'active');
    assert.equal(status.carrying, true);
    assert.deepEqual(await readStatus(receipt, served.node.did), status, 'signed by the host');
    assert.equal(await readStatus({ ...receipt, payload: receipt.payload.replace('"active"', '"lapsed"') }, served.node.did), null, 'and only as it was said');
    // A client that expects another host's key refuses what this one signs.
    await assert.rejects(createHostClient(url, 'did:key:zDnaeSomeoneElse', key).status(), /isn't signed by the host/);

    // Someone else's key, asking about this subscription.
    const other = await subscriptionKey(newSubscriptionSeed());
    const response = await fetch(`${url}/host/subscriptions/${encodeURIComponent(key.did)}`, {
      headers: { authorization: await signRequest(other, 'GET', `/host/subscriptions/${encodeURIComponent(key.did)}`) },
    });
    assert.equal(response.status, 401);
    assert.equal((await fetch(`${url}/host/subscriptions/${encodeURIComponent(key.did)}`)).status, 401, 'unsigned');
  });

  test('a paying host refuses to carry until paid; its pay page starts Stripe, whose webhook moves the date once', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const key = await subscriptionKey(newSubscriptionSeed());
    const periodEnd = nowSeconds() + 30 * 24 * 3600;
    const stripeCalls: string[] = [];
    let returnUrl: string | null = null;
    const billing = createStripeBilling({
      secretKey: 'sk_test_x',
      webhookSecret: 'whsec_test',
      monthlyPrice: 'price_month',
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const target = String(input);
        stripeCalls.push(`${init?.method ?? 'GET'} ${new URL(target).pathname}`);
        if (target.endsWith('/v1/checkout/sessions')) {
          assert.match(String(init?.body), /subscription_data%5Bmetadata%5D%5Bweave_subscription%5D=did%3Akey/);
          returnUrl = new URLSearchParams(String(init?.body)).get('success_url');
          return Response.json({ url: 'https://checkout.stripe.test/c/1' });
        }
        if (target.includes('/v1/subscriptions/sub_1')) {
          return Response.json({ id: 'sub_1', customer: 'cus_1', metadata: { weave_subscription: key.did }, items: { data: [{ current_period_end: periodEnd }] } });
        }
        if (target.endsWith('/v1/billing_portal/sessions')) return Response.json({ url: 'https://billing.stripe.test/p/1' });
        return Response.json({ error: { message: 'unexpected' } }, { status: 400 });
      }) as typeof fetch,
    });
    const served = await running(hub, { billing, name: 'Test Hosting', price: '$4 a month' });
    const url = `http://127.0.0.1:${served.port}`;
    const client = createHostClient(url, served.node.did, key);

    const info = await describeHost(url);
    assert.deepEqual({ name: info.name, price: info.price, pay: info.pay, free: info.free }, { name: 'Test Hosting', price: '$4 a month', pay: '/pay', free: false });
    const me = await account();
    const laptop = await device(me, hub);
    const { invite } = await laptop.carriers.add({ did: served.node.did, name: 'Host' });
    await assert.rejects(client.attach(me.did, invite), (error: unknown) => error instanceof HostError && error.status === 402);

    // The pay page: the page itself for anyone, its API only with a pay link.
    const page = await fetch(`${url}/pay`);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.match(await page.text(), /Test Hosting/);
    assert.equal((await fetch(`${url}/pay/api`)).status, 401);
    const pay = await payPage(url, served.node.did, key);
    const state = await pay<{ status: { state: string }; card: Array<{ id: string }>; wallet: unknown }>('GET');
    assert.equal(state.answer.status.state, 'none');
    assert.deepEqual(state.answer.card, [{ id: 'monthly', label: 'Monthly' }]);
    assert.equal(state.answer.wallet, null);
    assert.equal((await pay<{ url: string }>('POST', '/card', { plan: 'monthly' })).answer.url, 'https://checkout.stripe.test/c/1');
    assert.equal(returnUrl, `${url}/pay?paid=card`, 'Stripe sends people back to the pay page, never to the home');
    assert.equal((await pay('POST', '/card', { plan: 'weekly' })).status, 400);
    assert.equal((await pay('POST', '/manage')).status, 404, 'nothing paid by card yet');

    const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { subscription: 'sub_1' } } });
    const webhook = (body: string, secret = 'whsec_test') => {
      const t = nowSeconds();
      const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
      return fetch(`${url}/host/billing/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${v1}` }, body });
    };
    // A forged call first: not Stripe's, so nothing moves.
    assert.equal((await webhook(event, 'whsec_wrong')).status, 200);
    assert.equal((await client.status()).status.state, 'lapsed');

    await webhook(event);
    await webhook(event);
    const { status } = await client.status();
    assert.equal(status.state, 'active');
    assert.equal(status.paidUntil, periodEnd);
    assert.equal(status.renews, true);
    assert.equal((await client.attach(me.did, invite)).status.carrying, true);
    assert.equal(stripeCalls.filter((call) => call.startsWith('GET /v1/subscriptions')).length, 2);
    assert.equal((await pay<{ url: string }>('POST', '/manage')).answer.url, 'https://billing.stripe.test/p/1');
  });

  test('a pay link: this subscription, this host, for an hour', async () => {
    const host = await subscriptionId(); // any key stands in for the host's
    const key = await subscriptionKey(newSubscriptionSeed());
    const at = nowSeconds();
    const link = new URL(await payLink('https://host.test/pay', host, key, provider, at));
    assert.equal(link.search, '', 'nothing in what the browser sends');
    const params = new URLSearchParams(link.hash.slice(1));
    const header = `WeavePay s=${params.get('s')}, at=${params.get('at')}, sig=${params.get('sig')}`;
    assert.equal(await verifyPayLink(header, host, provider, at + 10), key.did);
    assert.equal(await verifyPayLink(header, host, provider, at + 3601), null, 'an hour old');
    assert.equal(await verifyPayLink(header, 'did:key:zDnaeAnotherHost', provider, at), null, 'at another host');
    assert.equal(await verifyPayLink(header.replace(/at=\d+/, `at=${at + 1}`), host, provider, at), null, 'another time');
  });
});

describe('Stripe signatures', () => {
  test('only a recent HMAC under the webhook secret counts', () => {
    const body = '{"type":"invoice.paid"}';
    const t = 1_700_000_000;
    const v1 = createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex');
    assert.equal(verifyStripeSignature(body, `t=${t},v1=${v1}`, 'whsec', t + 10), true);
    assert.equal(verifyStripeSignature(body, `t=${t},v1=${v1}`, 'whsec', t + 1000), false, 'too old');
    assert.equal(verifyStripeSignature(`${body} `, `t=${t},v1=${v1}`, 'whsec', t), false, 'another body');
    assert.equal(verifyStripeSignature(body, `t=${t},v1=00`, 'whsec', t), false);
    assert.equal(verifyStripeSignature(body, undefined, 'whsec', t), false);
  });
});

describe('an account using a host, end to end over sockets', () => {
  async function onSockets(me: Account, port: number): Promise<P2PNode> {
    const node = await createNode({
      signer: me.signer,
      stores: memoryStores(),
      accountKey: me.accountKey,
      watchIntervalMs: 0,
      network: { nodes: [`ws://127.0.0.1:${port}/peer`] },
    });
    open.push(node);
    return node;
  }

  test('a paying host: the home only opens its pay page, and hands over the spaces once the webhook says paid', async () => {
    let paidFor: string | null = null;
    const periodEnd = nowSeconds() + 365 * 24 * 3600;
    const billing = createStripeBilling({
      secretKey: 'sk_test_x',
      webhookSecret: 'whsec_test',
      yearlyPrice: 'price_year',
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const target = String(input);
        if (target.endsWith('/v1/checkout/sessions')) {
          paidFor = new URLSearchParams(String(init?.body)).get('client_reference_id');
          return Response.json({ url: 'https://checkout.stripe.test/c/2' });
        }
        return Response.json({ id: 'sub_2', customer: 'cus_2', metadata: { weave_subscription: paidFor }, items: { data: [{ current_period_end: periodEnd }] } });
      }) as typeof fetch,
    });
    const served = await startHost({ key: await provider.generateKeyPair(), stores: memoryStores(), port: 0, billing, name: 'Test Hosting', price: '$36 a year' });
    open.push(served);
    const url = `http://127.0.0.1:${served.port}`;
    const me = await account();
    const laptop = await onSockets(me, served.port);
    await laptop.spaces.create({ name: 'Notes', visibility: 'private' });

    const before = await laptop.hosting.use(url);
    assert.deepEqual({ name: before.name, price: before.price, pays: before.pays, live: before.live }, { name: 'Test Hosting', price: '$36 a year', pays: true, live: true });
    assert.equal(before.status?.carrying, false);

    // What the home opens: the host's page, with the subscription's signature in the fragment.
    const link = new URL(await laptop.hosting.payPage(url));
    assert.equal(`${link.origin}${link.pathname}`, `${url}/pay`);
    const params = new URLSearchParams(link.hash.slice(1));
    assert.equal(params.get('s'), before.subscription);
    const authorization = `WeavePay s=${params.get('s')}, at=${params.get('at')}, sig=${params.get('sig')}`;
    const checkout = await fetch(`${url}/pay/api/card`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'yearly' }) });
    assert.equal(((await checkout.json()) as { url: string }).url, 'https://checkout.stripe.test/c/2');
    assert.equal(paidFor, before.subscription);

    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { subscription: 'sub_2' } } });
    const t = nowSeconds();
    const v1 = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
    await fetch(`${url}/host/billing/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${v1}` }, body });

    // Back in the home, it asks again: the host is paid for now, and takes the spaces.
    const after = await laptop.hosting.use(url);
    assert.equal(after.status?.state, 'active');
    assert.equal(after.status?.carrying, true);
    assert.equal(after.status?.paidUntil, periodEnd);

    // The host's signed word is kept in the registry: with the host gone, the home still knows, and says so.
    await served.close();
    open.splice(open.indexOf(served), 1);
    const offline = (await laptop.hosting.list())[0]!;
    assert.equal(offline.live, false);
    assert.equal(offline.status?.paidUntil, periodEnd);
    assert.equal(offline.name, 'Test Hosting');
  });

  test('one call on the laptop; with the laptop gone, a new phone gets everything from the host', async () => {
    const served = await startHost({ key: await provider.generateKeyPair(), stores: memoryStores(), port: 0, free: true });
    open.push(served);
    const url = `http://127.0.0.1:${served.port}`;
    const me = await account();

    const laptop = await onSockets(me, served.port);
    const notes = await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    await laptop.records.put(notes.id, 'note', { text: 'safe with the host' });
    const view = await laptop.hosting.use(url);
    assert.equal(view.status?.carrying, true);
    assert.equal(view.host, served.node.did);
    await until(carries(served.node, notes.id), 5000, 'the host to carry the space');
    // Sockets the host refused before it carried a space come back on their own, after a backoff.
    await until(
      async () => {
        const reached = (await served.node.spaces()).filter((space) => space.peers > 0).map((space) => space.name);
        return reached.includes('Account registry') && reached.includes('Notes');
      },
      15_000,
      'the laptop to reach the host in its registry and its space',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await laptop.close();

    const phone = await onSockets(me, served.port);
    await until(async () => (await phone.spaces.list()).some((space) => space.id === notes.id), 8000, 'the phone to learn of the space');
    await until(async () => (await phone.records.list(notes.id)).length === 1, 8000, 'the note to reach the phone');
    assert.deepEqual((await phone.records.list(notes.id))[0]?.body, { text: 'safe with the host' });
    // Every device knows the host from the registry, with nothing set up.
    assert.deepEqual((await phone.hosting.list()).map((known) => known.url), [url]);
  });
});

describe('a host whose disk is only a cache', () => {
  test('lose the disk, start again on the same bucket: every subscription and space comes back, still sealed', async () => {
    const bucket = createMemoryBlobStore();
    const hostKeys = await provider.generateKeyPair();
    const start = async () => {
      const served = await startHost({ key: hostKeys, stores: memoryStores(), port: 0, free: true, mirror: bucket });
      open.push(served);
      return served;
    };
    const onSockets = async (me: Account, port: number) => {
      const node = await createNode({ signer: me.signer, stores: memoryStores(), accountKey: me.accountKey, watchIntervalMs: 0, network: { nodes: [`ws://127.0.0.1:${port}/peer`] } });
      open.push(node);
      return node;
    };

    const first = await start();
    const me = await account();
    const laptop = await onSockets(me, first.port);
    const notes = await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    await laptop.records.put(notes.id, 'note', { text: 'in the bucket' });
    await laptop.hosting.use(`http://127.0.0.1:${first.port}`);
    await until(
      async () => {
        const reached = (await first.node.spaces()).filter((space) => space.peers > 0).map((space) => space.name);
        return reached.includes('Account registry') && reached.includes('Notes');
      },
      15_000,
      'the laptop to reach the host',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await laptop.close();
    // Closing flushes what was waiting: the bucket holds it all now.
    await first.close();
    const everything = new TextDecoder().decode(new Uint8Array((await Promise.all((await bucket.list('')).map((key) => bucket.get(key)))).flatMap((bytes) => [...(bytes ?? [])])));
    assert.equal(everything.includes('in the bucket'), false, 'sealed, as it travels');

    // A new machine: an empty disk, the same key and bucket.
    const second = await start();
    assert.equal((await second.node.list()).length, 1, 'the subscription came back');
    await until(carries(second.node, notes.id), 8000, 'the space to be carried again');

    const phone = await onSockets(me, second.port);
    await until(async () => (await phone.records.list(notes.id).catch(() => [])).length === 1, 15_000, 'the note to reach a new phone');
    assert.deepEqual((await phone.records.list(notes.id))[0]?.body, { text: 'in the bucket' });
  });
});

describe('a host for named accounts only', () => {
  test('it carries for the accounts it was told, and turns everyone else away before keeping anything', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const [me, stranger] = [await account(), await account()];
    const served = await startHost({ key: await provider.generateKeyPair(), stores: memoryStores(), port: 0, free: true, allow: [me.did] });
    open.push(served);
    const url = `http://127.0.0.1:${served.port}`;

    const mine = await device(me, hub);
    await mine.spaces.create({ name: 'Notes', visibility: 'private' });
    const myKey = await subscriptionKey(newSubscriptionSeed());
    const { status } = await createHostClient(url, served.node.did, myKey).attach(me.did, (await mine.carriers.add({ did: served.node.did, name: 'Host' })).invite);
    assert.equal(status.carrying, true);

    const theirs = await device(stranger, hub);
    await theirs.spaces.create({ name: 'Mine now?', visibility: 'private' });
    const theirKey = await subscriptionKey(newSubscriptionSeed());
    await assert.rejects(
      createHostClient(url, served.node.did, theirKey).attach(stranger.did, (await theirs.carriers.add({ did: served.node.did, name: 'Host' })).invite),
      (error: unknown) => error instanceof HostError && error.status === 403,
    );
    assert.deepEqual((await served.node.list()).map((subscription) => subscription.id), [myKey.did], 'nothing kept for the stranger');
  });

  test('the host node itself refuses them too, whatever the API', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const stranger = await account();
    const node = await createHostNode({ key: await provider.generateKeyPair(), stores: memoryStores(), network: onHub(hub), free: true, allow: ['did:key:zSomeoneElse'] });
    open.push(node);
    const theirs = await device(stranger, hub);
    const id = await subscriptionId();
    await node.subscribe(id);
    await assert.rejects(node.attach(id, stranger.did, (await theirs.carriers.add({ did: node.did, name: 'Host' })).invite), /only carries spaces for the accounts/);
  });

  test('a free host anyone could reach refuses to start unless it names its accounts', () => {
    assert.doesNotThrow(() => checkExposure({ free: true, allow: null }));
    assert.doesNotThrow(() => checkExposure({ host: '127.0.0.1', free: true, allow: null }));
    assert.throws(() => checkExposure({ host: '0.0.0.0', free: true, allow: null }), /--allow/);
    assert.doesNotThrow(() => checkExposure({ host: '0.0.0.0', free: true, allow: ['did:key:zA'] }));
    assert.doesNotThrow(() => checkExposure({ host: '0.0.0.0', free: false, allow: null }), 'a paying host is open to anyone who pays');

    assert.equal(allowList(undefined, {}), null);
    assert.deepEqual(allowList(['did:key:zA'], { WEAVE_HOST_ALLOW: 'did:key:zB, did:key:zA' }), ['did:key:zA', 'did:key:zB']);
    assert.throws(() => allowList(['alice'], {}), /not an account DID/);
  });
});

/**
 * A network node that knows a few transactions: each a USDC transfer (or
 * anything else) in a block, and a chain `latest` blocks long.
 */
function fakeChain() {
  const HOST_ADDRESS = '0x1111111111111111111111111111111111111111';
  const word = (hex: string) => `0x${hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
  const chain = {
    latest: 100,
    txs: new Map<string, { status: string; block: number; time: number; logs: Array<{ address: string; topics: string[]; data: string }> }>(),
    calls: 0,
    /** A transfer of `amount` (smallest units) to `to`, in block `block` */
    send(amount: bigint | string, options: { block?: number; time?: number; to?: string; token?: string; status?: string } = {}) {
      const tx = `0x${(chain.txs.size + 1).toString(16).padStart(64, 'a')}`;
      chain.txs.set(tx, {
        status: options.status ?? '0x1',
        block: options.block ?? chain.latest,
        time: options.time ?? nowSeconds(),
        logs: [
          {
            address: options.token ?? NETWORKS['base-sepolia'].usdc,
            topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', word('0x2222222222222222222222222222222222222222'), word(options.to ?? HOST_ADDRESS)],
            data: word(BigInt(amount).toString(16)),
          },
        ],
      });
      return tx;
    },
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      chain.calls++;
      const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const answer = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
      if (method === 'eth_blockNumber') return answer(`0x${chain.latest.toString(16)}`);
      if (method === 'eth_getTransactionReceipt') {
        const found = chain.txs.get(String(params[0]));
        if (!found || found.block > chain.latest) return answer(null);
        return answer({ status: found.status, blockNumber: `0x${found.block.toString(16)}`, logs: found.logs });
      }
      if (method === 'eth_getBlockByNumber') {
        const found = [...chain.txs.values()].find((tx) => `0x${tx.block.toString(16)}` === params[0]);
        return answer({ timestamp: `0x${(found?.time ?? nowSeconds()).toString(16)}` });
      }
      return Response.json({ jsonrpc: '2.0', id, error: { message: `unexpected ${method}` } });
    }) as typeof fetch,
  };
  const wallet = createWalletPayments({ network: 'base-sepolia', to: HOST_ADDRESS, monthly: '4', yearly: '36', fetch: chain.fetch });
  return { chain, wallet, HOST_ADDRESS };
}

describe('wallet payments', () => {
  test('prices, and amounts marked apart by a fraction of a cent', () => {
    assert.equal(toUnits('36'), 36_000_000n);
    assert.equal(toUnits('4.5'), 4_500_000n);
    assert.throws(() => toUnits('36.001'), /not a price/);
    const { wallet } = fakeChain();
    assert.deepEqual(wallet.offer.plans.map((plan) => [plan.id, plan.price]), [['yearly', '36'], ['monthly', '4']]);
    const taken = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const amount = BigInt(wallet.payment('yearly', taken).amount);
      assert.ok(amount > 36_000_000n && amount < 36_010_000n, 'less than a cent over the price');
      assert.ok(!taken.has(amount.toString()), 'never an amount already open');
      taken.add(amount.toString());
    }
    assert.equal(wallet.extend('yearly', Date.UTC(2026, 8, 25) / 1000), Date.UTC(2027, 8, 25) / 1000);
    assert.equal(wallet.extend('monthly', Date.UTC(2026, 0, 15) / 1000), Date.UTC(2026, 1, 15) / 1000);
  });

  test('a transaction counts once confirmed, and only what reached this host in USDC', async () => {
    const { chain, wallet } = fakeChain();
    assert.deepEqual(await wallet.check('0x1234'), { state: 'failed', reason: 'That is not a transaction hash' });
    assert.deepEqual(await wallet.check(`0x${'f'.repeat(64)}`), { state: 'waiting' }, 'not on the chain yet');
    const tx = chain.send(36_004_217n, { block: 100 });
    assert.deepEqual(await wallet.check(tx), { state: 'waiting' }, 'one block is not enough');
    chain.latest = 102;
    const sent = await wallet.check(tx);
    assert.equal(sent.state, 'sent');
    assert.deepEqual(sent.state === 'sent' && sent.amounts, ['36004217']);

    assert.equal((await wallet.check(chain.send(36_004_217n, { block: 90, to: '0x3333333333333333333333333333333333333333' }))).state, 'failed', 'to someone else');
    assert.equal((await wallet.check(chain.send(36_004_217n, { block: 90, token: '0x4444444444444444444444444444444444444444' }))).state, 'failed', 'another token');
    assert.equal((await wallet.check(chain.send(36_004_217n, { block: 90, status: '0x0' }))).state, 'failed', 'reverted');
  });

  test('the pay page: an amount per subscription, the same when asked again; the date moves once per transaction', async () => {
    const { chain, wallet } = fakeChain();
    const served = await startHost({ key: await provider.generateKeyPair(), stores: memoryStores(), port: 0, wallet });
    open.push(served);
    const url = `http://127.0.0.1:${served.port}`;
    const key = await subscriptionKey(newSubscriptionSeed());
    type Payment = { plan: string; to: string; amount: string };
    type Status = { state: string; paidUntil: number; renews: boolean };

    const info = await describeHost(url);
    assert.equal(info.price, '$4 a month or $36 a year', 'from the wallet prices');
    const pay = await payPage(url, served.node.did, key);
    const state = await pay<{ wallet: { chainId: number; to: string }; card: unknown[]; walletConnect: string | null }>('GET');
    assert.equal(state.answer.wallet.chainId, 84532);
    assert.deepEqual(state.answer.card, [], 'no card plans without Stripe');
    assert.equal(state.answer.walletConnect, null, 'no WalletConnect without a project id');

    const payment = (await pay<Payment>('POST', '/wallet', { plan: 'yearly' })).answer;
    assert.equal(payment.to, state.answer.wallet.to);
    assert.equal((await pay<Payment>('POST', '/wallet', { plan: 'yearly' })).answer.amount, payment.amount, 'asked again, the same amount');
    const theirs = await payPage(url, served.node.did, await subscriptionKey(newSubscriptionSeed()));
    const theirPayment = (await theirs<Payment>('POST', '/wallet', { plan: 'yearly' })).answer;
    assert.notEqual(theirPayment.amount, payment.amount);

    // Someone else's payment, or one made before this one was asked for, pays nothing here.
    chain.latest = 110;
    const wrong = chain.send(BigInt(theirPayment.amount), { block: 105 });
    assert.match((await pay<{ error: string }>('POST', '/wallet/claim', { tx: wrong })).answer.error, /different amount/);
    const early = chain.send(BigInt(payment.amount), { block: 104, time: nowSeconds() - 3600 });
    assert.match((await pay<{ error: string }>('POST', '/wallet/claim', { tx: early })).answer.error, /not made while this payment was open/);

    const tx = chain.send(BigInt(payment.amount), { block: 111 });
    assert.equal((await pay('POST', '/wallet/claim', { tx })).status, 202, 'not confirmed yet');
    chain.latest = 113;
    const paid = await pay<Status>('POST', '/wallet/claim', { tx });
    assert.equal(paid.status, 200);
    assert.equal(paid.answer.state, 'active');
    assert.equal(paid.answer.renews, false, 'time paid up front');
    assert.ok(Math.abs(paid.answer.paidUntil - (nowSeconds() + 365 * 24 * 3600)) < 2 * 24 * 3600);
    assert.equal((await pay('POST', '/wallet/claim', { tx })).status, 409, 'counted once');
    assert.ok([400, 409].includes((await theirs('POST', '/wallet/claim', { tx })).status), "and never for someone else's subscription");

    // Paying again adds a month on top of the year.
    const again = (await pay<Payment>('POST', '/wallet', { plan: 'monthly' })).answer;
    assert.notEqual(again.amount, payment.amount);
    chain.latest = 120;
    const more = await pay<Status>('POST', '/wallet/claim', { tx: chain.send(BigInt(again.amount), { block: 117 }) });
    assert.ok(more.answer.paidUntil > paid.answer.paidUntil + 27 * 24 * 3600);
  });

  test('from the env: an address and a price, or nothing', () => {
    assert.equal(walletFromEnv({}), null);
    assert.throws(() => walletFromEnv({ WEAVE_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111' }), /need a price/);
    assert.throws(() => walletFromEnv({ WEAVE_WALLET_ADDRESS: 'me', WEAVE_WALLET_YEARLY: '36' }), /not an address/);
    assert.throws(() => walletFromEnv({ WEAVE_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111', WEAVE_WALLET_YEARLY: '36', WEAVE_WALLET_NETWORK: 'solana' }), /base or base-sepolia/);
    assert.equal(walletFromEnv({ WEAVE_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111', WEAVE_WALLET_YEARLY: '36' })?.offer.chainId, 8453);
  });

  test('an account pays from a wallet on the pay page, and the host takes its spaces', async () => {
    const { chain, wallet } = fakeChain();
    const served = await startHost({ key: await provider.generateKeyPair(), stores: memoryStores(), port: 0, wallet });
    open.push(served);
    const url = `http://127.0.0.1:${served.port}`;
    const me = await account();
    const laptop = await createNode({
      signer: me.signer,
      stores: memoryStores(),
      accountKey: me.accountKey,
      watchIntervalMs: 0,
      network: { nodes: [`ws://127.0.0.1:${served.port}/peer`] },
    });
    open.push(laptop);
    await laptop.spaces.create({ name: 'Notes', visibility: 'private' });

    const before = await laptop.hosting.use(url);
    assert.equal(before.pays, true);
    assert.equal(before.status?.carrying, false);
    const params = new URLSearchParams(new URL(await laptop.hosting.payPage(url)).hash.slice(1));
    const authorization = `WeavePay s=${params.get('s')}, at=${params.get('at')}, sig=${params.get('sig')}`;
    const call = (path: string, body: unknown) =>
      fetch(`${url}/pay/api${path}`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payment = (await (await call('/wallet', { plan: 'yearly' })).json()) as { amount: string };
    chain.latest = 200;
    assert.equal((await call('/wallet/claim', { tx: chain.send(BigInt(payment.amount), { block: 198 }) })).status, 200);

    // Back in the home, one more look: paid, so the spaces go over.
    const after = (await laptop.hosting.list())[0]!;
    assert.equal(after.status?.state, 'active');
    assert.equal(after.status?.carrying, true);
  });
});
