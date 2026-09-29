/**
 * "Only when…": conditions a person builds by picking, for notifications and
 * rules. A collection's schema says what each field holds, so what can be
 * picked follows from it — a choice offers its options, a person field "me"
 * and the people in the space, a number "at least" — and nobody types a
 * condition.
 *
 * A picked condition (a {@link Clause}) is kept as picked, so it can be shown
 * and changed again, and turned into the language of checks when it is used:
 * a subscription's `where` (spec 03 §15), or a rule's test. Pure functions,
 * like schema-ui.
 */
import type { Condition, Filter, NodeCollection } from '@weaveprotocol/core';
import { choicesOf, fieldsOf, type Choice } from './schema-ui';
import { fieldTypeOf, type FieldTypeName } from './field-types';

/** How a field is compared */
export type ClauseKind = 'text' | 'number' | 'yesno' | 'choice' | 'date' | 'person' | 'people' | 'list';

export interface ClauseField {
  readonly name: string;
  readonly label: string;
  readonly kind: ClauseKind;
  /** For a choice: its options */
  readonly choices?: ReadonlyArray<Choice>;
  /** Tagged on the outside of each record, so a carrier can match it too (`NodeCollection.topics`) */
  readonly topic: boolean;
}

export type ClauseOp =
  | 'is'
  | 'isNot'
  | 'more'
  | 'less'
  | 'atLeast'
  | 'atMost'
  | 'includes'
  | 'before'
  | 'after'
  | 'filled'
  | 'empty';

/** One condition as picked. A person is a DID, or `me`: whoever the rule or notification is for. */
export interface Clause {
  readonly field: string;
  readonly op: ClauseOp;
  readonly value?: string | number | boolean;
  readonly me?: true;
}

const OP_WORDS: Readonly<Record<ClauseOp, string>> = {
  is: 'is',
  isNot: 'is not',
  more: 'is more than',
  less: 'is less than',
  atLeast: 'is at least',
  atMost: 'is at most',
  includes: 'includes',
  before: 'is before',
  after: 'is on or after',
  filled: 'is filled in',
  empty: 'is empty',
};

const OPS: Readonly<Record<ClauseKind, ReadonlyArray<ClauseOp>>> = {
  choice: ['is', 'isNot', 'filled', 'empty'],
  person: ['is', 'isNot', 'filled', 'empty'],
  people: ['includes', 'filled', 'empty'],
  number: ['atLeast', 'more', 'less', 'atMost', 'is', 'isNot', 'filled', 'empty'],
  yesno: ['is'],
  date: ['before', 'after', 'filled', 'empty'],
  text: ['is', 'isNot', 'filled', 'empty'],
  list: ['includes', 'filled', 'empty'],
};

/** The comparisons a kind of field offers, the likeliest first */
export function opsFor(kind: ClauseKind): ReadonlyArray<{ op: ClauseOp; label: string }> {
  return OPS[kind].map((op) => ({ op, label: OP_WORDS[op] }));
}

export const needsValue = (op: ClauseOp) => op !== 'filled' && op !== 'empty';

const KIND_OF_TYPE: Readonly<Record<FieldTypeName, ClauseKind>> = {
  text: 'text',
  'long text': 'text',
  number: 'number',
  'whole number': 'number',
  'yes/no': 'yesno',
  choice: 'choice',
  date: 'date',
  person: 'person',
  people: 'people',
  'web link': 'text',
  'list of text': 'list',
};

/** The fields of a collection a condition can be on, people first: what "for me" is usually about */
export function clauseFields(
  collection: Pick<NodeCollection, 'schema' | 'topics'>,
): ReadonlyArray<ClauseField> {
  const fields = fieldsOf(collection.schema).flatMap((f): ClauseField[] => {
    const type = fieldTypeOf(f.schema);
    const choices = f.kind === 'choice' ? choicesOf(f) : null;
    // Choices read from a linked record differ per record: nothing fixed to pick from.
    if (f.kind === 'choice' && !choices) return [];
    const kind = f.kind === 'choice' ? 'choice' : type ? KIND_OF_TYPE[type] : null;
    if (!kind) return [];
    return [
      {
        name: f.name,
        label: f.label,
        kind,
        ...(choices ? { choices } : {}),
        topic: collection.topics.includes(f.name),
      },
    ];
  });
  const people = fields.filter((f) => f.kind === 'person' || f.kind === 'people');
  return [...people, ...fields.filter((f) => !people.includes(f))];
}

/** A new condition on a field: its first comparison, and a starting value */
export function clauseOn(field: ClauseField): Clause {
  const op = OPS[field.kind][0]!;
  switch (field.kind) {
    case 'person':
    case 'people':
      return { field: field.name, op, me: true };
    case 'yesno':
      return { field: field.name, op, value: true };
    case 'choice': {
      const first = field.choices?.[0]?.value;
      return typeof first === 'string' || typeof first === 'number' || typeof first === 'boolean'
        ? { field: field.name, op, value: first }
        : { field: field.name, op };
    }
    default:
      return { field: field.name, op };
  }
}

/** Whether a condition has what it needs to be used */
function complete(clause: Clause): boolean {
  return !needsValue(clause.op) || clause.me === true || (clause.value !== undefined && clause.value !== '');
}

const EMPTY = [null, '', []];

/** One condition in the language of checks, reading the record's body. `me` becomes this DID. */
function conditionOf(clause: Clause, me: string): Condition {
  const at = { var: `body.${clause.field}` };
  const value = clause.me ? me : clause.value;
  switch (clause.op) {
    case 'is':
      return { '==': [at, value] };
    case 'isNot':
      return { '!=': [at, value] };
    case 'more':
      return { '>': [at, value] };
    case 'less':
      return { '<': [at, value] };
    case 'atLeast':
    case 'after':
      return { '>=': [at, value] };
    case 'atMost':
      return { '<=': [at, value] };
    case 'before':
      return { '<': [at, value] };
    case 'includes':
      return { in: [value, at] };
    case 'filled':
      return { not: { in: [at, EMPTY] } };
    case 'empty':
      return { in: [at, EMPTY] };
  }
}

/** Every complete condition, all of which must hold; undefined when there are none */
export function whereOf(clauses: ReadonlyArray<Clause>, me: string): Condition {
  const parts = clauses.filter(complete).map((clause) => conditionOf(clause, me));
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : { and: parts };
}

/** One condition as a query's filter, on the body field it names */
function filterOf(clause: Clause, me: string): Filter {
  const value = clause.me ? me : clause.value;
  const on = (condition: unknown): Filter => ({ [clause.field]: condition });
  switch (clause.op) {
    case 'is':
      return on(value);
    case 'isNot':
      return on({ $ne: value });
    case 'more':
      return on({ $gt: value });
    case 'less':
    case 'before':
      return on({ $lt: value });
    case 'atLeast':
    case 'after':
      return on({ $gte: value });
    case 'atMost':
      return on({ $lte: value });
    case 'includes':
      return on({ $contains: value });
    case 'filled':
      return on({ $exists: true, $nin: EMPTY });
    case 'empty':
      return { $or: [on({ $exists: false }), on({ $in: EMPTY })] };
  }
}

/** Every complete condition as a query's `where`; undefined when there are none */
export function filterFrom(clauses: ReadonlyArray<Clause>, me: string): Filter | undefined {
  const parts = clauses.filter(complete).map((clause) => filterOf(clause, me));
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : { $and: parts };
}

/**
 * The conditions as a subscription holds them: the first a carrier can match
 * — a topic field equal to, or including, one value — as its `topic`, and the
 * rest as `where`, which only the app judges.
 */
export function subscriptionOf(
  clauses: ReadonlyArray<Clause>,
  fields: ReadonlyArray<ClauseField>,
  me: string,
): {
  topic?: { field: string; me: true } | { field: string; value: string | number | boolean };
  where?: Condition;
} {
  const ready = clauses.filter(complete);
  const carried = ready.find(
    (clause) =>
      fields.find((f) => f.name === clause.field)?.topic === true &&
      (clause.op === 'is' || clause.op === 'includes'),
  );
  const rest = whereOf(
    ready.filter((clause) => clause !== carried),
    me,
  );
  return {
    ...(carried
      ? {
          topic: carried.me
            ? { field: carried.field, me: true as const }
            : { field: carried.field, value: carried.value! },
        }
      : {}),
    ...(rest !== undefined ? { where: rest } : {}),
  };
}

/** A value as a person reads it: a choice by its label, a person by name, yes or no */
function valueWords(clause: Clause, field: ClauseField | undefined, nameOf: (did: string) => string): string {
  if (clause.me) return 'me';
  const value = clause.value;
  if (value === undefined) return '…';
  if (field?.kind === 'choice') return field.choices?.find((c) => c.value === value)?.label ?? String(value);
  if (field?.kind === 'person' || field?.kind === 'people') return nameOf(String(value));
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (field?.kind === 'text' || field?.kind === 'list') return `“${value}”`;
  return String(value);
}

/** "Priority is at least 3", "Assignees include me" */
export function clauseWords(
  clause: Clause,
  fields: ReadonlyArray<ClauseField>,
  nameOf: (did: string) => string = (did) => did,
): string {
  const field = fields.find((f) => f.name === clause.field);
  const label = field?.label ?? clause.field;
  if (field?.kind === 'yesno')
    return clause.value === false ? `not ${label.toLowerCase()}` : label.toLowerCase();
  const op = clause.op === 'includes' ? (field?.kind === 'people' ? 'includes' : 'has') : OP_WORDS[clause.op];
  return needsValue(clause.op)
    ? `${label.toLowerCase()} ${op} ${valueWords(clause, field, nameOf)}`
    : `${label.toLowerCase()} ${op}`;
}

/** Several conditions, joined the way a sentence would */
export function clausesWords(
  clauses: ReadonlyArray<Clause>,
  fields: ReadonlyArray<ClauseField>,
  nameOf?: (did: string) => string,
): string {
  const words = clauses.filter(complete).map((clause) => clauseWords(clause, fields, nameOf));
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
