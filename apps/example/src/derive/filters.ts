/**
 * Filters a person builds by picking, turned into a query's `where` and
 * `sort`. What can be picked comes from the collection's schema: text can
 * be searched, numbers compared, a choice matched against its options.
 * Pure functions, like schema-ui.
 */
import type { Filter, JsonSchema, SortDirection } from '@weaveprotocol/core';
import { choicesOf, fieldsOf, type Choice } from './schema-ui';

/** How a field is compared */
export type FilterKind = 'text' | 'number' | 'boolean' | 'choice' | 'list' | 'date' | 'person';

export interface FilterField {
  /** A body field, or a record field starting with `@` */
  readonly name: string;
  readonly label: string;
  readonly kind: FilterKind;
  /** For a choice: its options */
  readonly choices?: ReadonlyArray<Choice>;
}

export type Op =
  'contains' | 'is' | 'isNot' | 'gt' | 'gte' | 'lt' | 'lte' | 'after' | 'before' | 'set' | 'unset';

/** One condition as picked: the value as the input holds it, text */
export interface Condition {
  readonly id: number;
  readonly field: string;
  readonly op: Op;
  readonly value: string;
}

const OP_LABELS: Readonly<Record<Op, string>> = {
  contains: 'contains',
  is: 'is',
  isNot: 'is not',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  after: 'on or after',
  before: 'before',
  set: 'is filled in',
  unset: 'is empty',
};

const OPS: Readonly<Record<FilterKind, ReadonlyArray<Op>>> = {
  text: ['contains', 'is', 'isNot', 'set', 'unset'],
  number: ['is', 'isNot', 'gt', 'gte', 'lt', 'lte', 'set', 'unset'],
  boolean: ['is', 'set', 'unset'],
  choice: ['is', 'isNot', 'set', 'unset'],
  list: ['contains', 'set', 'unset'],
  date: ['after', 'before'],
  person: ['is', 'isNot'],
};

/** The operators a kind of field offers, first one the default */
export function opsFor(kind: FilterKind): ReadonlyArray<{ op: Op; label: string }> {
  return OPS[kind].map((op) => ({ op, label: OP_LABELS[op] }));
}

/** Whether the operator needs a value beside it */
export const needsValue = (op: Op) => op !== 'set' && op !== 'unset';

/** What every record has, whatever its collection */
const RECORD_FIELDS: ReadonlyArray<FilterField> = [
  { name: '@createdAt', label: 'Added', kind: 'date' },
  { name: '@updatedAt', label: 'Last changed', kind: 'date' },
  { name: '@createdBy', label: 'Added by', kind: 'person' },
];

/** The fields a collection can be filtered on: its own, then the record's */
export function filterFields(schema: JsonSchema | null): ReadonlyArray<FilterField> {
  const own = fieldsOf(schema).flatMap((f): FilterField[] => {
    switch (f.kind) {
      case 'text':
      case 'longText':
        return [{ name: f.name, label: f.label, kind: 'text' }];
      case 'number':
      case 'integer':
        return [{ name: f.name, label: f.label, kind: 'number' }];
      case 'boolean':
        return [{ name: f.name, label: f.label, kind: 'boolean' }];
      case 'list':
        return [{ name: f.name, label: f.label, kind: 'list' }];
      case 'choice': {
        // Choices read from a linked record differ per record: compared as what is stored.
        const choices = choicesOf(f);
        if (choices) return [{ name: f.name, label: f.label, kind: 'choice', choices }];
        const numeric = f.schema.type === 'number' || f.schema.type === 'integer';
        return [{ name: f.name, label: f.label, kind: numeric ? 'number' : 'text' }];
      }
      default:
        return [];
    }
  });
  return [...own, ...RECORD_FIELDS];
}

/** What a list can be ordered by: record times first, then the fields that compare simply */
export function sortFields(schema: JsonSchema | null): ReadonlyArray<FilterField> {
  const fields = filterFields(schema);
  const times = fields.filter((f) => f.kind === 'date');
  const own = fields.filter((f) => ['text', 'number', 'boolean', 'choice'].includes(f.kind));
  return [...times, ...own];
}

/** A new condition on a field, with its first operator and a starting value */
export function conditionOn(field: FilterField, id: number): Condition {
  const op = OPS[field.kind][0] ?? 'is';
  const value = field.kind === 'boolean' ? 'true' : field.kind === 'choice' ? '0' : '';
  return { id, field: field.name, op, value };
}

/** The condition's value as the query needs it; undefined while there is nothing to compare */
function valueOf(field: FilterField, value: string): unknown {
  switch (field.kind) {
    case 'number': {
      if (!value.trim()) return undefined;
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return value === 'true';
    case 'choice':
      return field.choices?.[Number(value)]?.value;
    default:
      return value.trim() ? value.trim() : undefined;
  }
}

/** One condition as a filter; null when it is not filled in yet and so filters nothing */
function filterOf(condition: Condition, field: FilterField): Filter | null {
  const name = condition.field;
  if (condition.op === 'set') return { [name]: { $exists: true } };
  if (condition.op === 'unset') return { [name]: { $exists: false } };
  const value = valueOf(field, condition.value);
  if (value === undefined) return null;
  switch (condition.op) {
    case 'contains':
      return { [name]: { $contains: value } };
    case 'is':
      return { [name]: { $eq: value } };
    case 'isNot':
      return { [name]: { $ne: value } };
    case 'gt':
      return typeof value === 'number' ? { [name]: { $gt: value } } : null;
    case 'gte':
    case 'after':
      return typeof value === 'number' || typeof value === 'string' ? { [name]: { $gte: value } } : null;
    case 'lt':
    case 'before':
      return typeof value === 'number' || typeof value === 'string' ? { [name]: { $lt: value } } : null;
    case 'lte':
      return typeof value === 'number' ? { [name]: { $lte: value } } : null;
  }
}

/** Every filled-in condition, all of which must hold; undefined when none are */
export function whereOf(
  conditions: ReadonlyArray<Condition>,
  fields: ReadonlyArray<FilterField>,
): Filter | undefined {
  const parts = conditions.flatMap((c) => {
    const field = fields.find((f) => f.name === c.field);
    const filter = field ? filterOf(c, field) : null;
    return filter ? [filter] : [];
  });
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : { $and: parts };
}

export interface Sort {
  readonly field: string;
  readonly direction: SortDirection;
}

export const NEWEST_FIRST: Sort = { field: '@createdAt', direction: 'desc' };

/** "app.todo.item" → "app.todo"; a name without a dot has no namespace */
export function namespaceOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(0, dot);
}
