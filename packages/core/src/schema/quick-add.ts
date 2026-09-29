/**
 * What names a record, and what one line of text makes, worked out from a
 * collection's JSON Schema alone: for lists that add from a text box, and for
 * rules that add a record. Nothing here knows about any collection.
 */
import { isObject } from '../utils/guards.js';
import type { JsonSchema } from './collection-def.js';

/** Fields that usually name a record, in the order to try them */
const TITLE_NAMES = ['title', 'name', 'text', 'question', 'label', 'subject', 'emoji'];

const propertiesOf = (schema: JsonSchema | null): ReadonlyArray<[string, JsonSchema]> =>
  isObject(schema?.properties)
    ? Object.entries(schema.properties).map(([name, value]): [string, JsonSchema] => [
        name,
        isObject(value) ? value : {},
      ])
    : [];

const requiredOf = (schema: JsonSchema | null) =>
  new Set(Array.isArray(schema?.required) ? schema.required : []);

/** Free text: a string that isn't picked from choices */
const isText = (field: JsonSchema) =>
  field.type === 'string' &&
  !Array.isArray(field.enum) &&
  !Array.isArray(field.oneOf) &&
  !field['x-choicesFrom'];

/** The field that names a record: a conventional name, else the first required text, else the first text */
export function titleField(schema: JsonSchema | null): string | null {
  const text = propertiesOf(schema).filter(([, field]) => isText(field));
  const required = requiredOf(schema);
  return (
    TITLE_NAMES.find((name) => text.some(([field]) => field === name)) ??
    text.find(([name]) => required.has(name))?.[0] ??
    text[0]?.[0] ??
    null
  );
}

/** What a record is called, in a few words, from the field that names it */
export function recordTitle(
  record: { readonly key: string; readonly collection: string; readonly body: unknown },
  schema: JsonSchema | null,
): string {
  if (record.body === null) return '(cannot open)';
  const body = isObject(record.body) ? record.body : {};
  const field = titleField(schema) ?? TITLE_NAMES.find((name) => typeof body[name] === 'string');
  const value = field ? body[field] : undefined;
  if (typeof value === 'string' && value.trim()) return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return `${record.collection.split('.').pop()} ${record.key.slice(0, 6)}`;
}

/** A field's value before anyone fills it in, or undefined when it has none */
function emptyValue(field: JsonSchema): unknown {
  if (field.default !== undefined) return field.default;
  if (field.type === 'boolean') return false;
  if (field.type === 'array') return [];
  if (field.type === 'object' && isObject(field.properties))
    return Object.fromEntries(propertiesOf(field).map(([name, sub]) => [name, emptyValue(sub)]));
  return undefined;
}

/**
 * What one line of text makes: the field that names a record filled in, the
 * rest at their empty values. Null when something else is required that has
 * no sensible empty value; then a full form is the honest way in.
 */
export function quickAddBody(schema: JsonSchema | null, text: string): Record<string, unknown> | null {
  const title = titleField(schema);
  if (!title) return null;
  const required = requiredOf(schema);
  const body: Record<string, unknown> = { [title]: text };
  for (const [name, field] of propertiesOf(schema)) {
    if (name === title) continue;
    const empty = emptyValue(field);
    if (empty !== undefined) body[name] = empty;
    else if (required.has(name)) return null;
  }
  return body;
}
