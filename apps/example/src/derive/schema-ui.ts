// What a screen can work out from a collection's own definition, knowing nothing about what it holds.
import {
  quickAddBody,
  recordTitle,
  titleField,
  type JsonSchema,
  type NodeCollection,
  type NodeRecord,
} from '@weaveprotocol/core';

export { quickAddBody, titleField };

/** A record in a few words */
export const recordLabel = (record: NodeRecord, schema: JsonSchema | null): string =>
  recordTitle(record, schema);

/** How a field is edited and shown */
export type FieldKind =
  'text' | 'longText' | 'number' | 'integer' | 'boolean' | 'choice' | 'list' | 'object' | 'json';

export interface Field {
  readonly name: string;
  readonly schema: JsonSchema;
  readonly kind: FieldKind;
  readonly required: boolean;
  /** Human label: the schema's title, else the name spaced out */
  readonly label: string;
}

const LONG_TEXT = 500;

/** A JSON object: a record body, a schema, or one of their parts */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A record's fields; none when there is no record or its body cannot be opened */
export function bodyOf(record: { readonly body: unknown } | null | undefined): Record<string, unknown> {
  const body = record?.body;
  return isObject(body) ? body : {};
}

/** A value as text: JSON for an object or a list, which have no text of their own */
export function textOf(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

export function kindOf(schema: JsonSchema): FieldKind {
  if (Array.isArray(schema.enum) || Array.isArray(schema.oneOf) || choicesFrom(schema)) return 'choice';
  switch (schema.type) {
    case 'string':
      return typeof schema.maxLength === 'number' && schema.maxLength >= LONG_TEXT ? 'longText' : 'text';
    case 'number':
      return 'number';
    case 'integer':
      return 'integer';
    case 'boolean':
      return 'boolean';
    case 'array': {
      const items = isObject(schema.items) ? schema.items : {};
      return items.type === 'string' || items.type === 'number' || items.type === 'integer' ? 'list' : 'json';
    }
    case 'object':
      return schema.properties ? 'object' : 'json';
    default:
      return 'json';
  }
}

/** "dueDate" → "Due date" */
export function humanize(name: string): string {
  const spaced = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The fields of an object schema, in the order the schema lists them */
export function fieldsOf(schema: JsonSchema | null): ReadonlyArray<Field> {
  const properties = isObject(schema?.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(properties).map(([name, value]) => {
    const field = isObject(value) ? value : {};
    return {
      name,
      schema: field,
      kind: kindOf(field),
      required: required.has(name),
      label: typeof field.title === 'string' ? field.title : humanize(name),
    };
  });
}

/** What a table shows: short fields, at most four */
export function columnsOf(schema: JsonSchema | null): ReadonlyArray<Field> {
  const title = titleField(schema);
  const short = fieldsOf(schema).filter((f) =>
    ['text', 'number', 'integer', 'boolean', 'choice', 'list'].includes(f.kind),
  );
  return [...short.filter((f) => f.name === title), ...short.filter((f) => f.name !== title)].slice(0, 4);
}

/** A starting value for a new record's field */
export function emptyValue(field: Field): unknown {
  if (field.schema.default !== undefined) return field.schema.default;
  switch (field.kind) {
    case 'boolean':
      return false;
    case 'list':
      return [];
    case 'object':
      return Object.fromEntries(fieldsOf(field.schema).map((f) => [f.name, emptyValue(f)]));
    default:
      return undefined;
  }
}

/** A collection's name for people */
export function collectionLabel(collection: Pick<NodeCollection, 'name' | 'title'>): string {
  return collection.title ?? humanize(collection.name.split('.').pop() ?? collection.name);
}

/** Collections declaring a link that may point at this one, less `except` (a poll offers "Add vote") */
export function attachable(
  collections: ReadonlyArray<NodeCollection>,
  target: string,
  except: ReadonlySet<string> = new Set(),
): ReadonlyArray<{ collection: NodeCollection; rel: string }> {
  const found: Array<{ collection: NodeCollection; rel: string }> = [];
  for (const collection of collections) {
    if (except.has(collection.name) || collection.schema === null) continue;
    for (const [rel, declaration] of Object.entries(collection.links)) {
      if (declaration.to === '*' || declaration.to.includes(target)) found.push({ collection, rel });
    }
  }
  return found;
}

/** Links that name this collection (or `about` anything), not ones that point at anything in passing */
export function belonging(
  collections: ReadonlyArray<NodeCollection>,
  target: string,
  except: ReadonlySet<string> = new Set(),
): ReadonlyArray<{ collection: NodeCollection; rel: string }> {
  return attachable(collections, target, except).filter(
    (a) => a.collection.version !== null && (a.collection.links[a.rel]?.to !== '*' || a.rel === 'about'),
  );
}

/** One choice for a field: what is stored, and what a person sees */
export interface Choice {
  readonly value: unknown;
  readonly label: string;
}

/** Linked records by link role — what `x-choicesFrom` looks in */
export type LinkedByRel = Readonly<Record<string, NodeRecord | null | undefined>>;

/** Where a field's choices come from, when they live in a linked record */
export function choicesFrom(schema: JsonSchema): { rel: string; field: string } | null {
  const from = schema['x-choicesFrom'];
  return isObject(from) && typeof from.rel === 'string' && typeof from.field === 'string'
    ? { rel: from.rel, field: from.field }
    : null;
}

/** A field's choices from `oneOf`, `enum` or a linked record's `x-choicesFrom`; null when none */
export function choicesOf(field: Field, linked: LinkedByRel = {}): ReadonlyArray<Choice> | null {
  const { schema } = field;
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map((option: unknown) => {
      const c = isObject(option) ? option : {};
      return { value: c.const, label: typeof c.title === 'string' ? c.title : String(c.const) };
    });
  }
  if (Array.isArray(schema.enum))
    return schema.enum.map((value: unknown) => ({ value, label: String(value) }));
  const from = choicesFrom(schema);
  if (!from) return null;
  const list = bodyOf(linked[from.rel])[from.field];
  if (!Array.isArray(list)) return null;
  // A number is a position in the list; anything else is the option itself.
  const byPosition = schema.type === 'integer' || schema.type === 'number';
  return list.map((item: unknown, index) => ({ value: byPosition ? index : item, label: String(item) }));
}

/** What a person should see for a value: its label, when it is one of the field's choices */
export function labelOf(field: Field, value: unknown, linked: LinkedByRel = {}): string | null {
  const choice = choicesOf(field, linked)?.find((c) => c.value === value);
  return choice ? choice.label : null;
}

/** A record's linked records, by role */
export function byRel(
  links: ReadonlyArray<{ rel: string; to: string }>,
  records: ReadonlyArray<NodeRecord | null>,
): LinkedByRel {
  return Object.fromEntries(links.map((link, i) => [link.rel, records[i] ?? null]));
}

/** "Oslo 1 · Lisbon 2": the records pointing at `target`, counted by the choice they picked */
export function tally(
  collection: NodeCollection,
  pointing: ReadonlyArray<NodeRecord>,
  target: NodeRecord,
): { field: Field; counts: ReadonlyArray<{ label: string; count: number }> } | null {
  const rels = new Set(pointing.flatMap((r) => r.links.filter((l) => l.to === target.key).map((l) => l.rel)));
  const field = fieldsOf(collection.schema).find((f) => {
    const from = choicesFrom(f.schema);
    return from !== null && rels.has(from.rel);
  });
  if (!field) return null;
  const rel = choicesFrom(field.schema)!.rel;
  const choices = choicesOf(field, { [rel]: target });
  if (!choices) return null;
  const counts = choices.map((c) => ({
    label: c.label,
    count: pointing.filter((r) => bodyOf(r)[field.name] === c.value).length,
  }));
  return { field, counts };
}

/** The yes/no field a list shows as a checkbox: the first boolean, nearly always "done" */
export function checkField(schema: JsonSchema | null): Field | null {
  return fieldsOf(schema).find((f) => f.kind === 'boolean') ?? null;
}

/** The fields a board can make columns from: those with a fixed set of choices */
export function groupFields(schema: JsonSchema | null): ReadonlyArray<Field> {
  return fieldsOf(schema).filter((f) => f.kind === 'choice' && !choicesFrom(f.schema));
}

/** The short fields worth showing beside a title in a list: not the title, not the checkbox */
export function metaFields(schema: JsonSchema | null): ReadonlyArray<Field> {
  const title = titleField(schema);
  const check = checkField(schema)?.name;
  return fieldsOf(schema)
    .filter(
      (f) =>
        f.name !== title &&
        f.name !== check &&
        ['text', 'number', 'integer', 'choice', 'list'].includes(f.kind),
    )
    .slice(0, 3);
}
