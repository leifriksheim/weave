/**
 * Rules as records (`std.rule`): a query, a condition over each result, and
 * what to do — run by their maker, once per record.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';
import { checkRecordCondition } from '../src/records/checks.js';
import { isRecord } from '../src/utils/guards.js';
import { channel, message } from '../src/schemas/library/publishing.js';
import { IT, checkRule, matching, rule, ruleRun, runRules, type Rule } from '../src/schemas/rules.js';

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function alone() {
  const manager = createIdentityManager();
  const me = await manager.fromSeed(generateSeed());
  const node = await createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    stores: memoryStores(),
    watchIntervalMs: 0,
  });
  open.push(node);
  const { id: space } = await node.spaces.create({ name: 'Club', ...team, visibility: 'private' });
  for (const definition of [channel, message, rule, ruleRun])
    await node.collections.define(space, definition);
  return { node, did: me.did, space };
}

/** "When a channel has more than `n` messages, say so in it" */
const busyChannels = (n: number, since: string): Rule => ({
  name: 'Busy channels',
  when: {
    query: {
      collection: channel.name,
      include: { messages: { rel: 'channel', from: message.name, count: true } },
    },
    holds: { '>': [{ var: 'included.messages' }, n] },
  },
  then: {
    kind: 'add',
    collection: message.name,
    text: '#{title} has {messages} messages',
    links: [{ rel: 'channel', to: IT }],
  },
  since,
});

describe('rules', () => {
  test('a rule is a query and a condition that may read what the query included', () => {
    const since = new Date().toISOString();
    assert.equal(checkRule(busyChannels(10, since)), null);
    assert.match(checkRule({ ...busyChannels(10, since), when: { query: {} } })!, /collection/);
    assert.match(
      checkRule({
        ...busyChannels(10, since),
        when: { query: { collection: 'std.channel' }, holds: { var: 'seq' } },
      })!,
      /not something a record condition can read/,
    );
    assert.match(checkRule({ ...busyChannels(10, since), then: { kind: 'shout', text: 'x' } })!, /then.kind/);
    // Actions name no collection of their own: a message is added like anything else.
    assert.match(
      checkRule({ ...busyChannels(10, since), then: { kind: 'message', text: 'x' } })!,
      /then.kind/,
    );
    assert.match(
      checkRule({
        ...busyChannels(10, since),
        then: { kind: 'add', collection: message.name, text: 'x', links: [{ rel: 'channel' }] },
      })!,
      /then.links/,
    );
    // A subscription's where reads the record alone: what a query included is not its to read.
    assert.match(checkRecordCondition({ '>': [{ var: 'included.messages' }, 1] })!, /not something/);
    assert.equal(
      checkRecordCondition({ '>': [{ var: 'included.messages' }, 1] }, 'holds', { included: true }),
      null,
    );
  });

  test('“a channel with more than 3 messages” counts the messages linked to it, and acts once', async () => {
    const { node, did, space } = await alone();
    const since = new Date(Date.now() - 1000).toISOString();
    const design = await node.records.put(space, channel.name, { name: 'design' });
    const quiet = await node.records.put(space, channel.name, { name: 'quiet' });
    const say = (text: string, to: string) =>
      node.records.put(space, message.name, { text }, { links: [{ rel: 'channel', to }] });
    for (const text of ['a', 'b', 'c']) await say(text, design.key);
    await say('hello', quiet.key);

    const when = busyChannels(3, since).when!;
    assert.deepEqual(await matching(node, space, when, did), []);
    await say('d', design.key);
    const found = await matching(node, space, when, did);
    assert.deepEqual(
      found.map((m) => [m.record.key, m.included.messages]),
      [[design.key, 4]],
    );

    const made = await node.records.put(space, rule.name, busyChannels(3, since));
    await runRules(node, space, did);
    await runRules(node, space, did);
    const posted = (
      await node.records.query(space, { collection: message, where: { 'link:channel': design.key } })
    ).records.filter((m) => m.body.text.startsWith('#design'));
    assert.deepEqual(
      posted.map((m) => m.body.text),
      ['#design has 4 messages'],
    );
    const runs = await node.records.linked(space, made.key, { rel: 'rule' });
    assert.equal(runs.length, 1);
    const body = runs[0]?.body;
    assert.ok(isRecord(body));
    assert.equal(body.ok, true);
    assert.equal(body.did, 'Added a message: #design has 4 messages');
    assert.equal(body.made, posted[0]?.key, 'the run names what it wrote');
  });

  test('“a message in #design” sets off for that channel’s messages alone', async () => {
    const { node, did, space } = await alone();
    const design = await node.records.put(space, channel.name, { name: 'design' });
    const quiet = await node.records.put(space, channel.name, { name: 'quiet' });
    const say = (text: string, to: string) =>
      node.records.put(space, message.name, { text }, { links: [{ rel: 'channel', to }] });
    const when = { query: { collection: message.name, where: { 'link:channel': design.key } } };
    assert.equal(
      checkRule({
        name: 'Design',
        when,
        then: { kind: 'notify', text: '{title}' },
        since: new Date().toISOString(),
      }),
      null,
    );
    await say('hello', quiet.key);
    assert.deepEqual(await matching(node, space, when, did), []);
    const posted = await say('new mockups', design.key);
    assert.deepEqual(
      (await matching(node, space, when, did)).map((m) => m.record.key),
      [posted.key],
    );
  });

  test('what came to hold before the rule was made does not set it off', async () => {
    const { node, did, space } = await alone();
    const design = await node.records.put(space, channel.name, { name: 'design' });
    for (const text of ['a', 'b']) {
      await node.records.put(space, message.name, { text }, { links: [{ rel: 'channel', to: design.key }] });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    await node.records.put(space, rule.name, busyChannels(1, new Date().toISOString()));
    await runRules(node, space, did);
    assert.equal((await node.records.list(space, { collection: ruleRun.name })).length, 0);
  });

  test('only its maker runs a rule', async () => {
    const { node, space } = await alone();
    const design = await node.records.put(space, channel.name, { name: 'design' });
    await node.records.put(
      space,
      message.name,
      { text: 'a' },
      { links: [{ rel: 'channel', to: design.key }] },
    );
    await node.records.put(space, rule.name, busyChannels(0, new Date(0).toISOString()));
    await runRules(node, space, 'did:key:zDnaeSomeoneElse');
    assert.equal((await node.records.list(space, { collection: ruleRun.name })).length, 0);
  });

  test('nothing a rule wrote sets off a rule, so “when a message is added, add a message” answers once', async () => {
    const { node, did, space } = await alone();
    const echo: Rule = {
      name: 'Echo',
      when: { query: { collection: message.name } },
      then: {
        kind: 'add',
        collection: message.name,
        text: 'Heard: {title}',
        links: [{ rel: 'shares', to: IT }],
      },
      since: new Date(Date.now() - 1000).toISOString(),
    };
    await node.records.put(space, rule.name, echo);
    // And a second rule answering the first's messages the same way: two rules can't answer each other either.
    await node.records.put(space, rule.name, { ...echo, name: 'Echo again' });
    const said = await node.records.put(space, message.name, { text: 'hi' });
    for (let i = 0; i < 4; i++) await runRules(node, space, did);
    const texts = (await node.records.list(space, { collection: message.name }))
      .map((m) => (isRecord(m.body) ? m.body.text : null))
      .sort();
    assert.deepEqual(texts, ['Heard: hi', 'Heard: hi', 'hi']);
    const shared = (await node.records.linked(space, said.key, { rel: 'shares' })).length;
    assert.equal(shared, 2, 'each links to what set it off');
  });

  test('a collection one line of text can’t make a record of is said, not written', async () => {
    const { node, did, space } = await alone();
    await node.records.put(space, rule.name, {
      name: 'Nowhere',
      when: { query: { collection: channel.name } },
      then: { kind: 'add', collection: 'app.nowhere', text: 'x' },
      since: new Date(Date.now() - 1000).toISOString(),
    });
    await node.records.put(space, channel.name, { name: 'design' });
    await runRules(node, space, did);
    const runs = await node.records.list(space, { collection: ruleRun.name });
    const body = runs[0]?.body;
    assert.ok(isRecord(body));
    assert.equal(body.ok, false);
    assert.match(String(body.did), /can't add/);
  });
});
