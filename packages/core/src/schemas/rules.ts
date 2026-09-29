/**
 * @module schemas/rules
 * Rules: "when a channel has more than 10 messages, post in it". Not the
 * rules a definition carries, which every peer checks (spec 02 §7) and which
 * can only refuse; these act, as the person who made them.
 *
 * A rule is an ordinary record (`std.rule`), so everyone in the space can see
 * what runs and who made it. What it is about is a query, in the format
 * `records.query` takes, and a condition over each result, in the language of
 * checks, that may read what the query's `include` found: anything a query
 * can find, a rule can act on. Only its maker's devices run it, and whatever
 * it writes is written as them, so a rule can do nothing its maker couldn't
 * do by hand. Each time it acts it leaves a run (`std.rule-run`), one per
 * rule per record by construction (`onePer`): that is how it acts once for
 * each record, and the rule's history for anyone.
 *
 * Not protocol: a peer that has never heard of rules syncs and judges these
 * records like any other. See `packages/core/docs/rules.md`.
 */
import type { DefineCollection, P2PNode } from '../node/types.js';
import { nameOf, plainQuery, type Query, type QueryRecord, type Typed } from '../query/types.js';
import { checkQuery } from '../query/filter.js';
import { checkRecordCondition, recordHolds, type Condition } from '../records/checks.js';
import { isObject } from '../utils/guards.js';
import { about, one, when as moment, words } from './fragments.js';
import { comment } from './library/annotations.js';
import { message } from './library/publishing.js';
import { task } from './library/planning.js';

/**
 * What a rule does. In text, `{title}` is what the record is called,
 * `{<include>}` how many an include found. A message's `channel` is a
 * channel's key, or `$it`: the record the rule holds for, when that is one.
 */
export type RuleAction =
  | { readonly kind: 'notify'; readonly text: string }
  | { readonly kind: 'message'; readonly text: string; readonly channel?: string }
  | { readonly kind: 'comment'; readonly text: string }
  | { readonly kind: 'set'; readonly field: string; readonly value: string | number | boolean }
  | { readonly kind: 'task'; readonly text: string };

/** What a rule is about: the records a query finds, those a condition holds for */
export interface RuleWhen {
  /** `records.query`'s format; `include` is how a rule counts or reads what points at a record */
  readonly query: Query;
  /** A record condition over each result, which may also read `included` (`checkRecordCondition`) */
  readonly holds?: Condition;
}

export interface Rule {
  readonly name: string;
  readonly when: RuleWhen;
  readonly then: RuleAction;
  /** How an app's builder showed it, so it can be shown and changed again. Never read to run it. */
  readonly picked?: Readonly<Record<string, unknown>>;
  readonly paused?: boolean;
  /** Nothing that came to hold before this sets it off */
  readonly since: string;
}

export interface RuleRun {
  /** What it did, in words */
  readonly did: string;
  readonly ok: boolean;
  readonly at: string;
}

export const rule: DefineCollection & Typed<Rule> = {
  name: 'std.rule',
  title: 'Rule',
  description: 'When records in the space are a certain way, do something. Runs as whoever made it.',
  schema: {
    type: 'object',
    properties: {
      name: words(120),
      when: { type: 'object' },
      then: { type: 'object' },
      picked: { type: 'object' },
      paused: { type: 'boolean' },
      since: moment('Nothing that came to hold before this sets it off'),
    },
    required: ['name', 'when', 'then', 'since'],
  },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
};

export const ruleRun: DefineCollection & Typed<RuleRun> = {
  name: 'std.rule-run',
  title: 'Rule run',
  description: 'A rule acted on a record: once each, whichever device did it.',
  schema: {
    type: 'object',
    properties: { did: words(500), ok: { type: 'boolean' }, at: moment() },
    required: ['did', 'ok', 'at'],
  },
  links: {
    rule: one([rule.name], 'The rule that ran'),
    about: about('The record it ran for'),
  },
  permissions: ['moderate'],
  rules: { onePer: ['link:rule', 'link:about'], edit: 'creator', delete: ['creator', 'can:moderate'] },
};

/** In an action, the record the rule holds for */
export const IT = '$it';

const KINDS = new Set(['notify', 'message', 'comment', 'set', 'task']);

/** Why this can't be a rule's action, or null */
function checkAction(then: unknown): string | null {
  if (!isObject(then) || typeof then.kind !== 'string' || !KINDS.has(then.kind))
    return `then.kind must be one of ${[...KINDS].join(', ')}`;
  if (then.kind === 'set') {
    if (typeof then.field !== 'string' || !then.field) return 'then.field must name a field';
    if (!['string', 'number', 'boolean'].includes(typeof then.value))
      return 'then.value must be a text, number or yes/no';
    return null;
  }
  if (typeof then.text !== 'string' || !then.text.trim()) return 'then.text must say something';
  if (
    then.kind === 'message' &&
    then.channel !== undefined &&
    (typeof then.channel !== 'string' || !then.channel)
  )
    return `then.channel must be a channel's key, or "${IT}"`;
  return null;
}

/** Why this can't be a rule, or null when it can */
export function checkRule(value: unknown): string | null {
  if (!isObject(value)) return 'A rule must be an object';
  if (typeof value.name !== 'string' || !value.name.trim()) return 'A rule needs a name';
  if (!isObject(value.when)) return 'A rule needs a when: { query, holds? }';
  const query = checkQuery(value.when.query);
  if (query) return `when.query: ${query}`;
  if (value.when.holds !== undefined) {
    const holds = checkRecordCondition(value.when.holds, 'when.holds', { included: true });
    if (holds) return holds;
  }
  const then = checkAction(value.then);
  if (then) return then;
  if (value.picked !== undefined && !isObject(value.picked)) return 'picked must be an object';
  if (value.paused !== undefined && typeof value.paused !== 'boolean') return 'paused must be true or false';
  if (typeof value.since !== 'string' || !Number.isFinite(Date.parse(value.since)))
    return 'since must be a date';
  return null;
}

const isRule = (value: unknown): value is Rule => checkRule(value) === null;

/** A rule record's body, when it is one */
export const ruleOf = (record: { readonly body: unknown }): Rule | null =>
  isRule(record.body) ? record.body : null;

/** One record a rule holds for now */
export interface RuleMatch {
  readonly record: QueryRecord;
  /** What its query's `include` found, as the condition read it: a count as a number */
  readonly included: Readonly<Record<string, unknown>>;
  /** When it came to hold, as far as can be told: its last change, or the newest record an include found */
  readonly moment: number;
}

/**
 * The records a rule holds for now, most recently changed first. Includes
 * that count are run as lists and counted here, so the newest of them can
 * tell when the rule came to hold.
 */
export async function matching(
  node: P2PNode,
  space: string,
  when: RuleWhen,
  limit = 200,
): Promise<ReadonlyArray<RuleMatch>> {
  const query = plainQuery(when.query);
  const counted = new Set<string>();
  const include = Object.fromEntries(
    Object.entries(query.include ?? {}).map(([name, found]) => {
      if (!found.count) return [name, found];
      counted.add(name);
      const { count: _count, limit: _limit, ...listed } = found;
      return [name, listed];
    }),
  );
  const { records } = await node.records.query(space, {
    ...query,
    include,
    sort: query.sort ?? { '@updatedAt': 'desc' },
    limit: query.limit ?? limit,
  });
  const found: RuleMatch[] = [];
  for (const record of records) {
    let latest = Date.parse(record.updatedAt);
    const included: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(record.included)) {
      if (typeof value === 'number') {
        included[name] = value;
        continue;
      }
      for (const one of value) latest = Math.max(latest, Date.parse(one.createdAt));
      included[name] = counted.has(name) ? value.length : value;
    }
    if (
      when.holds !== undefined &&
      !(await recordHolds(when.holds, { ...record, author: record.createdBy, included }))
    )
      continue;
    found.push({ record, included, moment: latest });
  }
  return found;
}

/** What a record is called, for `{title}`: its first text among the usual names, or its key */
function titleOf(record: QueryRecord): string {
  const body = isObject(record.body) ? record.body : {};
  for (const name of ['title', 'name', 'question', 'text']) {
    const value = body[name];
    if (typeof value === 'string' && value.trim())
      return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  }
  return record.key;
}

/** `{title}`, and `{<include>}` as a count, filled in */
export function fillRuleText(text: string, match: Pick<RuleMatch, 'record' | 'included'>, title = titleOf) {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    if (name === 'title') return title(match.record);
    const value = match.included[name];
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return String(value.length);
    return whole;
  });
}

/** What a device does for a rule's `notify`: shows it, and says whether it could */
export type RuleNotifier = (title: string, text: string, record: QueryRecord) => boolean;

export interface RunRulesOptions {
  /** Shows a notification. Without it, a `notify` rule's run says nothing could. */
  readonly notify?: RuleNotifier;
  /** What a record is called, for `{title}` */
  readonly title?: (record: QueryRecord) => string;
  /** Records being acted on now, shared across calls so a second look leaves them alone */
  readonly busy?: Set<string>;
}

/** Does what a rule says, as the person running it; says what happened */
export async function act(
  node: P2PNode,
  space: string,
  body: Rule,
  match: RuleMatch,
  options: RunRulesOptions = {},
): Promise<RuleRun> {
  const at = new Date().toISOString();
  const text = (template: string) => fillRuleText(template, match, options.title);
  const collections = await node.collections.list(space);
  const has = (name: string) => collections.some((c) => c.name === name && c.version !== null);
  const then = body.then;
  try {
    switch (then.kind) {
      case 'notify': {
        const shown = options.notify?.(body.name, text(then.text), match.record) ?? false;
        return { did: shown ? `Notified: ${text(then.text)}` : 'Nothing here could notify', ok: shown, at };
      }
      case 'message': {
        if (!has(message.name)) return { did: 'There is no chat in this space', ok: false, at };
        const channel = then.channel === IT ? match.record.key : then.channel;
        await node.records.put(
          space,
          message.name,
          { text: text(then.text) },
          {
            links: [
              ...(channel ? [{ rel: 'channel', to: channel }] : []),
              // Posted in it, it needn't share it too.
              ...(channel === match.record.key ? [] : [{ rel: 'shares', to: match.record.key }]),
            ],
          },
        );
        return { did: `Posted in chat: ${text(then.text)}`, ok: true, at };
      }
      case 'comment':
        if (!has(comment.name)) return { did: 'This space has no comments', ok: false, at };
        await node.records.put(
          space,
          comment.name,
          { text: text(then.text) },
          {
            links: [{ rel: 'about', to: match.record.key }],
          },
        );
        return { did: `Commented: ${text(then.text)}`, ok: true, at };
      case 'task':
        if (!has(task.name)) return { did: 'This space has no tasks', ok: false, at };
        await node.records.put(space, task.name, { title: text(then.text) });
        return { did: `Added a task: ${text(then.text)}`, ok: true, at };
      case 'set': {
        const current = await node.records.get(space, match.record.key);
        const was = isObject(current?.body) ? current.body : null;
        if (!current || !was) return { did: 'It is not there any more', ok: false, at };
        if (!(await node.records.can(space, 'edit', current.key)))
          return { did: 'Only whoever made it can change it', ok: false, at };
        await node.records.update(space, current.key, { ...was, [then.field]: then.value });
        return { did: `${text('“{title}”')}: set ${then.field} to ${String(then.value)}`, ok: true, at };
      }
    }
  } catch (error) {
    return { did: error instanceof Error ? error.message : String(error), ok: false, at };
  }
}

/** The records each rule has run for, by rule key */
async function runsIn(node: P2PNode, space: string): Promise<Map<string, Set<string>>> {
  const by = new Map<string, Set<string>>();
  for (const run of await node.records.list(space, { collection: ruleRun.name })) {
    const ran = run.links.find((l) => l.rel === 'rule')?.to;
    const on = run.links.find((l) => l.rel === 'about')?.to;
    if (!ran || !on) continue;
    const seen = by.get(ran) ?? new Set<string>();
    seen.add(on);
    by.set(ran, seen);
  }
  return by;
}

/**
 * Runs, once, every rule `maker` made in a space: acts for each record a rule
 * newly holds for, and leaves a run for it. A device calls it when records
 * change; two devices of one maker may both act before either's run reaches
 * the other (issue #109).
 */
export async function runRules(
  node: P2PNode,
  space: string,
  maker: string,
  options: RunRulesOptions = {},
): Promise<void> {
  const collections = await node.collections.list(space);
  const defined = (name: string) => collections.some((c) => c.name === name && c.version !== null);
  if (!defined(rule.name) || !defined(ruleRun.name)) return;
  const mine = (await node.records.list(space, { collection: rule.name })).filter(
    (record) => record.createdBy === maker && record.verified,
  );
  if (mine.length === 0) return;
  const busy = options.busy ?? new Set<string>();
  const runs = await runsIn(node, space);
  for (const record of mine) {
    const body = ruleOf(record);
    if (!body || body.paused || !defined(nameOf(body.when.query.collection))) continue;
    const since = Date.parse(body.since);
    for (const match of await matching(node, space, body.when)) {
      const claim = `${record.key} ${match.record.key}`;
      if (match.moment < since || runs.get(record.key)?.has(match.record.key) || busy.has(claim)) continue;
      busy.add(claim);
      try {
        const links = [
          { rel: 'rule', to: record.key },
          { rel: 'about', to: match.record.key },
        ];
        // Claimed first, so a second look while this acts leaves it alone.
        const run = await node.records.put(
          space,
          ruleRun.name,
          { did: 'Running…', ok: true, at: new Date().toISOString() },
          { links },
        );
        const done = await act(node, space, body, match, options);
        await node.records.update(space, run.key, done, { links });
      } finally {
        busy.delete(claim);
      }
    }
  }
}
