/**
 * The kinds of field and link a person can pick when defining a
 * collection — shared by the form that makes one and the one that changes it.
 */
import type { JsonSchema } from 'weave-protocol';
import { kindOf } from './schema-ui';

export const FIELD_TYPES = {
  text: { type: 'string' },
  'long text': { type: 'string', maxLength: 10000 },
  number: { type: 'number' },
  'yes/no': { type: 'boolean' },
  'list of text': { type: 'array', items: { type: 'string' } },
  // Its options are typed in beside it; a field like this is what a board makes columns from.
  choice: { type: 'string' },
} as const;
export type FieldTypeName = keyof typeof FIELD_TYPES;

/** "To do, Doing, Done" → the three, trimmed, without blanks or repeats */
export const optionsOf = (text = '') => [...new Set(text.split(',').map((o) => o.trim()).filter(Boolean))];

/** A field's schema from a picked type, and for a choice, its options */
export function fieldSchema(type: FieldTypeName, options?: string): JsonSchema {
  return type === 'choice' ? { type: 'string', enum: optionsOf(options) } : { ...FIELD_TYPES[type] };
}

/** Which of the pickable types an existing field is, or null when it is something else (kept as it is) */
export function fieldTypeOf(schema: JsonSchema): FieldTypeName | null {
  switch (kindOf(schema)) {
    case 'text':
      return 'text';
    case 'longText':
      return 'long text';
    case 'number':
      return 'number';
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
  const words = text.trim().replace(/[^a-zA-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const joined = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
  return joined.replace(/^[^a-z]+/, '').slice(0, 64);
}
