/**
 * @module schemas
 * A standard library of well-known record shapes — reactions, comments, tags,
 * attachments, references. Optional, and nothing special: the protocol knows
 * none of them. Each is an ordinary collection definition, and a space learns
 * one the same way it learns any other, when someone defines it there:
 *
 * ```ts
 * import { reaction, comment, useSchemas } from 'weave-protocol/schemas';
 *
 * await useSchemas(node, space.id, [reaction, comment]);
 * await node.records.put(space.id, reaction.name, { emoji: '👍' }, {
 *   links: [{ rel: 'about', to: post.key }],
 * });
 * ```
 *
 * The point of sharing them is agreement, not privilege: two apps that both
 * use `std.reaction` see each other's reactions. An app that prefers its own
 * shape defines its own collection instead, and loses nothing but that.
 *
 * **Strict nouns, polymorphic annotations.** These attach to anything (their
 * links point at `'*'`); an app's own nouns should say exactly what they point
 * at. Keep this list small — each entry is only worth it if nearly every app
 * would otherwise invent the same thing.
 */
import type { DefineCollection, P2PNode } from '../node/types.js';
import type { LinkDeclaration } from '../records/links.js';

const about = (description: string): LinkDeclaration => ({ to: '*', cardinality: 'one', description });

/** An emoji reaction to any record. Link it: `{ rel: 'about', to: <key> }`. */
export const reaction = {
  name: 'std.reaction',
  title: 'Reaction',
  description: 'An emoji reaction to any record.',
  schema: { type: 'object', properties: { emoji: { type: 'string', minLength: 1, maxLength: 16 } }, required: ['emoji'] },
  links: { about: about('The record reacted to') },
  // One of each emoji per person per record; only yours to take back.
  rules: { edit: 'creator', delete: 'creator', onePer: ['@author', 'link:about', 'emoji'] },
} as const satisfies DefineCollection;
export interface Reaction {
  readonly emoji: string;
}

/** A comment on any record, optionally a reply to another comment. */
export const comment = {
  name: 'std.comment',
  title: 'Comment',
  description: 'A comment on any record, optionally replying to another comment.',
  schema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 10000 } }, required: ['text'] },
  links: {
    about: about('The record commented on'),
    replyTo: { to: ['std.comment'], cardinality: 'one', description: 'The comment this replies to' },
  },
  rules: { edit: 'creator', delete: ['creator', 'owner'] },
} as const satisfies DefineCollection;
export interface Comment {
  readonly text: string;
}

/** A label on one or more records. */
export const tag = {
  name: 'std.tag',
  title: 'Tag',
  description: 'A label on one or more records.',
  schema: { type: 'object', properties: { label: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['label'] },
  links: { about: { to: '*', cardinality: 'many', description: 'The records tagged' } },
  rules: { edit: 'creator', delete: ['creator', 'owner'] },
} as const satisfies DefineCollection;
export interface Tag {
  readonly label: string;
}

/** A file attached to a record. Describes the file; storing its bytes is separate. */
export const attachment = {
  name: 'std.attachment',
  title: 'Attachment',
  description: 'A file attached to a record. Describes the file; storing its bytes is not part of this.',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      mime: { type: 'string', minLength: 1 },
      size: { type: 'integer', minimum: 0 },
      url: { type: 'string' },
    },
    required: ['name', 'mime'],
  },
  links: { about: about('The record the file is attached to') },
  rules: { edit: 'creator', delete: ['creator', 'owner'] },
} as const satisfies DefineCollection;
export interface Attachment {
  readonly name: string;
  readonly mime: string;
  readonly size?: number;
  readonly url?: string;
}

/** A note that one record refers to another. */
export const reference = {
  name: 'std.reference',
  title: 'Reference',
  description: 'A note that one record refers to another.',
  schema: { type: 'object', properties: { note: { type: 'string' } } },
  links: { about: about('The record doing the referring'), to: about('The record referred to') },
  rules: { edit: 'creator', delete: ['creator', 'owner'] },
} as const satisfies DefineCollection;
export interface Reference {
  readonly note?: string;
}

/** Everything in the library */
export const standardSchemas: ReadonlyArray<DefineCollection> = [reaction, comment, tag, attachment, reference];

/**
 * Makes sure a space knows these collections: defines the ones it has no
 * definition for, and leaves the rest alone — so calling it every time a
 * space opens is fine, and it never bumps a definition someone else owns.
 * A space you cannot write in is skipped.
 */
export async function useSchemas(node: P2PNode, spaceId: string, schemas: ReadonlyArray<DefineCollection>): Promise<void> {
  const summary = await node.spaces.get(spaceId);
  if (!summary?.writable) return;
  const known = new Set((await node.collections.list(spaceId)).filter((c) => c.version !== null).map((c) => c.name));
  for (const schema of schemas) {
    if (!known.has(schema.name)) await node.collections.define(spaceId, schema);
  }
}
