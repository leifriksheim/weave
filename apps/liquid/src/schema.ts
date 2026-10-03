/**
 * What an assembly keeps: ordinary collections, defined in the space when
 * the assembly is made. Rules say who may write what, and every device
 * enforces them. What the records mean (how a vote travels along
 * delegations) is this app's, in `tally.ts`.
 *
 * A result only ever moves forward. Every proposal fixes who votes on it,
 * and how many of them must vote for it to pass, when it is made; votes are
 * final; and a decision is a proof that cites enough votes to settle it,
 * which no later vote can undo. So every device
 * reaches the same result from whatever votes it holds, in any order, with
 * nobody closing the vote and no clock (issue #131).
 *
 * The names are Liquid's own (`liquid.*`) rather than the standard
 * library's: `std.proposal` has fixed options and no topic, and nothing in
 * the library says "I trust this person with my vote on housing".
 */
import type { Check } from '@weaveprotocol/core';
import { fragments } from '@weaveprotocol/core/schemas';

const { typed, words, text, markdown, count, choice, people, one, own } = fragments;

/** The most voters one proposal can have */
export const MAX_VOTERS = 500;

/** The most votes a decision can cite, so a proposal's rule must settle it with no more either way */
export const MAX_CITED = 255;

/** Ids of versions a record cites */
const ids = (max: number, description: string) => ({
  type: 'array',
  items: words(128),
  maxItems: max,
  description,
});

// Conditions for the checks below, built here so they read as what they say.
// What they build is plain JSON, stored with the definition.

const read = (path: string) => ({ var: path });
const is = (a: unknown, b: unknown) => ({ '==': [a, b] });
/** A field of the one version cited by the id at `path` */
const citedOne = (path: string, field: string) => ({ get: [{ versions: [[read(path)]] }, `0.${field}`] });
/** Half of a count, rounded down */
const half = (n: unknown) => ({ '/': [{ '-': [n, { '%': [n, 2] }] }, 2] });
/** How many different people wrote the versions cited at `path` */
const authorsOf = (path: string) => ({
  size: { distinct: { map: [{ versions: read(path) }, read('it.author')] } },
});
/** Every version cited at `path` is a first version of `collection`, about what this record is about */
const allAbout = (path: string, collection: string, also: ReadonlyArray<unknown>) => ({
  all: [
    { versions: read(path) },
    {
      and: [
        is(read('it.collection'), collection),
        is({ link: ['about', read('it')] }, { link: ['about'] }),
        is(read('it.seq'), 0),
        ...also,
      ],
    },
  ],
});

/** What an assembly may vote on, sorted into topics. Only moderators set them. */
export const topic = typed<Topic>()({
  name: 'liquid.topic',
  title: 'Topic',
  description: 'An area proposals belong to, and delegations can be limited to.',
  schema: {
    type: 'object',
    properties: {
      name: words(60),
      description: text(300),
      hue: count(0, 359, 'Its colour, as a hue'),
    },
    required: ['name'],
  },
  permissions: ['moderate'],
  rules: { create: 'can:moderate', edit: 'can:moderate', delete: 'can:moderate' },
});
interface Topic {
  readonly name: string;
  readonly description?: string;
  readonly hue?: number;
}

/** The three answers to a proposal */
export const CHOICES = ['for', 'against', 'abstain'] as const;
export type Choice = (typeof CHOICES)[number];

/**
 * Something put to the assembly: yes or no. Who votes on it, and how many of
 * them must vote for it to pass (`toPass`), are fixed when it is made. It
 * fails once so many vote against or abstain that `toPass` can't be reached.
 * Without `toPass`, as in proposals from before it existed, more than half.
 */
export const proposal = typed<Proposal>()({
  name: 'liquid.proposal',
  title: 'Proposal',
  description: 'Something put to the assembly to accept or reject, and who votes on it.',
  schema: {
    type: 'object',
    properties: {
      title: words(200),
      body: markdown(20000),
      voters: people(MAX_VOTERS, 'Who votes on it, picked from the members when it was proposed'),
      toPass: count(1, MAX_CITED, 'How many of its voters must vote for it to pass'),
    },
    required: ['title', 'voters'],
  },
  links: { topic: one(['liquid.topic'], 'The topic it belongs to') },
  permissions: ['moderate'],
  rules: {
    edit: ['creator', 'can:moderate'],
    delete: 'can:moderate',
    fixed: ['voters', 'toPass'],
    check: [
      {
        that: {
          if: [
            is(read('seq'), 0),
            {
              and: [
                { '>=': [{ size: read('body.voters') }, 1] },
                { '<=': [{ size: read('body.voters') }, MAX_VOTERS] },
                is({ size: { distinct: read('body.voters') } }, { size: read('body.voters') }),
                { all: [read('body.voters'), { member: read('it') }] },
              ],
            },
            true,
          ],
        },
        else: `A proposal's voters are members, each once, from 1 to ${MAX_VOTERS} of them`,
      },
      {
        that: {
          if: [
            is(read('body.toPass'), null),
            true,
            {
              and: [
                { '<=': [read('body.toPass'), { size: read('body.voters') }] },
                { '<=': [{ '-': [{ size: read('body.voters') }, read('body.toPass')] }, MAX_CITED - 1] },
              ],
            },
          ],
        },
        else: `A proposal can't need more votes for than it has voters, nor more than ${MAX_CITED} votes either way`,
      },
    ],
  },
});
interface Proposal {
  readonly title: string;
  readonly body?: string;
  readonly voters: ReadonlyArray<string>;
  readonly toPass?: number;
}

/** "This should be looked at": one per person per proposal, for sorting. It decides nothing. */
export const support = typed<Record<string, never>>()({
  name: 'liquid.support',
  title: 'Support',
  description: 'Someone wants a proposal to be seen.',
  schema: { type: 'object', properties: {} },
  links: { about: one(['liquid.proposal'], 'The proposal') },
  rules: { ...own, onePer: ['@author', 'link:about'] },
});

/**
 * Someone's vote on a proposal: one per person per proposal, and final. A
 * vote their device cast by following someone they trust says whom
 * (`via`), so the path a vote took is on the record.
 */
export const vote = typed<Vote>()({
  name: 'liquid.vote',
  title: 'Vote',
  description:
    'A final vote on a proposal, cast by its voter or by their device following someone they trust.',
  schema: {
    type: 'object',
    properties: {
      choice: choice(CHOICES),
      via: text(
        256,
        'Whom it follows: an account DID, or a party’s key. Absent when they voted themselves.',
        1,
      ),
    },
    required: ['choice'],
  },
  links: { about: one(['liquid.proposal'], 'The proposal') },
  rules: { onePer: ['@author', 'link:about'], final: true },
});
interface Vote {
  readonly choice: Choice;
  readonly via?: string;
}

/** Everything, for a delegation that isn't limited to one topic */
export const EVERYTHING = '*';

/**
 * "When I don't vote on this topic, vote as they do." One per person per
 * topic (or `*`, for everything else): delegating again moves it, deleting
 * it takes it back. The voter's own device reads it, and casts their vote
 * once the person or party they trust has voted.
 */
export const delegation = typed<Delegation>()({
  name: 'liquid.delegation',
  title: 'Delegation',
  description: 'Who someone’s device follows when they don’t vote, on one topic or on everything.',
  schema: {
    type: 'object',
    properties: {
      kind: choice(['person', 'party']),
      to: text(256, 'An account DID, or a party’s key', 1),
      topic: text(128, 'A topic’s key, or * for everything', 1),
    },
    required: ['kind', 'to', 'topic'],
  },
  history: 'all',
  rules: { ...own, onePer: ['@author', 'topic'] },
});
interface Delegation {
  readonly kind: 'person' | 'party';
  readonly to: string;
  readonly topic: string;
}

/** How many votes for the proposal a decision cites needs: its `toPass`, else more than half */
const toPassOf = (path: string) => ({
  if: [
    is(citedOne(path, 'body.toPass'), null),
    { '+': [half({ size: read('body.voters') }), 1] },
    citedOne(path, 'body.toPass'),
  ],
});

/**
 * Settles a proposal: it cites the proposal (any version: its voters and
 * `toPass` never change), and enough final votes from its voters that
 * nothing later can change the outcome. Passed: `toPass` of them voted for.
 * Rejected: so many voted against or abstained that `toPass` can no longer
 * be reached. Anyone may write it, once per proposal, and every device
 * checks it.
 */
export const decision = typed<Decision>()({
  name: 'liquid.decision',
  title: 'Decision',
  description: 'What a proposal came to, proven by the votes it cites.',
  schema: {
    type: 'object',
    properties: {
      outcome: choice(['passed', 'rejected']),
      proposal: words(128, 'The id of a version of the proposal'),
      voters: people(MAX_VOTERS, 'The proposal’s voters, as it lists them'),
      votes: ids(255, 'Ids of the votes it counts'),
    },
    required: ['outcome', 'proposal', 'voters', 'votes'],
  },
  links: { about: one(['liquid.proposal'], 'The proposal decided') },
  rules: {
    onePer: ['link:about'],
    final: true,
    check: [
      {
        that: {
          and: [
            is(citedOne('body.proposal', 'collection'), 'liquid.proposal'),
            is(citedOne('body.proposal', 'key'), { link: ['about'] }),
            is(citedOne('body.proposal', 'body.voters'), read('body.voters')),
          ],
        },
        else: 'A decision cites the proposal it decides, and its voters',
      },
      {
        that: allAbout('body.votes', 'liquid.vote', [
          { in: [read('it.author'), read('body.voters')] },
          {
            if: [
              is(read('body.outcome'), 'passed'),
              is(read('it.body.choice'), 'for'),
              { '!=': [read('it.body.choice'), 'for'] },
            ],
          },
        ]),
        else: 'A decision counts only votes on its proposal, by its voters, for its outcome',
      },
      {
        that: {
          if: [
            is(read('body.outcome'), 'passed'),
            { '>=': [authorsOf('body.votes'), toPassOf('body.proposal')] },
            {
              '>': [
                { '+': [authorsOf('body.votes'), toPassOf('body.proposal')] },
                { size: read('body.voters') },
              ],
            },
          ],
        },
        else: 'A proposal passes once as many voters as it needs voted for, and fails once that can’t happen',
      },
    ] satisfies ReadonlyArray<Check>,
  },
});
interface Decision {
  readonly outcome: 'passed' | 'rejected';
  readonly proposal: string;
  readonly voters: ReadonlyArray<string>;
  readonly votes: ReadonlyArray<string>;
}

/** A field of one of the two versions a conflict cites, by path: `0.body.choice` */
const both = (path: string) => ({ get: [{ versions: read('body.versions') }, path] });

/**
 * Proof that one record was written twice, two ways: two first versions of
 * the same vote with different choices, or of the same party roll with
 * different members. Honest devices never do this, so whoever finds it
 * writes this, and every device shows the proposal it is about as disputed.
 */
export const conflict = typed<Conflict>()({
  name: 'liquid.conflict',
  title: 'Conflict',
  description: 'Two different first versions of one vote or party roll: proof that someone said two things.',
  schema: {
    type: 'object',
    properties: {
      record: words(128, 'The key of the record written twice'),
      versions: ids(2, 'The two versions'),
    },
    required: ['record', 'versions'],
  },
  links: { about: one(['liquid.proposal'], 'The proposal it disputes') },
  rules: {
    onePer: ['record'],
    final: true,
    check: [
      {
        that: {
          and: [
            is({ size: read('body.versions') }, 2),
            {
              all: [
                { versions: read('body.versions') },
                {
                  and: [
                    { in: [read('it.collection'), ['liquid.vote', 'liquid.party-roll']] },
                    is(read('it.key'), read('body.record')),
                    is(read('it.seq'), 0),
                    is({ link: ['about', read('it')] }, { link: ['about'] }),
                  ],
                },
              ],
            },
            {
              or: [
                {
                  '!=': [both('0.body.choice'), both('1.body.choice')],
                },
                {
                  '!=': [both('0.body.members'), both('1.body.members')],
                },
              ],
            },
          ],
        },
        else: 'A conflict cites two first versions of one vote or party roll that say different things',
      },
    ] satisfies ReadonlyArray<Check>,
  },
});
interface Conflict {
  readonly record: string;
  readonly versions: ReadonlyArray<string>;
}

/**
 * A party: a name, what it stands for, who is in it, and its stewards, who
 * keep it. Any steward may change it, so the party carries on when one
 * stops using Liquid. Someone is in the party when they are on its list and
 * have asked to join (`membership`).
 */
export const party = typed<Party>()({
  name: 'liquid.party',
  title: 'Party',
  description: 'A group that votes together: more than half its members agreeing is its vote.',
  schema: {
    type: 'object',
    properties: {
      name: words(80),
      platform: text(2000),
      hue: count(0, 359),
      members: people(MAX_VOTERS, 'Who the stewards let in'),
      stewards: people(20, 'Who keeps the party: changes it and freezes its members for each proposal'),
    },
    required: ['name', 'members', 'stewards'],
  },
  permissions: ['moderate'],
  rules: {
    delete: ['creator', 'can:moderate'],
    check: [
      {
        that: {
          and: [
            { '>=': [{ size: read('body.stewards') }, 1] },
            { all: [read('body.stewards'), { in: [read('it'), read('body.members')] }] },
            {
              if: [
                is(read('prev'), null),
                { in: [read('author'), read('body.stewards')] },
                { in: [read('author'), read('prev.body.stewards')] },
              ],
            },
          ],
        },
        else: 'Only a party’s stewards change it, and it always has a steward, who is a member',
      },
    ] satisfies ReadonlyArray<Check>,
  },
});
interface Party {
  readonly name: string;
  readonly platform?: string;
  readonly hue?: number;
  readonly members: ReadonlyArray<string>;
  readonly stewards: ReadonlyArray<string>;
}

/** Someone asking to be in a party, or staying in it. Deleting it leaves. */
export const membership = typed<Record<string, never>>()({
  name: 'liquid.membership',
  title: 'Party membership',
  description: 'Someone wants to be in a party.',
  schema: { type: 'object', properties: {} },
  links: { about: one(['liquid.party'], 'The party') },
  rules: { ...own, onePer: ['@author', 'link:about'] },
});

/**
 * A party's members, frozen for one proposal by one of its stewards. Its
 * position on that proposal counts these members, whatever the list says
 * later. One per party per proposal, and final: a second, different one is
 * a conflict.
 */
export const partyRoll = typed<PartyRoll>()({
  name: 'liquid.party-roll',
  title: 'Party roll',
  description: 'A party’s members, frozen for one proposal.',
  schema: {
    type: 'object',
    properties: {
      party: words(128, 'The id of the party’s version it was taken from'),
      members: people(MAX_VOTERS, 'Its members for this proposal'),
    },
    required: ['party', 'members'],
  },
  links: {
    party: one(['liquid.party'], 'The party'),
    about: one(['liquid.proposal'], 'The proposal'),
  },
  rules: {
    onePer: ['link:party', 'link:about'],
    final: true,
    check: [
      {
        that: {
          and: [
            is(citedOne('body.party', 'collection'), 'liquid.party'),
            is(citedOne('body.party', 'key'), { link: ['party'] }),
            { in: [read('author'), citedOne('body.party', 'body.stewards')] },
            { all: [read('body.members'), { in: [read('it'), citedOne('body.party', 'body.members')] }] },
          ],
        },
        else: 'A party roll is written by a steward, from the party’s own member list',
      },
    ] satisfies ReadonlyArray<Check>,
  },
});
interface PartyRoll {
  readonly party: string;
  readonly members: ReadonlyArray<string>;
}

/** The party roll a party's position cites */
const rollItself = { get: [{ versions: [[read('body.roll')]] }, '0'] };

/**
 * A party's position on a proposal: more than half of its frozen members
 * voted this way themselves. Votes they cast by following someone don't
 * count, so a party can't count its own followers back into itself. Anyone
 * may write it; followers' devices then cast the same vote.
 */
export const partyBallot = typed<PartyBallot>()({
  name: 'liquid.party-ballot',
  title: 'Party position',
  description: 'How a party voted on a proposal, proven by its members’ own votes.',
  schema: {
    type: 'object',
    properties: {
      choice: choice(CHOICES),
      roll: words(128, 'The id of the party’s roll for this proposal'),
      members: people(MAX_VOTERS, 'The roll’s members'),
      votes: ids(255, 'Ids of the members’ votes it counts'),
    },
    required: ['choice', 'roll', 'members', 'votes'],
  },
  links: {
    party: one(['liquid.party'], 'The party'),
    about: one(['liquid.proposal'], 'The proposal'),
  },
  rules: {
    onePer: ['link:party', 'link:about'],
    final: true,
    check: [
      {
        that: {
          and: [
            is(citedOne('body.roll', 'collection'), 'liquid.party-roll'),
            is({ link: ['party', rollItself] }, { link: ['party'] }),
            is({ link: ['about', rollItself] }, { link: ['about'] }),
            is(citedOne('body.roll', 'body.members'), read('body.members')),
          ],
        },
        else: 'A party’s position cites its roll for the proposal',
      },
      {
        that: allAbout('body.votes', 'liquid.vote', [
          { in: [read('it.author'), read('body.members')] },
          is(read('it.body.choice'), read('body.choice')),
          is(read('it.body.via'), null),
        ]),
        else: 'A party’s position counts only its members’ own votes, for that choice',
      },
      {
        that: { '>': [{ '*': [authorsOf('body.votes'), 2] }, { size: read('body.members') }] },
        else: 'A party takes a position once more than half its members voted that way',
      },
    ] satisfies ReadonlyArray<Check>,
  },
});
interface PartyBallot {
  readonly choice: Choice;
  readonly roll: string;
  readonly members: ReadonlyArray<string>;
  readonly votes: ReadonlyArray<string>;
}

/** Everything an assembly needs, defined when one is made */
export const ASSEMBLY = [
  topic,
  proposal,
  support,
  vote,
  delegation,
  decision,
  conflict,
  party,
  membership,
  partyRoll,
  partyBallot,
] as const;
