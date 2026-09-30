/**
 * Who runs a rule, and what sets it off: a person's agent answering `ask`, a
 * bot running the rules of members who may instruct it, the time. Against
 * real nodes, with an agent writing under a real note.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';

import { createNode } from '../src/node/node.js';
import { runAction } from '../src/node/actions.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { AGENT_FACT } from '../src/identity/agent-note.js';
import { community } from '../src/space/presets.js';
import { message } from '../src/schemas/library/publishing.js';
import { task } from '../src/schemas/library/planning.js';
import { checkCron, cronMatches } from '../src/schemas/cron.js';
import {
  ACTIVITY_STALE_SECONDS,
  activeNow,
  activity,
  checkRule,
  rule,
  ruleRun,
  setActivity,
  startRules,
  type Rule,
  type RuleTrigger,
  type StartRulesOptions,
} from '../src/schemas/rules.js';
import { memoryStores } from './helpers/memory-stores.js';
import { until } from './helpers/until.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { hold } from './helpers/hold.js';
import { joined } from './helpers/joined.js';

const stops: Array<() => void> = [];
const nodes: P2PNode[] = [];
after(async () => {
  for (const stop of stops) stop();
  await Promise.all(nodes.map((node) => node.close()));
});

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

/** A person's node, and the same node acting as their agent under a note that says so */
async function personAndAgent(fill: number) {
  const manager = createIdentityManager();
  const me = await manager.fromSeed(new Uint8Array(16).fill(fill));
  const provider = manager.getProvider();
  const person = await createNode({
    signer: createLocalRootSigner(me, provider),
    stores: memoryStores(),
    watchIntervalMs: 0,
  });
  nodes.push(person);
  const space = (await person.spaces.create({ name: 'Board', visibility: 'private' })).id;
  for (const definition of [task, rule, ruleRun]) await person.collections.define(space, definition);
  const keys = await provider.generateKeyPair();
  const note = await createLocalRootSigner(me, provider).delegate({
    audience: publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC),
    capabilities: [{ with: `space:${space}`, can: 'expression/*' }],
    expiration: Math.floor(Date.now() / 1000) + 3600,
    facts: [AGENT_FACT],
  });
  const agent = await person.asAgent({ keys, note: note.encoded });
  nodes.push(agent);
  return { person, agent, space, account: person.did };
}

/** Runs rules on a node with an agent that answers `ask`, and keeps what set it off */
function running(node: P2PNode, account: string, options: Partial<StartRulesOptions> = {}) {
  const asked: RuleTrigger[] = [];
  const names: string[][] = [];
  stops.push(
    startRules(node, {
      account,
      ask: (trigger) => {
        asked.push(trigger);
        return Promise.resolve({ did: 'Did it', ok: true });
      },
      onRules: (rules) => names.push(rules.map((r) => r.body.name)),
      ...options,
    }),
  );
  return { asked, names };
}

const now = () => new Date().toISOString();

const doneAndMine = (): Rule => ({
  name: 'Done tasks of mine',
  when: { query: { collection: task.name, where: { status: 'done', assignees: { $contains: '$me' } } } },
  then: { kind: 'ask', text: 'Post a short win in #general' },
  since: now(),
});

describe('a rule that asks an agent', () => {
  test('runs once a record comes to hold for it; what held before, and what doesn’t hold, don’t set it off', async () => {
    const { person, agent, space, account } = await personAndAgent(21);
    await person.records.put(space, task.name, { title: 'Old', status: 'done', assignees: [account] });
    await settle(5);
    await person.records.put(space, rule.name, doneAndMine());
    const { asked, names } = running(agent, account);
    await until(() => names.at(-1)?.[0] === 'Done tasks of mine');

    const posters = await person.records.put(space, task.name, {
      title: 'Posters',
      status: 'todo',
      assignees: [account],
    });
    await person.records.put(space, task.name, {
      title: 'Not mine',
      status: 'done',
      assignees: ['did:key:zDnaeBob'],
    });
    await person.records.update(space, posters.key, {
      title: 'Posters',
      status: 'done',
      assignees: [account],
    });

    await until(() => asked.length > 0);
    await settle();
    assert.deepEqual(
      asked.map((t) => t.match?.record.key),
      [posters.key],
    );
    const runs = await person.records.list(space, { collection: ruleRun.name });
    assert.equal(runs.length, 1, 'the run says what the agent did');
  });

  test('a runner that can’t ask an agent, like an app, leaves it alone', async () => {
    const { person, space, account } = await personAndAgent(27);
    await person.records.put(space, rule.name, doneAndMine());
    const { names } = running(person, account, { ask: undefined });
    await person.records.put(space, task.name, { title: 'Done', status: 'done', assignees: [account] });
    await settle(200);
    assert.deepEqual(names.at(-1) ?? [], []);
    assert.equal((await person.records.list(space, { collection: ruleRun.name })).length, 0);
  });

  test('a rule an agent wrote waits for the person; saving it themselves turns it on', async () => {
    const { person, agent, space, account } = await personAndAgent(22);
    const suggested = await agent.records.put(space, rule.name, doneAndMine());
    const { asked, names } = running(agent, account);
    await settle();
    assert.deepEqual(names.at(-1) ?? [], []);

    await person.records.put(space, task.name, { title: 'Early', status: 'done', assignees: [account] });
    await settle();
    assert.equal(asked.length, 0, 'nothing runs while the agent’s version is the current one');

    await person.records.update(space, suggested.key, doneAndMine());
    await until(() => names.at(-1)?.[0] === 'Done tasks of mine');
    await person.records.put(space, task.name, { title: 'Late', status: 'done', assignees: [account] });
    await until(() => asked.length === 1);
  });

  test('nothing the agent writes sets a rule off, so it can’t set itself off', async () => {
    const { person, agent, space, account } = await personAndAgent(23);
    await person.records.put(space, rule.name, doneAndMine());
    const { asked, names } = running(agent, account);
    await until(() => names.at(-1)?.length === 1);

    await agent.records.put(space, task.name, {
      title: 'By the agent',
      status: 'done',
      assignees: [account],
    });
    await settle();
    assert.equal(asked.length, 0);
  });

  test('a paused rule, or one that can’t be read, doesn’t run', async () => {
    const { person, agent, space, account } = await personAndAgent(24);
    await person.records.put(space, rule.name, { ...doneAndMine(), paused: true });
    await person.records.put(space, rule.name, {
      name: 'Nothing',
      then: { kind: 'ask', text: 'x' },
      since: now(),
    });
    await person.records.put(space, rule.name, {
      name: 'Bad time',
      every: 'at noon every day',
      then: { kind: 'ask', text: 'x' },
      since: now(),
    });
    const { names } = running(agent, account);
    await settle();
    assert.deepEqual(names.at(-1) ?? [], []);
  });
});

describe('the time', () => {
  test('a rule with every runs once in each minute it names', async () => {
    const { person, agent, space, account } = await personAndAgent(25);
    await person.records.put(space, rule.name, {
      name: 'Weekday mornings',
      every: '0 8 * * 1-5',
      then: { kind: 'ask', text: 'Plan my day' },
      since: now(),
    });
    let at = new Date(2026, 8, 30, 8, 0, 5); // a Wednesday, 08:00
    const { asked, names } = running(agent, account, { now: () => at, tickMs: 10 });
    await until(() => names.at(-1)?.length === 1);
    await until(() => asked.length === 1);
    await settle(50);
    assert.equal(asked.length, 1, 'once in the minute, however often it looks');
    at = new Date(2026, 9, 3, 8, 0, 5); // a Saturday
    await settle(50);
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.at?.getHours(), 8);
  });

  test('a runner that is not always on leaves the time to one that is', async () => {
    const { person, agent, space, account } = await personAndAgent(26);
    await person.records.put(space, rule.name, {
      name: 'Every minute',
      every: '* * * * *',
      then: { kind: 'ask', text: 'Anything' },
      since: now(),
    });
    const { asked, names } = running(agent, account, { timed: false, tickMs: 10 });
    await until(() => names.at(-1)?.length === 1);
    await settle(80);
    assert.equal(asked.length, 0);
  });

  test('cron reads five fields, refuses what it can’t read, and a day and a weekday mean either', () => {
    assert.equal(checkCron('*/15 8-17 * * 1-5'), null);
    assert.match(checkCron('0 9 * *') ?? '', /five fields/);
    assert.match(checkCron('61 * * * *') ?? '', /minute/);
    const at = (d: number, h: number, m: number) => new Date(2026, 8, d, h, m); // September 2026
    assert.ok(cronMatches('*/15 8-17 * * 1-5', at(29, 9, 30))); // Tuesday
    assert.ok(!cronMatches('*/15 8-17 * * 1-5', at(27, 9, 30))); // Sunday
    assert.ok(cronMatches('0 9 * * 7', at(27, 9, 0)), '7 is Sunday too');
    assert.ok(cronMatches('0 9 1 * 1', at(1, 9, 0)), 'the 1st, a Tuesday');
    assert.ok(!cronMatches('0 9 1 * 1', at(29, 9, 0)));
    // A rule changing a record needs one; the time alone has none.
    assert.match(
      checkRule({
        name: 'x',
        every: '0 9 * * *',
        then: { kind: 'set', field: 'a', value: 1 },
        since: now(),
      })!,
      /needs a when/,
    );
  });
});

/** Someone on the network, with an account of their own */
async function member(hub: FakeHub, fill: number) {
  const manager = createIdentityManager();
  const me = await manager.fromSeed(new Uint8Array(16).fill(fill));
  const node = await createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    stores: memoryStores(),
    watchIntervalMs: 0,
    network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
  });
  nodes.push(node);
  return node;
}

/** A community space: an admin, a member, and a bot the admin invited as a member */
async function club(fill: number) {
  const hub = createFakeHub({ latencyMs: 1 });
  const admin = await member(hub, fill);
  const person = await member(hub, fill + 1);
  const bot = await member(hub, fill + 2);
  const { id: space } = await admin.spaces.create({ name: 'Club', ...community, visibility: 'private' });
  for (const definition of [message, rule, ruleRun]) await admin.collections.define(space, definition);
  await person.spaces.join(await admin.spaces.invite(space, { role: 'member' }));
  await bot.spaces.join(await admin.spaces.invite(space, { role: 'member' }));
  await hold(admin, space);
  await joined(person, space);
  await joined(bot, space);
  await hold(person, space);
  await hold(bot, space);
  return { admin, person, bot, space };
}

const mentionsBot = (bot: string): Rule => ({
  name: 'Answer when mentioned',
  when: { query: { collection: message.name, where: { mentions: { $contains: '$me' } } } },
  then: { kind: 'ask', text: 'Answer them in the same channel' },
  by: bot,
  since: now(),
});

describe('a bot', () => {
  test('runs the rules naming it of members allowed to instruct it, and not the others’', async () => {
    const { admin, person, bot, space } = await club(31);
    await admin.records.put(space, rule.name, mentionsBot(bot.did));
    await person.records.put(space, rule.name, { ...mentionsBot(bot.did), name: 'Not allowed' });
    await admin.records.put(space, rule.name, {
      ...mentionsBot(bot.did),
      name: 'Not for it',
      by: person.did,
    });
    const { asked, names } = running(bot, bot.did, { bot: true });
    await until(() => names.at(-1)?.includes('Answer when mentioned') ?? false, 6000, 'the admin’s rule');
    assert.deepEqual(names.at(-1), ['Answer when mentioned']);

    const hi = await person.records.put(space, message.name, { text: '@Bot hi', mentions: [bot.did] });
    await until(() => asked.length === 1, 6000, 'the mention');
    assert.equal(asked[0]?.match?.record.key, hi.key, '$me is the bot running it');
    assert.equal(asked[0]?.rule.maker, admin.did);

    // What the bot writes never sets it off, even mentioning itself.
    await bot.records.put(space, message.name, { text: 'Hi! @me', mentions: [bot.did] });
    await settle(200);
    assert.equal(asked.length, 1);
  });

  test('a rule with from is set off only by members holding one of those roles', async () => {
    const { admin, person, bot, space } = await club(41);
    await admin.records.put(space, rule.name, {
      ...mentionsBot(bot.did),
      when: { ...mentionsBot(bot.did).when!, from: ['admin'] },
    });
    const { asked, names } = running(bot, bot.did, { bot: true });
    await until(() => names.at(-1)?.length === 1, 6000, 'the rule');

    await person.records.put(space, message.name, { text: '@Bot hi', mentions: [bot.did] });
    const fromAdmin = await admin.records.put(space, message.name, { text: '@Bot hi', mentions: [bot.did] });
    await until(() => asked.length === 1, 6000, 'the admin’s mention');
    await settle(200);
    assert.deepEqual(
      asked.map((t) => t.match?.record.key),
      [fromAdmin.key],
    );
  });

  test('a person’s own runner doesn’t run a rule meant for a bot, nor anyone else’s', async () => {
    const { admin, bot, space } = await club(51);
    await admin.records.put(space, rule.name, mentionsBot(bot.did));
    const mine = running(admin, admin.did);
    const theirs = running(bot, bot.did);
    // Waited for, not slept on: the rule reaches the bot over the network, which takes longer under load.
    await until(
      () => theirs.names.at(-1)?.[0] === 'Answer when mentioned',
      6000,
      'the bot to run what names it',
    );
    // Now both nodes hold the rule, so what doesn't run is worth checking.
    await settle(200);
    assert.deepEqual(mine.names.at(-1) ?? [], []);
    const others = running(bot, 'did:key:zDnaeSomeoneElse');
    await settle(200);
    assert.deepEqual(others.names.at(-1) ?? [], []);
  });
});

describe('std.activity', () => {
  test('one per account per record, changed in place, and believed only while fresh', async () => {
    const { person, space } = await personAndAgent(97);
    const done = await person.records.put(space, task.name, { title: 'Book the hall' });
    assert.equal(
      await setActivity(person, space, done.key, 'working'),
      null,
      'none where the space keeps none',
    );
    await person.collections.define(space, activity);

    const first = await setActivity(person, space, done.key, 'working', 'Booking');
    const again = await setActivity(person, space, done.key, 'done');
    assert.equal(again?.key, first?.key, 'the same record, changed');
    const kept = await person.records.linked(space, done.key, { rel: 'about', collection: activity.name });
    assert.equal(kept.filter((r) => !r.deleted).length, 1);
    assert.equal(z.object({ state: z.string() }).parse(kept[0]?.body).state, 'done');
    const put = await person.records.put(
      space,
      activity.name,
      { state: 'working', at: new Date().toISOString() },
      { links: [{ rel: 'about', to: done.key }] },
    );
    assert.equal(put.key, first?.key, 'a second for the same record is the same record again');

    const now = Date.now();
    const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();
    assert.equal(activeNow({ state: 'working', at: at(10) }, now), true);
    assert.equal(activeNow({ state: 'waiting', at: at(10) }, now), true);
    assert.equal(activeNow({ state: 'done', at: at(10) }, now), false);
    assert.equal(
      activeNow({ state: 'working', at: at(ACTIVITY_STALE_SECONDS + 1) }, now),
      false,
      'gone stale',
    );
  });

  test('anyone at work says what they are doing with activity_set, and the label stays to the end', async () => {
    const { person, space } = await personAndAgent(98);
    const on = await person.records.put(space, task.name, { title: 'Plan the trip' });
    await assert.rejects(
      runAction(person, 'activity_set', { space, about: on.key, label: 'Reading' }),
      /keeps no std\.activity/,
    );
    await person.collections.define(space, activity);
    const set = z
      .object({ state: z.string(), label: z.string() })
      .parse(await runAction(person, 'activity_set', { space, about: on.key, label: 'Making an app' }));
    assert.deepEqual(set, { state: 'working', label: 'Making an app' });
    await setActivity(person, space, on.key, 'done');
    const [kept] = await person.records.linked(space, on.key, { rel: 'about', collection: activity.name });
    assert.deepEqual(
      z.object({ state: z.string(), label: z.string() }).parse(kept?.body),
      { state: 'done', label: 'Making an app' },
      'done, still saying what it did',
    );
    await assert.rejects(
      runAction(person, 'activity_set', { space, about: on.key, label: 'x', state: 'thinking' }),
      /state/,
    );
  });
});
