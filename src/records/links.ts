/**
 * @module records/links
 * Links between records.
 *
 * A link says "this record is about that one, in a named role". The subject is
 * always the record doing the pointing, so this is not a graph — just a role
 * and a target key. Keys survive edits, so a comment stays on a todo
 * however many times it is ticked.
 *
 * A collection declares its link roles in its definition. The protocol has no
 * built-in kinds of record: well-known shapes like reactions and comments are
 * an optional library (`@weaveprotocol/core/schemas`), defined into a space like
 * any other collection.
 */
import type { Link } from '../types.js';
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
