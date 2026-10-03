/**
 * People: who someone is, who they follow, block and mute, what they are up to.
 * Blocks and mutes are one person's choice, so they belong in that person's
 * own space rather than in a space others read.
 */
import { address, blob, day, own, person, text, define, url, when, words } from '../fragments.js';
import type { BodyOf } from '../../query/types.js';

/**
 * How someone presents themselves: more than the name every space keeps for
 * them (`sys.profile`). One per person, and only theirs to write.
 *
 * `bot` is the account saying it is software someone runs, not a person, so
 * apps can show it. It is the account's own word, like the rest: an honest
 * operator discloses with it, and it proves nothing about anyone who doesn't.
 */
export const profile = define({
  name: 'std.profile',
  title: 'Profile',
  description: 'How someone presents themselves: one per person.',
  schema: {
    type: 'object',
    properties: {
      name: text(100),
      bio: text(2000),
      avatar: blob(),
      banner: blob(),
      pronouns: text(50),
      links: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          properties: { title: text(100), url: url() },
          required: ['url'],
        },
      },
      bot: { type: 'boolean', description: 'The account is software someone runs, not a person' },
    },
  },
  rules: { ...own, onePer: ['@author'] },
});
export type Profile = BodyOf<typeof profile>;

const labelled = <const P extends object, const R extends keyof P>(value: P, required: R) => ({
  type: 'array' as const,
  maxItems: 16,
  items: {
    type: 'object' as const,
    properties: { ...value, label: text(50, 'Like "work" or "home"') },
    required: [required] as const,
  },
});

/**
 * A person who may not be on Weave: a subset of JSContact (RFC 9553). For
 * people who are, `std.contact` keeps their DID.
 */
export const card = define({
  name: 'std.card',
  title: 'Contact card',
  description: 'A person’s name, emails, phones and addresses, as an address book keeps them.',
  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'object',
        properties: { full: text(200), given: text(100), family: text(100) },
      },
      emails: labelled({ address: words(320) }, 'address'),
      phones: labelled({ number: words(64) }, 'number'),
      addresses: labelled({ address: address() }, 'address'),
      organization: text(200),
      jobTitle: text(200),
      birthday: day(),
      photo: blob(),
      urls: { type: 'array', maxItems: 16, items: url() },
      note: text(10000),
    },
  },
});
export type Card = BodyOf<typeof card>;

/** Following someone: their DID, and the space they publish in if known. */
export const follow = define({
  name: 'std.follow',
  title: 'Follow',
  description: 'Following a person: one per person followed.',
  schema: {
    type: 'object',
    properties: { did: person('Who is followed'), space: text(256, 'The space they publish in') },
    required: ['did'],
  },
  rules: { ...own, onePer: ['@author', 'did'] },
  topics: ['did'],
});
export type Follow = BodyOf<typeof follow>;

const avoided = (name: string, title: string, description: string) =>
  define({
    name,
    title,
    description,
    schema: {
      type: 'object',
      properties: { did: person(), until: when('Until when; forever without one') },
      required: ['did'],
    },
    rules: { ...own, onePer: ['@author', 'did'] },
  });
export type Avoid = BodyOf<typeof block>;

/** Someone whose records an app hides and whose invitations it refuses. Keep it in your own space. */
export const block = avoided(
  'std.block',
  'Block',
  'Someone to hide and keep away. Keep it in your own space.',
);
/** Someone whose records an app quiets but still shows when asked. Keep it in your own space. */
export const mute = avoided('std.mute', 'Mute', 'Someone to quiet for a while. Keep it in your own space.');

/** What someone is up to right now: one per person, gone after `until`. */
export const status = define({
  name: 'std.status',
  title: 'Status',
  description: 'What someone is up to now: one per person.',
  schema: {
    type: 'object',
    properties: { text: text(280), emoji: text(16), until: when('When it stops showing') },
  },
  rules: { ...own, onePer: ['@author'] },
});
export type Status = BodyOf<typeof status>;

/** This file's part of `standardGroups` */
export const socialGroups = {
  People: [profile, card, follow, block, mute, status],
};
