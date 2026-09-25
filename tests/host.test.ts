/**
 * Hosting: a carrier for many accounts that never sleeps. Subscriptions that
 * are paid, in their grace period or lapsed; spaces carried once however many
 * pay for them; an API where every call is signed by the subscription; and
 * Stripe, telling the host who paid until when.
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
import { createHostClient, HostError, newSubscriptionSeed, signRequest, subscriptionKey, verifyRequest } from '../src/session/hosting.js';
import { startHost } from '../cli/src/host.js';
import { createStripeBilling, verifyStripeSignature } from '../cli/src/stripe.js';
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
  async function running(hub: FakeHub, options: { free?: boolean; billing?: Parameters<typeof startHost>[0]['billing'] } = {}) {
    const served = await startHost({ key: await provider.generateKeyPair(), stores: memoryStores(), port: 0, ...options });
    open.push(served);
    return served;
  }

  test('a free host takes any subscription; only the subscription itself may ask about it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const served = await running(hub, { free: true });
    const url = `http://127.0.0.1:${served.port}`;
    const key = await subscriptionKey(newSubscriptionSeed());
    const client = createHostClient(url, key);

    const info = await client.info();
    assert.equal(info.did, served.node.did);
    assert.equal(info.free, true);

    const me = await account();
    const laptop = await device(me, hub);
    await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    const { invite } = await laptop.carriers.add({ did: info.did, name: 'Host' });
    const status = await client.attach(me.did, invite);
    assert.equal(status.state, 'active');
    assert.equal(status.carrying, true);

    // Someone else's key, asking about this subscription.
    const other = await subscriptionKey(newSubscriptionSeed());
    const response = await fetch(`${url}/host/subscriptions/${encodeURIComponent(key.did)}`, {
      headers: { authorization: await signRequest(other, 'GET', `/host/subscriptions/${encodeURIComponent(key.did)}`) },
    });
    assert.equal(response.status, 401);
    assert.equal((await fetch(`${url}/host/subscriptions/${encodeURIComponent(key.did)}`)).status, 401, 'unsigned');
  });

  test('a paying host refuses to carry until paid; Stripe’s webhook moves the date, and replays change nothing', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const key = await subscriptionKey(newSubscriptionSeed());
    const periodEnd = nowSeconds() + 30 * 24 * 3600;
    const stripeCalls: string[] = [];
    const billing = createStripeBilling({
      secretKey: 'sk_test_x',
      webhookSecret: 'whsec_test',
      monthlyPrice: 'price_month',
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const target = String(input);
        stripeCalls.push(`${init?.method ?? 'GET'} ${new URL(target).pathname}`);
        if (target.endsWith('/v1/checkout/sessions')) {
          assert.match(String(init?.body), /subscription_data%5Bmetadata%5D%5Bweave_subscription%5D=did%3Akey/);
          return Response.json({ url: 'https://checkout.stripe.test/c/1' });
        }
        if (target.includes('/v1/subscriptions/sub_1')) {
          return Response.json({ id: 'sub_1', customer: 'cus_1', metadata: { weave_subscription: key.did }, items: { data: [{ current_period_end: periodEnd }] } });
        }
        return Response.json({ error: { message: 'unexpected' } }, { status: 400 });
      }) as typeof fetch,
    });
    const served = await running(hub, { billing });
    const url = `http://127.0.0.1:${served.port}`;
    const client = createHostClient(url, key);

    assert.deepEqual((await client.info()).plans, [{ id: 'monthly', label: 'Monthly' }]);
    const me = await account();
    const laptop = await device(me, hub);
    const { invite } = await laptop.carriers.add({ did: served.node.did, name: 'Host' });
    await assert.rejects(client.attach(me.did, invite), (error: unknown) => error instanceof HostError && error.status === 402);

    assert.equal((await client.checkout('monthly', 'https://home.test/settings')).url, 'https://checkout.stripe.test/c/1');
    await assert.rejects(client.checkout('monthly', 'javascript:alert(1)'), /return address/);

    const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { subscription: 'sub_1' } } });
    const webhook = (body: string, secret = 'whsec_test') => {
      const t = nowSeconds();
      const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
      return fetch(`${url}/host/billing/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${v1}` }, body });
    };
    // A forged call first: not Stripe's, so nothing moves.
    assert.equal((await webhook(event, 'whsec_wrong')).status, 200);
    assert.equal((await client.status()).state, 'lapsed');

    await webhook(event);
    await webhook(event);
    const status = await client.status();
    assert.equal(status.state, 'active');
    assert.equal(status.paidUntil, periodEnd);
    assert.equal((await client.attach(me.did, invite)).carrying, true);
    assert.equal(stripeCalls.filter((call) => call.startsWith('GET /v1/subscriptions')).length, 2);
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
