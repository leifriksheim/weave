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

/** What to pull in alongside each record, by following links. */
export interface Include {
  /** The link role: 'about', 'replyTo' */
  readonly rel: string;
  /** Only records in this collection */
  readonly from?: string;
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
  readonly collection: string;
  readonly where?: Filter;
  readonly include?: Readonly<Record<string, Include>>;
  /** Fields to sort by, in order: `{ done: 'asc', '@createdAt': 'desc' }`. Ties always break on the key. */
  readonly sort?: Readonly<Record<string, SortDirection>>;
  readonly limit?: number;
  /** From the previous page's `cursor` */
  readonly cursor?: string;
}

export interface QueryRecord<T = unknown> extends NodeRecord<T> {
  /** What each `include` found: records, or a number when it asked for a count */
  readonly included?: Readonly<Record<string, ReadonlyArray<QueryRecord> | number>>;
}

export interface QueryResult<T = unknown> {
  readonly records: ReadonlyArray<QueryRecord<T>>;
  /** Pass back as `cursor` for the next page; null when there is none */
  readonly cursor: string | null;
}
