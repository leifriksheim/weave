/**
 * Community and governance: polls and votes, proposals and the decisions
 * they come to, goals and pledges, announcements, badges. And settings, for
 * apps that keep a person's choices in a space.
 *
 * A decision and a goal reached are proven, not declared: each cites the
 * records that prove it, and every device checks the proof (02 §7.6).
 */
import type { Check } from '../../records/checks.js';
import {
  authored,
  blob,
  choice,
  count,
  markdown,
  one,
  own,
  person,
  text,
  typed,
  when,
  words,
  type BlobRef,
} from '../fragments.js';

/**
 * A question with fixed options. The options cannot change once it is asked —
 * votes point at them by position — but whoever asked can close it.
 */
export const poll = typed<Poll>()({
  name: 'std.poll',
  title: 'Poll',
  description: 'A question with options to vote on.',
  schema: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 500 },
      options: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 } },
      closed: { type: 'boolean', description: 'No more votes, as the asker sees it' },
    },
    required: ['question', 'options'],
  },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'], fixed: ['options'] },
});
export interface Poll {
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly closed?: boolean;
}

/**
 * One person's vote on a poll or proposal: the position of their choice in
 * its options. For more than one choice, or a ranking, `choices` lists them
 * in order and `choice` is the first. One per person per poll — voting again
 * changes it; deleting takes it back.
 */
export const vote = typed<Vote>()({
  name: 'std.vote',
  title: 'Vote',
  description: 'A vote on a poll: one per person, changed by voting again.',
  schema: {
    type: 'object',
    properties: {
      choice: { type: 'integer', minimum: 0, 'x-choicesFrom': { rel: 'about', field: 'options' } },
      choices: {
        type: 'array',
        maxItems: 100,
        description: 'Every choice, most preferred first, when there are several',
        items: { type: 'integer', minimum: 0, 'x-choicesFrom': { rel: 'about', field: 'options' } },
      },
    },
    required: ['choice'],
  },
  links: {
    about: { to: ['std.poll', 'std.proposal'], cardinality: 'one', description: 'The poll voted on' },
  },
  rules: { edit: 'creator', delete: 'creator', onePer: ['@author', 'link:about'] },
});
export interface Vote {
  readonly choice: number;
  readonly choices?: ReadonlyArray<number>;
}

/** Something put to the group to decide, voted on with `std.vote` over its options. */
export const proposal = typed<Proposal>()({
  name: 'std.proposal',
  title: 'Proposal',
  description: 'Something put to the group to decide by a vote.',
  schema: {
    type: 'object',
    properties: {
      title: words(300),
      body: markdown(20000),
      options: { type: 'array', minItems: 1, maxItems: 20, items: words(200) },
      closesAt: when(),
      status: choice(['open', 'passed', 'rejected', 'withdrawn']),
      quorum: count(1, 10000, 'Ballots for one option that decide it (std.decision)'),
    },
    required: ['title', 'options'],
  },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'], fixed: ['options'] },
});
export interface Proposal {
  readonly title: string;
  readonly body?: string;
  readonly options: ReadonlyArray<string>;
  readonly closesAt?: string;
  readonly status?: 'open' | 'passed' | 'rejected' | 'withdrawn';
  readonly quorum?: number;
}

// ─── Proven outcomes ───────────────────────────────────────────────
//
// Conditions for the checks below, built here so they read as what they
// say. What they build is plain JSON, stored with the definition.

const read = (path: string) => ({ var: path });
/** The one version cited by the id at `path`, or a field of it */
const citedOne = (path: string, field: string) => ({ get: [{ versions: [[read(path)]] }, `0.${field}`] });
/** The versions cited at `path` that are records of `collection` about the same thing as this one */
const citedAbout = (path: string, collection: string, also: ReadonlyArray<unknown> = []) => ({
  filter: [
    { versions: read(path) },
    {
      and: [
        { '==': [read('it.collection'), collection] },
        { '==': [{ link: ['about', read('it')] }, { link: ['about'] }] },
        ...also,
      ],
    },
  ],
});
/** The version cited at `path` is the first version of the record this one is about, in `collection` */
const citesWhatItIsAbout = (path: string, collection: string) => ({
  and: [
    { '==': [citedOne(path, 'collection'), collection] },
    { '==': [citedOne(path, 'key'), { link: ['about'] }] },
    { '==': [citedOne(path, 'seq'), 0] },
  ],
});

/**
 * One person's final say on a proposal: the position of their choice in its
 * options. Unlike a `std.vote`, it can't be changed once cast, so a
 * `std.decision` can cite it and mean it.
 */
export const ballot = typed<Ballot>()({
  name: 'std.ballot',
  title: 'Ballot',
  description: 'A final vote on a proposal: one per person, not changed once cast.',
  schema: {
    type: 'object',
    properties: {
      choice: { type: 'integer', minimum: 0, 'x-choicesFrom': { rel: 'about', field: 'options' } },
    },
    required: ['choice'],
  },
  links: { about: one(['std.proposal'], 'The proposal') },
  rules: { ...own, onePer: ['@author', 'link:about'], fixed: ['choice'] },
});
export interface Ballot {
  readonly choice: number;
}

const DECIDES: ReadonlyArray<Check> = [
  {
    that: citesWhatItIsAbout('body.proposal', 'std.proposal'),
    else: 'A decision cites the proposal it decides, as it was first put',
  },
  {
    that: { '<': [read('body.outcome'), { size: citedOne('body.proposal', 'body.options') }] },
    else: 'A decision picks one of the proposal’s options',
  },
  {
    that: {
      '>=': [
        {
          size: {
            distinct: {
              map: [
                citedAbout('body.ballots', 'std.ballot', [
                  { '==': [read('it.body.choice'), read('body.outcome')] },
                ]),
                read('it.author'),
              ],
            },
          },
        },
        citedOne('body.proposal', 'body.quorum'),
      ],
    },
    else: 'A decision cites ballots for its outcome from as many people as the proposal’s quorum',
  },
];

/**
 * What a proposal came to, proven: it cites the proposal as first put and
 * enough ballots for one option, from different people, to reach its
 * quorum. Anyone may write it once the ballots are in; every device checks.
 */
export const decision = typed<Decision>()({
  name: 'std.decision',
  title: 'Decision',
  description: 'What a proposal came to, proven by the ballots it cites.',
  schema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'integer',
        minimum: 0,
        'x-choicesFrom': { rel: 'about', field: 'options' },
        description: 'The option decided on',
      },
      proposal: words(128, 'The id of the proposal’s first version'),
      ballots: {
        type: 'array',
        maxItems: 256,
        items: words(128),
        description: 'Ids of the ballots it counts',
      },
    },
    required: ['outcome', 'proposal', 'ballots'],
  },
  links: { about: one(['std.proposal'], 'The proposal decided') },
  rules: { edit: 'creator', delete: 'creator', onePer: ['link:about'], check: DECIDES },
});
export interface Decision {
  readonly outcome: number;
  readonly proposal: string;
  readonly ballots: ReadonlyArray<string>;
}

/**
 * Something the group reaches together, a unit at a time: "40 people", "5000
 * NOK", "100 hours". People pledge toward it; `std.goal-reached` proves it.
 */
export const goal = typed<Goal>()({
  name: 'std.goal',
  title: 'Goal',
  description: 'A target the group reaches together, pledge by pledge.',
  schema: {
    type: 'object',
    properties: {
      title: words(300),
      body: markdown(20000),
      target: count(1, 1_000_000_000, 'How many units reach it'),
      unit: words(50, 'What is counted: people, NOK, hours'),
      closesAt: when(),
    },
    required: ['title', 'target', 'unit'],
  },
  permissions: ['moderate'],
  rules: { ...authored, fixed: ['target', 'unit'] },
});
export interface Goal {
  readonly title: string;
  readonly body?: string;
  readonly target: number;
  readonly unit: string;
  readonly closesAt?: string;
}

/** One person's pledge toward a goal, in its units: once each, not changed once made. */
export const pledge = typed<Pledge>()({
  name: 'std.pledge',
  title: 'Pledge',
  description: 'A promise toward a goal: once per person, not changed once made.',
  schema: {
    type: 'object',
    properties: { amount: count(1, 1_000_000_000, 'In the goal’s units'), note: text(1000) },
    required: ['amount'],
  },
  links: { about: one(['std.goal'], 'The goal') },
  rules: { ...own, onePer: ['@author', 'link:about'], fixed: ['amount'] },
});
export interface Pledge {
  readonly amount: number;
  readonly note?: string;
}

const PLEDGES = citedAbout('body.pledges', 'std.pledge');
const REACHES: ReadonlyArray<Check> = [
  {
    that: citesWhatItIsAbout('body.goal', 'std.goal'),
    else: 'It cites the goal it reaches, as it was first set',
  },
  {
    // One pledge per person: two first versions under one key would count twice.
    that: {
      '==': [{ size: { distinct: { map: [PLEDGES, read('it.author')] } } }, { size: { distinct: PLEDGES } }],
    },
    else: 'Each person’s pledge counts once',
  },
  {
    that: {
      '>=': [{ sum: [{ distinct: PLEDGES }, read('it.body.amount')] }, citedOne('body.goal', 'body.target')],
    },
    else: 'The pledges it cites add up to the goal’s target',
  },
];

/** A goal reached, proven: it cites the goal as first set and pledges that add up to its target. */
export const goalReached = typed<GoalReached>()({
  name: 'std.goal-reached',
  title: 'Goal reached',
  description: 'A goal reached, proven by the pledges it cites.',
  schema: {
    type: 'object',
    properties: {
      goal: words(128, 'The id of the goal’s first version'),
      pledges: {
        type: 'array',
        maxItems: 256,
        items: words(128),
        description: 'Ids of the pledges it counts',
      },
    },
    required: ['goal', 'pledges'],
  },
  links: { about: one(['std.goal'], 'The goal reached') },
  rules: { edit: 'creator', delete: 'creator', onePer: ['link:about'], check: REACHES },
});
export interface GoalReached {
  readonly goal: string;
  readonly pledges: ReadonlyArray<string>;
}

/** News for everyone in the space, from whoever may announce. */
export const announcement = typed<Announcement>()({
  name: 'std.announcement',
  title: 'Announcement',
  description: 'News for everyone in the space.',
  schema: {
    type: 'object',
    properties: { title: words(300), text: markdown(20000) },
    required: ['title'],
  },
  permissions: ['announce'],
  rules: { create: 'can:announce', edit: 'creator', delete: ['creator', 'can:announce'] },
});
export interface Announcement {
  readonly title: string;
  readonly text?: string;
}

/** A badge that can be awarded. */
export const badge = typed<Badge>()({
  name: 'std.badge',
  title: 'Badge',
  description: 'A badge that people can be awarded.',
  schema: {
    type: 'object',
    properties: { name: words(100), description: text(1000), image: blob() },
    required: ['name'],
  },
  permissions: ['award'],
  rules: { create: 'can:award', edit: 'can:award' },
});
export interface Badge {
  readonly name: string;
  readonly description?: string;
  readonly image?: BlobRef;
}

/** A badge given to someone: once per person per badge. */
export const award = typed<Award>()({
  name: 'std.award',
  title: 'Award',
  description: 'A badge given to someone, once.',
  schema: {
    type: 'object',
    properties: { did: person('Who is awarded it'), note: text(1000) },
    required: ['did'],
  },
  links: { about: one(['std.badge'], 'The badge') },
  permissions: ['award'],
  rules: { create: 'can:award', edit: 'can:award', onePer: ['link:about', 'did'] },
});
export interface Award {
  readonly did: string;
  readonly note?: string;
}

/** One of a person's settings for an app: one per person per app per key. */
export const setting = typed<Setting>()({
  name: 'std.setting',
  title: 'Setting',
  description: 'A person’s setting for an app: one per app and key.',
  schema: {
    type: 'object',
    properties: {
      app: words(200, 'Which app, by the name it goes by'),
      key: words(200),
      value: { description: 'Any JSON' },
    },
    required: ['app', 'key'],
  },
  rules: { ...own, onePer: ['@author', 'app', 'key'] },
});
export interface Setting {
  readonly app: string;
  readonly key: string;
  readonly value?: unknown;
}
