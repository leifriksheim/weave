/**
 * @module records/links
 * Links between records, and the annotation collections every node knows.
 *
 * A link says "this record is about that one, in a named role". The subject is
 * always the record doing the pointing, so this is not a graph — just a role
 * and a target key. Keys survive edits (BLOCK-14), so a comment stays on a todo
 * however many times it is ticked.
 *
 * **Strict nouns, polymorphic annotations.** A noun declares exactly what it
 * points at; an annotation — a reaction, a comment — attaches to anything
 * (`'*'`). The `sys.*` library below is the annotation layer, built into every
 * node so they all agree on it without anyone publishing it. Keep it small:
 * the sixth entry would be somebody's noun wearing a disguise.
 */
import type { Link } from '../types.js';
import type { StoredCollection } from '../schema/collection-def.js';
import { RECORD_KEY_PATTERN } from './version.js';

export const LINK_REL_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/;

/** A record pointing at more than this is a list, and should be one. */
export const MAX_LINKS = 32;

/** Why a set of links is malformed on its own, or null when it is not. */
export function checkLinks(links: unknown): string | null {
  if (!Array.isArray(links)) return 'links must be a list';
  if (links.length > MAX_LINKS) return `At most ${MAX_LINKS} links per record`;
  for (const link of links as Array<Partial<Link>>) {
    if (typeof link !== 'object' || link === null) return 'A link must be an object';
    if (typeof link.rel !== 'string' || !LINK_REL_PATTERN.test(link.rel)) {
      return 'A link role is lower camel case, like "about" or "replyTo"';
    }
    if (typeof link.to !== 'string' || !RECORD_KEY_PATTERN.test(link.to)) return 'A link points at a record key';
    const extra = Object.keys(link).filter((k) => k !== 'rel' && k !== 'to');
    if (extra.length) return `A link has only "rel" and "to" (found ${extra.join(', ')})`;
  }
  return null;
}

/** How a collection declares one of its link roles */
export interface LinkDeclaration {
  /** Collections the target may be in, or '*' for any */
  readonly to: '*' | ReadonlyArray<string>;
  /** How many links of this role one record may carry. Default 'many'. */
  readonly cardinality?: 'one' | 'many';
  readonly description?: string;
}

const about = (description: string): LinkDeclaration => ({ to: '*', cardinality: 'one', description });

/**
 * The annotation library: five collections every node knows, so every app gets
 * them on every other app's data.
 */
export const SYS_LIBRARY: ReadonlyArray<StoredCollection> = Object.freeze<StoredCollection[]>([
  {
    name: 'sys.reaction',
    title: 'Reaction',
    description: 'An emoji reaction to any record.',
    schema: { type: 'object', properties: { emoji: { type: 'string', minLength: 1, maxLength: 16 } }, required: ['emoji'] },
    version: 1,
    links: { about: about('The record reacted to') },
  },
  {
    name: 'sys.comment',
    title: 'Comment',
    description: 'A comment on any record, optionally replying to another comment.',
    schema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 10000 } }, required: ['text'] },
    version: 1,
    links: {
      about: about('The record commented on'),
      replyTo: { to: ['sys.comment'], cardinality: 'one', description: 'The comment this replies to' },
    },
  },
  {
    name: 'sys.tag',
    title: 'Tag',
    description: 'A label on one or more records.',
    schema: { type: 'object', properties: { label: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['label'] },
    version: 1,
    links: { about: { to: '*', cardinality: 'many', description: 'The records tagged' } },
  },
  {
    name: 'sys.attachment',
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
    version: 1,
    links: { about: about('The record the file is attached to') },
  },
  {
    name: 'sys.reference',
    title: 'Reference',
    description: 'A note that one record refers to another.',
    schema: { type: 'object', properties: { note: { type: 'string' } } },
    version: 1,
    links: {
      about: about('The record doing the referring'),
      to: about('The record referred to'),
    },
  },
]);

export const SYS_LIBRARY_NAMES: ReadonlySet<string> = new Set(SYS_LIBRARY.map((c) => c.name));
