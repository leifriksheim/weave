/**
 * Rules: "when a poll has more than 10 votes, close it". A person builds one
 * by picking, from what the space's collections say their records hold, and
 * it runs on their own devices while this app is open on one of them.
 *
 * A rule is an ordinary record in the space (`app.rule`), so everyone there
 * can see what runs, and who made it. Only its maker's devices run it, and
 * whatever it writes is written as them: a rule can do nothing its maker
 * couldn't do by hand. Each time it acts it leaves a run (`app.rule.run`),
 * one per rule per record by construction (`onePer`), which is how it acts
 * once for each record and not again — and the rule's history, for anyone.
 *
 * Nothing here is protocol: a peer that has never heard of rules syncs and
 * judges these records like any other. Two devices of the maker open at once
 * may both act before either's run arrives at the other; running rules on
 * one always-on node instead is the way out of that (issue #109).
 */
import { useEffect, useRef } from 'react';
import { useAccount, useNode } from '@weaveprotocol/core/react';
import { recordHolds } from '@weaveprotocol/core';
import type { DefineCollection, NodeCollection, NodeRecord, P2PNode } from '@weaveprotocol/core';
import { comment, fragments, message, task } from '@weaveprotocol/core/schemas';
import { isObject, recordLabel } from './derive/schema-ui';
import { clausesWords, clauseFields, whereOf, type Clause, type ClauseField } from './derive/conditions';
import { collectionLabel } from './derive/schema-ui';

export const ruleCollection = {
  name: 'app.rule',
  title: 'Rule',
  description: 'When something happens in the space, do something. Runs on its maker’s devices.',
  schema: {
    type: 'object',
    properties: {
      name: fragments.words(120),
      when: { type: 'object' },
      then: { type: 'object' },
      paused: { type: 'boolean' },
      since: fragments.when('Nothing before this sets it off'),
    },
    required: ['name', 'when', 'then', 'since'],
  },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
} as const satisfies DefineCollection;

export const runCollection = {
  name: 'app.rule.run',
  title: 'Rule run',
  description: 'A rule acted on a record: once each, whichever device did it.',
  schema: {
    type: 'object',
    properties: {
      did: fragments.words(500),
      ok: { type: 'boolean' },
      at: fragments.when(),
    },
    required: ['did', 'ok', 'at'],
  },
  links: {
    rule: fragments.one(['app.rule'], 'The rule that ran'),
    about: fragments.about('The record it ran for'),
  },
  permissions: ['moderate'],
  rules: { onePer: ['link:rule', 'link:about'], edit: 'creator', delete: ['creator', 'can:moderate'] },
} as const satisfies DefineCollection;

/** "…has more than 10 votes": how many records point at it, of one collection, perhaps only some of them */
export interface CountClause {
  readonly collection: string;
  readonly rel: string;
  readonly op: 'more' | 'atLeast' | 'less' | 'atMost' | 'is';
  readonly value: number;
  readonly clauses?: ReadonlyArray<Clause>;
}

export interface RuleWhen {
  readonly collection: string;
  readonly clauses: ReadonlyArray<Clause>;
  readonly count?: CountClause;
}

/** What a rule does. `{title}` in text becomes what the record is called, `{count}` how many it counted. */
export type RuleAction =
  | { readonly kind: 'notify'; readonly text: string }
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'comment'; readonly text: string }
  | { readonly kind: 'set'; readonly field: string; readonly value: string | number | boolean }
  | { readonly kind: 'task'; readonly text: string };

export interface Rule {
  readonly name: string;
  readonly when: RuleWhen;
  readonly then: RuleAction;
  readonly paused?: boolean;
  readonly since: string;
}

export interface RuleRun {
  readonly did: string;
  readonly ok: boolean;
  readonly at: string;
}

export const ACTIONS: ReadonlyArray<{
  kind: RuleAction['kind'];
  label: string;
  hint: string;
  /** What the space must have for it */
  needs?: string;
}> = [
  { kind: 'notify', label: 'Notify me', hint: 'A notification on this device' },
  {
    kind: 'message',
    label: 'Post in chat',
    hint: 'A message everyone sees, sharing it',
    needs: message.name,
  },
  { kind: 'comment', label: 'Comment on it', hint: 'A comment under it', needs: comment.name },
  { kind: 'set', label: 'Change it', hint: 'Set one of its fields' },
  { kind: 'task', label: 'Add a task', hint: 'A task on the board', needs: task.name },
];

const COUNT_WORDS: Readonly<Record<CountClause['op'], string>> = {
  more: 'more than',
  atLeast: 'at least',
  less: 'fewer than',
  atMost: 'at most',
  is: 'exactly',
};
export const COUNT_OPS = (['atLeast', 'more', 'less', 'atMost', 'is'] as const).map((op) => ({
  op,
  label: COUNT_WORDS[op],
}));

function isRule(body: unknown): body is Rule {
  return (
    isObject(body) &&
    typeof body.name === 'string' &&
    isObject(body.when) &&
    typeof body.when.collection === 'string' &&
    Array.isArray(body.when.clauses) &&
    isObject(body.then) &&
    typeof body.then.kind === 'string' &&
    typeof body.since === 'string'
  );
}

/** A rule record's body, when it is one */
export const ruleOf = (record: NodeRecord): Rule | null => (isRule(record.body) ? record.body : null);

const plural = (word: string) => (/(s|x|ch|sh)$/.test(word) ? `${word}es` : `${word}s`);

/** A collection's name, lower case, as a sentence needs it */
export function noun(collections: ReadonlyArray<NodeCollection>, name: string, many = false): string {
  const found = collections.find((c) => c.name === name);
  const word = (found ? collectionLabel(found) : (name.split('.').pop() ?? name)).toLowerCase();
  return many ? plural(word) : word;
}

const article = (word: string) => (/^[aeiou]/.test(word) ? 'an' : 'a');

/** "When a poll has more than 10 votes" */
export function whenWords(
  when: RuleWhen,
  collections: ReadonlyArray<NodeCollection>,
  nameOf?: (did: string) => string,
): string {
  const thing = noun(collections, when.collection);
  const fields = fieldsFor(collections, when.collection);
  const parts: string[] = [];
  if (when.count) {
    const counted = noun(collections, when.count.collection, when.count.value !== 1);
    const only = when.count.clauses?.length
      ? ` where ${clausesWords(when.count.clauses, fieldsFor(collections, when.count.collection), nameOf)}`
      : '';
    parts.push(`has ${COUNT_WORDS[when.count.op]} ${when.count.value} ${counted}${only}`);
  }
  const clauses = clausesWords(when.clauses, fields, nameOf);
  if (clauses) parts.push(`${when.count ? 'and its' : 'whose'} ${clauses}`);
  return `When ${article(thing)} ${thing} ${parts.length ? parts.join(' ') : 'is added'}`;
}

/** "close it", "post “{title} is decided” in chat" */
export function thenWords(
  then: RuleAction,
  collections: ReadonlyArray<NodeCollection>,
  collection: string,
): string {
  switch (then.kind) {
    case 'notify':
      return `notify me: “${then.text}”`;
    case 'message':
      return `post in chat: “${then.text}”`;
    case 'comment':
      return `comment on it: “${then.text}”`;
    case 'task':
      return `add a task: “${then.text}”`;
    case 'set': {
      const field = fieldsFor(collections, collection).find((f) => f.name === then.field);
      const label = (field?.label ?? then.field).toLowerCase();
      const value =
        typeof then.value === 'boolean'
          ? then.value
            ? 'yes'
            : 'no'
          : (field?.choices?.find((c) => c.value === then.value)?.label ?? String(then.value));
      return `set its ${label} to ${value}`;
    }
  }
}

function fieldsFor(collections: ReadonlyArray<NodeCollection>, name: string): ReadonlyArray<ClauseField> {
  const found = collections.find((c) => c.name === name);
  return found ? clauseFields(found) : [];
}

/** `{title}` and `{count}` filled in */
function fill(text: string, record: NodeRecord, schema: NodeCollection['schema'], count: number | null) {
  return text.replaceAll('{title}', recordLabel(record, schema)).replaceAll('{count}', String(count ?? ''));
}

/** The records a rule counts for one record, as the rule's maker sees them */
async function counted(
  node: P2PNode,
  space: string,
  record: NodeRecord,
  count: CountClause,
  me: string,
): Promise<ReadonlyArray<NodeRecord>> {
  const pointing = await node.records.linked(space, record.key, {
    rel: count.rel,
    collection: count.collection,
  });
  const where = whereOf(count.clauses ?? [], me);
  const kept: NodeRecord[] = [];
  for (const one of pointing)
    if (
      one.verified &&
      (where === undefined || (await recordHolds(where, { ...one, author: one.createdBy })))
    )
      kept.push(one);
  return kept;
}

function compare(op: CountClause['op'], n: number, value: number): boolean {
  switch (op) {
    case 'more':
      return n > value;
    case 'atLeast':
      return n >= value;
    case 'less':
      return n < value;
    case 'atMost':
      return n <= value;
    case 'is':
      return n === value;
  }
}

/** One record a rule is about, and whether it holds for it now */
export interface RuleMatch {
  readonly record: NodeRecord;
  readonly count: number | null;
  /** When it came to hold, as far as can be told: the record's last change, or the newest thing counted */
  readonly moment: number;
}

/** The records a rule holds for now, newest first. `me` is the rule's maker, for "me" in its conditions. */
export async function matching(
  node: P2PNode,
  space: string,
  when: RuleWhen,
  me: string,
  limit = 200,
): Promise<ReadonlyArray<RuleMatch>> {
  const records = await node.records.list(space, { collection: when.collection, newestFirst: true, limit });
  const where = whereOf(when.clauses, me);
  const found: RuleMatch[] = [];
  for (const record of records) {
    if (!record.verified || record.deleted || record.body === null) continue;
    if (where !== undefined && !(await recordHolds(where, { ...record, author: record.createdBy }))) continue;
    let moment = Date.parse(record.updatedAt);
    let count: number | null = null;
    if (when.count) {
      const them = await counted(node, space, record, when.count, me);
      count = them.length;
      if (!compare(when.count.op, count, when.count.value)) continue;
      for (const one of them) moment = Math.max(moment, Date.parse(one.createdAt));
    }
    found.push({ record, count, moment });
  }
  return found;
}

/** Does what a rule says, as the person running it; says what happened */
async function act(
  node: P2PNode,
  space: string,
  rule: Rule,
  match: RuleMatch,
  collections: ReadonlyArray<NodeCollection>,
): Promise<RuleRun> {
  const at = new Date().toISOString();
  const schema = collections.find((c) => c.name === match.record.collection)?.schema ?? null;
  const text = (template: string) => fill(template, match.record, schema, match.count);
  const has = (name: string) => collections.some((c) => c.name === name && c.version !== null);
  const then = rule.then;
  try {
    switch (then.kind) {
      case 'notify': {
        const shown = typeof globalThis.Notification === 'function' && Notification.permission === 'granted';
        if (shown)
          new Notification(rule.name, { body: text(then.text), tag: `${rule.name}:${match.record.key}` });
        return {
          did: shown ? `Notified: ${text(then.text)}` : 'Notifications are off in this browser',
          ok: shown,
          at,
        };
      }
      case 'message':
        if (!has(message.name)) return { did: 'There is no chat in this space', ok: false, at };
        await node.records.put(
          space,
          message.name,
          { text: text(then.text) },
          {
            links: [{ rel: 'shares', to: match.record.key }],
          },
        );
        return { did: `Posted in chat: ${text(then.text)}`, ok: true, at };
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
        const body = isObject(current?.body) ? current.body : null;
        if (!current || !body) return { did: 'It is not there any more', ok: false, at };
        if (!(await node.records.can(space, 'edit', current.key)))
          return { did: 'Only whoever made it can change it', ok: false, at };
        await node.records.update(space, current.key, { ...body, [then.field]: then.value });
        return {
          did: `${text('“{title}”')}: ${thenWords(then, collections, rule.when.collection).replace(/^set its/, 'set')}`,
          ok: true,
          at,
        };
      }
    }
  } catch (error) {
    return { did: error instanceof Error ? error.message : String(error), ok: false, at };
  }
}

/** The records each rule has run for, by rule key */
async function runsIn(node: P2PNode, space: string): Promise<Map<string, Set<string>>> {
  const runs = await node.records.list(space, { collection: runCollection.name });
  const by = new Map<string, Set<string>>();
  for (const run of runs) {
    const rule = run.links.find((l) => l.rel === 'rule')?.to;
    const about = run.links.find((l) => l.rel === 'about')?.to;
    if (!rule || !about) continue;
    if (!by.has(rule)) by.set(rule, new Set());
    by.get(rule)!.add(about);
  }
  return by;
}

/** Runs every rule this account made, in one space, once: acting for each record it newly holds for */
async function runSpace(node: P2PNode, space: string, me: string, busy: Set<string>): Promise<void> {
  const collections = await node.collections.list(space);
  const defined = (name: string) => collections.some((c) => c.name === name && c.version !== null);
  if (!defined(ruleCollection.name) || !defined(runCollection.name)) return;
  const rules = (await node.records.list(space, { collection: ruleCollection.name })).filter(
    (record) => record.createdBy === me && record.verified,
  );
  if (rules.length === 0) return;
  const runs = await runsIn(node, space);
  for (const record of rules) {
    const rule = ruleOf(record);
    if (!rule || rule.paused || !defined(rule.when.collection)) continue;
    const since = Date.parse(rule.since);
    for (const match of await matching(node, space, rule.when, me)) {
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
          runCollection.name,
          { did: 'Running…', ok: true, at: new Date().toISOString() },
          { links },
        );
        const done = await act(node, space, rule, match, collections);
        await node.records.update(space, run.key, done, { links });
      } finally {
        busy.delete(claim);
      }
    }
  }
}

/** How long after a burst of changes in a space its rules are looked at */
const SETTLE_MS = 800;

/**
 * Runs the rules this account made, in every space, while the app is open:
 * once at the start, and again after each burst of changes in a space.
 */
export function useRunRules(): void {
  const node = useNode();
  const { did } = useAccount();
  const busy = useRef(new Set<string>());
  useEffect(() => {
    let live = true;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const running = new Map<string, Promise<void>>();
    const run = (space: string) => {
      const before = running.get(space) ?? Promise.resolve();
      const next = before
        .then(() => (live ? runSpace(node, space, did, busy.current) : undefined))
        .catch(() => {});
      running.set(space, next);
    };
    const soon = (space: string) => {
      clearTimeout(timers.get(space));
      timers.set(
        space,
        setTimeout(() => run(space), SETTLE_MS),
      );
    };
    void node.spaces.list().then(
      (spaces) => spaces.forEach((space) => soon(space.id)),
      () => {},
    );
    const stop = node.subscribe((event) => {
      if (event.type === 'records') soon(event.space);
    });
    return () => {
      live = false;
      stop();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [node, did]);
}

/** Starting points for a space, from the collections it has: what a rule is for, before anyone has made one */
export function ideas(
  collections: ReadonlyArray<NodeCollection>,
): ReadonlyArray<{ title: string; rule: Omit<Rule, 'since'> }> {
  const has = (name: string) => collections.some((c) => c.name === name && c.version !== null);
  const found: Array<{ title: string; rule: Omit<Rule, 'since'> }> = [];
  if (has('std.poll') && has('std.vote'))
    found.push({
      title: 'Close a poll once 10 people have voted',
      rule: {
        name: 'Close full polls',
        when: {
          collection: 'std.poll',
          clauses: [],
          count: { collection: 'std.vote', rel: 'about', op: 'atLeast', value: 10 },
        },
        then: { kind: 'set', field: 'closed', value: true },
      },
    });
  if (has('std.poll') && has('std.vote') && has(message.name))
    found.push({
      title: 'Tell the chat when a poll gets its fifth vote',
      rule: {
        name: 'Popular polls',
        when: {
          collection: 'std.poll',
          clauses: [],
          count: { collection: 'std.vote', rel: 'about', op: 'atLeast', value: 5 },
        },
        then: { kind: 'message', text: '“{title}” has {count} votes' },
      },
    });
  if (has(task.name) && has(message.name))
    found.push({
      title: 'Celebrate finished tasks in chat',
      rule: {
        name: 'Done!',
        when: { collection: task.name, clauses: [{ field: 'status', op: 'is', value: 'done' }] },
        then: { kind: 'message', text: 'Done: {title} 🎉' },
      },
    });
  if (has(task.name))
    found.push({
      title: 'Notify me when an urgent task is assigned to me',
      rule: {
        name: 'Urgent for me',
        when: {
          collection: task.name,
          clauses: [
            { field: 'assignees', op: 'includes', me: true },
            { field: 'priority', op: 'is', value: 1 },
          ],
        },
        then: { kind: 'notify', text: '{title}' },
      },
    });
  return found;
}
