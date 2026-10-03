/**
 * Checks: conditions over a version, the version before it and versions it
 * cites, judged by every peer that can read them (02 §7.6).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { bodyHashOf } from '../src/schema/expression.js';
import { checkRules, onePerKey } from '../src/records/rules.js';
import {
  checkChecks,
  runChecks,
  MAX_CHECK_STEPS,
  type Check,
  type CheckScope,
  type CheckedVersion,
  type Condition,
} from '../src/records/checks.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { joined } from './helpers/joined.js';
import { team } from '../src/space/presets.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { useSchemas } from '../src/schemas/index.js';
import { ballot, decision, goal, goalReached, pledge, proposal } from '../src/schemas/library/community.js';
import { forge, person, type Person } from './helpers/person.js';

// ─── The language, alone ───────────────────────────────────────────

const ALICE = 'did:key:zAlice';
const BOB = 'did:key:zBob';

function version(id: string, fields: Partial<CheckedVersion> = {}): CheckedVersion {
  return {
    id,
    key: `k-${id}`,
    collection: 'app.vote',
    seq: 0,
    author: ALICE,
    createdAt: '2026-09-28T12:00:00.000Z',
    deleted: false,
    body: null,
    links: [],
    ...fields,
  };
}

function scope(values: Record<string, unknown> = {}, held: ReadonlyArray<CheckedVersion> = []): CheckScope {
  return {
    values: { body: null, links: [], author: ALICE, prev: null, ...values },
    cite: async (id) => held.find((v) => v.id === id) ?? { later: true },
    can: (permission, did) => permission === 'approve' && did === ALICE,
    member: (did) => did === ALICE || did === BOB,
  };
}

/** Why a version was refused, or '' when it wasn't */
const passed = (outcome: Awaited<ReturnType<typeof runChecks>>) => 'passed' in outcome && outcome.passed;
const why = (outcome: Awaited<ReturnType<typeof runChecks>>) =>
  'passed' in outcome && !outcome.passed ? outcome.reason : '';

const run = (that: Condition, values?: Record<string, unknown>, held?: ReadonlyArray<CheckedVersion>) =>
  runChecks([{ that, else: 'No' }], scope(values, held));

describe('checks: a definition', () => {
  test('takes a list of { that, else }', () => {
    assert.equal(checkChecks([{ that: { '>': [{ var: 'body.amount' }, 0] }, else: 'Give something' }]), null);
    assert.equal(
      checkRules({ check: [{ that: true, else: 'Always' }] }),
      null,
      'rules take check alongside the rest',
    );
    assert.match(checkChecks([]) ?? '', /1 to 16 checks/);
    assert.match(checkChecks([{ that: true }]) ?? '', /else says why/);
    assert.match(checkChecks([{ that: true, else: 'x', also: 1 }]) ?? '', /only "that" and "else"/);
  });

  test('refuses what no peer could judge the same way', () => {
    const problem = (that: unknown, permissions: string[] = []) =>
      checkChecks([{ that, else: 'x' }], 'rules.check', permissions) ?? '';
    assert.match(problem({ eval: 'x' }), /"eval" is not an operator/);
    assert.match(problem({ '==': [1] }), /takes 2 arguments/);
    assert.match(problem({ '==': [1, 2], '!=': [1, 2] }), /one member/);
    assert.match(problem({ var: 'window.location' }), /"window" is not something a check can read/);
    assert.match(problem({ var: 'it.body' }), /"it" is not something/, '`it` only inside a list operation');
    assert.equal(problem({ all: [{ var: 'body.items' }, { '>': [{ var: 'it.price' }, 0] }] }), '');
    assert.match(problem({ var: 'body..x' }), /takes a path/);
    assert.match(problem({ can: 'approve' }), /does not declare it/);
    assert.equal(problem({ can: 'approve' }, ['approve']), '');
    let deep: unknown = true;
    for (let i = 0; i < 40; i++) deep = { not: deep };
    assert.match(problem(deep), /nested more than 32 deep/);
  });
});

describe('checks: judging', () => {
  test('reads the version: its body, the version before, who wrote it', async () => {
    assert.deepEqual(await run({ '==': [{ var: 'body.n' }, 2] }, { body: { n: 2 } }), { passed: true });
    assert.deepEqual(await run({ '==': [{ var: 'body.n' }, 3] }, { body: { n: 2 } }), {
      passed: false,
      reason: 'No',
    });
    const next = { '==': [{ var: 'body.n' }, { '+': [{ var: 'prev.body.n' }, 1] }] };
    assert.deepEqual(await run(next, { body: { n: 3 }, prev: version('p', { body: { n: 2 } }) }), {
      passed: true,
    });
    assert.deepEqual(await run({ '==': [{ var: 'author' }, ALICE] }), { passed: true });
    // Missing is null, and a list position is a path segment.
    assert.deepEqual(await run({ '==': [{ var: 'body.nothing.here' }, null] }, { body: {} }), {
      passed: true,
    });
    assert.deepEqual(await run({ '==': [{ var: 'body.list.1' }, 'b'] }, { body: { list: ['a', 'b'] } }), {
      passed: true,
    });
    // Only a body's own members: nothing JavaScript adds to every object.
    assert.deepEqual(await run({ '==': [{ var: 'body.constructor' }, null] }, { body: {} }), {
      passed: true,
    });
  });

  test('no truthiness: a condition is true, or the version is refused', async () => {
    assert.equal(passed(await run(1)), false);
    assert.equal(passed(await run('yes')), false);
    assert.match(
      why(await run({ and: [true, 1] })),
      /"and" needs true or false/,
      'the reason says what went wrong',
    );
    assert.match(why(await run({ '<': [1, 'two'] })), /compares two numbers or two texts/);
    assert.match(why(await run({ '/': [1, 0] })), /by zero/);
    assert.match(why(await run({ '+': [{ var: 'body.n' }, 1] }, { body: { n: '1' } })), /needs numbers/);
  });

  test('lists: all, some, count, sum, map, filter, distinct, in', async () => {
    const body = {
      items: [
        { price: 3, by: ALICE },
        { price: 4, by: BOB },
        { price: 5, by: ALICE },
      ],
      a: { x: 1, y: [2, 3] },
      b: { y: [2, 3], x: 1 },
    };
    const yes = async (that: Condition) =>
      assert.deepEqual(await run(that, { body }), { passed: true }, JSON.stringify(that));
    await yes({ all: [{ var: 'body.items' }, { '>': [{ var: 'it.price' }, 0] }] });
    await yes({ some: [{ var: 'body.items' }, { '==': [{ var: 'it.price' }, 4] }] });
    await yes({ '==': [{ count: [{ var: 'body.items' }, { '==': [{ var: 'it.by' }, ALICE] }] }, 2] });
    await yes({ '==': [{ sum: [{ var: 'body.items' }, { var: 'it.price' }] }, 12] });
    await yes({ '==': [{ size: { distinct: { map: [{ var: 'body.items' }, { var: 'it.by' }] } } }, 2] });
    await yes({
      '==': [{ size: { filter: [{ var: 'body.items' }, { '>': [{ var: 'it.price' }, 3] }] } }, 2],
    });
    await yes({ in: [BOB, { map: [{ var: 'body.items' }, { var: 'it.by' }] }] });
    await yes({ all: [[], false] });
    await yes({ not: { some: [[], true] } });
    await yes({ '==': [{ max: [1, 7, 3] }, 7] });
    await yes({ '==': [{ '%': [7, 3] }, 1] });
    await yes({ '==': [{ '-': [3] }, -3] });
    await yes({ '==': [{ get: [{ var: 'body.items' }, '2.price'] }, 5] });
    // Equality is of canonical JSON: member order doesn't matter.
    await yes({ '==': [{ var: 'body.a' }, { var: 'body.b' }] });
  });

  test('always ends: a check that takes too many steps is refused', async () => {
    const many = Array.from({ length: 200 }, (_, i) => i);
    // 200 × 200 elements, more than the limit
    const that = { all: [many, { all: [many, true] }] };
    const outcome = await run(that);
    assert.equal(passed(outcome), false);
    assert.match(why(outcome), new RegExp(`more than ${MAX_CHECK_STEPS} steps`));
  });

  test('hash is the content id of canonical JSON, the same as a body hash: commit, then reveal', async () => {
    const secret = { roll: 4, salt: 'k3j9x' };
    const commitment = await bodyHashOf(secret);
    assert.deepEqual(
      await run(
        { '==': [{ hash: { var: 'body.reveal' } }, commitment] },
        { body: { reveal: { salt: 'k3j9x', roll: 4 } } },
      ),
      { passed: true },
    );
  });

  test('cited versions: read by id; one not here yet makes the version wait', async () => {
    const held = [
      version('v1', { author: ALICE, body: { choice: 'yes' }, links: [{ rel: 'about', to: 'prop' }] }),
      version('v2', { author: BOB, body: { choice: 'yes' }, links: [{ rel: 'about', to: 'prop' }] }),
    ];
    const enough = {
      '>=': [
        {
          size: {
            distinct: {
              map: [
                {
                  filter: [
                    { versions: { var: 'body.votes' } },
                    {
                      and: [
                        { '==': [{ link: ['about', { var: 'it' }] }, { link: ['about'] }] },
                        { '==': [{ var: 'it.body.choice' }, 'yes'] },
                      ],
                    },
                  ],
                },
                { var: 'it.author' },
              ],
            },
          },
        },
        2,
      ],
    };
    const links = [{ rel: 'about', to: 'prop' }];
    assert.deepEqual(await run(enough, { body: { votes: ['v1', 'v2'] }, links }, held), { passed: true });
    assert.equal(passed(await run(enough, { body: { votes: ['v1', 'v1'] }, links }, held)), false);
    assert.deepEqual(await run(enough, { body: { votes: ['v1', 'v3'] }, links }, held), { later: true });
  });

  test('can and member: roles as of what the version saw', async () => {
    assert.deepEqual(await run({ can: 'approve' }), { passed: true });
    assert.deepEqual(await run({ can: ['approve', BOB] }), { passed: false, reason: 'No' });
    assert.deepEqual(await run({ member: BOB }), { passed: true });
    assert.equal(passed(await run({ member: 'not a did' })), false);
  });

  test('the first check that is not true decides', async () => {
    const checks: Check[] = [
      { that: true, else: 'First' },
      { that: false, else: 'Second' },
      { that: false, else: 'Third' },
    ];
    assert.deepEqual(await runChecks(checks, scope()), { passed: false, reason: 'Second' });
  });
});

// ─── Between peers ─────────────────────────────────────────────────

/** "Passed" cites at least two distinct members' yes votes on the same proposal */
const TWO_YES: Check = {
  that: {
    '>=': [
      {
        size: {
          distinct: {
            map: [
              {
                filter: [
                  { versions: { var: 'body.votes' } },
                  {
                    and: [
                      { '==': [{ var: 'it.collection' }, 'app.proposal.vote'] },
                      { '==': [{ link: ['about', { var: 'it' }] }, { link: ['about'] }] },
                      { '==': [{ var: 'it.body.choice' }, 'yes'] },
                    ],
                  },
                ],
              },
              { var: 'it.author' },
            ],
          },
        },
      },
      2,
    ],
  },
  else: 'A proposal passes with yes votes from at least two members',
};

/** A counter counts up by one: the version before decides what comes next */
const BY_ONE: Check = {
  that: {
    if: [
      { '==': [{ var: 'prev' }, null] },
      { '==': [{ var: 'body.n' }, 0] },
      { '==': [{ var: 'body.n' }, { '+': [{ var: 'prev.body.n' }, 1] }] },
    ],
  },
  else: 'A counter starts at 0 and counts up by one',
};

async function proposalSpace(visibility: 'public' | 'private' = 'public') {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await alice.node.collections.define(space, { name: 'app.proposal', schema: { type: 'object' } });
  await alice.node.collections.define(space, {
    name: 'app.proposal.vote',
    schema: { type: 'object' },
    links: { about: { to: ['app.proposal'], cardinality: 'one' } },
    rules: { edit: 'creator', onePer: ['@author', 'link:about'] },
  });
  await alice.node.collections.define(space, {
    name: 'app.proposal.passed',
    schema: { type: 'object' },
    links: { about: { to: ['app.proposal'], cardinality: 'one' } },
    rules: { onePer: ['link:about'], check: [TWO_YES] },
  });
  await alice.node.collections.define(space, {
    name: 'app.counter',
    schema: { type: 'object' },
    rules: { check: [BY_ONE] },
  });
  await hold(alice.node, space);
  await hold(bob.node, space);
  await joined(bob.node, space);
  await until(
    async () => (await bob.node.collections.list(space)).filter((c) => c.version !== null).length === 4,
    4000,
    'definitions to reach Bob',
  );
  return { hub, alice, bob, space };
}

describe('checks: between peers', () => {
  for (const visibility of ['public', 'private'] as const) {
    test(`a proposal passes once two members have voted yes, and every peer agrees (${visibility} space)`, async () => {
      const { alice, bob, space } = await proposalSpace(visibility);
      const proposal = await alice.node.records.put(space, 'app.proposal', { title: 'A new logo' });
      const about = [{ rel: 'about', to: proposal.key }];
      const mine = await alice.node.records.put(
        space,
        'app.proposal.vote',
        { choice: 'yes' },
        { links: about },
      );
      await until(
        async () => (await bob.node.records.get(space, proposal.key)) !== null,
        4000,
        'the proposal',
      );
      const theirs = await bob.node.records.put(
        space,
        'app.proposal.vote',
        { choice: 'yes' },
        { links: about },
      );
      await until(async () => (await alice.node.records.get(space, theirs.key)) !== null, 4000, 'Bob’s vote');

      // One vote, cited twice, is still one member.
      await assert.rejects(
        alice.node.records.put(
          space,
          'app.proposal.passed',
          { votes: [mine.version, mine.version] },
          { links: about },
        ),
        /at least two members/,
      );
      const passed = await alice.node.records.put(
        space,
        'app.proposal.passed',
        { votes: [mine.version, theirs.version] },
        { links: about },
      );
      await until(
        async () => (await bob.node.records.get(space, passed.key)) !== null,
        4000,
        'Bob to accept it',
      );
    });
  }

  test('a claim with too little evidence, signed anyway, is refused by every peer that receives it', async () => {
    const { alice, bob, space } = await proposalSpace();
    const proposal = await alice.node.records.put(space, 'app.proposal', { title: 'A new logo' });
    const about = [{ rel: 'about', to: proposal.key }];
    await until(async () => (await bob.node.records.get(space, proposal.key)) !== null, 4000, 'the proposal');
    const own = await bob.node.records.put(space, 'app.proposal.vote', { choice: 'yes' }, { links: about });

    // One "passed" per proposal: the key is derived from what it is about.
    const key = (await onePerKey('app.proposal.passed', ['link:about'], {
      root: '',
      links: about,
      body: {},
    }))!;
    await letGo(bob.node, space);
    await forge(bob, space, {
      author: '',
      collection: 'app.proposal.passed',
      body: { votes: [own.version] },
      links: about,
      retain: true,
      version: { key, seq: 0 },
    });
    const rejected: string[] = [];
    alice.node.subscribe((event) => {
      if (event.type === 'rejected') rejected.push(event.reason);
    });
    await hold(bob.node, space);
    await until(async () => rejected.some((r) => /at least two members/.test(r)), 4000, 'Alice to refuse it');
    assert.equal(await alice.node.records.get(space, key), null);
  });

  test('a version under a check must be kept whole, or every peer refuses it', async () => {
    const { alice, bob, space } = await proposalSpace();
    await letGo(bob.node, space);
    await forge(bob, space, {
      author: '',
      collection: 'app.counter',
      body: { n: 0 },
      version: { key: 'forgotten', seq: 0 },
    });
    const rejected: string[] = [];
    alice.node.subscribe((event) => {
      if (event.type === 'rejected') rejected.push(event.reason);
    });
    await hold(bob.node, space);
    await until(async () => rejected.some((r) => /must be kept whole/.test(r)), 4000, 'Alice to refuse it');
  });

  test('a record whose versions are checked against the one before is a state machine', async () => {
    const { alice, bob, space } = await proposalSpace();
    const counter = await alice.node.records.put(space, 'app.counter', { n: 0 });
    await alice.node.records.update(space, counter.key, { n: 1 });
    await assert.rejects(alice.node.records.update(space, counter.key, { n: 5 }), /counts up by one/);
    await until(
      async () => (await bob.node.records.get<{ n: number }>(space, counter.key))?.body?.n === 1,
      4000,
      'Bob to follow',
    );
    await bob.node.records.update(space, counter.key, { n: 2 });
    await assert.rejects(alice.node.records.put(space, 'app.counter', { n: 3 }), /starts at 0/);
  });

  test('a proof stays a proof: removing a voter it counted, later, does not undo it', async () => {
    const { hub, alice, bob, space } = await proposalSpace();
    const carol = await person(hub);
    await carol.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(carol.node, space);
    await joined(carol.node, space);
    const first = await alice.node.records.put(space, 'app.proposal', { title: 'A new logo' });
    const second = await alice.node.records.put(space, 'app.proposal', { title: 'A new name' });
    const yes = (who: Person, about: string) =>
      who.node.records.put(
        space,
        'app.proposal.vote',
        { choice: 'yes' },
        { links: [{ rel: 'about', to: about }] },
      );
    await until(
      async () =>
        (await bob.node.records.get(space, second.key)) !== null &&
        (await carol.node.records.get(space, second.key)) !== null &&
        (await carol.node.collections.list(space)).filter((c) => c.version !== null).length === 4,
      4000,
      'the proposals to reach Bob and Carol',
    );

    // Alice goes offline. Bob votes on both, Carol on the first, and Carol proves the first passed.
    await letGo(alice.node, space);
    const bobFirst = await yes(bob, first.key);
    const bobSecond = await yes(bob, second.key);
    const carolFirst = await yes(carol, first.key);
    await until(
      async () => (await carol.node.records.get(space, bobSecond.key)) !== null,
      4000,
      'Bob’s votes to reach Carol',
    );
    const passed = await carol.node.records.put(
      space,
      'app.proposal.passed',
      { votes: [bobFirst.version, carolFirst.version] },
      { links: [{ rel: 'about', to: first.key }] },
    );

    // Offline, Alice removes Bob, without having seen his votes, so the removal keeps none.
    await alice.node.spaces.setMember(space, bob.node.did, null);
    await hold(alice.node, space);
    await until(
      async () => (await carol.node.spaces.access(space)).members.every((m) => m.did !== bob.node.did),
      4000,
      'the removal to reach Carol',
    );
    await until(
      async () => (await carol.node.records.get(space, bobFirst.key)) === null,
      4000,
      'Bob’s vote to stop counting for Carol',
    );

    // Carol's proof had not seen the removal: it stands for her, and for Alice, who joins in late.
    assert.notEqual(await carol.node.records.get(space, passed.key), null);
    await until(
      async () => (await alice.node.records.get(space, passed.key)) !== null,
      4000,
      'Alice to accept the proof',
    );
    assert.equal(await alice.node.records.get(space, bobFirst.key), null, 'Bob’s vote counts for no one now');

    // A proof made after seeing the removal can't count him.
    const carolSecond = await yes(carol, second.key);
    await assert.rejects(
      carol.node.records.put(
        space,
        'app.proposal.passed',
        { votes: [bobSecond.version, carolSecond.version] },
        { links: [{ rel: 'about', to: second.key }] },
      ),
      /does not stand/,
    );
  });
});

// ─── The standard library's proven outcomes ────────────────────────

async function governedSpace() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'private' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  const library = [proposal, ballot, decision, goal, pledge, goalReached];
  await useSchemas(alice.node, space, library);
  await hold(alice.node, space);
  await hold(bob.node, space);
  await joined(bob.node, space);
  await until(
    async () =>
      (await bob.node.collections.list(space)).filter((c) => c.version !== null).length === library.length,
    4000,
    'definitions to reach Bob',
  );
  return { alice, bob, space };
}

describe('checks: std.decision and std.goal-reached', () => {
  test('a proposal is decided once its quorum of ballots for one option is cited', async () => {
    const { alice, bob, space } = await governedSpace();
    const put = await alice.node.records.put(space, proposal, {
      title: 'Where do we meet?',
      options: ['Café', 'Library'],
      quorum: 2,
    });
    const about = [{ rel: 'about', to: put.key }];
    const mine = await alice.node.records.put(space, ballot, { choice: 1 }, { links: about });
    // A ballot is final.
    await assert.rejects(alice.node.records.update(space, mine.key, { choice: 0 }), /"choice" is fixed/);
    await until(async () => (await bob.node.records.get(space, put.key)) !== null, 4000, 'the proposal');
    const theirs = await bob.node.records.put(space, ballot, { choice: 1 }, { links: about });
    await until(async () => (await alice.node.records.get(space, theirs.key)) !== null, 4000, 'Bob’s ballot');

    const decide = (outcome: number, ballots: string[]) =>
      alice.node.records.put(space, decision, { outcome, proposal: put.version, ballots }, { links: about });
    await assert.rejects(decide(1, [mine.version]), /as many people as the proposal’s quorum/);
    await assert.rejects(
      decide(0, [mine.version, theirs.version]),
      /as many people as the proposal’s quorum/,
    );
    await assert.rejects(decide(2, [mine.version, theirs.version]), /one of the proposal’s options/);
    const decided = await decide(1, [mine.version, theirs.version]);
    await until(
      async () => (await bob.node.records.get(space, decided.key)) !== null,
      4000,
      'Bob to accept it',
    );
  });

  test('a goal is reached once the pledges cited add up to its target, each person once', async () => {
    const { alice, bob, space } = await governedSpace();
    const set = await alice.node.records.put(space, goal, { title: 'A new roof', target: 10, unit: 'NOK' });
    const about = [{ rel: 'about', to: set.key }];
    const mine = await alice.node.records.put(space, pledge, { amount: 4 }, { links: about });
    await until(async () => (await bob.node.records.get(space, set.key)) !== null, 4000, 'the goal');
    const theirs = await bob.node.records.put(space, pledge, { amount: 7 }, { links: about });
    await until(async () => (await alice.node.records.get(space, theirs.key)) !== null, 4000, 'Bob’s pledge');

    const reach = (pledges: string[]) =>
      alice.node.records.put(space, goalReached, { goal: set.version, pledges }, { links: about });
    await assert.rejects(reach([mine.version, mine.version, mine.version]), /add up to the goal’s target/);
    const reached = await reach([mine.version, theirs.version]);
    await until(
      async () => (await bob.node.records.get(space, reached.key)) !== null,
      4000,
      'Bob to accept it',
    );
  });

  test('a decision without its quorum, signed anyway, is refused by every peer that receives it', async () => {
    const { alice, bob, space } = await governedSpace();
    const put = await alice.node.records.put(space, proposal, {
      title: 'Paint it red?',
      options: ['Yes', 'No'],
      quorum: 2,
    });
    const about = [{ rel: 'about', to: put.key }];
    await until(async () => (await bob.node.records.get(space, put.key)) !== null, 4000, 'the proposal');
    const own = await bob.node.records.put(space, ballot, { choice: 0 }, { links: about });

    const key = (await onePerKey(decision.name, ['link:about'], { root: '', links: about, body: {} }))!;
    await letGo(bob.node, space);
    await forge(bob, space, {
      author: '',
      collection: decision.name,
      body: { outcome: 0, proposal: put.version, ballots: [own.version] },
      links: about,
      retain: true,
      version: { key, seq: 0 },
    });
    const rejected: string[] = [];
    alice.node.subscribe((event) => {
      if (event.type === 'rejected') rejected.push(event.reason);
    });
    await hold(bob.node, space);
    await until(async () => rejected.some((r) => /quorum/.test(r)), 4000, 'Alice to refuse it');
    assert.equal(await alice.node.records.get(space, key), null);
  });
});
