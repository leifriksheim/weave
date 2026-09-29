/**
 * Rules, as this app builds them: "when a poll has more than 10 votes, close
 * it", picked from what the space's collections say their records hold. What
 * runs is the library's (`std.rule`, `runRules` in `@weaveprotocol/core/schemas`):
 * a query and a condition. What was picked is kept beside it (`picked`), so
 * the rule can be shown in words and changed again.
 *
 * It runs on its maker's devices while this app is open on one of them;
 * running rules on one always-on node instead is issue #109.
 */
import { useEffect, useRef } from 'react';
import { useAccount, useNode } from '@weaveprotocol/core/react';
import type { Condition, NodeCollection, QueryRecord } from '@weaveprotocol/core';
import {
  IT,
  channel,
  comment,
  message,
  runRules,
  task,
  type Rule,
  type RuleAction,
  type RuleWhen,
} from '@weaveprotocol/core/schemas';
import { isObject } from './derive/schema-ui';
import {
  clausesWords,
  clauseFields,
  filterFrom,
  whereOf,
  type Clause,
  type ClauseField,
} from './derive/conditions';
import { collectionLabel } from './derive/schema-ui';

/** "…has more than 10 votes": how many records point at it, of one collection, perhaps only some of them */
export interface CountClause {
  readonly collection: string;
  readonly rel: string;
  readonly op: 'more' | 'atLeast' | 'less' | 'atMost' | 'is';
  readonly value: number;
  readonly clauses?: ReadonlyArray<Clause>;
}

/** What a person picked: records of a collection, some of their fields, and perhaps how many point at them */
// A type, not an interface, so it is also the plain object a rule's `picked` is.
export type Picked = {
  readonly collection: string;
  readonly clauses: ReadonlyArray<Clause>;
  readonly count?: CountClause;
};

/** A rule as the builder starts or reopens it */
export interface PickedRule {
  readonly name: string;
  readonly picked: Picked;
  readonly then: RuleAction;
}

/** The include a counted rule reads, which `{count}` in its text fills in */
const COUNTED = 'count';

function isClause(value: unknown): value is Clause {
  return isObject(value) && typeof value.field === 'string' && typeof value.op === 'string';
}

function isCount(value: unknown): value is CountClause {
  return (
    isObject(value) &&
    typeof value.collection === 'string' &&
    typeof value.rel === 'string' &&
    typeof value.op === 'string' &&
    typeof value.value === 'number'
  );
}

/** What was picked for a rule, when this app built it */
export function pickedOf(rule: Rule): Picked | null {
  const picked = rule.picked;
  if (!isObject(picked) || typeof picked.collection !== 'string' || !Array.isArray(picked.clauses))
    return null;
  const clauses: ReadonlyArray<unknown> = picked.clauses;
  return {
    collection: picked.collection,
    clauses: clauses.filter(isClause),
    ...(isCount(picked.count) ? { count: picked.count } : {}),
  };
}

const COUNT_OPERATOR: Readonly<Record<CountClause['op'], string>> = {
  more: '>',
  atLeast: '>=',
  less: '<',
  atMost: '<=',
  is: '==',
};

/**
 * What was picked, as the rule runs it: the collection as a query, counting
 * what links to it as an include, and every condition as one. `me` becomes
 * the maker, who alone runs it.
 */
export function compile(picked: Picked, me: string): RuleWhen {
  const parts: Condition[] = [];
  const own = whereOf(picked.clauses, me);
  if (own !== undefined) parts.push(own);
  const count = picked.count;
  if (count) parts.push({ [COUNT_OPERATOR[count.op]]: [{ var: `included.${COUNTED}` }, count.value] });
  const only = count ? filterFrom(count.clauses ?? [], me) : undefined;
  return {
    query: {
      collection: picked.collection,
      ...(count
        ? {
            include: {
              [COUNTED]: {
                rel: count.rel,
                from: count.collection,
                count: true,
                ...(only ? { where: only } : {}),
              },
            },
          }
        : {}),
    },
    ...(parts.length ? { holds: parts.length === 1 ? parts[0] : { and: parts } } : {}),
  };
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
  when: Picked,
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
      return then.channel === IT ? `post in it: “${then.text}”` : `post in chat: “${then.text}”`;
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

/** A whole rule in words; one made elsewhere, by hand or by an agent, by what it looks at */
export function ruleWords(
  rule: Rule,
  collections: ReadonlyArray<NodeCollection>,
  nameOf?: (did: string) => string,
): string {
  const picked = pickedOf(rule);
  const queried = rule.when.query.collection;
  const collection = picked?.collection ?? (typeof queried === 'string' ? queried : queried.name);
  const when = picked
    ? whenWords(picked, collections, nameOf)
    : `When ${article(noun(collections, collection))} ${noun(collections, collection)} matches its query${rule.when.holds ? ' and condition' : ''}`;
  return `${when}, ${thenWords(rule.then, collections, collection)}.`;
}

function fieldsFor(collections: ReadonlyArray<NodeCollection>, name: string): ReadonlyArray<ClauseField> {
  const found = collections.find((c) => c.name === name);
  return found ? clauseFields(found) : [];
}

/** A rule's `notify`, on this device: a browser notification, when they are on */
function notify(title: string, text: string, record: QueryRecord): boolean {
  if (typeof globalThis.Notification !== 'function' || Notification.permission !== 'granted') return false;
  new Notification(title, { body: text, tag: `${title}:${record.key}` });
  return true;
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
        .then(() => (live ? runRules(node, space, did, { busy: busy.current, notify }) : undefined))
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
): ReadonlyArray<{ title: string; rule: PickedRule }> {
  const has = (name: string) => collections.some((c) => c.name === name && c.version !== null);
  const found: Array<{ title: string; rule: PickedRule }> = [];
  if (has('std.poll') && has('std.vote'))
    found.push({
      title: 'Close a poll once 10 people have voted',
      rule: {
        name: 'Close full polls',
        picked: {
          collection: 'std.poll',
          clauses: [],
          count: { collection: 'std.vote', rel: 'about', op: 'atLeast', value: 10 },
        },
        then: { kind: 'set', field: 'closed', value: true },
      },
    });
  if (has(channel.name) && has(message.name))
    found.push({
      title: 'Say so in a channel once it has 100 messages',
      rule: {
        name: 'Busy channels',
        picked: {
          collection: channel.name,
          clauses: [],
          count: { collection: message.name, rel: 'channel', op: 'atLeast', value: 100 },
        },
        then: { kind: 'message', text: '#{title} just passed {count} messages 🎉', channel: IT },
      },
    });
  if (has('std.poll') && has('std.vote') && has(message.name))
    found.push({
      title: 'Tell the chat when a poll gets its fifth vote',
      rule: {
        name: 'Popular polls',
        picked: {
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
        picked: { collection: task.name, clauses: [{ field: 'status', op: 'is', value: 'done' }] },
        then: { kind: 'message', text: 'Done: {title} 🎉' },
      },
    });
  if (has(task.name))
    found.push({
      title: 'Notify me when an urgent task is assigned to me',
      rule: {
        name: 'Urgent for me',
        picked: {
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
