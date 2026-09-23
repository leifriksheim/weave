/**
 * @module records/rules
 * What a collection allows: who may create its records, who may edit and
 * delete them, what must be unique, and which fields are fixed at creation.
 *
 * Every rule here is judged from **one record and things every peer is sure to
 * have**: its signature and delegation, its own first version, the definition
 * that first version names, and the space's owner. Nothing depends on other
 * records, on what has arrived yet, or on a clock — so every peer reaches the
 * same verdict, and a peer may reject a record during sync without the two
 * ever disagreeing for good.
 *
 * "At most one per…" is not checked against other records (no peer ever holds
 * them all). It is made true by construction: the record's key is derived from
 * what must be unique, so a second vote *is* the first one's next version.
 */
import { sha256 } from '../utils/hash.js';
import type { Link } from '../types.js';

/** Who may do something. A list means any of them. */
export type Who = 'member' | 'owner' | 'creator';

export interface CollectionRules {
  /** Who may create a record. Default: `member` — anyone who may write in the space. */
  readonly create?: Who | ReadonlyArray<Who>;
  /** Who may write later versions. Default: `member`. `creator` is whoever wrote the first version. */
  readonly edit?: Who | ReadonlyArray<Who>;
  /** Who may delete. Default: the same as `edit`. */
  readonly delete?: Who | ReadonlyArray<Who>;
  /**
   * At most one record per combination of these — by construction: the key is
   * derived from them. `@author` is the writer's identity, `link:<rel>` the
   * record a link points at, anything else a field of the body.
   * `['@author', 'link:about']` is one vote per person per poll.
   */
  readonly onePer?: ReadonlyArray<string>;
  /** Fields that keep the value the record was created with */
  readonly fixed?: ReadonlyArray<string>;
}

const WHO = new Set(['member', 'owner', 'creator']);

/** Why a set of rules is malformed, or null when it is not */
export function checkRules(rules: unknown, at = 'rules'): string | null {
  if (rules === undefined) return null;
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) return `${at} must be an object`;
  const r = rules as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!['create', 'edit', 'delete', 'onePer', 'fixed'].includes(key)) return `${at}.${key} is not a rule (use create, edit, delete, onePer, fixed)`;
  }
  for (const action of ['create', 'edit', 'delete']) {
    const who = r[action];
    if (who === undefined) continue;
    const list = Array.isArray(who) ? who : [who];
    if (list.length === 0 || !list.every((w) => typeof w === 'string' && WHO.has(w))) {
      return `${at}.${action} must be "member", "owner" or "creator", or a list of them`;
    }
  }
  if (r.create !== undefined && (Array.isArray(r.create) ? r.create : [r.create]).includes('creator')) {
    return `${at}.create cannot be "creator" — a record has no creator until it is created`;
  }
  for (const list of ['onePer', 'fixed']) {
    const value = r[list];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && v.length > 0)) {
      return `${at}.${list} must be a non-empty list of names`;
    }
  }
  return null;
}

/** Whether `root` is among `who`, given who owns the space and who created the record */
export function allows(who: Who | ReadonlyArray<Who> | undefined, root: string | null, context: { owner: string; creator: string | null }): boolean {
  const list = who === undefined ? ['member'] : Array.isArray(who) ? who : [who];
  return list.some((w) => w === 'member' || (w === 'owner' && root === context.owner) || (w === 'creator' && root !== null && root === context.creator));
}

/** "Only the creator or the space owner" — for error messages */
export function describeWho(who: Who | ReadonlyArray<Who> | undefined): string {
  const list = who === undefined ? ['member'] : Array.isArray(who) ? who : [who];
  const words = list.map((w) => (w === 'member' ? 'members' : w === 'owner' ? 'the space owner' : 'whoever created it'));
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
}

/**
 * The key a record must have under `onePer`, or null when something it names
 * is missing (no such link, no such field). Lower-case hex, so it is a valid
 * record key.
 */
export async function onePerKey(
  collection: string,
  onePer: ReadonlyArray<string>,
  record: { root: string; links: ReadonlyArray<Link>; body: unknown },
): Promise<string | null> {
  const parts: string[] = [collection];
  for (const part of onePer) {
    if (part === '@author') {
      parts.push(`@author=${record.root}`);
    } else if (part.startsWith('link:')) {
      const rel = part.slice(5);
      const link = record.links.find((l) => l.rel === rel);
      if (!link) return null;
      parts.push(`${part}=${link.to}`);
    } else {
      const value = (record.body as Record<string, unknown> | null)?.[part];
      if (value === undefined) return null;
      parts.push(`${part}=${JSON.stringify(value)}`);
    }
  }
  const digest = await sha256(new TextEncoder().encode(parts.join('\n')));
  return `one:${Array.from(digest.subarray(0, 20), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The first fixed field whose value differs from the record's first version, or null */
export function changedFixedField(fixed: ReadonlyArray<string> | undefined, first: unknown, next: unknown): string | null {
  for (const field of fixed ?? []) {
    const a = (first as Record<string, unknown> | null)?.[field];
    const b = (next as Record<string, unknown> | null)?.[field];
    if (JSON.stringify(a) !== JSON.stringify(b)) return field;
  }
  return null;
}
