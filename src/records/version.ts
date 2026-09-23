/**
 * @module records/version
 * What makes one version of a record newer than another — without a clock.
 *
 * A record keeps one `key` for life. Every change is a new signed version
 * carrying `seq` (one more than the version it replaces), `prev` (that
 * version's hash) and `genesis` (the hash of the record's first version).
 *
 * **The ordering rule: higher `seq` wins; on a tie, the lower id wins.** Every
 * node applies it to the same data and reaches the same answer, and `createdAt`
 * — which is whatever the writer typed — decides nothing. So a replayed old
 * version loses to the current one, a delete (a version with a higher `seq`)
 * stays deleted, and two devices that edited the same record while apart agree
 * on the same winner.
 *
 * The rule is load-bearing forever: nodes running two versions of it would
 * disagree about which version is current. It is pinned by tests.
 */
import type { Expression } from '../types.js';
import { base32Encode } from '../utils/hash.js';
import { checkLinks } from './links.js';

/** Keys a caller may choose: `profile`, `collection:app.todo.item`, `space:b7…` */
export const RECORD_KEY_PATTERN = /^[a-z0-9:._-]{1,128}$/;

/** A fresh key: 128 random bits. Random rather than time-based, so it says nothing about when. */
export function newRecordKey(): string {
  return base32Encode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** The parts of a version the ordering rule looks at */
export interface Versioned {
  readonly id: string;
  readonly seq: number;
}

/**
 * Whether `a` supersedes `b`. Higher `seq` first, then the lower id.
 * Never looks at a timestamp.
 */
export function supersedes(a: Versioned, b: Versioned): boolean {
  return a.seq > b.seq || (a.seq === b.seq && a.id < b.id);
}

/** Sorts newest first by the ordering rule. */
export function byVersion(a: Versioned, b: Versioned): number {
  if (a.id === b.id) return 0;
  return supersedes(a, b) ? -1 : 1;
}

/** The version fields for the next change to a record, given its current version. */
export function nextVersion(current: Pick<Expression, 'id' | 'key' | 'seq' | 'genesis'>): {
  key: string;
  seq: number;
  prev: string;
  genesis: string;
} {
  return {
    key: current.key,
    seq: current.seq + 1,
    prev: current.id,
    genesis: current.seq === 0 ? current.id : (current.genesis ?? current.id),
  };
}

/**
 * Why a version is malformed on its own, or null when it is not.
 *
 * Only what can be seen in this one version. Whether `prev` exists, whether
 * `seq` is exactly one past it, whether the collection matches earlier versions
 * — each depends on what else a node happens to hold, and a check that depends
 * on that makes nodes disagree forever. Those are applied when reading.
 */
export function checkVersionShape(expression: Partial<Expression>): string | null {
  const { key, seq, prev, genesis, deleted, retain, body, def } = expression;
  if (typeof key !== 'string' || !RECORD_KEY_PATTERN.test(key)) return 'Record key is missing or malformed';
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) return 'Version number must be a whole number from 0';
  if (seq === 0) {
    if (prev !== undefined || genesis !== undefined) return 'A first version cannot name a previous one';
  } else {
    if (typeof prev !== 'string' || typeof genesis !== 'string') return 'A later version must name its previous and first versions';
    if (prev === expression.id || genesis === expression.id) return 'A version cannot name itself';
  }
  if (def !== undefined && (seq !== 0 || typeof def !== 'string')) return 'Only a first version names the definition it was written under';
  if (deleted !== undefined && deleted !== true) return 'deleted must be true when present';
  if (retain !== undefined && retain !== true) return 'retain must be true when present';
  if (deleted && body !== null) return 'A delete carries no body';
  if (expression.links !== undefined) return checkLinks(expression.links);
  return null;
}
