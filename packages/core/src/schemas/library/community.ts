/**
 * Community and governance: polls and votes, proposals, announcements,
 * badges. And settings, for apps that keep a person's choices in a space.
 */
import {
  blob,
  choice,
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
