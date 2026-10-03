import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  follow,
  majority,
  needed,
  ruleName,
  partyPosition,
  pending,
  proof,
  resultOf,
  settled,
  tally,
  trail,
  type CastVote,
  type DelegationEdge,
  type FollowInput,
  type PartyStand,
  type Votes,
} from '../src/tally';
import type { Choice } from '../src/schema';

const HOUSING = 'topic-housing';
const PARKS = 'topic-parks';
const VOTERS = ['did:ada', 'did:bo', 'did:cy', 'did:di', 'did:ed'];

const cast = (choice: Choice, via: string | null = null, who = 'x'): CastVote => ({
  choice,
  via,
  version: `v-${who}`,
  key: `k-${who}`,
});
const votes = (entries: Record<string, Choice | [Choice, string]>): Votes =>
  new Map(
    Object.entries(entries).map(([did, v]) => [
      did,
      Array.isArray(v) ? cast(v[0], v[1], did) : cast(v, null, did),
    ]),
  );

const to = (from: string, target: string, topic = '*'): DelegationEdge => ({
  from,
  kind: 'person',
  to: target,
  topic,
});
const toParty = (from: string, key: string, topic = '*'): DelegationEdge => ({
  from,
  kind: 'party',
  to: key,
  topic,
});

const input = (over: Partial<FollowInput> = {}): FollowInput => ({
  me: 'did:ada',
  topic: HOUSING,
  votes: new Map(),
  delegations: [],
  parties: new Map<string, PartyStand>(),
  voters: new Set(VOTERS),
  ...over,
});

describe('settling a proposal', () => {
  test('counts only its voters', () => {
    const t = tally(VOTERS, votes({ 'did:ada': 'for', 'did:bo': 'against', 'did:newcomer': 'for' }));
    assert.deepEqual(t, { for: 1, against: 1, abstain: 0, uncast: 3 });
  });

  test('passes with more than half for, and not a vote sooner', () => {
    assert.equal(settled(tally(VOTERS, votes({ 'did:ada': 'for', 'did:bo': 'for' })), 3), null);
    assert.equal(
      settled(tally(VOTERS, votes({ 'did:ada': 'for', 'did:bo': 'for', 'did:cy': 'for' })), 3),
      'passed',
    );
  });

  test('fails once half are against or abstain, since for can no longer pass', () => {
    const four = VOTERS.slice(0, 4);
    assert.equal(settled(tally(four, votes({ 'did:ada': 'against' })), 3), null);
    assert.equal(settled(tally(four, votes({ 'did:ada': 'against', 'did:bo': 'abstain' })), 3), 'rejected');
    // Five voters: two not for still leaves three to pass.
    assert.equal(settled(tally(VOTERS, votes({ 'did:ada': 'against', 'did:bo': 'abstain' })), 3), null);
  });

  test('a settled count stays settled whatever arrives later', () => {
    const early = votes({ 'did:ada': 'for', 'did:bo': 'for', 'did:cy': 'for' });
    const later = votes({
      'did:ada': 'for',
      'did:bo': 'for',
      'did:cy': 'for',
      'did:di': 'against',
      'did:ed': 'against',
    });
    assert.equal(settled(tally(VOTERS, early), 3), 'passed');
    assert.equal(settled(tally(VOTERS, later), 3), 'passed');
  });

  test('says how far each way is', () => {
    assert.deepEqual(needed(tally(VOTERS, votes({ 'did:ada': 'for', 'did:bo': 'against' })), 3), {
      toPass: 2,
      toFail: 2,
    });
  });

  test('a proof cites just enough votes, in the same order on every device', () => {
    const all = votes({
      'did:ed': 'for',
      'did:ada': 'for',
      'did:cy': 'for',
      'did:bo': 'for',
      'did:di': 'against',
    });
    assert.deepEqual(proof(VOTERS, all, 'passed', 3), ['v-did:ada', 'v-did:bo', 'v-did:cy']);
    assert.equal(proof(VOTERS, all, 'rejected', 3), null);
  });

  test('a proposal that needs more passes later and fails sooner', () => {
    // Five voters, four to pass: two not for already makes four unreachable.
    const three = votes({ 'did:ada': 'for', 'did:bo': 'for', 'did:cy': 'for' });
    assert.equal(settled(tally(VOTERS, three), 4), null);
    assert.equal(settled(tally(VOTERS, votes({ 'did:ada': 'against', 'did:bo': 'abstain' })), 4), 'rejected');
    assert.deepEqual(needed(tally(VOTERS, three), 4), { toPass: 1, toFail: 2 });
    const all = votes({
      'did:ada': 'for',
      'did:bo': 'for',
      'did:cy': 'for',
      'did:di': 'for',
      'did:ed': 'against',
    });
    assert.deepEqual(proof(VOTERS, all, 'passed', 4), ['v-did:ada', 'v-did:bo', 'v-did:cy', 'v-did:di']);
    // Everyone: one not for settles it.
    assert.equal(settled(tally(VOTERS, votes({ 'did:ed': 'abstain' })), 5), 'rejected');
    assert.deepEqual(proof(VOTERS, votes({ 'did:ed': 'abstain' }), 'rejected', 5), ['v-did:ed']);
  });

  test('a proposal that needs fewer than half can pass without most', () => {
    assert.equal(settled(tally(VOTERS, votes({ 'did:ada': 'for', 'did:bo': 'for' })), 2), 'passed');
    assert.equal(
      settled(tally(VOTERS, votes({ 'did:ada': 'against', 'did:bo': 'against', 'did:cy': 'against' })), 2),
      null,
    );
  });

  test('names the rule a proposal took, when it is one of the presets', () => {
    assert.equal(majority(4), 3);
    assert.equal(majority(5), 3);
    assert.equal(ruleName(3, 5), 'More than half');
    assert.equal(ruleName(6, 9), 'Two-thirds');
    assert.equal(ruleName(9, 12), 'Three-quarters');
    assert.equal(ruleName(7, 7), 'Everyone');
    assert.equal(ruleName(2, 9), null);
  });

  test('the ladder: open, then passed or rejected, then disputed for good', () => {
    assert.equal(resultOf(null, false), 'open');
    assert.equal(resultOf('passed', false), 'passed');
    assert.equal(resultOf('passed', true), 'disputed');
    assert.equal(resultOf(null, true), 'disputed');
  });
});

describe('following someone you trust', () => {
  test('nobody trusted: nothing to do', () => {
    assert.deepEqual(follow(input()), { kind: 'wait', path: [], how: 'unset' });
  });

  test('once they have voted, your device casts the same, saying whom it followed', () => {
    const next = follow(
      input({ delegations: [to('did:ada', 'did:bo')], votes: votes({ 'did:bo': 'against' }) }),
    );
    assert.deepEqual(next, { kind: 'cast', choice: 'against', via: 'did:bo' });
  });

  test('a copied vote is followed too, so a chain fills in one device at a time', () => {
    const delegations = [to('did:ada', 'did:bo'), to('did:bo', 'did:cy')];
    // Cy voted; Bo's device hasn't followed yet, so Ada waits, and sees where it's headed.
    const waiting = follow(input({ delegations, votes: votes({ 'did:cy': 'for' }) }));
    assert.equal(waiting.kind, 'wait');
    assert.deepEqual(waiting.kind === 'wait' && waiting.path, [
      { kind: 'person', did: 'did:bo' },
      { kind: 'person', did: 'did:cy' },
    ]);
    // Bo's device follows Cy; then Ada's follows Bo.
    const next = follow(
      input({ delegations, votes: votes({ 'did:cy': 'for', 'did:bo': ['for', 'did:cy'] }) }),
    );
    assert.deepEqual(next, { kind: 'cast', choice: 'for', via: 'did:bo' });
  });

  test('a topic’s delegation comes before the one for everything', () => {
    const delegations = [to('did:ada', 'did:bo'), to('did:ada', 'did:cy', HOUSING)];
    const v = votes({ 'did:bo': 'for', 'did:cy': 'against' });
    assert.deepEqual(follow(input({ delegations, votes: v })), {
      kind: 'cast',
      choice: 'against',
      via: 'did:cy',
    });
    assert.deepEqual(follow(input({ delegations, votes: v, topic: PARKS })), {
      kind: 'cast',
      choice: 'for',
      via: 'did:bo',
    });
  });

  test('a loop never casts anything, and says so', () => {
    const delegations = [to('did:ada', 'did:bo'), to('did:bo', 'did:ada')];
    const next = follow(input({ delegations }));
    assert.equal(next.kind === 'wait' && next.how, 'loop');
  });

  test('in a loop, someone voting themselves goes round once and stops', () => {
    const delegations = [to('did:ada', 'did:bo'), to('did:bo', 'did:cy'), to('did:cy', 'did:ada')];
    const first = votes({ 'did:cy': 'for' });
    assert.deepEqual(follow(input({ me: 'did:bo', delegations, votes: first })), {
      kind: 'cast',
      choice: 'for',
      via: 'did:cy',
    });
    const second = votes({ 'did:cy': 'for', 'did:bo': ['for', 'did:cy'] });
    assert.deepEqual(follow(input({ delegations, votes: second })), {
      kind: 'cast',
      choice: 'for',
      via: 'did:bo',
    });
    // Everyone in the loop has voted, each once: nothing is left to cast round it.
    const third = votes({ 'did:cy': 'for', 'did:bo': ['for', 'did:cy'], 'did:ada': ['for', 'did:bo'] });
    assert.deepEqual(pending(input({ delegations, votes: third })), {
      for: 0,
      against: 0,
      abstain: 0,
      uncast: 2,
    });
  });

  test('someone who isn’t a voter on this proposal is a dead end', () => {
    const next = follow(input({ delegations: [to('did:ada', 'did:newcomer')] }));
    assert.equal(next.kind === 'wait' && next.how, 'stopped');
  });

  test('a party: cast its position, wait for it, or not follow it when disputed', () => {
    const delegations = [toParty('did:ada', 'greens')];
    assert.deepEqual(follow(input({ delegations, parties: new Map([['greens', 'for']]) })), {
      kind: 'cast',
      choice: 'for',
      via: 'greens',
    });
    assert.equal(follow(input({ delegations })).kind, 'wait');
    const disputed = follow(input({ delegations, parties: new Map([['greens', 'disputed']]) }));
    assert.equal(disputed.kind === 'wait' && disputed.how, 'disputed');
  });

  test('the path a cast vote took, read from its via', () => {
    const v = votes({
      'did:cy': ['for', 'greens'],
      'did:bo': ['for', 'did:cy'],
      'did:ada': ['for', 'did:bo'],
    });
    assert.deepEqual(trail('did:ada', v), [
      { kind: 'person', did: 'did:bo' },
      { kind: 'person', did: 'did:cy' },
      { kind: 'party', key: 'greens' },
    ]);
    assert.deepEqual(trail('did:ed', v), []);
  });

  test('what’s coming: votes devices would cast once online', () => {
    const delegations = [to('did:bo', 'did:ada'), to('did:cy', 'did:ada'), to('did:di', 'did:ed')];
    const coming = pending({ ...input({ delegations, votes: votes({ 'did:ada': 'for' }) }) });
    assert.deepEqual(coming, { for: 2, against: 0, abstain: 0, uncast: 2 });
  });
});

describe('a party’s position', () => {
  const roll = ['did:ada', 'did:bo', 'did:cy', 'did:di'];

  test('more than half of its frozen members, voting themselves', () => {
    assert.equal(partyPosition(roll, votes({ 'did:ada': 'for', 'did:bo': 'for' })), null);
    assert.deepEqual(partyPosition(roll, votes({ 'did:ada': 'for', 'did:bo': 'for', 'did:cy': 'for' })), {
      choice: 'for',
      votes: ['v-did:ada', 'v-did:bo', 'v-did:cy'],
    });
  });

  test('votes cast by following don’t count, so a party never counts its followers back in', () => {
    const v = votes({ 'did:ada': 'for', 'did:bo': ['for', 'greens'], 'did:cy': ['for', 'greens'] });
    assert.equal(partyPosition(roll, v), null);
  });

  test('members who joined after the roll don’t count', () => {
    assert.equal(
      partyPosition(['did:ada', 'did:bo', 'did:cy'], votes({ 'did:ada': 'for', 'did:zed': 'for' })),
      null,
    );
  });
});
