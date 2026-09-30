/**
 * Reminders by email before paid time runs out: an address confirmed before
 * anything but the confirmation goes to it, a reminder 14 and 3 days before
 * and one when the grace period starts, each once per date, none for a card
 * that renews, and a link in each that stops them.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { Subscription, SubscriptionState } from '../../core/src/node/host.js';
import { createP256Provider } from '../../core/src/identity/crypto-p256.js';
import { newSubscriptionSeed, payLink, subscriptionKey } from '../../core/src/session/hosting.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';
import { createReminders, isEmail, mailerFromEnv, type Mailer } from '../src/reminders.js';
import { startHost } from '../src/host.js';
import { at, bodyOf, urlOf } from './helpers/json.js';

const DAY = 24 * 3600;
const ORIGIN = 'https://host.example';

function inbox() {
  const mails: Array<{ to: string; subject: string; text: string }> = [];
  const mailer: Mailer = { send: async (mail) => void mails.push(mail) };
  const link = (kind: 'confirm' | 'stop') =>
    new URL(new RegExp(`https?://\\S+/pay/email/${kind}\\?t=\\S+`).exec(mails.at(-1)?.text ?? '')![0]);
  return { mails, mailer, link };
}

async function setUp(start = 1_800_000_000) {
  let clock = start;
  const box = inbox();
  const reminders = createReminders({
    store: await memoryStores()('reminders'),
    mailer: box.mailer,
    name: 'Test Hosting',
    now: () => clock,
  });
  const state = (subscription: Subscription): SubscriptionState =>
    subscription.paidUntil >= clock
      ? 'active'
      : subscription.paidUntil + 30 * DAY >= clock
        ? 'grace'
        : 'lapsed';
  return {
    ...box,
    reminders,
    at: (seconds: number) => void (clock = seconds),
    send: (subscriptions: Subscription[]) => reminders.send(subscriptions, state, ORIGIN),
  };
}

describe('reminders by email', () => {
  test('nothing but the confirmation reaches an address until it is confirmed', async () => {
    const t = await setUp();
    const paid: Subscription = { id: 'did:key:zSub', paidUntil: 1_800_000_000 + 5 * DAY, since: 0 };
    await t.reminders.ask(paid.id, 'me@example.com', ORIGIN);
    assert.equal(t.mails.length, 1);
    assert.match(t.mails[0]!.subject, /Confirm/);
    assert.equal(await t.reminders.state(paid.id), 'waiting');

    await t.send([paid]);
    assert.equal(t.mails.length, 1, 'unconfirmed: nothing more');

    assert.equal(await t.reminders.confirm(t.link('confirm').searchParams.get('t')!), true);
    assert.equal(await t.reminders.state(paid.id), 'on');
    assert.equal(await t.reminders.confirm('x'.repeat(32)), false, 'a token it never made');
  });

  test('14 and 3 days before, and when the grace period starts: each once per date; none for a card', async () => {
    const start = 1_800_000_000;
    const t = await setUp(start);
    const until = start + 20 * DAY;
    const paid: Subscription = { id: 'space:club', paidUntil: until, since: 0 };
    await t.reminders.ask(paid.id, 'club@example.com', ORIGIN);
    await t.reminders.confirm(t.link('confirm').searchParams.get('t')!);
    const count = () => t.mails.length - 1;

    await t.send([paid]);
    assert.equal(count(), 0, '20 days left: nothing yet');
    t.at(until - 13 * DAY);
    await t.send([paid]);
    await t.send([paid]);
    assert.equal(count(), 1, 'the 14-day reminder, once');
    assert.match(t.mails.at(-1)!.text, /the space you chipped in for/);
    t.at(until - 2 * DAY);
    await t.send([paid]);
    assert.equal(count(), 2, 'the 3-day reminder');
    t.at(until + DAY);
    await t.send([paid]);
    await t.send([paid]);
    assert.equal(count(), 3, 'one when the grace period starts');
    assert.match(t.mails.at(-1)!.subject, /ran out/);

    // Paid again: the new date gets its own reminders.
    const again = { ...paid, paidUntil: until + 30 * DAY };
    t.at(again.paidUntil - 10 * DAY);
    await t.send([again]);
    assert.equal(count(), 4);

    // A card renews by itself: nothing to remind about.
    const card = { ...again, paidUntil: again.paidUntil + 30 * DAY, customer: 'cus_1' };
    t.at(card.paidUntil - DAY);
    await t.send([card]);
    assert.equal(count(), 4);
  });

  test('the link in a reminder stops them; an address whose subscription is gone is dropped', async () => {
    const start = 1_800_000_000;
    const t = await setUp(start);
    const paid: Subscription = { id: 'did:key:zSub', paidUntil: start + 2 * DAY, since: 0 };
    await t.reminders.ask(paid.id, 'me@example.com', ORIGIN);
    await t.reminders.confirm(t.link('confirm').searchParams.get('t')!);
    await t.send([paid]);
    assert.equal(await t.reminders.stop(t.link('stop').searchParams.get('t')!), true);
    assert.equal(await t.reminders.state(paid.id), 'off');

    await t.reminders.ask(paid.id, 'me@example.com', ORIGIN);
    await t.send([]);
    assert.equal(await t.reminders.state(paid.id), 'off', 'no subscription: forgotten');
  });

  test('addresses, and the mail service from the environment', async () => {
    assert.ok(isEmail('a@b.co'));
    assert.ok(!isEmail('not an address'));
    assert.ok(!isEmail('a@b'));
    assert.equal(mailerFromEnv({}), null);
    let sent: { url: string; body: unknown; auth: string | null } | null = null;
    const mailer = mailerFromEnv(
      { WEAVE_MAIL_API_KEY: 're_test', WEAVE_MAIL_FROM: 'Host <host@example.com>' },
      async (input, init) => {
        sent = {
          url: urlOf(input),
          body: JSON.parse(bodyOf(init)),
          auth: new Headers(init?.headers).get('authorization'),
        };
        return Response.json({ id: '1' });
      },
    );
    await mailer!.send({ to: 'me@example.com', subject: 'Hi', text: 'There' });
    assert.deepEqual(sent, {
      url: 'https://api.resend.com/emails',
      body: { from: 'Host <host@example.com>', to: ['me@example.com'], subject: 'Hi', text: 'There' },
      auth: 'Bearer re_test',
    });
  });
});

describe('reminders on the pay page', () => {
  const open: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((running) => running.close()));
  });

  test('asked for with a pay link, confirmed from the mail', async () => {
    const box = inbox();
    const provider = createP256Provider();
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      wallet: null,
      billing: {
        plans: [{ id: 'monthly', label: 'Monthly' }],
        checkout: async () => 'https://checkout.test',
        manage: async () => 'https://manage.test',
        webhook: async () => null,
      },
      publicUrl: 'http://127.0.0.1',
      reminders: createReminders({
        store: await memoryStores()('r'),
        mailer: box.mailer,
        name: 'Test Hosting',
      }),
    });
    open.push(served);
    const base = `http://127.0.0.1:${served.port}`;
    const key = await subscriptionKey(newSubscriptionSeed());
    const params = new URLSearchParams(
      new URL(await payLink(`${base}/pay`, served.node.did, key)).hash.slice(1),
    );
    const authorization = `WeavePay s=${params.get('s')}, at=${params.get('at')}, sig=${params.get('sig')}`;
    const call = (path: string, body?: unknown) =>
      fetch(`${base}/pay/api${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    assert.equal(at(await (await call('')).json(), 'reminders'), 'off');
    assert.equal((await call('/email', { email: 'nope' })).status, 400);
    assert.equal(
      at(await (await call('/email', { email: 'me@example.com' })).json(), 'reminders'),
      'waiting',
    );
    assert.equal(box.mails.length, 1);

    const confirm = box.link('confirm');
    const page = await fetch(`${base}${confirm.pathname}${confirm.search}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Done/);
    assert.equal(at(await (await call('')).json(), 'reminders'), 'on');
    // Without a pay link, nobody may ask for someone else's subscription.
    const stranger = await fetch(`${base}/pay/api/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com' }),
    });
    assert.equal(stranger.status, 401);
  });
});
