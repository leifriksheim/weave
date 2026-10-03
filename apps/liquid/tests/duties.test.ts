import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { duties } from '../src/duties';
import type { Assembly, PartyFull, ProposalView, RollView } from '../src/model';
import {
  follow,
  majority,
  pending,
  tally,
  type CastVote,
  type DelegationEdge,
  type PartyStand,
} from '../src/tally';
import type { Choice } from '../src/schema';

const ADA = 'did:ada';
const BO = 'did:bo';
const CY = 'did:cy';
const VOTERS = [ADA, BO, CY];

const cast = (choice: Choice, who: string, via: string | null = null): [string, CastVote] => [
  who,
  { choice, via, version: `v-${who}`, key: `k-${who}` },
];

function proposalView(key: string, over: Partial<ProposalView> = {}): ProposalView {
  return {
    key,
    version: `v-${key}`,
    title: key,
    body: '',
    topic: null,
    voters: VOTERS,
    toPass: majority(VOTERS.length),
    createdBy: ADA,
    createdAt: '2026-10-03T12:00:00.000Z',
    supporters: new Set(),
    votes: new Map(),
    mySupportKey: null,
    decided: null,
    conflicts: [],
    result: 'open',
    rolls: new Map<string, RollView>(),
    stands: new Map<string, PartyStand>(),
    ...over,
  };
}

function partyView(key: string, members: string[], stewards: string[]): PartyFull {
  return {
    key,
    version: `v-${key}`,
    name: key,
    platform: '',
    hue: 0,
    stewards: new Set(stewards),
    listed: new Set(members),
    asked: new Map(),
    members: new Set(members),
    decides: 'majority',
    representative: null,
  };
}

/** An assembly as Ada's device sees it, run on the real counting rules */
function assembly(
  proposals: ProposalView[],
  delegations: DelegationEdge[] = [],
  parties: PartyFull[] = [],
): Assembly {
  const input = (p: ProposalView) => ({
    topic: p.topic,
    votes: p.votes,
    delegations,
    parties: p.stands,
    voters: new Set(p.voters),
  });
  return {
    spaceId: 'space',
    me: ADA,
    name: (did) => did ?? '',
    members: VOTERS.map((did) => ({ did, role: 'member' })),
    bots: new Set(),
    roles: [],
    myRole: null,
    mayModerate: false,
    mayInvite: false,
    topics: [],
    topicOf: () => null,
    proposals,
    delegations,
    mine: [],
    parties,
    partyOf: (key) => parties.find((p) => p.key === key) ?? null,
    countOf: (p) => tally(p.voters, p.votes),
    comingOf: (p) => pending(input(p)),
    nextFor: (p, did = ADA) => follow({ ...input(p), me: did }),
    current: true,
    ready: true,
  };
}

describe('what a device does by itself', () => {
  test('follows whoever you trust, once they have voted, and only then', () => {
    const trusts = [{ from: ADA, kind: 'person' as const, to: BO, topic: '*' }];
    const voted = proposalView('p1', { votes: new Map([cast('against', BO)]) });
    const notYet = proposalView('p2');
    assert.deepEqual(duties(assembly([voted, notYet], trusts)), [
      { kind: 'vote', proposal: 'p1', choice: 'against', via: BO },
    ]);
  });

  test('never votes twice, and leaves proposals settled or disputed alone', () => {
    const trusts = [{ from: ADA, kind: 'person' as const, to: BO, topic: '*' }];
    const votes = new Map([cast('for', BO), cast('for', ADA)]);
    assert.deepEqual(
      duties(assembly([proposalView('p1', { votes, result: 'passed' })], trusts)).filter(
        (d) => d.kind === 'vote',
      ),
      [],
    );
    assert.deepEqual(
      duties(
        assembly([proposalView('p2', { votes: new Map([cast('for', BO)]), result: 'disputed' })], trusts),
      ),
      [],
    );
  });

  test('a steward freezes the party’s members for each open proposal; others don’t', () => {
    const greens = partyView('greens', [ADA, CY], [ADA]);
    const reds = partyView('reds', [BO, CY], [BO]);
    const plan = duties(assembly([proposalView('p1')], [], [greens, reds]));
    assert.deepEqual(
      plan.map((d) => d.kind === 'roll' && d.party.key),
      ['greens'],
    );
  });

  test('writes a party’s position once more than half its frozen members voted that way themselves', () => {
    const roll: RollView = { key: 'roll', version: 'v-roll', members: [BO, CY], decides: { toTake: 2 } };
    const votes = new Map([cast('for', BO), cast('for', CY)]);
    const plan = duties(assembly([proposalView('p1', { votes, rolls: new Map([['reds', roll]]) })]));
    assert.deepEqual(
      plan.find((d) => d.kind === 'ballot'),
      {
        kind: 'ballot',
        proposal: 'p1',
        party: 'reds',
        roll,
        choice: 'for',
        votes: ['v-did:bo', 'v-did:cy'],
      },
    );
  });

  test('freezes the party’s rule in its roll, and skips a representative who left', () => {
    const greens = { ...partyView('greens', [ADA, CY], [ADA]), decides: 'everyone' as const };
    const reps = {
      ...partyView('reps', [ADA, BO], [ADA]),
      decides: 'representative' as const,
      representative: BO,
    };
    const gone = {
      ...partyView('gone', [ADA], [ADA]),
      decides: 'representative' as const,
      representative: CY,
    };
    const plan = duties(assembly([proposalView('p1')], [], [greens, reps, gone]));
    assert.deepEqual(
      plan.flatMap((d) => (d.kind === 'roll' ? [[d.party.key, d.decides]] : [])),
      [
        ['greens', { toTake: 2 }],
        ['reps', { representative: BO }],
      ],
    );
  });

  test('writes a party’s position as its representative voted', () => {
    const roll: RollView = {
      key: 'roll',
      version: 'v-roll',
      members: [BO, CY],
      decides: { representative: CY },
    };
    const votes = new Map([cast('against', CY)]);
    const plan = duties(assembly([proposalView('p1', { votes, rolls: new Map([['reds', roll]]) })]));
    assert.deepEqual(
      plan.flatMap((d) => (d.kind === 'ballot' ? [[d.choice, d.votes]] : [])),
      [['against', ['v-did:cy']]],
    );
  });

  test('writes the decision once the count settles it, citing just enough votes', () => {
    const p = proposalView('p1', { votes: new Map([cast('against', BO), cast('abstain', CY)]) });
    const plan = duties(assembly([p]));
    assert.deepEqual(
      plan.map((d) => (d.kind === 'decision' ? [d.outcome, d.votes] : d.kind)),
      [['rejected', ['v-did:bo', 'v-did:cy']]],
    );
  });

  test('decides by the proposal’s own rule', () => {
    const votes = new Map([cast('for', BO), cast('for', CY)]);
    // Two for is enough when it needs two, and not when it needs everyone.
    const lenient = duties(assembly([proposalView('p1', { votes, toPass: 2 })]));
    assert.deepEqual(
      lenient.flatMap((d) => (d.kind === 'decision' ? [d.outcome] : [])),
      ['passed'],
    );
    const strict = duties(assembly([proposalView('p1', { votes, toPass: VOTERS.length })]));
    assert.deepEqual(
      strict.filter((d) => d.kind === 'decision'),
      [],
    );
  });
});
