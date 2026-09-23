/**
 * @module collection-def
 * Collections a space describes itself, as data.
 *
 * `StandardSchemaV1` is a runtime object carrying a function — it cannot be
 * written into a space and read by another app. So a space stores **JSON
 * Schema**, and Standard Schema becomes the adapter that runs it locally.
 *
 * Only a small, fixed subset may be *published*, so every app in any language
 * agrees on what a stored schema means:
 *
 *   type · properties · required · items · enum · minimum · maximum ·
 *   minLength · maxLength · additionalProperties (boolean) · title · description
 *
 * Anything else is refused at publish time — loudly, where the author can fix
 * it. At validation time unknown keywords are ignored instead, so a space
 * written by a newer app that allows more stays readable by an older one.
 */
import { Validator } from '@cfworker/json-schema';
import type { StandardSchemaV1 } from '../types.js';

export type JsonSchema = { readonly [keyword: string]: unknown };

/** A collection, as a space describes it to whoever opens it. */
export interface StoredCollection {
  /** Reverse-DNS, like `app.todo.item`. `sys.*` is the protocol's own. */
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** JSON Schema for a record's body */
  readonly schema: JsonSchema;
  /** Bumped when the shape changes; records keep the version they were written under */
  readonly version: number;
  /**
   * Whether edits to its records keep old versions. `latest` (the default)
   * keeps current state only; `all` keeps every version, hash-linked, as a
   * verifiable history. Read by writers, who mark each version accordingly.
   */
  readonly history?: 'latest' | 'all';
}

/** The reserved collection that collection definitions live in. */
export const CATALOG_COLLECTION = 'sys.collection';

const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'additionalProperties',
  'title',
  'description',
]);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/**
 * Why a schema may not be published, or null when it may.
 * @param schema The candidate schema
 * @param path Where in the schema, for the message
 */
export function checkPublishableSchema(schema: unknown, path = 'schema'): string | null {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return `${path} must be an object`;
  for (const [keyword, value] of Object.entries(schema)) {
    const at = `${path}.${keyword}`;
    if (!KEYWORDS.has(keyword)) {
      return `${at} is not supported. Stored schemas may use: ${[...KEYWORDS].join(', ')}`;
    }
    switch (keyword) {
      case 'type': {
        const types = Array.isArray(value) ? value : [value];
        if (types.length === 0 || !types.every((t) => typeof t === 'string' && TYPES.has(t))) {
          return `${at} must be one of ${[...TYPES].join(', ')}`;
        }
        break;
      }
      case 'properties': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${at} must be an object`;
        for (const [property, sub] of Object.entries(value)) {
          const problem = checkPublishableSchema(sub, `${at}.${property}`);
          if (problem) return problem;
        }
        break;
      }
      case 'items': {
        const problem = checkPublishableSchema(value, at);
        if (problem) return problem;
        break;
      }
      case 'required':
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return `${at} must be a list of property names`;
        break;
      case 'enum':
        if (!Array.isArray(value) || value.length === 0) return `${at} must be a non-empty list`;
        break;
      case 'minimum':
      case 'maximum':
      case 'minLength':
      case 'maxLength':
        if (typeof value !== 'number' || !Number.isFinite(value)) return `${at} must be a number`;
        break;
      case 'additionalProperties':
        if (typeof value !== 'boolean') return `${at} must be true or false`;
        break;
      case 'title':
      case 'description':
        if (typeof value !== 'string') return `${at} must be text`;
        break;
    }
  }
  return null;
}

/**
 * Why a definition may not be published, or null when it may.
 */
export function checkStoredCollection(definition: unknown): string | null {
  const d = definition as Partial<StoredCollection> | null;
  if (typeof d !== 'object' || d === null) return 'A collection definition must be an object';
  if (typeof d.name !== 'string' || !NAME.test(d.name)) {
    return 'name must be reverse-DNS, lower case, with at least one dot — e.g. "app.todo.item"';
  }
  if (d.name.startsWith('sys.')) return '"sys.*" collections belong to the protocol';
  if (!Number.isInteger(d.version) || (d.version as number) < 1) return 'version must be a whole number from 1';
  if (d.title !== undefined && typeof d.title !== 'string') return 'title must be text';
  if (d.description !== undefined && typeof d.description !== 'string') return 'description must be text';
  if (d.history !== undefined && d.history !== 'latest' && d.history !== 'all') return 'history must be "latest" or "all"';
  return checkPublishableSchema(d.schema);
}

export interface SchemaIssue {
  /** Where in the value, as a JSON pointer: `/items/0/text` */
  readonly path: string;
  readonly message: string;
}

/**
 * Validates a value against a stored schema.
 * @returns The issues; empty when it conforms
 */
export function validateJsonSchema(schema: JsonSchema, value: unknown): ReadonlyArray<SchemaIssue> {
  const result = new Validator(schema as never, '2020-12', false).validate(value);
  if (result.valid) return [];
  // The validator reports the wrapping keywords too ("properties" failed
  // because "text" did); the leaves are the useful part.
  const leaves = result.errors.filter((error) => error.keyword !== 'properties' && error.keyword !== 'items');
  return (leaves.length ? leaves : result.errors).map((error) => ({
    path: error.instanceLocation.replace(/^#/, '') || '/',
    message: error.error,
  }));
}

/** Wraps a stored schema as a Standard Schema, so gates and engines take it unchanged. */
export function asStandardSchema(schema: JsonSchema): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'p2p-web/json-schema',
      validate(value: unknown) {
        const issues = validateJsonSchema(schema, value);
        return issues.length
          ? { issues: issues.map((issue) => ({ message: issue.path === '/' ? issue.message : `${issue.path}: ${issue.message}` })) }
          : { value };
      },
    },
  };
}
