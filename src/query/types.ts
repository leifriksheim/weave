/**
 * @module query/types
 * A query is plain data: an object you could write by hand, send over a wire,
 * or have an agent produce. No parser, no language — filters borrow Mongo's
 * operators, relationships borrow the `include` map that Prisma, Mongoose and
 * Rails all use, and anything that serialises keeps working the day a daemon
 * answers queries instead of the tab.
 */
import type { NodeRecord } from '../node/types.js';

/** Predicates on one field. Absent operators do not constrain. */
export interface Operators {
  readonly $eq?: unknown;
  /** True for a missing field too — the one everybody gets wrong */
  readonly $ne?: unknown;
  readonly $gt?: number | string;
  readonly $gte?: number | string;
  readonly $lt?: number | string;
  readonly $lte?: number | string;
  readonly $in?: ReadonlyArray<unknown>;
  readonly $nin?: ReadonlyArray<unknown>;
  readonly $exists?: boolean;
  /** Case-insensitive substring of a text field, or an element of a list. Not search. */
  readonly $contains?: unknown;
}

/**
 * Field predicates, all of which must hold.
 *
 * A bare name is a field of the record's body — `done`, `address.city`. A
 * name starting with `@` is about the record itself: `@key`, `@author`,
 * `@root`, `@createdBy`, `@createdAt`, `@updatedAt`, `@seq`.
 */
export type Filter = {
  readonly [field: string]: unknown;
} & {
  readonly $and?: ReadonlyArray<Filter>;
  readonly $or?: ReadonlyArray<Filter>;
  readonly $not?: Filter;
};

/**
 * A collection, by name or by a reference that also carries its records'
 * type: a definition whose schema is a validator (a Zod object), a standard
 * one from `weave-protocol/schemas`, or a {@link Typed} name. Before a query
 * runs, every reference becomes its name — the query stays plain data.
 */
export type CollectionRef = string | { readonly name: string };

/**
 * A collection name that carries its records' type, for collections whose
 * schema is plain JSON Schema: `const todos: Typed<Todo> = { name: 'app.todo' }`.
 * The type is a promise you make, not something checked when reading.
 */
export interface Typed<T> {
  readonly name: string;
  readonly '~body'?: T;
}

/** A validator's output type, when it declares one (Standard Schema) */
type OutputOf<S> = S extends { readonly '~standard': { readonly types?: infer Types } }
  ? NonNullable<Types> extends { readonly output: infer O }
    ? O
    : unknown
  : unknown;

/**
 * The body type of a collection reference: declared with {@link Typed}, or
 * the output of its definition's validator. `unknown` for a bare name.
 */
export type BodyOf<C> = C extends { readonly '~body'?: infer T } ? (unknown extends T ? FromSchema<C> : T) : FromSchema<C>;
type FromSchema<C> = C extends { readonly schema: infer S } ? OutputOf<S> : unknown;

/**
 * What an `include` map finds for each record, typed from the query. A map
 * only known as "some includes" (a query built at run time) gives the loose
 * {@link AnyIncluded}.
 */
export type IncludedOf<I> = [I] extends [undefined]
  ? {}
  : string extends keyof NonNullable<I>
    ? AnyIncluded
    : {
        readonly [K in keyof NonNullable<I>]: NonNullable<I>[K] extends { readonly count: true }
          ? number
          : ReadonlyArray<
              QueryRecord<
                BodyOf<NonNullable<I>[K] extends { readonly from?: infer F } ? F : never>,
                IncludedOf<NonNullable<I>[K] extends { readonly include?: infer J } ? J : undefined>
              >
            >;
      };

/** What to pull in alongside each record, by following links. */
export interface Include {
  /** The link role: 'about', 'replyTo' */
  readonly rel: string;
  /** Only records in this collection — by name, or a reference that carries its type */
  readonly from?: CollectionRef;
  /** `in` (default): records linking *to* this one. `out`: records this one links to. */
  readonly direction?: 'in' | 'out';
  readonly where?: Filter;
  readonly include?: Readonly<Record<string, Include>>;
  readonly limit?: number;
  /** Just the number of them — the usual thing for reactions and votes */
  readonly count?: boolean;
}

export type SortDirection = 'asc' | 'desc';

export interface Query {
  /** By name, or a reference that carries its records' type (see {@link CollectionRef}) */
  readonly collection: CollectionRef;
  readonly where?: Filter;
  readonly include?: Readonly<Record<string, Include>>;
  /** Fields to sort by, in order: `{ done: 'asc', '@createdAt': 'desc' }`. Ties always break on the key. */
  readonly sort?: Readonly<Record<string, SortDirection>>;
  readonly limit?: number;
  /** From the previous page's `cursor` */
  readonly cursor?: string;
}

/** What an untyped query's `include` finds */
export type AnyIncluded = Readonly<Record<string, ReadonlyArray<QueryRecord> | number>>;

/**
 * A record a query found. Queries only return records this device can read,
 * so `body` is never null here.
 */
export interface QueryRecord<T = unknown, I = AnyIncluded> extends Omit<NodeRecord<T>, 'body'> {
  readonly body: T;
  /** What each `include` found: records, or a number when it asked for a count. Empty without `include`. */
  readonly included: I;
}

export interface QueryResult<T = unknown, I = AnyIncluded> {
  readonly records: ReadonlyArray<QueryRecord<T, I>>;
  /** Pass back as `cursor` for the next page; null when there is none */
  readonly cursor: string | null;
}

/** The result a query gives, typed from the query itself */
export type ResultOf<Q extends Query> = QueryResult<
  BodyOf<Q['collection']>,
  Q extends { readonly include: infer I } ? IncludedOf<I> : 'include' extends keyof Q ? AnyIncluded : {}
>;

/** The name a collection reference stands for */
export const nameOf = (ref: CollectionRef): string => (typeof ref === 'object' && ref !== null && typeof ref.name === 'string' ? ref.name : (ref as string));

/**
 * The query as plain data: every collection reference replaced by its name.
 * What runs, what is sent to an agent, and what is compared, is this.
 * Anything malformed is passed through untouched, for the checker to explain.
 */
export function plainQuery(query: Query): Query {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const includes = (map: unknown): unknown =>
    isObject(map)
      ? Object.fromEntries(
          Object.entries(map).map(([name, inc]) => [
            name,
            isObject(inc)
              ? { ...inc, ...(inc.from !== undefined ? { from: nameOf(inc.from as CollectionRef) } : {}), ...(inc.include !== undefined ? { include: includes(inc.include) } : {}) }
              : inc,
          ]),
        )
      : map;
  if (!isObject(query)) return query;
  return { ...query, collection: nameOf(query.collection), ...(query.include !== undefined ? { include: includes(query.include) as Query['include'] } : {}) };
}
