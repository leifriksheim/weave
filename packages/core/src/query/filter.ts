/**
 * @module query/filter
 * The filter operators, as pure functions over opened records.
 */
import type { NodeRecord } from '../node/types.js';
import type { Filter, Include, Query } from './types.js';

/** Nested `include` beyond this is refused rather than quietly slow. */
export const MAX_INCLUDE_DEPTH = 3;

const META: Record<string, (r: NodeRecord) => unknown> = {
  '@key': (r) => r.key,
  '@author': (r) => r.author,
  '@root': (r) => r.root,
  '@createdBy': (r) => r.createdBy,
  '@createdAt': (r) => r.createdAt,
  '@updatedAt': (r) => r.updatedAt,
  '@seq': (r) => r.seq,
  '@collection': (r) => r.collection,
};

const OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$contains']);

/** A field of a record: `@…` for the record itself, a dotted path into its body otherwise. */
export function fieldValue(record: NodeRecord, path: string): unknown {
  if (path.startsWith('@')) {
    const read = META[path];
    if (!read) throw new Error(`Unknown record field "${path}" — use one of ${Object.keys(META).join(', ')}`);
    return read(record);
  }
  let value: unknown = record.body;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  return ak.length === bk.length && ak.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Ordered comparison, only between two numbers or two strings. */
function compare(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function operatorHolds(op: string, value: unknown, operand: unknown): boolean {
  switch (op) {
    case '$eq':
      return equal(value, operand);
    case '$ne':
      return !equal(value, operand);
    case '$gt': {
      const c = compare(value, operand);
      return c !== null && c > 0;
    }
    case '$gte': {
      const c = compare(value, operand);
      return c !== null && c >= 0;
    }
    case '$lt': {
      const c = compare(value, operand);
      return c !== null && c < 0;
    }
    case '$lte': {
      const c = compare(value, operand);
      return c !== null && c <= 0;
    }
    case '$in':
      return Array.isArray(operand) && operand.some((o) => equal(value, o));
    case '$nin':
      return Array.isArray(operand) && !operand.some((o) => equal(value, o));
    case '$exists':
      return (value !== undefined) === operand;
    case '$contains':
      if (typeof value === 'string' && typeof operand === 'string') return value.toLowerCase().includes(operand.toLowerCase());
      if (Array.isArray(value)) return value.some((item) => equal(item, operand));
      return false;
    default:
      throw new Error(`Unknown operator ${op}`);
  }
}

/** Whether one field satisfies a condition: an operator object, or a value to equal. */
function conditionHolds(value: unknown, condition: unknown): boolean {
  if (isPlainObject(condition) && Object.keys(condition).length > 0 && Object.keys(condition).every((k) => k.startsWith('$'))) {
    return Object.entries(condition).every(([op, operand]) => operatorHolds(op, value, operand));
  }
  return equal(value, condition);
}

/** Whether a record matches a filter. */
export function matches(record: NodeRecord, filter: Filter): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === '$and') return (condition as Filter[]).every((f) => matches(record, f));
    if (field === '$or') return (condition as Filter[]).some((f) => matches(record, f));
    if (field === '$not') return !matches(record, condition as Filter);
    return conditionHolds(fieldValue(record, field), condition);
  });
}

// ─── Checking a query before running it ─────────────────────────────

function checkFilter(filter: unknown, at: string): string | null {
  if (!isPlainObject(filter)) return `${at} must be an object`;
  for (const [field, condition] of Object.entries(filter)) {
    if (field === '$and' || field === '$or') {
      if (!Array.isArray(condition)) return `${at}.${field} must be a list of filters`;
      for (const [i, sub] of condition.entries()) {
        const problem = checkFilter(sub, `${at}.${field}[${i}]`);
        if (problem) return problem;
      }
      continue;
    }
    if (field === '$not') {
      const problem = checkFilter(condition, `${at}.$not`);
      if (problem) return problem;
      continue;
    }
    if (field.startsWith('$')) return `${at}: "${field}" is not a field or a logical operator ($and, $or, $not)`;
    if (field.startsWith('@') && !META[field]) return `${at}: unknown record field "${field}" — use one of ${Object.keys(META).join(', ')}`;
    if (isPlainObject(condition) && Object.keys(condition).some((k) => k.startsWith('$'))) {
      for (const op of Object.keys(condition)) {
        if (!OPERATORS.has(op)) return `${at}.${field}: unknown operator "${op}" — use one of ${[...OPERATORS].join(', ')}`;
      }
    }
  }
  return null;
}

function checkIncludes(includes: unknown, at: string, depth: number): string | null {
  if (!isPlainObject(includes)) return `${at} must be an object of named includes`;
  if (depth > MAX_INCLUDE_DEPTH) return `${at}: includes nest at most ${MAX_INCLUDE_DEPTH} deep`;
  for (const [name, spec] of Object.entries(includes)) {
    const inc = spec as Partial<Include> | null;
    const here = `${at}.${name}`;
    if (!isPlainObject(inc)) return `${here} must be an object`;
    if (typeof inc.rel !== 'string') return `${here}.rel is required: the link role to follow, e.g. "about"`;
    if (inc.from !== undefined && typeof inc.from !== 'string') return `${here}.from must be a collection name`;
    if (inc.direction !== undefined && inc.direction !== 'in' && inc.direction !== 'out') return `${here}.direction must be "in" or "out"`;
    if (inc.limit !== undefined && (!Number.isInteger(inc.limit) || inc.limit < 0)) return `${here}.limit must be a whole number`;
    if (inc.where !== undefined) {
      const problem = checkFilter(inc.where, `${here}.where`);
      if (problem) return problem;
    }
    if (inc.include !== undefined) {
      const problem = checkIncludes(inc.include, `${here}.include`, depth + 1);
      if (problem) return problem;
    }
  }
  return null;
}

/** Why a query cannot run, or null when it can. Queries are data; functions and unknown operators are refused. */
export function checkQuery(query: unknown): string | null {
  const q = query as Partial<Query> | null;
  if (!isPlainObject(q)) return 'A query must be an object';
  if (typeof q.collection !== 'string' || !q.collection) return 'A query needs a "collection"';
  if (q.where !== undefined) {
    const problem = checkFilter(q.where, 'where');
    if (problem) return problem;
  }
  if (q.include !== undefined) {
    const problem = checkIncludes(q.include, 'include', 1);
    if (problem) return problem;
  }
  if (q.sort !== undefined) {
    if (!isPlainObject(q.sort)) return 'sort must be an object: { field: "asc" | "desc" }';
    for (const [field, direction] of Object.entries(q.sort)) {
      if (direction !== 'asc' && direction !== 'desc') return `sort.${field} must be "asc" or "desc"`;
      if (field.startsWith('@') && !META[field]) return `sort: unknown record field "${field}"`;
    }
  }
  if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 0)) return 'limit must be a whole number';
  if (q.cursor !== undefined && typeof q.cursor !== 'string') return 'cursor must be the string a previous page returned';
  return null;
}
