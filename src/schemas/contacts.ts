/**
 * @module schemas/contacts
 * Contacts, as two standard collections — the protocol knows neither.
 *
 * A contact is someone you share a private space for two with. Your list of
 * them is `std.contact` records in your contacts space, which only your
 * account can find (`deriveContactsSpace`). Asking someone to add you, inside
 * a space you both belong to, is a `std.contact-request` there: the invite to a
 * new space for two, sealed with their contact key so only they can read it.
 *
 * `node.contacts` does the work with both; these are here so apps can read
 * and query the records like any other.
 */
import type { DefineCollection } from '../node/types.js';
import type { Typed } from '../query/types.js';

const typed =
  <T>() =>
  <const C extends DefineCollection>(definition: C): C & Typed<T> =>
    definition;

/** Someone you can reach, and the space you share with them. One per person. */
export const contact = typed<Contact>()({
  name: 'std.contact',
  title: 'Contact',
  description: 'Someone you can reach, and the space you share with them.',
  schema: {
    type: 'object',
    properties: {
      did: { type: 'string', maxLength: 256, description: 'Their account' },
      name: { type: 'string', maxLength: 200, description: 'What you call them' },
      space: { type: 'string', maxLength: 256, description: 'The id of your space for two' },
      note: { type: 'string', maxLength: 2000 },
      blocked: { type: 'boolean', description: 'Their contact requests are hidden, in every space' },
    },
    required: ['did', 'name'],
  },
  rules: { onePer: ['did'] },
});
export interface Contact {
  readonly did: string;
  readonly name: string;
  readonly space?: string;
  readonly note?: string;
  readonly blocked?: boolean;
}

/** An invite to a space for two, sealed so only the person it is for can read it. */
export const contactRequest = typed<ContactRequestRecord>()({
  name: 'std.contact-request',
  title: 'Contact request',
  description: 'An invite to a space for two, sealed so only one person can read it.',
  schema: {
    type: 'object',
    properties: {
      to: { type: 'string', maxLength: 256, description: 'The account it is for' },
      sealed: { type: 'string', maxLength: 16000, description: 'The invite and a note, sealed with their contact key' },
    },
    required: ['to', 'sealed'],
  },
  rules: { edit: 'creator', delete: 'creator' },
});
export interface ContactRequestRecord {
  readonly to: string;
  readonly sealed: string;
}

