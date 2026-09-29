/**
 * What an assembly keeps: ordinary collections, defined in the space when
 * the assembly is made. Rules say who may write what, and every device
 * enforces them. What the records mean (how a vote travels along
 * delegations) is this app's, in `tally.ts`.
 *
 * The names are Liquid's own (`liquid.*`) rather than the standard
 * library's: `std.proposal` has fixed options and no topic, and nothing in
 * the library says "I trust this person with my vote on housing".
 */
import { fragments } from '@weaveprotocol/core/schemas';

const { typed, words, text, markdown, count, choice, people, one, own } = fragments;

/** What the space may vote on, sorted into topics. Only moderators set them. */
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
 * Something put to the assembly: yes or no. Whoever proposed it, or a
 * moderator, closes it, and the close carries the count as their device made
 * it, for everyone to check against their own.
 */
export const proposal = typed<Proposal>()({
  name: 'liquid.proposal',
  title: 'Proposal',
  description: 'Something put to the assembly to accept or reject.',
  schema: {
    type: 'object',
    properties: {
      title: words(200),
      body: markdown(20000),
      closed: { type: 'boolean' },
      result: {
        type: 'object',
        description: 'The count when it was closed, as the closer’s device made it',
        properties: {
          for: count(0),
          against: count(0),
          abstain: count(0),
          uncast: count(0),
        },
        required: ['for', 'against', 'abstain', 'uncast'],
      },
    },
    required: ['title'],
  },
  links: { topic: one(['liquid.topic'], 'The topic it belongs to') },
  permissions: ['moderate'],
  rules: { edit: ['creator', 'can:moderate'], delete: ['creator', 'can:moderate'] },
});
interface Proposal {
  readonly title: string;
  readonly body?: string;
  readonly closed?: boolean;
  readonly result?: Tally;
}
export interface Tally {
  readonly for: number;
  readonly against: number;
  readonly abstain: number;
  readonly uncast: number;
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
 * Someone's own vote on a proposal. One per person per proposal, changed by
 * voting again and taken back by deleting it, which hands the vote back to
 * their delegation. Every version is kept, so a change can be seen.
 */
export const vote = typed<Vote>()({
  name: 'liquid.vote',
  title: 'Vote',
  description: 'A vote cast on a proposal. Casting one overrides any delegation for it.',
  schema: {
    type: 'object',
    properties: { choice: choice(CHOICES) },
    required: ['choice'],
  },
  links: { about: one(['liquid.proposal'], 'The proposal') },
  history: 'all',
  rules: { ...own, onePer: ['@author', 'link:about'] },
});
interface Vote {
  readonly choice: Choice;
}

/** Everything, for a delegation that isn't limited to one topic */
export const EVERYTHING = '*';

/**
 * "When I don't vote on this topic, vote as they do." One per person per
 * topic (or `*`, for everything else): delegating again moves it, deleting
 * it takes it back. Every version is kept, so who trusted whom stays on the
 * record.
 */
export const delegation = typed<Delegation>()({
  name: 'liquid.delegation',
  title: 'Delegation',
  description: 'Who votes for someone when they don’t, on one topic or on everything.',
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

/**
 * A party: a name, what it stands for, and who is in it. Its founder keeps
 * the member list; someone is in the party when they are on it and have
 * asked to join (`membership`), so nobody is put in a party they didn't ask
 * for, and nobody gets in without the founder.
 */
export const party = typed<Party>()({
  name: 'liquid.party',
  title: 'Party',
  description: 'A group that votes together: its members’ majority is its vote.',
  schema: {
    type: 'object',
    properties: {
      name: words(80),
      platform: text(2000),
      hue: count(0, 359),
      members: people(1000, 'Who the founder let in'),
    },
    required: ['name'],
  },
  rules: own,
});
interface Party {
  readonly name: string;
  readonly platform?: string;
  readonly hue?: number;
  readonly members?: ReadonlyArray<string>;
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

/** Everything an assembly needs, defined when one is made */
export const ASSEMBLY = [topic, proposal, support, vote, delegation, party, membership] as const;
