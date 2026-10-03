/**
 * Checks: conditions a collection's records must meet, written as data and
 * judged by every peer that can read them.
 *
 * A check is an expression over the version being judged (its body, the
 * version before it, who wrote it) and over versions it cites as evidence,
 * by id. Peers only check; they never search. Whatever is hard to work out
 * (who voted, what adds up, which move is legal) the writer works out and
 * cites, and every peer confirms it from what was cited.
 *
 * So that every peer gets the same answer, whenever it judges:
 *
 * - it always ends: loops only over lists already in hand, no recursion,
 *   and a cost limit;
 * - it reads nothing that changes: cited versions are named by id and must
 *   be kept whole (`retain`), the version before is read only when it was
 *   kept whole, and there is no clock;
 * - it has no truthiness and no coercion: a condition is `true` or it fails,
 *   and an operation given the wrong kind of value fails the check.
 *
 * One step is bounded, but a record's versions are not: a record whose
 * every version is checked against the one before is a state machine, and
 * versions citing versions build on each other the way a ledger does.
 */
import { canonicalize } from '../schema/expression.js';
import { cidFromBytes } from '../utils/hash.js';
import { utf8Encode } from '../utils/encoding.js';
import { isObject } from '../utils/guards.js';
import type { Link } from '../types.js';
import { LINK_REL_PATTERN } from './links.js';

/**
 * A condition, as JSON: a literal, a list, or `{ "<operator>": <arguments> }`.
 * Kept as `unknown`: it is data from a definition, checked by `checkChecks`.
 */
export type Condition = unknown;

/** One check a collection's records must pass: `that` must be true, else the version is refused and `else` says why */
export interface Check {
  readonly that: Condition;
  readonly else: string;
}

/** Checks one collection may have */
const MAX_CHECKS = 16;
/** Operations and literals in one collection's checks together */
const MAX_CHECK_NODES = 2000;
/** How deeply a condition may nest */
const MAX_CHECK_DEPTH = 32;
/** Steps one version's checks may take: each operation, and each list element an operation goes through */
export const MAX_CHECK_STEPS = 10_000;
/** Distinct versions one version's checks may cite */
const MAX_CITED = 256;

/** The names a condition can read with `var`, besides `it` inside a list operation */
const CHECK_NAMES = Object.freeze([
  'body',
  'links',
  'key',
  'seq',
  'collection',
  'author',
  'creator',
  'createdAt',
  'prev',
]);

/** How many arguments each operator takes: [fewest, most] */
const ARITY: Readonly<Record<string, readonly [number, number]>> = {
  var: [1, 1],
  get: [2, 2],
  and: [1, 64],
  or: [1, 64],
  not: [1, 1],
  if: [3, 3],
  '==': [2, 2],
  '!=': [2, 2],
  '<': [2, 2],
  '<=': [2, 2],
  '>': [2, 2],
  '>=': [2, 2],
  in: [2, 2],
  '+': [1, 64],
  '-': [1, 2],
  '*': [1, 64],
  '/': [2, 2],
  '%': [2, 2],
  min: [1, 64],
  max: [1, 64],
  size: [1, 1],
  map: [2, 2],
  filter: [2, 2],
  all: [2, 2],
  some: [2, 2],
  count: [1, 2],
  sum: [1, 2],
  distinct: [1, 1],
  hash: [1, 1],
  link: [1, 2],
  versions: [1, 1],
  can: [1, 2],
  member: [1, 1],
};

/** Operators whose second argument is judged once per element of the first, with the element as `it` */
const OVER_ELEMENTS = new Set(['map', 'filter', 'all', 'some', 'count', 'sum']);

/** A path: names or list positions, dot-separated, at most eight */
const PATH =
  /^([A-Za-z_][A-Za-z0-9_]{0,63}|0|[1-9][0-9]{0,8})(\.([A-Za-z_][A-Za-z0-9_]{0,63}|0|[1-9][0-9]{0,8})){0,7}$/;

/** A permission a collection declares: lower camel case, like `moderate` or `closePolls` */
export const PERMISSION_PATTERN = /^[a-z][a-zA-Z0-9]{0,39}$/;

/** An operation's operator and arguments: a list is the arguments, anything else is the one argument */
function operation(condition: unknown): { op: string; args: ReadonlyArray<unknown> } | null {
  if (!isObject(condition)) return null;
  const ops = Object.keys(condition);
  if (ops.length !== 1) return null;
  const raw: unknown = condition[ops[0]!];
  const args: ReadonlyArray<unknown> = Array.isArray(raw) ? raw : [raw];
  return { op: ops[0]!, args };
}

/**
 * Why a collection's checks can't be kept, or null.
 * @param permissions The permissions the collection declares — the only ones `can` may name
 */
export function checkChecks(
  checks: unknown,
  at = 'rules.check',
  permissions: ReadonlyArray<string> = [],
): string | null {
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > MAX_CHECKS)
    return `${at} must be a list of 1 to ${MAX_CHECKS} checks`;
  const count = { nodes: 0 };
  const items: ReadonlyArray<unknown> = checks;
  for (const [i, check] of items.entries()) {
    if (!isObject(check)) return `${at}[${i}] must be { that, else }`;
    const extra = Object.keys(check).filter((k) => k !== 'that' && k !== 'else');
    if (extra.length) return `${at}[${i}] has only "that" and "else" (found ${extra.join(', ')})`;
    if (typeof check.else !== 'string' || !check.else.trim() || check.else.length > 200)
      return `${at}[${i}].else says why a version is refused: some text, at most 200 characters`;
    if (!('that' in check)) return `${at}[${i}].that is the condition`;
    const problem = checkCondition(check.that, `${at}[${i}].that`, permissions, false, 1, count);
    if (problem) return problem;
  }
  return null;
}

function checkCondition(
  condition: unknown,
  at: string,
  permissions: ReadonlyArray<string>,
  bound: boolean,
  depth: number,
  count: { nodes: number },
  names: ReadonlyArray<string> = CHECK_NAMES,
): string | null {
  if (++count.nodes > MAX_CHECK_NODES)
    return `${at}: checks are too large (at most ${MAX_CHECK_NODES} parts)`;
  if (depth > MAX_CHECK_DEPTH) return `${at}: nested more than ${MAX_CHECK_DEPTH} deep`;
  if (condition === null || typeof condition === 'boolean' || typeof condition === 'string') return null;
  if (typeof condition === 'number') return Number.isFinite(condition) ? null : `${at}: not a number`;
  if (Array.isArray(condition)) {
    const items: ReadonlyArray<unknown> = condition;
    for (const [i, item] of items.entries()) {
      const problem = checkCondition(item, `${at}[${i}]`, permissions, bound, depth + 1, count, names);
      if (problem) return problem;
    }
    return null;
  }
  if (!isObject(condition)) return `${at}: not JSON`;
  const found = operation(condition);
  if (!found) return `${at}: an operation is an object with one member, like { "==": [a, b] }`;
  const { op, args } = found;
  const arity = ARITY[op];
  if (!arity) return `${at}: "${op}" is not an operator`;
  if (args.length < arity[0] || args.length > arity[1])
    return `${at}: "${op}" takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]} to ${arity[1]}`} argument${arity[1] === 1 ? '' : 's'}`;

  if (op === 'var') {
    const path = args[0];
    if (typeof path !== 'string' || !PATH.test(path)) return `${at}: "var" takes a path, like "body.amount"`;
    const name = path.split('.')[0]!;
    if (!names.includes(name) && !(bound && name === 'it'))
      return `${at}: "${name}" is not something a check can read (${[...names, ...(bound ? ['it'] : [])].join(', ')})`;
    return null;
  }
  if (op === 'get' && (typeof args[1] !== 'string' || !PATH.test(args[1])))
    return `${at}: "get" takes a value and a path, like "body.amount"`;
  if (op === 'link' && (typeof args[0] !== 'string' || !LINK_REL_PATTERN.test(args[0])))
    return `${at}: "link" takes a link role, like "about"`;
  if (op === 'can') {
    const permission = args[0];
    if (typeof permission !== 'string' || !PERMISSION_PATTERN.test(permission))
      return `${at}: "can" takes a permission, like "approve"`;
    if (!permissions.includes(permission))
      return `${at}: names "${permission}", but the collection does not declare it in its permissions`;
  }
  for (const [i, arg] of args.entries()) {
    if ((op === 'get' && i === 1) || (op === 'link' && i === 0) || (op === 'can' && i === 0)) continue;
    const inner = bound || (OVER_ELEMENTS.has(op) && i === 1);
    const problem = checkCondition(arg, `${at}.${op}[${i}]`, permissions, inner, depth + 1, count, names);
    if (problem) return problem;
  }
  return null;
}

/** A version a check reads: the one before, or one it cites */
export interface CheckedVersion {
  readonly id: string;
  readonly key: string;
  readonly collection: string;
  readonly seq: number;
  /** Who wrote it: the account, not the key that signed */
  readonly author: string;
  readonly createdAt: string;
  readonly deleted: boolean;
  /** Null for a delete, and for a version before that was not kept whole */
  readonly body: unknown;
  readonly links: ReadonlyArray<Link>;
}

/** Why a cited version can't be read: not here yet, can't be opened, or can't count */
export type Uncited = { readonly later: true } | { readonly unreadable: true } | { readonly refused: string };

/** What a check reads, and asks, when judging one version */
export interface CheckScope {
  /** `body`, `links`, `key`, `seq`, `collection`, `author`, `creator`, `createdAt`, `prev` */
  readonly values: Readonly<Record<string, unknown>>;
  /** A version cited by id */
  readonly cite: (id: string) => Promise<CheckedVersion | Uncited>;
  /** Whether an account held this permission of the collection, as of what the version saw */
  readonly can: (permission: string, did: string) => boolean;
  /** Whether an account held any role, as of what the version saw */
  readonly member: (did: string) => boolean;
}

/** How a version's checks came out */
export type CheckOutcome =
  | { readonly passed: true }
  | { readonly passed: false; readonly reason: string }
  /** It cites a version not held yet: judge it again when more arrives */
  | { readonly later: true }
  /** Something it reads is sealed with a key this peer doesn't hold: it can't tell */
  | { readonly unreadable: true };

/** Stops an evaluation: a wrong value, a cited version not here, or one that can't be opened */
interface Stop {
  readonly stop: 'fail' | 'later' | 'unreadable';
  readonly why: string;
}

const isStop = (value: unknown): value is Stop => isObject(value) && typeof value.stop === 'string';

function stop(why: string, kind: Stop['stop'] = 'fail'): never {
  throw Object.assign(new Error(why), { stop: kind, why });
}

/** A value as the language sees it: plain JSON, with undefined read as null */
const json = (value: unknown): unknown => (value === undefined ? null : value);

/** A path read from a value, through objects' own members and list positions. Anything missing is null. */
function readPath(value: unknown, segments: ReadonlyArray<string>): unknown {
  let at = value;
  for (const segment of segments) {
    if (Array.isArray(at)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return null;
      const items: ReadonlyArray<unknown> = at;
      at = items[Number(segment)];
    } else if (isObject(at) && Object.hasOwn(at, segment)) {
      at = at[segment];
    } else {
      return null;
    }
    if (at === undefined) return null;
  }
  return json(at);
}

const same = (a: unknown, b: unknown) => canonicalize(json(a)) === canonicalize(json(b));

function bool(value: unknown, op: string): boolean {
  if (typeof value !== 'boolean') stop(`"${op}" needs true or false`);
  return value;
}

function num(value: unknown, op: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) stop(`"${op}" needs numbers`);
  return value;
}

function list(value: unknown, op: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) stop(`"${op}" needs a list`);
  return value;
}

function finite(value: number, op: string): number {
  if (!Number.isFinite(value)) stop(`"${op}" gave no finite number`);
  return value;
}

function did(value: unknown, op: string): string {
  if (typeof value !== 'string' || !value.startsWith('did:')) stop(`"${op}" needs an account's DID`);
  return value;
}

interface Run {
  readonly scope: CheckScope;
  steps: number;
  readonly cited: Map<string, CheckedVersion>;
}

function step(run: Run): void {
  if (++run.steps > MAX_CHECK_STEPS) stop(`it takes more than ${MAX_CHECK_STEPS} steps`);
}

function linkTo(links: unknown, rel: string): unknown {
  if (!Array.isArray(links)) return null;
  const items: ReadonlyArray<unknown> = links;
  for (const link of items) if (isObject(link) && link.rel === rel) return json(link.to);
  return null;
}

/** An argument the definition check has already found to be text: a path, a link role, a permission */
function text(value: unknown): string {
  if (typeof value !== 'string') stop('expected text');
  return value;
}

async function evaluate(condition: unknown, run: Run, it: unknown): Promise<unknown> {
  step(run);
  if (condition === null || typeof condition !== 'object') return condition;
  if (Array.isArray(condition)) {
    const items: ReadonlyArray<unknown> = condition;
    const out: unknown[] = [];
    for (const item of items) out.push(await evaluate(item, run, it));
    return out;
  }
  const found = operation(condition);
  if (!found) stop('an operation is an object with one member');
  const { op, args } = found;
  const arg = (i: number) => evaluate(args[i], run, it);
  const all = async () => {
    const out: unknown[] = [];
    for (let i = 0; i < args.length; i++) out.push(await arg(i));
    return out;
  };
  /** The second argument, judged for each element of the first */
  const each = async function* (name: string) {
    for (const element of list(await arg(0), name)) {
      step(run);
      yield { element, value: args[1] === undefined ? element : await evaluate(args[1], run, element) };
    }
  };

  switch (op) {
    case 'var': {
      const [name, ...rest] = text(args[0]).split('.');
      const root = name === 'it' ? it : run.scope.values[name!];
      return readPath(root, rest);
    }
    case 'get':
      return readPath(await arg(0), text(args[1]).split('.'));
    case 'and':
      for (let i = 0; i < args.length; i++) if (!bool(await arg(i), op)) return false;
      return true;
    case 'or':
      for (let i = 0; i < args.length; i++) if (bool(await arg(i), op)) return true;
      return false;
    case 'not':
      return !bool(await arg(0), op);
    case 'if':
      return bool(await arg(0), op) ? arg(1) : arg(2);
    case '==':
      return same(await arg(0), await arg(1));
    case '!=':
      return !same(await arg(0), await arg(1));
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const a = await arg(0);
      const b = await arg(1);
      // Text by UTF-16 code units, as JavaScript compares strings.
      if (typeof a === 'number' && typeof b === 'number') return compare(op, a, b);
      if (typeof a === 'string' && typeof b === 'string') return compare(op, a, b);
      return stop(`"${op}" compares two numbers or two texts`);
    }
    case 'in': {
      const needle = await arg(0);
      return list(await arg(1), op).some((item) => same(item, needle));
    }
    case '+':
      return finite(
        (await all()).reduce<number>((total, v) => total + num(v, op), 0),
        op,
      );
    case '*':
      return finite(
        (await all()).reduce<number>((total, v) => total * num(v, op), 1),
        op,
      );
    case '-': {
      const values = (await all()).map((v) => num(v, op));
      return finite(values.length === 1 ? -values[0]! : values[0]! - values[1]!, op);
    }
    case '/':
    case '%': {
      const a = num(await arg(0), op);
      const b = num(await arg(1), op);
      if (b === 0) stop(`"${op}" by zero`);
      return finite(op === '/' ? a / b : a % b, op);
    }
    case 'min':
    case 'max': {
      const values = (await all()).map((v) => num(v, op));
      return op === 'min' ? Math.min(...values) : Math.max(...values);
    }
    case 'size':
      return list(await arg(0), op).length;
    case 'map': {
      const out: unknown[] = [];
      for await (const { value } of each(op)) out.push(json(value));
      return out;
    }
    case 'filter': {
      const out: unknown[] = [];
      for await (const { element, value } of each(op)) if (bool(value, op)) out.push(element);
      return out;
    }
    case 'all':
      for await (const { value } of each(op)) if (!bool(value, op)) return false;
      return true;
    case 'some':
      for await (const { value } of each(op)) if (bool(value, op)) return true;
      return false;
    case 'count': {
      if (args.length === 1) return list(await arg(0), op).length;
      let n = 0;
      for await (const { value } of each(op)) if (bool(value, op)) n++;
      return n;
    }
    case 'sum': {
      let total = 0;
      for await (const { value } of each(op)) total = finite(total + num(value, op), op);
      return total;
    }
    case 'distinct': {
      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const item of list(await arg(0), op)) {
        step(run);
        const text = canonicalize(json(item));
        if (!seen.has(text)) {
          seen.add(text);
          out.push(item);
        }
      }
      return out;
    }
    case 'hash':
      // The content id of the value's canonical JSON: what `bodyHash` is of a body.
      return cidFromBytes(utf8Encode(canonicalize(json(await arg(0)))));
    case 'link':
      return linkTo(
        args.length === 1 ? run.scope.values.links : readPath(await arg(1), ['links']),
        text(args[0]),
      );
    case 'versions': {
      const out: CheckedVersion[] = [];
      for (const id of list(await arg(0), op)) {
        step(run);
        if (typeof id !== 'string') stop('"versions" takes a list of version ids');
        out.push(await cite(run, id));
      }
      return out;
    }
    case 'can':
      return run.scope.can(
        text(args[0]),
        did(args.length === 2 ? await arg(1) : run.scope.values.author, op),
      );
    case 'member':
      return run.scope.member(did(await arg(0), op));
    default:
      return stop(`"${op}" is not an operator`);
  }
}

function compare<T extends number | string>(op: string, a: T, b: T): boolean {
  return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
}

async function cite(run: Run, id: string): Promise<CheckedVersion> {
  const known = run.cited.get(id);
  if (known) return known;
  if (run.cited.size >= MAX_CITED) stop(`it cites more than ${MAX_CITED} versions`);
  const found = await run.scope.cite(id);
  if ('later' in found) stop(`${id} has not arrived yet`, 'later');
  if ('unreadable' in found) stop(`${id} is sealed with a key this peer doesn't hold`, 'unreadable');
  if ('refused' in found) stop(found.refused);
  run.cited.set(id, found);
  return found;
}

/**
 * Judges a version's checks, in order: the first that isn't true decides.
 * Only a check that could be judged and was not true refuses the version.
 */
export async function runChecks(checks: ReadonlyArray<Check>, scope: CheckScope): Promise<CheckOutcome> {
  // Steps and citations are counted across all of a version's checks.
  const run: Run = { scope, steps: 0, cited: new Map() };
  for (const check of checks) {
    let result: unknown;
    try {
      result = await evaluate(check.that, run, null);
    } catch (error) {
      if (!isStop(error)) throw error;
      if (error.stop === 'later') return { later: true };
      if (error.stop === 'unreadable') return { unreadable: true };
      return { passed: false, reason: `${check.else} (${error.why})` };
    }
    if (result !== true) return { passed: false, reason: check.else };
  }
  return { passed: true };
}

/** What a record condition reads: a record as it stands, without the space or anything cited */
const RECORD_NAMES = new Set(['body', 'links', 'key', 'collection', 'author', 'createdAt']);
/** Operators that ask the space, which a record condition has nothing to ask */
const SPACE_OPERATORS = new Set(['versions', 'can', 'member']);

/** What a condition over a query's result may read besides: what its `include` found */
const INCLUDED = 'included';

/**
 * Why a condition over one record can't be kept, or null. The same language
 * as a check, reading only `body`, `links`, `key`, `collection`, `author` and
 * `createdAt`, and asking the space nothing: what a subscription's `where`
 * holds, judged by an app with the record in hand. With `included`, it may
 * also read `included`: what a query's `include` found for the record, as a
 * rule's condition does (`packages/core/docs/rules.md`).
 */
export function checkRecordCondition(
  condition: unknown,
  at = 'where',
  options: { readonly included?: boolean } = {},
): string | null {
  const names = options.included ? [...RECORD_NAMES, INCLUDED] : [...RECORD_NAMES];
  const problem = checkCondition(condition, at, [], false, 1, { nodes: 0 }, [...CHECK_NAMES, ...names]);
  if (problem) return problem;
  return readsOnlyRecord(condition, at, new Set(names));
}

function readsOnlyRecord(condition: unknown, at: string, names: ReadonlySet<string>): string | null {
  if (Array.isArray(condition)) {
    const items: ReadonlyArray<unknown> = condition;
    for (const [i, item] of items.entries()) {
      const problem = readsOnlyRecord(item, `${at}[${i}]`, names);
      if (problem) return problem;
    }
    return null;
  }
  const found = operation(condition);
  if (!found) return null;
  const { op, args } = found;
  if (SPACE_OPERATORS.has(op)) return `${at}: "${op}" asks the space, which a record condition can't`;
  if (op === 'var') {
    const name = String(args[0]).split('.')[0]!;
    if (name !== 'it' && !names.has(name))
      return `${at}: "${name}" is not something a record condition can read (${[...names].join(', ')})`;
    return null;
  }
  for (const [i, arg] of args.entries()) {
    const problem = readsOnlyRecord(arg, `${at}.${op}[${i}]`, names);
    if (problem) return problem;
  }
  return null;
}

/**
 * Whether a condition that passed `checkRecordCondition` holds for a record.
 * Only `true` holds: a wrong kind of value, a missing field compared as a
 * number, anything that would refuse a version, is simply not a match.
 */
export async function recordHolds(
  condition: unknown,
  record: {
    readonly body: unknown;
    readonly links: ReadonlyArray<Link>;
    readonly key: string;
    readonly collection: string;
    readonly author: string | null;
    readonly createdAt: string;
    /** What a query's `include` found for it, for a condition checked with `included` */
    readonly included?: Readonly<Record<string, unknown>>;
  },
): Promise<boolean> {
  const scope: CheckScope = {
    values: {
      body: record.body,
      links: record.links,
      key: record.key,
      collection: record.collection,
      author: record.author,
      createdAt: record.createdAt,
      included: record.included ?? {},
    },
    cite: () => Promise.resolve({ refused: 'a record condition cites nothing' }),
    can: () => false,
    member: () => false,
  };
  try {
    return (await evaluate(condition, { scope, steps: 0, cited: new Map() }, null)) === true;
  } catch (error) {
    if (isStop(error)) return false;
    throw error;
  }
}
