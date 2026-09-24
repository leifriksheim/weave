/**
 * @module records/rules
 * What a collection allows: who may create its records, who may edit and
 * delete them, what must be unique, and which fields are fixed at creation.
 *
 * A rule names one of two things, and the difference matters:
 *
 * - **A fact about the record** — `creator`, whoever wrote its first version.
 *   Nobody decides it and nobody can take it away; any peer can check it from
 *   the record itself.
 * - **A permission** — `can:moderate`. Whether someone holds it was decided by
 *   a person, in the space's roles (`space/roles.ts`), and can change.
 *
 * `member` is anyone holding a role in the space at all.
 *
 * A version is judged by the definition in force, and the roles people held,
 * as of the access changes it says it saw (`seen`) — the same on every peer,
 * and never by a clock.
 *
 * "At most one per…" is not checked against other records (no peer ever holds
 * them all). It is made true by construction: the record's key is derived from
 * what must be unique, so a second vote *is* the first one's next version.
 */
import { sha256 } from '../utils/hash.js';
import type { Link } from '../types.js';

/**
 * Who may do something. A list means any of them. `can:<permission>` names a
 * permission the collection declares — `can:moderate` in `app.poll` is the
 * permission `app.poll/moderate`, which a role may hold.
 */
export type Who = 'member' | 'creator' | `can:${string}`;

/** A permission a collection declares: lower camel case, like `moderate` or `closePolls` */
export const PERMISSION_PATTERN = /^[a-z][a-zA-Z0-9]{0,39}$/;

/** The full name a role holds for a collection's permission */
export const permissionName = (collection: string, permission: string) => `${collection}/${permission}`;

export interface CollectionRules {
  /** Who may create a record. Default: `member` — anyone holding a role in the space. */
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

const isWho = (w: unknown): w is Who => w === 'member' || w === 'creator' || (typeof w === 'string' && w.startsWith('can:') && PERMISSION_PATTERN.test(w.slice(4)));

/**
 * Why a set of rules is malformed, or null when it is not.
 * @param permissions The permissions the collection declares — the only ones its rules may name
 */
export function checkRules(rules: unknown, at = 'rules', permissions: ReadonlyArray<string> = []): string | null {
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
    if (list.length === 0 || !list.every(isWho)) {
      return `${at}.${action} must be "member", "creator" or "can:<permission>", or a list of them`;
    }
    const undeclared = list.find((w) => w.startsWith('can:') && !permissions.includes(w.slice(4)));
    if (undeclared) return `${at}.${action} names ${undeclared}, but the collection does not declare "${undeclared.slice(4)}" in its permissions`;
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

/** What a rule needs to know about the writer */
export interface RuleContext {
  /** Whether the writer holds any role in the space */
  readonly member: boolean;
  /** Whether the writer created the record — false when creating it */
  readonly creator: boolean;
  /** Whether the writer holds one of the collection's permissions */
  readonly can: (permission: string) => boolean;
}

/** Whether a writer is among `who` */
export function allows(who: Who | ReadonlyArray<Who> | undefined, context: RuleContext): boolean {
  const list: ReadonlyArray<Who> = who === undefined ? ['member'] : Array.isArray(who) ? who : [who as Who];
  return list.some((w) => (w === 'member' ? context.member : w === 'creator' ? context.creator : context.can(w.slice(4))));
}

/** "Only whoever created it or those allowed to moderate" — for error messages */
export function describeWho(who: Who | ReadonlyArray<Who> | undefined): string {
  const list: ReadonlyArray<Who> = who === undefined ? ['member'] : Array.isArray(who) ? who : [who as Who];
  const words = list.map((w) => (w === 'member' ? 'members' : w === 'creator' ? 'whoever created it' : `those allowed to ${w.slice(4)}`));
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
