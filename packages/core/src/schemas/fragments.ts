/**
 * @module schemas/fragments
 * The pieces every standard definition builds its fields from. The stored
 * dialect has no `$ref`, so a time, an amount of money or a file is spelled
 * out in each definition that has one; building them here keeps them
 * identical everywhere, which is what lets definitions be compared.
 */
import type { JsonSchema } from '../schema/collection-def.js';
import type { LinkDeclaration } from '../records/links.js';
import type { DefineCollection } from '../node/types.js';
import type { Typed } from '../query/types.js';

/**
 * A definition that also carries its records' type, so querying or writing
 * with it is typed — `include: { votes: { rel: 'about', from: vote } }` gives
 * votes as `Vote`. The schemas here are plain JSON Schema, so the type is said
 * alongside rather than worked out.
 */
export const typed =
  <T>() =>
  <const C extends DefineCollection>(definition: C): C & Typed<T> =>
    definition;

const described = (schema: JsonSchema, description?: string): JsonSchema =>
  description ? { ...schema, description } : schema;

/** A string of at most `max` characters; `min` 1 for a field that can't be blank */
export const text = (max: number, description?: string, min?: number): JsonSchema =>
  described({ type: 'string', ...(min ? { minLength: min } : {}), maxLength: max }, description);

/** Plain text of 1 to `max` characters, for a field that must say something */
export const words = (max: number, description?: string): JsonSchema => text(max, description, 1);

/** Long text, CommonMark */
export const markdown = (max: number, description = 'CommonMark'): JsonSchema => text(max, description);

/**
 * A moment, RFC 3339 (`2026-03-01T18:30:00+01:00`), or a whole day,
 * `YYYY-MM-DD`. Unchecked until the dialect has `format`.
 */
export const when = (description?: string): JsonSchema =>
  text(64, description ?? 'RFC 3339 date-time, or YYYY-MM-DD for a whole day', 10);

/** A day, `YYYY-MM-DD` */
export const day = (description?: string): JsonSchema =>
  described({ type: 'string', minLength: 10, maxLength: 10 }, description ?? 'YYYY-MM-DD');

/** An IANA time zone, `Europe/Oslo` */
export const timeZone = (): JsonSchema => text(64, 'IANA time zone, like Europe/Oslo', 1);

/** A person, by their account DID */
export const person = (description?: string): JsonSchema => text(256, description ?? 'An account DID', 1);

/** Some people, by their account DIDs */
export const people = (max: number, description?: string): JsonSchema =>
  described({ type: 'array', items: person(), maxItems: max }, description);

/** A web address */
export const url = (description?: string): JsonSchema => text(2048, description, 1);

/**
 * An amount of money: a decimal string, never a float, so 0.1 + 0.2 is
 * nobody's problem, and an ISO 4217 currency code.
 */
export const money = (description?: string): JsonSchema =>
  described(
    {
      type: 'object',
      properties: {
        amount: text(32, 'A decimal string, like "12.50"', 1),
        currency: described({ type: 'string', minLength: 3, maxLength: 3 }, 'ISO 4217, like "EUR"'),
      },
      required: ['amount', 'currency'],
    },
    description,
  );

/** A postal address, in JSContact's parts */
export const address = (): JsonSchema => ({
  type: 'object',
  properties: {
    street: text(500),
    locality: text(200, 'Town or city'),
    region: text(200),
    postcode: text(32),
    country: text(2, 'ISO 3166-1 alpha-2, like "NO"', 2),
  },
});

/** Latitude and longitude in degrees, WGS 84 */
const latitude = (): JsonSchema => ({ type: 'number', minimum: -90, maximum: 90 });
const longitude = (): JsonSchema => ({ type: 'number', minimum: -180, maximum: 180 });

/** The fields of a place, for a definition that is one */
export const placeFields = (): Readonly<Record<string, JsonSchema>> => ({
  name: text(200),
  address: address(),
  lat: latitude(),
  lon: longitude(),
});

/** A place inside another record: a name, an address, a point */
export const placeRef = (description?: string): JsonSchema =>
  described({ type: 'object', properties: placeFields() }, description);

/** A point, for where someone is */
export const point = (): Readonly<Record<string, JsonSchema>> => ({ lat: latitude(), lon: longitude() });

/**
 * A file's bytes, by the SHA-256 of the bytes as stored (lower-case hex). How
 * bytes are stored and fetched is planned (05 §16.6); the reference is not.
 */
export const blob = (description?: string): JsonSchema =>
  described(
    {
      type: 'object',
      properties: {
        hash: described({ type: 'string', minLength: 64, maxLength: 64 }, 'SHA-256 of the bytes, hex'),
        size: { type: 'integer', minimum: 0 },
        mime: text(255, undefined, 1),
        name: text(255),
      },
      required: ['hash', 'size', 'mime'],
    },
    description,
  );

/** An image with its words for people who can't see it */
export const image = (): JsonSchema => ({
  type: 'object',
  properties: { blob: blob(), alt: text(2000, 'What it shows') },
  required: ['blob'],
});

/** Where a record goes in a hand-made order (see `positionBetween`) */
export const position = (description = 'Sorts where it goes'): JsonSchema => text(200, description, 1);

/** A whole number from `min` to `max` */
export const count = (min: number, max?: number, description?: string): JsonSchema =>
  described({ type: 'integer', minimum: min, ...(max !== undefined ? { maximum: max } : {}) }, description);

/** One of a fixed set of values */
export const choice = (values: ReadonlyArray<string>, description?: string): JsonSchema =>
  described({ enum: [...values] }, description);

/** A link to one record in any collection, for annotations */
export const about = (description: string): LinkDeclaration => ({ to: '*', cardinality: 'one', description });

/** A link to one record in the given collections */
export const one = (to: ReadonlyArray<string>, description: string): LinkDeclaration => ({
  to: [...to],
  cardinality: 'one',
  description,
});

/** Links to any number of records in the given collections */
export const many = (to: ReadonlyArray<string> | '*', description: string): LinkDeclaration => ({
  to: to === '*' ? '*' : [...to],
  cardinality: 'many',
  description,
});

/** Only its author changes it; its author or a moderator removes it */
export const authored = { edit: 'creator', delete: ['creator', 'can:moderate'] } as const;
/** Only its author changes or removes it */
export const own = { edit: 'creator', delete: 'creator' } as const;

/** Types for the fragments, as records carry them */
export interface Money {
  readonly amount: string;
  readonly currency: string;
}
export interface Address {
  readonly street?: string;
  readonly locality?: string;
  readonly region?: string;
  readonly postcode?: string;
  readonly country?: string;
}
export interface Place {
  readonly name?: string;
  readonly address?: Address;
  readonly lat?: number;
  readonly lon?: number;
}
export interface BlobRef {
  readonly hash: string;
  readonly size: number;
  readonly mime: string;
  readonly name?: string;
}
export interface ImageRef {
  readonly blob: BlobRef;
  readonly alt?: string;
}
