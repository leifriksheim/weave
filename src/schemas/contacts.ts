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


/**
 * A door of yours: a way in for people you share no space with (`node.doors`).
 * Kept in your contacts space, so every device of the account opens the same
 * doors. Its key is derived from the contact key and `id`; closing the door
 * is deleting the record.
 */
export const door = typed<Door>()({
  name: 'std.door',
  title: 'Door',
  description: 'A way for people you share no space with to ask to become your contact.',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 16, maxLength: 64, description: 'Random; the door key is derived from it' },
      label: { type: 'string', maxLength: 64, description: 'What you call this door — only you see it' },
      name: { type: 'string', maxLength: 64, description: 'The name its code gives, shown to whoever knocks' },
      relays: { type: 'array', items: { type: 'string', maxLength: 200 }, minItems: 1, maxItems: 3, description: 'Whose mailboxes hold its knocks' },
    },
    required: ['id', 'relays'],
  },
  rules: { onePer: ['id'] },
});
export interface Door {
  readonly id: string;
  readonly label?: string;
  readonly name?: string;
  readonly relays: ReadonlyArray<string>;
}

/**
 * A knock you left on someone's door, waiting for them to open it. You don't
 * know who they are until they join the space for two; then it becomes a
 * `std.contact`, and this goes.
 */
export const knock = typed<Knock>()({
  name: 'std.knock',
  title: 'Knock',
  description: 'A knock left on a door, waiting for an answer.',
  schema: {
    type: 'object',
    properties: {
      space: { type: 'string', maxLength: 256, description: 'The space for two it invites them to' },
      name: { type: 'string', maxLength: 64, description: 'The name their door code gave' },
      door: { type: 'string', maxLength: 64, description: 'The door key knocked on' },
    },
    required: ['space', 'name', 'door'],
  },
  rules: { onePer: ['space'] },
});
export interface Knock {
  readonly space: string;
  readonly name: string;
  readonly door: string;
}
