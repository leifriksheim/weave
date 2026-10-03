/**
 * The pieces every standard definition builds its fields from. The stored
 * dialect has no `$ref`, so a time, an amount of money or a file is spelled
 * out in each definition that has one; building them here keeps them
 * identical everywhere, which is what lets definitions be compared.
 */
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

/**
 * A record body's type, worked out from its JSON Schema: what the standard
 * definitions are built from, so each is written once.
 */
export type SchemaBody<S> = S extends { readonly enum: ReadonlyArray<infer E> }
  ? E
  : S extends { readonly type: 'string' }
    ? string
    : S extends { readonly type: 'integer' | 'number' }
      ? number
      : S extends { readonly type: 'boolean' }
        ? boolean
        : S extends { readonly type: 'array'; readonly items: infer I }
          ? ReadonlyArray<SchemaBody<I>>
          : S extends { readonly type: 'object'; readonly properties: infer P }
            ? Fields<P, RequiredOf<S>>
            : S extends { readonly type: 'object' }
              ? { readonly [key: string]: unknown }
              : unknown;
type RequiredOf<S> = S extends { readonly required: ReadonlyArray<infer R> } ? R : never;
type Fields<P, R> = Flat<
  { readonly [K in keyof P as K extends R ? K : never]: SchemaBody<P[K]> } & {
    readonly [K in keyof P as K extends R ? never : K]?: SchemaBody<P[K]>;
  }
>;
type Flat<T> = { [K in keyof T]: T[K] } & {};

/** A definition whose records' type is worked out from its schema */
export const define = <const C extends DefineCollection>(definition: C): C & Typed<SchemaBody<C['schema']>> =>
  definition;

const described = <S extends object>(schema: S, description?: string): S =>
  description ? { ...schema, description } : schema;

/** A string of at most `max` characters; `min` 1 for a field that can't be blank */
export const text = (max: number, description?: string, min?: number) =>
  described({ type: 'string' as const, ...(min ? { minLength: min } : {}), maxLength: max }, description);

/** Plain text of 1 to `max` characters, for a field that must say something */
export const words = (max: number, description?: string) => text(max, description, 1);

/** Long text, CommonMark */
export const markdown = (max: number, description = 'CommonMark') => text(max, description);

/**
 * A moment, RFC 3339 (`2026-03-01T18:30:00+01:00`), or a whole day,
 * `YYYY-MM-DD`. Unchecked until the dialect has `format`.
 */
export const when = (description?: string) =>
  text(64, description ?? 'RFC 3339 date-time, or YYYY-MM-DD for a whole day', 10);

/** A day, `YYYY-MM-DD` */
export const day = (description?: string) =>
  described({ type: 'string' as const, minLength: 10, maxLength: 10 }, description ?? 'YYYY-MM-DD');

/** An IANA time zone, `Europe/Oslo` */
export const timeZone = () => text(64, 'IANA time zone, like Europe/Oslo', 1);

/** A person, by their account DID */
export const person = (description?: string) => text(256, description ?? 'An account DID', 1);

/** Some people, by their account DIDs */
export const people = (max: number, description?: string) =>
  described({ type: 'array' as const, items: person(), maxItems: max }, description);

/** A web address */
export const url = (description?: string) => text(2048, description, 1);

/**
 * An amount of money: a decimal string, never a float, so 0.1 + 0.2 is
 * nobody's problem, and an ISO 4217 currency code.
 */
export const money = (description?: string) =>
  described(
    {
      type: 'object' as const,
      properties: {
        amount: text(32, 'A decimal string, like "12.50"', 1),
        currency: described({ type: 'string' as const, minLength: 3, maxLength: 3 }, 'ISO 4217, like "EUR"'),
      },
      required: ['amount', 'currency'] as const,
    },
    description,
  );

/** A postal address, in JSContact's parts */
export const address = () => ({
  type: 'object' as const,
  properties: {
    street: text(500),
    locality: text(200, 'Town or city'),
    region: text(200),
    postcode: text(32),
    country: text(2, 'ISO 3166-1 alpha-2, like "NO"', 2),
  },
});

/** Latitude and longitude in degrees, WGS 84 */
const latitude = () => ({ type: 'number' as const, minimum: -90, maximum: 90 });
const longitude = () => ({ type: 'number' as const, minimum: -180, maximum: 180 });

/** The fields of a place, for a definition that is one */
export const placeFields = () => ({
  name: text(200),
  address: address(),
  lat: latitude(),
  lon: longitude(),
});

/** A place inside another record: a name, an address, a point */
export const placeRef = (description?: string) =>
  described({ type: 'object' as const, properties: placeFields() }, description);

/** A point, for where someone is */
export const point = () => ({ lat: latitude(), lon: longitude() });

/**
 * A file's bytes, by the SHA-256 of the bytes as stored (lower-case hex). How
 * bytes are stored and fetched is planned (05 §16.6); the reference is not.
 */
export const blob = (description?: string) =>
  described(
    {
      type: 'object' as const,
      properties: {
        hash: described(
          { type: 'string' as const, minLength: 64, maxLength: 64 },
          'SHA-256 of the bytes, hex',
        ),
        size: { type: 'integer' as const, minimum: 0 },
        mime: text(255, undefined, 1),
        name: text(255),
      },
      required: ['hash', 'size', 'mime'] as const,
    },
    description,
  );

/** An image with its words for people who can't see it */
export const image = () => ({
  type: 'object' as const,
  properties: { blob: blob(), alt: text(2000, 'What it shows') },
  required: ['blob'] as const,
});

/** Where a record goes in a hand-made order (see `positionBetween`) */
export const position = (description = 'Sorts where it goes') => text(200, description, 1);

/** A whole number from `min` to `max` */
export const count = (min: number, max?: number, description?: string) =>
  described(
    { type: 'integer' as const, minimum: min, ...(max !== undefined ? { maximum: max } : {}) },
    description,
  );

/** One of a fixed set of values */
export const choice = <const V extends ReadonlyArray<string>>(values: V, description?: string) =>
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
