/** Rules picked from the space's collections, kept with what was picked so they can be shown in words; run by `startRules` while this app is open. */
import { useEffect } from 'react';
import { useAccount, useNode } from '@weaveprotocol/core/react';
import type { Condition, NodeCollection, QueryRecord } from '@weaveprotocol/core';
import {
  IT,
  ME,
  SCHEDULES,
  startRules,
  type Rule,
  type RuleAction,
  type RuleWhen,
} from '@weaveprotocol/core/schemas';
import { attachable, isObject, quickAddBody } from './derive/schema-ui';
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

/** What was picked, as the rule runs it: a query, counts as includes, and the conditions; "me" is `$me`, whoever runs it */
export function compile(picked: Picked): RuleWhen {
  const parts: Condition[] = [];
  const own = whereOf(picked.clauses, ME);
  if (own !== undefined) parts.push(own);
  const count = picked.count;
  if (count) parts.push({ [COUNT_OPERATOR[count.op]]: [{ var: `included.${COUNTED}` }, count.value] });
  const only = count ? filterFrom(count.clauses ?? [], ME) : undefined;
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

export const ACTIONS: ReadonlyArray<{ kind: RuleAction['kind']; label: string; hint: string }> = [
  { kind: 'notify', label: 'Notify me', hint: 'A notification on this device' },
  { kind: 'add', label: 'Add something', hint: 'A record in any collection here, about it' },
  { kind: 'set', label: 'Change it', hint: 'Set one of its fields' },
  { kind: 'ask', label: 'Ask an agent', hint: 'Your agent, or a bot here, does what you say' },
];

/** Where a rule can add a record, and the links a new one could point at the record it is about by */
export interface AddTarget {
  readonly collection: NodeCollection;
  readonly links: ReadonlyArray<string>;
}

/** The collections a rule can add to for a record of `about`, by one line of text, those that can link to it first */
export function addable(collections: ReadonlyArray<NodeCollection>, about: string): ReadonlyArray<AddTarget> {
  const pointing = attachable(collections, about);
  const found = collections
    .filter(
      (c) => c.version !== null && !c.name.startsWith('std.rule') && quickAddBody(c.schema, 'text') !== null,
    )
    .map((collection) => {
      const rels = pointing.filter((a) => a.collection.name === collection.name).map((a) => a.rel);
      const named = rels.filter((rel) => collection.links[rel]?.to !== '*');
      return { collection, links: [...named, ...rels.filter((rel) => !named.includes(rel))] };
    });
  return [...found.filter((t) => t.links.length > 0), ...found.filter((t) => t.links.length === 0)];
}

/** The link an added record points at the rule's record by, if any */
export const linkToIt = (then: RuleAction): string | undefined =>
  then.kind === 'add' ? then.links?.find((l) => l.to === IT)?.rel : undefined;

/** An add action, pointing at the rule's record by `link` when given */
export const addAction = (collection: string, text: string, link?: string): RuleAction => ({
  kind: 'add',
  collection,
  text,
  ...(link ? { links: [{ rel: link, to: IT }] } : {}),
});

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
    case 'ask':
      return `ask: “${then.text}”`;
    case 'add': {
      const thing = noun(collections, then.collection);
      return `add ${article(thing)} ${thing}${linkToIt(then) ? ' about it' : ''}: “${then.text}”`;
    }
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

const WEEKDAYS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
  'Sundays',
];

/** The common shapes of five cron fields in words: a time each day, on weekdays, or on some days of the week */
function cronWords(every: string): string | null {
  const [minute, hour, day, month, weekday] = every.trim().split(/\s+/);
  if (!minute || !hour || !weekday || day !== '*' || month !== '*') return null;
  if (!/^\d+$/.test(minute)) return null;
  const at = /^\d+$/.test(hour) ? `at ${hour}:${minute.padStart(2, '0')}` : null;
  if (hour === '*' && minute === '0' && weekday === '*') return 'Every hour';
  if (!at) return null;
  if (weekday === '*') return `Every day ${at}`;
  if (weekday === '1-5') return `Weekdays ${at}`;
  if (weekday === '0,6' || weekday === '6,0') return `Weekends ${at}`;
  const days = weekday.split(',').map((d) => (/^[0-7]$/.test(d) ? WEEKDAYS[Number(d)] : null));
  if (days.some((d) => !d)) return null;
  return `${days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days.at(-1)}` : days[0]} ${at}`;
}

/** "Weekday mornings at 8", "Weekdays at 7:30", or for a time it can’t say, the fields as they are */
export function scheduleWords(every: string, start = true): string {
  const words = SCHEDULES.find((s) => s.value === every.trim())?.label ?? cronWords(every) ?? `At “${every}”`;
  return start ? words : words.charAt(0).toLowerCase() + words.slice(1);
}

/** A whole rule in words; one made elsewhere, by hand or by an agent, by what it looks at */
export function ruleWords(
  rule: Rule,
  collections: ReadonlyArray<NodeCollection>,
  nameOf?: (did: string) => string,
): string {
  const picked = pickedOf(rule);
  const queried = rule.when?.query.collection;
  const collection = picked?.collection ?? (typeof queried === 'object' ? queried.name : (queried ?? ''));
  const when = picked
    ? whenWords(picked, collections, nameOf)
    : rule.when
      ? `When ${article(noun(collections, collection))} ${noun(collections, collection)} matches its query${rule.when.holds ? ' and condition' : ''}`
      : '';
  const at = rule.every
    ? when
      ? `${when}, and ${scheduleWords(rule.every, false)}`
      : scheduleWords(rule.every)
    : when;
  return `${at}, ${thenWords(rule.then, collections, collection)}.`;
}

function fieldsFor(collections: ReadonlyArray<NodeCollection>, name: string): ReadonlyArray<ClauseField> {
  const found = collections.find((c) => c.name === name);
  return found ? clauseFields(found) : [];
}

/** A rule's `notify`, on this device: a browser notification, when they are on */
function notify(title: string, text: string, record?: QueryRecord): boolean {
  if (typeof globalThis.Notification !== 'function' || Notification.permission !== 'granted') return false;
  new Notification(title, { body: text, tag: `${title}:${record?.key ?? ''}` });
  return true;
}

/** Runs this account's rules in every space while the app is open; those that ask an agent or run on a timer are `weave agent`'s */
export function useRunRules(): void {
  const node = useNode();
  const { did } = useAccount();
  // Their agent may run the same rules; the earlier of two claims acts.
  useEffect(() => startRules(node, { account: did, notify, timed: false, claimMs: 1500 }), [node, did]);
}

/** Starting points for a space, from what its collections say about themselves */
export function ideas(
  collections: ReadonlyArray<NodeCollection>,
): ReadonlyArray<{ title: string; rule: PickedRule }> {
  const live = collections.filter(
    (c) => c.schema !== null && c.version !== null && !c.name.startsWith('std.rule'),
  );
  const found: Array<{ title: string; rule: PickedRule }> = [];
  for (const collection of live) {
    const thing = noun(collections, collection.name);
    const fields = fieldsFor(collections, collection.name);
    // Another collection that belongs under this one by a link naming it, as votes do under a poll
    const counted = attachable(live, collection.name).find(
      (a) =>
        a.collection.name !== collection.name && (a.collection.links[a.rel]?.to !== '*' || a.rel === 'about'),
    );
    if (counted) {
      const many = noun(collections, counted.collection.name, true);
      const count = { collection: counted.collection.name, rel: counted.rel, op: 'atLeast' as const };
      const yes = fields.find((f) => f.kind === 'yesno');
      found.push(
        yes
          ? {
              title: `Mark ${article(thing)} ${thing} “${yes.label.toLowerCase()}” once it has 10 ${many}`,
              rule: {
                name: `${yes.label} at 10 ${many}`,
                picked: { collection: collection.name, clauses: [], count: { ...count, value: 10 } },
                then: { kind: 'set', field: yes.name, value: true },
              },
            }
          : {
              title: `Hear when ${article(thing)} ${thing} gets 5 ${many}`,
              rule: {
                name: `Popular ${plural(thing)}`,
                picked: { collection: collection.name, clauses: [], count: { ...count, value: 5 } },
                then: { kind: 'notify', text: `“{title}” has {count} ${many}` },
              },
            },
      );
    }
    const person = fields.find((f) => f.kind === 'person' || f.kind === 'people');
    if (person)
      found.push({
        title: `Notify me when ${article(thing)} ${thing} has me as ${person.label.toLowerCase()}`,
        rule: {
          name: `${collectionLabel(collection)} for me`,
          picked: {
            collection: collection.name,
            clauses: [{ field: person.name, op: person.kind === 'people' ? 'includes' : 'is', me: true }],
          },
          then: { kind: 'notify', text: '{title}' },
        },
      });
  }
  return found.slice(0, 6);
}
