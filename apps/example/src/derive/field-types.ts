/**
 * The kinds of field and link a person can pick when defining a
 * collection — shared by the form that makes one and the one that changes it,
 * and by everything that reads a field back: the record form, and the
 * builders for notifications and rules.
 *
 * Dates, people and web addresses have no type of their own in JSON Schema:
 * they are strings, spelled the way the standard library's fragments spell
 * them, so a field made here and one from `std.*` read back the same.
 */
import type { JsonSchema } from '@weaveprotocol/core';
import { fragments } from '@weaveprotocol/core/schemas';
import { isObject, kindOf } from './schema-ui';

export const FIELD_TYPES = {
  text: { type: 'string' },
  'long text': { type: 'string', maxLength: 10000 },
  number: { type: 'number' },
  'whole number': { type: 'integer' },
  'yes/no': { type: 'boolean' },
  // Its options are typed in beside it; a field like this is what a board makes columns from.
  choice: { type: 'string' },
  date: fragments.when(),
  person: fragments.person(),
  people: fragments.people(64),
  'web link': fragments.url('A web address'),
  'list of text': { type: 'array', items: { type: 'string' } },
} as const satisfies Record<string, JsonSchema>;
export type FieldTypeName = keyof typeof FIELD_TYPES;

/** How each type is offered: a mark, and a few words on what it is for */
export const FIELD_TYPE_INFO: Readonly<Record<FieldTypeName, { mark: string; hint: string }>> = {
  text: { mark: 'Aa', hint: 'A name, a title, a short answer' },
  'long text': { mark: '¶', hint: 'Notes, a description, a story' },
  number: { mark: '#', hint: 'An amount, a score, a price' },
  'whole number': { mark: '123', hint: 'A count, a rank, a quantity' },
  'yes/no': { mark: '✓', hint: 'Done or not, going or not' },
  choice: { mark: '◉', hint: 'One of a few options you list' },
  date: { mark: '▦', hint: 'A day, or a day and a time' },
  person: { mark: '☺', hint: 'Someone in the space' },
  people: { mark: '☺☺', hint: 'Some of the people in the space' },
  'web link': { mark: '↗', hint: 'An address on the web' },
  'list of text': { mark: '≡', hint: 'Several short bits of text' },
};

export function isFieldType(name: string): name is FieldTypeName {
  return Object.hasOwn(FIELD_TYPES, name);
}

/** A field's schema from a picked type, and for a choice, its options */
export function fieldSchema(type: FieldTypeName, options: ReadonlyArray<string> = []): JsonSchema {
  return type === 'choice' ? { type: 'string', enum: [...options] } : structuredClone(FIELD_TYPES[type]);
}

/** A string holding an account's DID, as `fragments.person` writes one */
function isPersonSchema(schema: JsonSchema): boolean {
  if (schema.type !== 'string' || schema.maxLength !== 256 || schema.minLength !== 1) return false;
  const description = typeof schema.description === 'string' ? schema.description : '';
  return /^(An account DID|Who|Whose|A person)\b/.test(description);
}

/** Which of the pickable types an existing field is, or null when it is something else (kept as it is) */
export function fieldTypeOf(schema: JsonSchema): FieldTypeName | null {
  if (isPersonSchema(schema)) return 'person';
  if (schema.type === 'array' && isObject(schema.items) && isPersonSchema(schema.items)) return 'people';
  if (
    schema.type === 'string' &&
    schema.minLength === 10 &&
    (schema.maxLength === 64 || schema.maxLength === 10)
  )
    return 'date';
  if (schema.type === 'string' && schema.maxLength === 2048 && !Array.isArray(schema.enum)) return 'web link';
  switch (kindOf(schema)) {
    case 'text':
      return 'text';
    case 'longText':
      return 'long text';
    case 'number':
      return 'number';
    case 'integer':
      return 'whole number';
    case 'boolean':
      return 'yes/no';
    case 'list':
      return 'list of text';
    case 'choice':
      return Array.isArray(schema.enum) ? 'choice' : null;
    default:
      return null;
  }
}

/** "Due date" → "dueDate": what a field is stored as, from what a person calls it */
export function fieldNameFrom(label: string): string {
  const words = label
    .trim()
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const joined = words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join('');
  return joined.replace(/^[^a-zA-Z]+/, '').slice(0, 64);
}

/** Kinds of link most records need, each with a word on what it means */
export const SUGGESTED_LINKS: ReadonlyArray<{ rel: string; description: string }> = [
  { rel: 'about', description: 'What this is about' },
  { rel: 'in', description: 'Where this belongs' },
  { rel: 'partOf', description: 'The bigger record this is part of' },
  { rel: 'relatedTo', description: 'Something related' },
  { rel: 'blocks', description: "What can't go ahead until this is done" },
  { rel: 'dependsOn', description: 'What has to happen first' },
];

/** "part of" → "partOf": link names are one lower camel case word */
export function relFrom(text: string): string {
  return fieldNameFrom(text).replace(/^[^a-z]+/, '');
}
