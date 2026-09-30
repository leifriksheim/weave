/**
 * Hosting: a carrier for many accounts that never sleeps. Subscriptions that
 * are paid, in their grace period or lapsed; spaces carried once however many
 * pay for them; an API where every call is signed by the subscription; and
 * a description, signed statuses, and a pay page opened with a signed link,
 * where Stripe and USDC from a wallet (on a fake network) pay.
 */
import { test, describe, afterEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createNode } from '../../core/src/node/node.js';
import { createHostNode, type HostNode } from '../../core/src/node/host.js';
import type { P2PNode } from '../../core/src/node/types.js';
import { createIdentityManager } from '../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../core/src/identity/root-signer.js';
import { createP256Provider } from '../../core/src/identity/crypto-p256.js';
import { generateSeed } from '../../core/src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../../core/src/identity/account-vault.js';
import {
  createHostClient,
  createSpaceHostClient,
  describeHost,
  hostPeerAddress,
  HostError,
  readPayAnswer,
  newSubscriptionSeed,
  readStatus,
  signRequest,
  subscriptionKey,
  verifyRequest,
} from '../../core/src/session/hosting.js';
import { startHost } from '../src/host.js';
import { createStripeBilling, verifyStripeSignature } from '../src/stripe.js';
import { allowList, checkExposure, walletFromEnv } from '../src/host-setup.js';
import { createWalletPayments, NETWORKS, toUnits } from '../src/wallet.js';
import { createMemoryBlobStore } from '../../core/src/storage/blob/memory.js';
import { createFakeHub, type FakeHub } from '../../core/tests/helpers/fake-transport.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';
import { at, bodyOf, urlOf } from './helpers/json.js';
import { until } from '../../core/tests/helpers/until.js';
import { host as hostSchema } from '../../core/src/schemas/library/community.js';
import { team } from '../../core/src/space/presets.js';
import { parseSpaceInvite } from '../../core/src/space/space-manager.js';
import { hold } from '../../core/tests/helpers/hold.js';
import { joined } from '../../core/tests/helpers/joined.js';

const provider = createP256Provider();
const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

const onHub = (hub: FakeHub) => ({
  transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)],
});

async function account() {
  const manager = createIdentityManager();
  const seed = generateSeed();
  const identity = await manager.fromSeed(seed);
  return {
    did: identity.did,
    signer: createLocalRootSigner(identity, manager.getProvider()),
    accountKey: await deriveVaultKeyBytes(seed),
  };
}
type Account = Awaited<ReturnType<typeof account>>;

async function device(me: Account, hub: FakeHub): Promise<P2PNode> {
  const node = await createNode({
    signer: me.signer,
    stores: memoryStores(),
    accountKey: me.accountKey,
    watchIntervalMs: 0,
    network: onHub(hub),
  });
  open.push(node);
  return node;
}

async function host(hub: FakeHub, options: { now?: () => number; free?: boolean } = {}): Promise<HostNode> {
  const node = await createHostNode({
    key: await provider.generateKeyPair(),
    stores: memoryStores(),
    network: onHub(hub),
    watchIntervalMs: 0,
    ...options,
  });
  open.push(node);
  return node;
}

const carries = (node: HostNode, spaceId: string) => async () =>
  (await node.spaces()).some((space) => space.id === spaceId);
const subscriptionId = async () => (await subscriptionKey(newSubscriptionSeed())).did;
const YEAR = 365 * 24 * 3600;
const nowSeconds = () => Math.floor(Date.now() / 1000);

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
    await node.attach(
      id,
      me.did,
      (await laptop.carriers.add({ did: node.did, name: 'Weave hosting' })).invite,
    );
    await until(carries(node, notes.id), 5000, 'the space to be carried');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await laptop.close();

    const phone = await device(me, hub);
    await until(
      async () => (await phone.spaces.list()).some((space) => space.id === notes.id),
      5000,
      'the phone to learn of the space',
    );
    await until(
      async () => (await phone.records.list(notes.id)).length === 1,
      5000,
      'the note to reach the phone',
    );
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
  async function running(options: Partial<Parameters<typeof startHost>[0]> = {}) {
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      ...options,
    });
    open.push(served);
    return served;
  }

  test('a free host takes any subscription; only the subscription itself may ask about it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const served = await running({ free: true });
    const url = `http://127.0.0.1:${served.port}`;
    const key = await subscriptionKey(newSubscriptionSeed());

    const info = await describeHost(url);
    assert.equal(info.did, served.node.did);
    assert.equal(info.free, true);
    assert.equal(info.plans, undefined, 'a free host takes no payments');
    const client = createHostClient(url, info.did, key);

    const me = await account();
    const laptop = await device(me, hub);
    await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    const { invite } = await laptop.carriers.add({ did: info.did, name: 'Host' });
    const { status, receipt } = await client.attach(me.did, invite);
    assert.equal(status.state, 'active');
    assert.equal(status.carrying, true);
    assert.deepEqual(await readStatus(receipt, served.node.did), status, 'signed by the host');
    assert.equal(
      await readStatus(
        { ...receipt, payload: receipt.payload.replace('"active"', '"lapsed"') },
        served.node.did,
      ),
      null,
      'and only as it was said',
    );
    // A client that expects another host's key refuses what this one signs.
    await assert.rejects(
      createHostClient(url, 'did:key:zDnaeSomeoneElse', key).status(),
      /isn't signed by the host/,
    );

    // Someone else's key, asking about this subscription.
    const other = await subscriptionKey(newSubscriptionSeed());
    const response = await fetch(`${url}/host/subscriptions/${encodeURIComponent(key.did)}`, {
      headers: {
        authorization: await signRequest(other, 'GET', `/host/subscriptions/${encodeURIComponent(key.did)}`),
      },
    });
    assert.equal(response.status, 401);
    assert.equal(
      (await fetch(`${url}/host/subscriptions/${encodeURIComponent(key.did)}`)).status,
      401,
      'unsigned',
    );
  });

  test('a paying host refuses to carry until paid; paying starts Stripe, whose webhook moves the date once', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const key = await subscriptionKey(newSubscriptionSeed());
    const periodEnd = nowSeconds() + 30 * 24 * 3600;
    const stripeCalls: string[] = [];
    let returnUrl: string | null = null;
    const billing = createStripeBilling({
      secretKey: 'sk_test_x',
      webhookSecret: 'whsec_test',
      monthlyPrice: 'price_month',
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const target = urlOf(input);
        stripeCalls.push(`${init?.method ?? 'GET'} ${new URL(target).pathname}`);
        if (target.endsWith('/v1/checkout/sessions')) {
          assert.match(bodyOf(init), /subscription_data%5Bmetadata%5D%5Bweave_subscription%5D=did%3Akey/);
          returnUrl = new URLSearchParams(bodyOf(init)).get('success_url');
          return Response.json({ url: 'https://checkout.stripe.test/c/1' });
        }
        if (target.includes('/v1/subscriptions/sub_1')) {
          return Response.json({
            id: 'sub_1',
            customer: 'cus_1',
            metadata: { weave_subscription: key.did },
            items: { data: [{ current_period_end: periodEnd }] },
          });
        }
        if (target.endsWith('/v1/billing_portal/sessions'))
          return Response.json({ url: 'https://billing.stripe.test/p/1' });
        if (target.endsWith('/v1/prices/price_month'))
          return Response.json({ unit_amount: 400, currency: 'usd', recurring: { interval: 'month' } });
        return Response.json({ error: { message: 'unexpected' } }, { status: 400 });
      },
    });
    const served = await running({ billing, name: 'Test Hosting', price: '$4 a month' });
    const url = `http://127.0.0.1:${served.port}`;
    const client = createHostClient(url, served.node.did, key);

    const info = await describeHost(url);
    assert.deepEqual(
      { name: info.name, price: info.price, plans: info.plans, free: info.free },
      {
        name: 'Test Hosting',
        price: '$4 a month',
        plans: [
          {
            id: 'card-monthly',
            label: '$4 a month, by card',
            method: 'checkout',
            renews: true,
            for: ['account'],
          },
        ],
        free: false,
      },
      'its plans, priced as Stripe keeps them',
    );
    const me = await account();
    const laptop = await device(me, hub);
    const { invite } = await laptop.carriers.add({ did: served.node.did, name: 'Host' });
    await assert.rejects(
      client.attach(me.did, invite),
      (error: unknown) => error instanceof HostError && error.status === 402,
    );

    // Paying is a signed call: the home opens the page it answers with, at Stripe.
    assert.deepEqual(await client.pay('card-monthly'), { checkout: 'https://checkout.stripe.test/c/1' });
    assert.equal(returnUrl, `${url}/host/paid`, 'Stripe sends people back to a page that says done');
    assert.match(await (await fetch(returnUrl)).text(), /Done/);
    await assert.rejects(
      client.pay('card-weekly'),
      (error: unknown) => error instanceof HostError && error.status === 400,
    );
    await assert.rejects(
      client.pay('once-monthly'),
      /no such plan/,
      'a plan for spaces is not for an account',
    );
    await assert.rejects(
      client.manage(),
      (error: unknown) => error instanceof HostError && error.status === 404,
    );
    const stranger = await fetch(`${url}/host/subscriptions/${encodeURIComponent(key.did)}/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'card-monthly' }),
    });
    assert.equal(stranger.status, 401, 'only the subscription starts paying for itself');

    const event = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { subscription: 'sub_1' } },
    });
    const webhook = (body: string, secret = 'whsec_test') => {
      const t = nowSeconds();
      const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
      return fetch(`${url}/host/billing/webhook`, {
        method: 'POST',
        headers: { 'stripe-signature': `t=${t},v1=${v1}` },
        body,
      });
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
    assert.deepEqual(await client.manage(), { checkout: 'https://billing.stripe.test/p/1' });
  });
});

describe('pay answers', () => {
  test('a device takes only an https:// checkout page, or a payment request with a known scheme', () => {
    assert.deepEqual(readPayAnswer({ checkout: 'https://checkout.stripe.com/c/1' }), {
      checkout: 'https://checkout.stripe.com/c/1',
    });
    assert.equal(readPayAnswer({ checkout: 'http://evil.example/pay' }), null, 'not https');
    assert.equal(readPayAnswer({ checkout: 'javascript:alert(1)' }), null);
    assert.ok(readPayAnswer({ checkout: 'http://localhost:8788/x' }), 'http on this machine');

    const request = { uri: 'ethereum:0xabc@8453/transfer', amount: '4 USDC on Base', expires: 1 };
    assert.deepEqual(readPayAnswer({ request }), { request });
    assert.equal(
      readPayAnswer({ request: { ...request, uri: 'https://pay.example' } }),
      null,
      'not a payment URI',
    );
    assert.equal(readPayAnswer({ request: { ...request, amount: 4 } }), null);
    // A transfer spelled out wrongly is left out, not trusted: the link still works.
    const read = readPayAnswer({ request: { ...request, evm: { chainId: 8453, to: 'me' } } });
    assert.ok(read && 'request' in read && read.request.evm === undefined);
    assert.equal(readPayAnswer({ url: 'https://x' }), null);
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

  test('a paying host: the home shows its plans, opens the checkout it answers, and hands over the spaces once paid', async () => {
    let paidFor: string | null = null;
    const periodEnd = nowSeconds() + 365 * 24 * 3600;
    const billing = createStripeBilling({
      secretKey: 'sk_test_x',
      webhookSecret: 'whsec_test',
      yearlyPrice: 'price_year',
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const target = urlOf(input);
        if (target.endsWith('/v1/checkout/sessions')) {
          paidFor = new URLSearchParams(bodyOf(init)).get('client_reference_id');
          return Response.json({ url: 'https://checkout.stripe.test/c/2' });
        }
        return Response.json({
          id: 'sub_2',
          customer: 'cus_2',
          metadata: { weave_subscription: paidFor },
          items: { data: [{ current_period_end: periodEnd }] },
        });
      },
    });
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      billing,
      name: 'Test Hosting',
      price: '$36 a year',
    });
    open.push(served);
    const url = `http://127.0.0.1:${served.port}`;
    const me = await account();
    const laptop = await onSockets(me, served.port);
    await laptop.spaces.create({ name: 'Notes', visibility: 'private' });

    const before = await laptop.hosting.use(url);
    assert.deepEqual(
      { name: before.name, plans: before.plans.map((plan) => plan.id), live: before.live },
      { name: 'Test Hosting', plans: ['card-yearly'], live: true },
    );
    assert.equal(before.status?.carrying, false);

    // What the home opens: the checkout page the host answers with, at Stripe, and nothing of the host's.
    assert.deepEqual(await laptop.hosting.pay(url, 'card-yearly'), {
      checkout: 'https://checkout.stripe.test/c/2',
    });
    assert.equal(paidFor, before.subscription);

    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { subscription: 'sub_2' } },
    });
    const t = nowSeconds();
    const v1 = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
    await fetch(`${url}/host/billing/webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': `t=${t},v1=${v1}` },
      body,
    });

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
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      free: true,
    });
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
        const reached = (await served.node.spaces())
          .filter((space) => space.peers > 0)
          .map((space) => space.name);
        return reached.includes('Account registry') && reached.includes('Notes');
      },
      15_000,
      'the laptop to reach the host in its registry and its space',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await laptop.close();

    const phone = await onSockets(me, served.port);
    await until(
      async () => (await phone.spaces.list()).some((space) => space.id === notes.id),
      8000,
      'the phone to learn of the space',
    );
    await until(
      async () => (await phone.records.list(notes.id)).length === 1,
      8000,
      'the note to reach the phone',
    );
    assert.deepEqual((await phone.records.list(notes.id))[0]?.body, { text: 'safe with the host' });
    // Every device knows the host from the registry, with nothing set up.
    assert.deepEqual(
      (await phone.hosting.list()).map((known) => known.url),
      [url],
    );
  });
});

describe('reaching a host at the address it names', () => {
  /** A device configured with no always-on node at all: whatever it reaches, it learned */
  async function unconfigured(me: Account, network: { hosts?: string[] } = {}): Promise<P2PNode> {
    const node = await createNode({
      signer: me.signer,
      stores: memoryStores(),
      accountKey: me.accountKey,
      watchIntervalMs: 0,
      network,
    });
    open.push(node);
    return node;
  }

  test('a host says where it takes peers; only wss://, or ws:// on this machine, is used', () => {
    assert.equal(hostPeerAddress('https://host.example', { peer: '/peer' }), 'wss://host.example/peer');
    assert.equal(hostPeerAddress('http://127.0.0.1:8787', { peer: '/peer' }), 'ws://127.0.0.1:8787/peer');
    assert.equal(hostPeerAddress('https://a.example', { peer: 'wss://b.example/p' }), 'wss://b.example/p');
    assert.equal(hostPeerAddress('https://host.example', { peer: 'ws://host.example/peer' }), null);
    assert.equal(hostPeerAddress('https://host.example', {}), null);
  });

  test('using a host is enough: the device reaches it, and a new phone given only the host gets everything', async () => {
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      free: true,
    });
    open.push(served);
    const url = `http://127.0.0.1:${served.port}`;
    assert.equal((await describeHost(url)).peer, '/peer');
    const me = await account();

    const laptop = await unconfigured(me);
    const notes = await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    await laptop.records.put(notes.id, 'note', { text: 'found through the host' });
    await laptop.hosting.use(url);
    await until(
      async () => {
        const reached = (await served.node.spaces()).filter((space) => space.peers > 0).map((s) => s.name);
        return reached.includes('Account registry') && reached.includes('Notes');
      },
      15_000,
      'the laptop to reach the host with nothing configured',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await laptop.close();

    // The phone knows only the host its app was built with: the registry is there, and every space from it.
    const phone = await unconfigured(me, { hosts: [url] });
    await until(
      async () => (await phone.records.list(notes.id).catch(() => [])).length === 1,
      15_000,
      'the note to reach the phone',
    );
    assert.deepEqual((await phone.records.list(notes.id))[0]?.body, { text: 'found through the host' });
  });

  test('a space that pays a host: its members’ devices reach it with nothing configured', async () => {
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      free: true,
    });
    open.push(served);
    const url = `http://127.0.0.1:${served.port}`;
    const laptop = await unconfigured(await account());
    const { id } = await laptop.spaces.create({ name: 'Club', ...team, visibility: 'private' });
    await laptop.collections.define(id, hostSchema);
    await laptop.records.put(id, hostSchema.name, { url });
    await laptop.records.put(id, 'note', { text: 'kept by the club’s host' });
    await laptop.hosting.space(id);
    await until(
      async () => (await served.node.spaces()).some((space) => space.id === id && space.peers > 0),
      15_000,
      'the laptop to reach the host its space pays',
    );
  });
});

describe('bots a host runs', () => {
  const folders: string[] = [];
  const hosts: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    // The hosts first: their bots write into these folders until they stop.
    await Promise.all(hosts.splice(0).map((served) => served.close()));
    await Promise.all(
      folders
        .splice(0)
        .map((folder) => rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
    );
  });

  /** A model that is never asked: these bots have no rules to run */
  const model = {
    name: 'claude-sonnet-5-5',
    dailyCap: 1,
    think: () => async () => {
      throw new Error('No model in these tests');
    },
  };
  async function hostWithBots(options: Partial<Parameters<typeof startHost>[0]> = {}) {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'weave-bots-'));
    folders.push(folder);
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      bots: { folder, model },
      ...options,
    });
    hosts.push(served);
    return { served, url: `http://127.0.0.1:${served.port}` };
  }
  /** A community whose admin keeps it online at the host, on a laptop that reaches only what it learns */
  async function community(url: string) {
    const me = await account();
    const laptop = await createNode({
      signer: me.signer,
      stores: memoryStores(),
      accountKey: me.accountKey,
      watchIntervalMs: 0,
      network: {},
    });
    open.push(laptop);
    const { id } = await laptop.spaces.create({ name: 'Club', ...team, visibility: 'private' });
    await laptop.collections.define(id, hostSchema);
    await laptop.records.put(id, hostSchema.name, { url });
    return { laptop, space: id };
  }

  test('an admin asks the host for a bot: it joins with the invite’s role, through the host, and runs', async () => {
    const { served, url } = await hostWithBots({ free: true });
    assert.equal((await describeHost(url)).bots, true);
    const { laptop, space } = await community(url);
    await laptop.hosting.space(space);
    await until(carries(served.node, space), 6000, 'the host to carry the space');

    const bot = await laptop.hosting.startBot(space, url, { name: 'Club Bot' });
    assert.equal(bot.status.subscription, `space:${space}`, 'the answer is the space’s status');
    await until(
      async () =>
        (await laptop.spaces.access(space)).members.some((m) => m.did === bot.bot && m.role !== 'admin'),
      15_000,
      'the bot to join, below its admin',
    );
    await until(
      async () =>
        (await laptop.hosting.space(space))[0]?.bots.some(
          (b) => b.bot === bot.bot && b.name === 'Club Bot' && b.running,
        ) ?? false,
      8000,
      'the space’s signed status to say the bot runs',
    );
  });

  test('a bot runs from its community’s fund: only where the host keeps the space, and while there is money in it', async () => {
    const { chain, wallet } = fakeChain();
    const { url } = await hostWithBots({ wallet, watchMs: 20, fundMs: 50 });
    const info = await describeHost(url);
    assert.equal(info.bots, true);
    assert.deepEqual(info.fund, {
      monthly: '4',
      min: '1',
      methods: ['request'],
      recurring: false,
      botDailyCap: '1.50',
    });
    const { laptop, space } = await community(url);
    await assert.rejects(
      laptop.hosting.startBot(space, url, { name: 'Early Bot' }),
      /keep the space online here first/,
    );

    // Anyone chips in any amount; the fund keeps the space online and runs its bots.
    const paying = await laptop.hosting.payForSpace(space, url, { amount: '10', method: 'request' });
    assert.ok('request' in paying);
    assert.match(paying.request.amount, /^10\.\d+ USDC/);
    chain.latest = 150;
    chain.send(BigInt(paying.request.evm!.units), { block: 147 });
    await until(
      async () => (await laptop.hosting.space(space))[0]?.status?.carrying === true,
      8000,
      'the space to be kept online',
    );
    const [view] = await laptop.hosting.space(space);
    assert.ok((view?.status?.balance ?? 0) > 9_990_000, 'what was paid is in the fund');
    assert.ok(
      Math.abs((view?.status?.daily ?? 0) - 4e6 / 30) < 1000,
      'spent at the monthly rate, a day at a time',
    );
    const lasts = ((view?.status?.paidUntil ?? 0) - nowSeconds()) / 86_400;
    assert.ok(lasts > 74 && lasts < 76, `$10 at $4 a month lasts about 75 days, not ${lasts}`);

    const bot = await laptop.hosting.startBot(space, url, { name: 'Club Bot' });
    await until(
      async () =>
        (await laptop.hosting.space(space))[0]?.bots.some((b) => b.bot === bot.bot && b.running) ?? false,
      10_000,
      'the bot to run, its community funded',
    );
  });

  test('a host with no model runs no bots, though communities fund themselves there', async () => {
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      wallet: createWalletPayments({
        network: 'base-sepolia',
        to: '0x1111111111111111111111111111111111111111',
        monthly: '4',
      }),
    });
    open.push(served);
    const url = `http://127.0.0.1:${served.port}`;
    const info = await describeHost(url);
    assert.equal(info.bots, undefined);
    assert.equal(info.fund?.monthly, '4');
    const response = await fetch(`${url}/host/bots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', invite: 'y' }),
    });
    assert.equal(response.status, 404);
  });
});

describe('a host’s room', () => {
  test('a status says what the spaces take; at its limit an account keeps its spaces and takes no new one', async () => {
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      free: true,
      measure: async () => 1000,
      quotaBytes: 2500,
    });
    open.push(served);
    const url = `http://127.0.0.1:${served.port}`;
    const me = await account();
    const laptop = await createNode({
      signer: me.signer,
      stores: memoryStores(),
      accountKey: me.accountKey,
      watchIntervalMs: 0,
      network: {},
    });
    open.push(laptop);
    const one = await laptop.spaces.create({ name: 'One', visibility: 'private' });
    await laptop.hosting.use(url);
    await until(carries(served.node, one.id), 8000, 'the host to carry the first space');

    const [view] = await laptop.hosting.list();
    assert.equal(view?.status?.quota, 2500);
    assert.ok((view?.status?.bytes ?? 0) >= 2500, 'the carry space, the registry and the space: over it now');

    const two = await laptop.spaces.create({ name: 'Two', visibility: 'private' });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(await carries(served.node, two.id)(), false, 'no room for a new space');
    assert.equal(await carries(served.node, one.id)(), true, 'what it had stays');
  });
});

describe('a host whose disk is only a cache', () => {
  test('lose the disk, start again on the same bucket: every subscription and space comes back, still sealed', async () => {
    const bucket = createMemoryBlobStore();
    const hostKeys = await provider.generateKeyPair();
    const start = async () => {
      const served = await startHost({
        key: hostKeys,
        stores: memoryStores(),
        port: 0,
        free: true,
        mirror: bucket,
      });
      open.push(served);
      return served;
    };
    const onSockets = async (me: Account, port: number) => {
      const node = await createNode({
        signer: me.signer,
        stores: memoryStores(),
        accountKey: me.accountKey,
        watchIntervalMs: 0,
        network: { nodes: [`ws://127.0.0.1:${port}/peer`] },
      });
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
        const reached = (await first.node.spaces())
          .filter((space) => space.peers > 0)
          .map((space) => space.name);
        return reached.includes('Account registry') && reached.includes('Notes');
      },
      15_000,
      'the laptop to reach the host',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await laptop.close();
    // Closing flushes what was waiting: the bucket holds it all now.
    await first.close();
    const everything = new TextDecoder().decode(
      new Uint8Array(
        (await Promise.all((await bucket.list('')).map((key) => bucket.get(key)))).flatMap((bytes) => [
          ...(bytes ?? []),
        ]),
      ),
    );
    assert.equal(everything.includes('in the bucket'), false, 'sealed, as it travels');

    // A new machine: an empty disk, the same key and bucket.
    const second = await start();
    assert.equal((await second.node.list()).length, 1, 'the subscription came back');
    await until(carries(second.node, notes.id), 8000, 'the space to be carried again');

    const phone = await onSockets(me, second.port);
    await until(
      async () => (await phone.records.list(notes.id).catch(() => [])).length === 1,
      15_000,
      'the note to reach a new phone',
    );
    assert.deepEqual((await phone.records.list(notes.id))[0]?.body, { text: 'in the bucket' });
  });
});

describe('a host for named accounts only', () => {
  test('it carries for the accounts it was told, and turns everyone else away before keeping anything', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const [me, stranger] = [await account(), await account()];
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      free: true,
      allow: [me.did],
    });
    open.push(served);
    const url = `http://127.0.0.1:${served.port}`;

    const mine = await device(me, hub);
    await mine.spaces.create({ name: 'Notes', visibility: 'private' });
    const myKey = await subscriptionKey(newSubscriptionSeed());
    const { status } = await createHostClient(url, served.node.did, myKey).attach(
      me.did,
      (await mine.carriers.add({ did: served.node.did, name: 'Host' })).invite,
    );
    assert.equal(status.carrying, true);

    const theirs = await device(stranger, hub);
    await theirs.spaces.create({ name: 'Mine now?', visibility: 'private' });
    const theirKey = await subscriptionKey(newSubscriptionSeed());
    await assert.rejects(
      createHostClient(url, served.node.did, theirKey).attach(
        stranger.did,
        (await theirs.carriers.add({ did: served.node.did, name: 'Host' })).invite,
      ),
      (error: unknown) => error instanceof HostError && error.status === 403,
    );
    assert.deepEqual(
      (await served.node.list()).map((subscription) => subscription.id),
      [myKey.did],
      'nothing kept for the stranger',
    );
  });

  test('the host node itself refuses them too, whatever the API', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const stranger = await account();
    const node = await createHostNode({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      network: onHub(hub),
      free: true,
      allow: ['did:key:zSomeoneElse'],
    });
    open.push(node);
    const theirs = await device(stranger, hub);
    const id = await subscriptionId();
    await node.subscribe(id);
    await assert.rejects(
      node.attach(id, stranger.did, (await theirs.carriers.add({ did: node.did, name: 'Host' })).invite),
      /only carries spaces for the accounts/,
    );
  });

  test('a free host anyone could reach refuses to start unless it names its accounts', () => {
    assert.doesNotThrow(() => checkExposure({ free: true, allow: null }));
    assert.doesNotThrow(() => checkExposure({ host: '127.0.0.1', free: true, allow: null }));
    assert.throws(() => checkExposure({ host: '0.0.0.0', free: true, allow: null }), /--allow/);
    assert.doesNotThrow(() => checkExposure({ host: '0.0.0.0', free: true, allow: ['did:key:zA'] }));
    assert.doesNotThrow(
      () => checkExposure({ host: '0.0.0.0', free: false, allow: null }),
      'a paying host is open to anyone who pays',
    );

    assert.equal(allowList(undefined, {}), null);
    assert.deepEqual(allowList(['did:key:zA'], { WEAVE_HOST_ALLOW: 'did:key:zB, did:key:zA' }), [
      'did:key:zA',
      'did:key:zB',
    ]);
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
    txs: new Map<
      string,
      {
        status: string;
        block: number;
        time: number;
        logs: Array<{ address: string; topics: string[]; data: string }>;
      }
    >(),
    calls: 0,
    /** A transfer of `amount` (smallest units) to `to`, in block `block` */
    send(
      amount: bigint | string,
      options: { block?: number; time?: number; to?: string; token?: string; status?: string } = {},
    ) {
      const tx = `0x${(chain.txs.size + 1).toString(16).padStart(64, 'a')}`;
      chain.txs.set(tx, {
        status: options.status ?? '0x1',
        block: options.block ?? chain.latest,
        time: options.time ?? nowSeconds(),
        logs: [
          {
            address: options.token ?? NETWORKS['base-sepolia'].usdc,
            topics: [
              '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              word('0x2222222222222222222222222222222222222222'),
              word(options.to ?? HOST_ADDRESS),
            ],
            data: word(BigInt(amount).toString(16)),
          },
        ],
      });
      return tx;
    },
    fetch: (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      chain.calls++;
      const request: unknown = JSON.parse(bodyOf(init));
      const [id, method, first] = [at(request, 'id'), at(request, 'method'), at(request, 'params', 0)];
      const answer = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
      if (method === 'eth_blockNumber') return answer(`0x${chain.latest.toString(16)}`);
      if (method === 'eth_getLogs') {
        const [from, to] = [Number(at(first, 'fromBlock')), Number(at(first, 'toBlock'))];
        const address = String(at(first, 'address')).toLowerCase();
        const receiver = String(at(first, 'topics', 2)).toLowerCase();
        return answer(
          [...chain.txs].flatMap(([tx, found]) =>
            // A reverted transaction leaves no logs.
            found.status !== '0x1' || found.block < from || found.block > to
              ? []
              : found.logs
                  .filter(
                    (log) =>
                      log.address.toLowerCase() === address && log.topics[2]?.toLowerCase() === receiver,
                  )
                  .map((log) => ({
                    ...log,
                    transactionHash: tx,
                    blockNumber: `0x${found.block.toString(16)}`,
                  })),
          ),
        );
      }
      if (method === 'eth_getBlockByNumber') {
        const found = [...chain.txs.values()].find((tx) => `0x${tx.block.toString(16)}` === first);
        return answer({ timestamp: `0x${(found?.time ?? nowSeconds()).toString(16)}` });
      }
      return Response.json({ jsonrpc: '2.0', id, error: { message: `unexpected ${String(method)}` } });
    }) satisfies typeof fetch,
  };
  const wallet = createWalletPayments({
    network: 'base-sepolia',
    to: HOST_ADDRESS,
    monthly: '4',
    yearly: '36',
    fetch: chain.fetch,
  });
  return { chain, wallet, HOST_ADDRESS };
}

describe('wallet payments', () => {
  test('prices, and amounts marked apart by a fraction of a cent', () => {
    assert.equal(toUnits('36'), 36_000_000n);
    assert.equal(toUnits('4.5'), 4_500_000n);
    assert.throws(() => toUnits('36.001'), /not a price/);
    const { wallet } = fakeChain();
    assert.deepEqual(
      wallet.offer.plans.map((plan) => [plan.id, plan.price]),
      [
        ['yearly', '36'],
        ['monthly', '4'],
      ],
    );
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

  test('the network is read for what reached this host in USDC, once confirmed, each block once', async () => {
    const { chain, wallet, HOST_ADDRESS } = fakeChain();
    const tx = chain.send(36_004_217n, { block: 100 });
    chain.send(1n, { block: 100, to: '0x3333333333333333333333333333333333333333' });
    chain.send(2n, { block: 100, token: '0x4444444444444444444444444444444444444444' });
    chain.send(3n, { block: 100, status: '0x0' });
    let scan = await wallet.scan(null);
    assert.deepEqual(scan, { upTo: 98n, transfers: [] }, 'a block needs three confirmations');
    chain.latest = 102;
    scan = await wallet.scan(scan.upTo);
    assert.deepEqual(
      scan.transfers.map((transfer) => [transfer.tx, transfer.amount]),
      [[tx, '36004217']],
      'only USDC, to this host, that went through',
    );
    assert.deepEqual((await wallet.scan(scan.upTo)).transfers, [], 'and each block once');

    // What the home shows: a link any wallet opens, and the amount in words.
    const request = wallet.request('36004217');
    assert.equal(
      request.uri,
      `ethereum:${NETWORKS['base-sepolia'].usdc}@84532/transfer?address=${HOST_ADDRESS}&uint256=36004217`,
    );
    assert.equal(request.amount, '36.004217 USDC on Base Sepolia');
  });

  test('paying from a wallet: an amount per subscription, the same asked again; the host sees it arrive, once', async () => {
    const { chain, wallet, HOST_ADDRESS } = fakeChain();
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      wallet,
      watchMs: 20,
    });
    open.push(served);
    const url = `http://127.0.0.1:${served.port}`;
    const mine = createHostClient(url, served.node.did, await subscriptionKey(newSubscriptionSeed()));
    const theirs = createHostClient(url, served.node.did, await subscriptionKey(newSubscriptionSeed()));
    const requestOf = async (client: typeof mine, plan: string) => {
      const answer = await client.pay(plan);
      assert.ok('request' in answer, 'a wallet pays a request');
      return answer.request;
    };
    const state = async (client: typeof mine) => (await client.status()).status;

    const info = await describeHost(url);
    assert.equal(info.price, '$4 a month or $36 a year', 'from the wallet prices');
    assert.deepEqual(
      info.plans?.map((plan) => [plan.id, plan.method, plan.renews, plan.for]),
      [
        ['wallet-yearly', 'request', false, ['account']],
        ['wallet-monthly', 'request', false, ['account']],
      ],
    );

    const request = await requestOf(mine, 'wallet-yearly');
    assert.equal(request.evm?.to, HOST_ADDRESS);
    assert.equal(request.evm?.chainId, 84532);
    assert.match(request.uri, /^ethereum:0x[0-9a-fA-F]{40}@84532\/transfer\?address=/);
    assert.deepEqual(await requestOf(mine, 'wallet-yearly'), request, 'asked again, the same amount');
    const their = await requestOf(theirs, 'wallet-yearly');
    assert.notEqual(their.evm?.units, request.evm?.units);

    // Someone else's payment pays theirs; one made before this one was asked for pays nothing.
    chain.send(BigInt(their.evm!.units), { block: 101 });
    chain.send(BigInt(request.evm.units), { block: 102, time: nowSeconds() - 3600 });
    chain.latest = 110;
    await until(async () => (await state(theirs)).state === 'active', 4000, 'their payment to count');
    assert.notEqual((await state(mine)).state, 'active');

    chain.send(BigInt(request.evm.units), { block: 111 });
    chain.latest = 112;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.notEqual((await state(mine)).state, 'active', 'not confirmed yet');
    chain.latest = 113;
    await until(async () => (await state(mine)).state === 'active', 4000, 'my payment to count');
    const paid = await state(mine);
    assert.equal(paid.renews, false, 'time paid up front');
    assert.ok(Math.abs(paid.paidUntil - (nowSeconds() + 365 * 24 * 3600)) < 2 * 24 * 3600);

    // Paying again adds a month on top of the year; the first payment is never counted twice.
    const again = await requestOf(mine, 'wallet-monthly');
    assert.notEqual(again.evm?.units, request.evm?.units);
    chain.send(BigInt(again.evm!.units), { block: 114 });
    chain.latest = 120;
    await until(
      async () => (await state(mine)).paidUntil > paid.paidUntil + 27 * 24 * 3600,
      4000,
      'the month to be added',
    );
    assert.ok((await state(mine)).paidUntil < paid.paidUntil + 32 * 24 * 3600, 'once');
  });

  test('from the env: an address and a price, or nothing', () => {
    assert.equal(walletFromEnv({}), null);
    assert.throws(
      () => walletFromEnv({ WEAVE_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111' }),
      /need a price/,
    );
    assert.throws(
      () => walletFromEnv({ WEAVE_WALLET_ADDRESS: 'me', WEAVE_WALLET_YEARLY: '36' }),
      /not an address/,
    );
    assert.throws(
      () =>
        walletFromEnv({
          WEAVE_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
          WEAVE_WALLET_YEARLY: '36',
          WEAVE_WALLET_NETWORK: 'solana',
        }),
      /base or base-sepolia/,
    );
    assert.equal(
      walletFromEnv({
        WEAVE_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
        WEAVE_WALLET_YEARLY: '36',
      })?.offer.chainId,
      8453,
    );
  });

  test('an account pays a request from its home, and the host takes its spaces', async () => {
    const { chain, wallet } = fakeChain();
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      wallet,
      watchMs: 20,
    });
    open.push(served);
    const url = `http://127.0.0.1:${served.port}`;
    const me = await account();
    const laptop = await createNode({
      signer: me.signer,
      stores: memoryStores(),
      accountKey: me.accountKey,
      watchIntervalMs: 0,
      network: {},
    });
    open.push(laptop);
    await laptop.spaces.create({ name: 'Notes', visibility: 'private' });

    const before = await laptop.hosting.use(url);
    assert.deepEqual(
      before.plans.map((plan) => plan.id),
      ['wallet-yearly', 'wallet-monthly'],
    );
    assert.equal(before.status?.carrying, false);
    const answer = await laptop.hosting.pay(url, 'wallet-yearly');
    assert.ok('request' in answer);
    chain.latest = 200;
    chain.send(BigInt(answer.request.evm!.units), { block: 198 });

    // Back in the home, it looks again: paid, so the spaces go over.
    await until(
      async () => (await laptop.hosting.list())[0]?.status?.carrying === true,
      6000,
      'the host to be paid and carry the spaces',
    );
  });
});

describe('a space paying for itself', () => {
  async function running(options: Partial<Parameters<typeof startHost>[0]> = {}) {
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      ...options,
    });
    open.push(served);
    return served;
  }

  /** A space its creator's device made, naming a host in `std.host` */
  async function community(hub: FakeHub, url: string) {
    const me = await account();
    const laptop = await device(me, hub);
    const { id } = await laptop.spaces.create({ name: 'Club', ...team, visibility: 'private' });
    await laptop.collections.define(id, hostSchema);
    await laptop.records.put(id, hostSchema.name, { url });
    return { me, laptop, space: id };
  }

  test('a member’s device hands a free host the pass, and the host carries the space for itself', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const served = await running({ free: true });
    const url = `http://127.0.0.1:${served.port}`;
    const { laptop, space } = await community(hub, url);

    const [view] = await laptop.hosting.space(space);
    assert.equal(view?.host, served.node.did);
    assert.equal(view?.status?.subscription, `space:${space}`);
    assert.equal(view?.status?.carrying, true);
    assert.ok(view?.status?.readKey?.startsWith('did:key:'), 'it holds the read key, which opens nothing');
    assert.equal(view?.fund, null, 'a free host takes no payments');
    await until(carries(served.node, space), 4000, 'the host to carry the space');

    // Anyone may ask how a space stands, and gets the host's signed word.
    const info = await describeHost(url);
    const { status } = await createSpaceHostClient(url, info.did).status(space);
    assert.equal(status.carrying, true);
    const unknown = await createSpaceHostClient(url, info.did).status('nosuchspace');
    assert.equal(unknown.status.state, 'none', 'a space nobody has handed over yet');
    assert.equal(unknown.status.carrying, false);

    // A pass proves which space it is for: one for another space is refused.
    const { id: other } = await laptop.spaces.create({ name: 'Other', visibility: 'public' });
    const otherPass = { v: 1, space: parseSpaceInvite(await laptop.spaces.invite(other)).space };
    const wrong = await fetch(`${url}/host/spaces/${space}/pass`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pass: otherPass }),
    });
    assert.equal(wrong.status, 400);
    assert.match(String(at(await wrong.json(), 'error')), /not a pass for this space/);
  });

  test('a paying host carries nothing until someone chips in; a card adds any amount to the fund, once or monthly', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const bodies: string[] = [];
    const billing = createStripeBilling({
      secretKey: 'sk_test_x',
      webhookSecret: 'whsec_test',
      monthlyPrice: 'price_month',
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        if (urlOf(input).endsWith('/v1/checkout/sessions')) bodies.push(bodyOf(init));
        return new Response(JSON.stringify({ url: 'https://checkout.stripe.test/c/1' }));
      },
    });
    const served = await running({ billing, fundMs: 50, manageFunds: 'https://billing.stripe.test/p/login' });
    const url = `http://127.0.0.1:${served.port}`;
    const { laptop, space } = await community(hub, url);

    const [before] = await laptop.hosting.space(space);
    assert.equal(before?.status?.state, 'none');
    assert.equal(before?.status?.carrying, false);
    assert.deepEqual(before?.fund, {
      monthly: '4',
      min: '1',
      methods: ['checkout'],
      recurring: true,
      manage: 'https://billing.stripe.test/p/login',
    });
    const put = await fetch(`${url}/host/spaces/${space}/pass`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pass: { v: 1 } }),
    });
    assert.equal(put.status, 402, 'not before someone pays');

    // Anyone in the space chips in from the app: the host answers with Stripe's page, nothing of its own.
    assert.deepEqual(await laptop.hosting.payForSpace(space, url, { amount: '12.50', method: 'checkout' }), {
      checkout: 'https://checkout.stripe.test/c/1',
    });
    await assert.rejects(
      laptop.hosting.payForSpace(space, url, { amount: '0.50', method: 'checkout' }),
      /at least 1/,
    );
    await assert.rejects(
      laptop.hosting.payForSpace(space, url, { amount: '5', method: 'request' }),
      /no such payment/,
    );
    await assert.rejects(
      laptop.hosting.payForSpace(space, 'https://elsewhere.test', { amount: '5', method: 'checkout' }),
      /doesn’t use/,
    );
    const once = new URLSearchParams(bodies[0]);
    assert.equal(once.get('mode'), 'payment');
    assert.equal(once.get('line_items[0][price_data][unit_amount]'), '1250');
    assert.equal(once.get('metadata[weave_fund]'), `space:${space}`);
    await laptop.hosting.payForSpace(space, url, { amount: '5', method: 'checkout', monthly: true });
    const monthly = new URLSearchParams(bodies[1]);
    assert.equal(monthly.get('mode'), 'subscription');
    assert.equal(monthly.get('line_items[0][price_data][recurring][interval]'), 'month');
    assert.equal(monthly.get('subscription_data[metadata][weave_fund]'), `space:${space}`);

    const webhook = (body: string) => {
      const t = nowSeconds();
      const v1 = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
      return fetch(`${url}/host/billing/webhook`, {
        method: 'POST',
        headers: { 'stripe-signature': `t=${t},v1=${v1}` },
        body,
      });
    };
    const paidOnce = (id: string, cents: number) =>
      JSON.stringify({
        type: 'checkout.session.completed',
        data: {
          object: {
            id,
            mode: 'payment',
            payment_status: 'paid',
            amount_total: cents,
            metadata: { weave_fund: `space:${space}` },
          },
        },
      });
    const paidMonthly = (id: string, cents: number) =>
      JSON.stringify({
        type: 'invoice.paid',
        data: {
          object: {
            id,
            amount_paid: cents,
            parent: {
              subscription_details: { subscription: 'sub_9', metadata: { weave_fund: `space:${space}` } },
            },
          },
        },
      });
    const client = createSpaceHostClient(url, served.node.did);
    const balance = async () => (await client.status(space)).status.balance ?? 0;
    await webhook(paidOnce('cs_1', 1250));
    await webhook(paidOnce('cs_1', 1250));
    assert.ok(Math.abs((await balance()) - 12_500_000) < 1000, 'counted once');
    // Someone else adds every month: each month's invoice adds to the same fund.
    await webhook(paidMonthly('in_1', 500));
    await webhook(paidMonthly('in_1', 500));
    assert.ok(Math.abs((await balance()) - 17_500_000) < 1000, 'the monthly one too, once');
    const paidUntil = (await client.status(space)).status.paidUntil;
    const days = (paidUntil - nowSeconds()) / 86_400;
    assert.ok(days > 129 && days < 132, `$17.50 at $4 a month lasts about 131 days, not ${days}`);

    const [after] = await laptop.hosting.space(space);
    assert.equal(after?.status?.carrying, true);
    await until(carries(served.node, space), 4000, 'the host to carry the space');
  });

  test('when the space’s key changes, the next look hands the host the new pass', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const served = await running({ free: true });
    const url = `http://127.0.0.1:${served.port}`;
    const { laptop, space } = await community(hub, url);
    const bob = await device(await account(), hub);
    await bob.spaces.join(await laptop.spaces.invite(space));
    await hold(laptop, space);
    await joined(bob, space);
    // Bob seeing his join isn't the laptop seeing it: removing him before then is "Not a member".
    await until(
      async () => (await laptop.spaces.access(space)).members.some((m) => m.did === bob.did),
      6000,
      'the laptop to see Bob join',
    );
    const first = (await laptop.hosting.space(space))[0]?.status?.readKey;
    assert.ok(first);

    await laptop.spaces.setMember(space, bob.did, null);
    await until(
      async () => (await laptop.hosting.space(space))[0]?.status?.readKey !== first,
      6000,
      'the host to hold the new read key',
    );
  });

  test('a host for named accounts only carries no space for itself', async () => {
    const served = await running({ free: true, allow: ['did:key:zDnaeSomeone'] });
    const response = await fetch(`http://127.0.0.1:${served.port}/host/spaces/abc/pass`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pass: { v: 1 } }),
    });
    assert.equal(response.status, 403);
  });
});
