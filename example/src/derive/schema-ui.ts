/**
 * What a screen can work out from a space's own description of its data.
 *
 * Nothing here knows about todos, polls or anything else. A collection's
 * definition — its JSON Schema and its declared links — is enough to draw a
 * form, a table, a record page and the "add a vote to this poll" buttons.
 * Pure functions, so any renderer (DOM, native, a voice agent) could use them.
 */
import type { JsonSchema, NodeCollection, NodeRecord } from '@p2p-web/protocol';

/** How a field is edited and shown */
export type FieldKind = 'text' | 'longText' | 'number' | 'integer' | 'boolean' | 'choice' | 'list' | 'object' | 'json';

export interface Field {
  readonly name: string;
  readonly schema: JsonSchema;
  readonly kind: FieldKind;
  readonly required: boolean;
  /** Human label: the schema's title, else the name spaced out */
  readonly label: string;
}

const LONG_TEXT = 500;
/** Fields that usually name a record, in the order to try them */
const TITLE_NAMES = ['title', 'name', 'text', 'question', 'label', 'subject', 'emoji'];

export function kindOf(schema: JsonSchema): FieldKind {
  if (Array.isArray(schema.enum)) return 'choice';
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
      const items = (schema.items ?? {}) as JsonSchema;
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
  const spaced = name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The fields of an object schema, in the order the schema lists them */
export function fieldsOf(schema: JsonSchema | null): ReadonlyArray<Field> {
  const properties = (schema?.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema?.required ?? []) as string[]);
  return Object.entries(properties).map(([name, field]) => ({
    name,
    schema: field,
    kind: kindOf(field),
    required: required.has(name),
    label: typeof field.title === 'string' ? field.title : humanize(name),
  }));
}

/** The field that names a record: a conventional name, else the first required text, else the first text */
export function titleField(schema: JsonSchema | null): string | null {
  const fields = fieldsOf(schema);
  const text = fields.filter((f) => f.kind === 'text' || f.kind === 'longText');
  return (
    TITLE_NAMES.find((name) => text.some((f) => f.name === name)) ??
    text.find((f) => f.required)?.name ??
    text[0]?.name ??
    null
  );
}

/** A record in a few words */
export function recordLabel(record: NodeRecord, schema: JsonSchema | null): string {
  if (record.body === null) return '🔒 (cannot open)';
  const body = record.body as Record<string, unknown>;
  const field = titleField(schema) ?? TITLE_NAMES.find((name) => typeof body[name] === 'string');
  const value = field ? body[field] : undefined;
  if (typeof value === 'string' && value.trim()) return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return `${record.collection.split('.').pop()} ${record.key.slice(0, 6)}`;
}

/** What a table shows: short fields, at most four */
export function columnsOf(schema: JsonSchema | null): ReadonlyArray<Field> {
  const title = titleField(schema);
  const short = fieldsOf(schema).filter((f) => ['text', 'number', 'integer', 'boolean', 'choice', 'list'].includes(f.kind));
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

/**
 * The records that could be added pointing at a record of this collection:
 * every collection declaring a link whose target includes it. A poll's page
 * offers "Add vote" because `app.poll.vote` declares `about → app.poll`.
 *
 * The protocol's own annotations are left out — reactions and comments get
 * their own place on every record.
 */
export function attachable(collections: ReadonlyArray<NodeCollection>, target: string): ReadonlyArray<{ collection: NodeCollection; rel: string }> {
  const found: Array<{ collection: NodeCollection; rel: string }> = [];
  for (const collection of collections) {
    if (collection.builtIn || collection.schema === null) continue;
    for (const [rel, declaration] of Object.entries(collection.links)) {
      if (declaration.to === '*' || declaration.to.includes(target)) found.push({ collection, rel });
    }
  }
  return found;
}
