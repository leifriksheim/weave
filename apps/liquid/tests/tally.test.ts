import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { accepted, count, turnout, type CountInput, type DelegationEdge, type PartyView } from '../src/tally';
import type { Choice } from '../src/schema';

const HOUSING = 'topic-housing';
const PARKS = 'topic-parks';

const input = (
  over: Partial<Omit<CountInput, 'votes'>> & { votes?: Record<string, Choice> },
): CountInput => ({
  members: ['ada', 'bo', 'cy', 'di', 'ed'],
  topic: HOUSING,
  delegations: [],
  parties: [],
  ...over,
  votes: new Map(Object.entries(over.votes ?? {})),
});

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
const party = (key: string, members: string[]): PartyView => ({ key, name: key, members: new Set(members) });

describe('counting a proposal', () => {
  test('everyone votes themselves', () => {
    const { totals } = count(input({ votes: { ada: 'for', bo: 'for', cy: 'against', di: 'abstain' } }));
    assert.deepEqual(totals, { for: 2, against: 1, abstain: 1, uncast: 1 });
    assert.equal(accepted(totals), true);
    assert.equal(turnout(totals), 0.8);
  });

  test('a delegation carries the vote, along a chain', () => {
    const { totals, outcomes, carried } = count(
      input({ votes: { ada: 'against' }, delegations: [to('bo', 'cy'), to('cy', 'ada'), to('di', 'ada')] }),
    );
    assert.deepEqual(totals, { for: 0, against: 4, abstain: 0, uncast: 1 });
    assert.deepEqual(outcomes.get('bo')?.path, [
      { kind: 'person', did: 'cy' },
      { kind: 'person', did: 'ada' },
    ]);
    assert.equal(outcomes.get('bo')?.how, 'followed');
    assert.equal(carried.get('ada'), 4);
  });

  test('your own vote overrides your delegation', () => {
    const { outcomes } = count(
      input({ votes: { ada: 'for', bo: 'against' }, delegations: [to('bo', 'ada')] }),
    );
    assert.equal(outcomes.get('bo')?.choice, 'against');
    assert.equal(outcomes.get('bo')?.how, 'own');
  });

  test('a topic delegation comes before the one for everything', () => {
    const delegations = [to('ed', 'ada'), to('ed', 'bo', HOUSING)];
    const votes = { ada: 'for', bo: 'against' } as const;
    assert.equal(count(input({ votes, delegations })).outcomes.get('ed')?.choice, 'against');
    assert.equal(count(input({ votes, delegations, topic: PARKS })).outcomes.get('ed')?.choice, 'for');
    assert.equal(count(input({ votes, delegations, topic: null })).outcomes.get('ed')?.choice, 'for');
  });

  test('a loop casts nothing, and says so', () => {
    const { outcomes, totals } = count(
      input({ delegations: [to('ada', 'bo'), to('bo', 'cy'), to('cy', 'ada')] }),
    );
    assert.equal(outcomes.get('ada')?.how, 'loop');
    assert.equal(outcomes.get('ada')?.choice, null);
    assert.equal(totals.uncast, 5);
  });

  test('a chain that ends with someone who did nothing casts nothing', () => {
    const { outcomes } = count(input({ delegations: [to('ada', 'bo')] }));
    assert.equal(outcomes.get('ada')?.how, 'stopped');
    assert.equal(outcomes.get('cy')?.how, 'unset');
  });

  test('someone who left the assembly carries no votes', () => {
    const { outcomes, totals } = count(input({ votes: { gone: 'for' }, delegations: [to('ada', 'gone')] }));
    assert.equal(outcomes.get('ada')?.how, 'stopped');
    assert.equal(outcomes.has('gone'), false);
    assert.equal(totals.for, 0);
  });

  test('a party votes with the majority of its members who voted themselves', () => {
    const greens = party('greens', ['ada', 'bo', 'cy']);
    const { outcomes, parties, carried } = count(
      input({
        votes: { ada: 'for', bo: 'for', cy: 'against' },
        parties: [greens],
        delegations: [toParty('di', 'greens'), toParty('ed', 'greens')],
      }),
    );
    assert.equal(parties.get('greens'), 'for');
    assert.equal(outcomes.get('di')?.choice, 'for');
    assert.equal(carried.get('greens'), 2);
  });

  test('a tied party casts nothing', () => {
    const { outcomes } = count(
      input({
        votes: { ada: 'for', bo: 'against' },
        parties: [party('greens', ['ada', 'bo'])],
        delegations: [toParty('di', 'greens')],
      }),
    );
    assert.equal(outcomes.get('di')?.how, 'undecided');
  });

  test('delegated votes do not decide a party: only its members’ own votes do', () => {
    // bo follows ada, but only ada voted herself, so the party is for.
    const { parties } = count(
      input({
        votes: { ada: 'for', cy: 'against' },
        parties: [party('greens', ['ada', 'bo'])],
        delegations: [to('bo', 'cy')],
      }),
    );
    assert.equal(parties.get('greens'), 'for');
  });

  test('a person’s chain can end in a party', () => {
    const { outcomes } = count(
      input({
        votes: { ada: 'against' },
        parties: [party('reds', ['ada'])],
        delegations: [to('ed', 'di'), toParty('di', 'reds')],
      }),
    );
    assert.equal(outcomes.get('ed')?.choice, 'against');
    assert.deepEqual(outcomes.get('ed')?.path, [
      { kind: 'person', did: 'di' },
      { kind: 'party', key: 'reds' },
    ]);
  });

  test('a delegation to a party that is gone casts nothing', () => {
    const { outcomes } = count(input({ delegations: [toParty('ada', 'nowhere')] }));
    assert.equal(outcomes.get('ada')?.how, 'stopped');
  });

  test('a tie between for and against is not accepted', () => {
    assert.equal(accepted({ for: 2, against: 2, abstain: 1, uncast: 0 }), false);
  });
});
