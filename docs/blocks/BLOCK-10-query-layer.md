# BLOCK-10 — A query layer

> **Done (2026-09-23).** `src/query/` (types, filter, engine), exposed as
> `node.records.query(space, query)` and `node.records.watch(space, query, onResult)`,
> and as the `records_query` action — so the CLI, MCP and WebMCP get it too.
> Tests: `tests/query.test.ts`. The example's list is one query, with its 👍
> reactions pulled in through `include`; verified in two browsers.
>
> What changed from the plan below, now that BLOCK-09 and BLOCK-14 exist:
>
> - **It lives on the node, not the storage provider.** Filtering needs opened
>   records — decrypted, verified — which only the node has.
> - **`@` names are about the record, bare names are the body.** `@key`,
>   `@author`, `@root`, `@createdBy`, `@createdAt`, `@updatedAt`, `@seq`. So
>   `{ createdAt: … }` in a body never collides with the record's own. An
>   unknown `@` name is refused; an unknown body field simply matches nothing.
> - **Ties break on the record key**, not the version id — the key survives edits,
>   so a cursor (the last key of a page) stays valid when a record is ticked.
> - **`include` has `count: true`**, for reactions and votes; `from` is optional.
> - **Queries are checked before they run.** An unknown operator, a `$where`, or
>   includes nested past 3 are refused with a message saying what to fix.
> - **Links are sealed in private spaces** (BLOCK-09), so the gotcha below about
>   filtering links without decrypting holds for public spaces only.

## What this delivers

Filtering, sorting, paging and following links, in a shape TypeScript developers
already know. Today the whole query surface is:

```ts
queryExpressions(collection, limit, cursor)
```

Afterwards:

```ts
await query({
  collection: 'app.kanban.card',
  where: { archived: false, points: { $gte: 3 } },
  include: {
    reactions: { rel: 'about', from: 'sys.reaction' },
    comments: { rel: 'about', from: 'sys.comment', limit: 3 },
  },
  sort: { createdAt: 'desc' },
  limit: 50,
});
```

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'linked' src/storage/storage-provider.ts && \
grep -q 'findLinked' src/storage/link-index.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — needs BLOCK-09"
```

**Needs BLOCK-09.** `include` is a lookup in the link index, and without it every
expansion is a full scan. The `where`/`sort`/`limit` half works alone if you want
to start early, but the interesting half does not.

---

## Why not a query language

Every string-based option was considered and rejected, and the reasons are worth
keeping so nobody relitigates them at 2am:

| | Why not |
|---|---|
| **SQL** | Needs a parser, a planner and a join engine. Wrong shape: these are documents with one-hop links, not tables. |
| **GraphQL** | The *shape* is right — nested selection maps onto links beautifully — but the reference implementation is ~500KB and you own a parser. |
| **SPARQL / Cypher** | Graph languages for a system that deliberately is not a graph, and few people know them. |
| **Datalog** | Genuinely good at relationships, genuinely unfamiliar. |

And a general point: **the moment you have a parser you own a language.** You
will be answering questions about its semantics, its error messages and its edge
cases forever. A plain object has none of that, and serialises over the wire for
free — which matters the day a daemon answers queries instead of the tab.

## What to borrow instead

Two conventions, both already in everyone's hands:

**Filtering — Mongo/Mango operators.** `{ done: false, order: { $gt: 5 } }`. Used
by CouchDB's Mango, Minimongo, RxDB and a dozen others. JSON, no parser, and any
JavaScript developer reads it without being taught.

**Relationships — the `include` map.** Prisma's `include`, Mongoose's `populate`,
Rails' `includes`. Same idea everywhere: name the thing, say where it comes from,
get it nested in the result.

Neither is novel. The composition is the point.

---

## Files

| File | Change |
|---|---|
| `src/query/types.ts` | **New.** `Query`, `Filter`, `Include`, `Result` |
| `src/query/filter.ts` | **New.** The operators, as pure functions |
| `src/query/engine.ts` | **New.** Narrow, filter, expand |
| `src/storage/storage-provider.ts` | `query()`, and `subscribe()` |
| `src/index.ts` | Exports |
| `tests/query-filter.test.ts` | **New** |
| `tests/query-engine.test.ts` | **New** |

### `src/query/types.ts`

```ts
export interface Query {
  readonly collection: string;
  readonly where?: Filter;
  readonly include?: Readonly<Record<string, Include>>;
  readonly sort?: Readonly<Record<string, 'asc' | 'desc'>>;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Field predicates over the record body, plus the author and timestamps. */
export type Filter = {
  readonly [field: string]: unknown | Operators;
} & {
  readonly $and?: ReadonlyArray<Filter>;
  readonly $or?: ReadonlyArray<Filter>;
  readonly $not?: Filter;
};

export interface Operators {
  readonly $eq?: unknown;
  readonly $ne?: unknown;
  readonly $gt?: number | string;
  readonly $gte?: number | string;
  readonly $lt?: number | string;
  readonly $lte?: number | string;
  readonly $in?: ReadonlyArray<unknown>;
  readonly $nin?: ReadonlyArray<unknown>;
  readonly $exists?: boolean;
  /** Case-insensitive substring. Not search — see Out of scope. */
  readonly $contains?: string;
}

/** What to pull in alongside each record. */
export interface Include {
  readonly rel: string;
  /** The collection on the other end */
  readonly from: string;
  /** `in` follows links pointing *at* this record; `out` follows its own */
  readonly direction?: 'in' | 'out';
  readonly where?: Filter;
  readonly include?: Readonly<Record<string, Include>>;
  readonly limit?: number;
}
```

### `src/query/engine.ts`

Three steps, and deliberately no planner:

1. **Narrow** by collection, which is already indexed.
2. **Filter** in memory. A browser holds a replica, not a warehouse; at the
   scale this runs at, an optimiser would be more code than it saves.
3. **Expand** each `include` through the link index — one lookup per record per
   include, which is why this block needs BLOCK-09.

```ts
export function runQuery(storage: StorageProvider, query: Query): Promise<QueryResult>;
```

### Live queries

The reason to do this at all rather than filtering in the app: data arrives by
sync, so a query that re-runs when its inputs change is what every screen
actually wants.

```ts
subscribe(query: Query, onChange: (result: QueryResult) => void): () => void;
```

The first version can re-run the whole query on any change to the space — correct,
and fast enough at this scale. Narrowing it to "did this change touch the
collections this query reads" is an obvious later improvement and should not hold
up the first one.

---

## Steps

1. `filter.ts` and its tests first. Pure functions over plain values, no storage,
   no async — get every operator green before anything depends on them.
2. `types.ts`, then `engine.ts` with `where`/`sort`/`limit`/`cursor` only.
3. Add `include`, one level. Test it against the link index in both directions.
4. Allow nested `include`, with a depth cap — see *Gotchas*.
5. Add `subscribe`, re-running on any change to the space.
6. Move the example's todo list onto it, and add reaction counts through
   `include` to prove the expansion works end to end.

---

## Testing

`tests/query-filter.test.ts`

- Each operator, including against a missing field — `$ne` on an absent field is
  the one everybody gets wrong
- `$and` / `$or` / `$not`, nested
- Dotted paths into nested body objects
- A filter naming an unknown field matches nothing rather than throwing

`tests/query-engine.test.ts`

- `where` + `sort` + `limit` + `cursor` page without overlap or gaps
- `include` pulls linked records in both directions
- An `include` whose target is not held locally yields an empty list, not an error
- Nested `include` stops at the depth cap
- `subscribe` fires on a write and stops after unsubscribing

---

## Acceptance criteria

- [ ] The example's list renders from `query()` rather than `queryExpressions()`
- [ ] Reaction counts come through `include`, with no second round trip
- [ ] A query written as JSON survives `JSON.stringify` and back
- [ ] Sorting and paging are stable across peers holding the same data
- [ ] Zero new dependencies
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

**Full-text search.** `$contains` is a substring scan. It is honest at browser
scale and it is not search: no ranking, no stemming, no prefix index. Real search
needs an inverted index — a third MST keyed by token — and that is its own block.
Do not let `$contains` quietly become the search feature.

**Multi-hop traversal.** `include` follows one link per level and nests, which
covers what these apps do. Pattern matching across arbitrary paths is a different
tool; the link index is the substrate for it if it is ever needed.

**Aggregation.** Counts fall out of `include`, and `$sum`/`$group` do not. Add
them when something needs them.

---

## Gotchas

- **Sort has to be total, or paging breaks.** Two records with the same
  `createdAt` on two peers can come back in different orders and a cursor will
  skip or repeat. Always break ties on the expression id, which is a content
  hash and therefore stable everywhere.
- **Nested `include` is where a query gets expensive.** Each level multiplies
  lookups. Cap the depth — three is generous — and make exceeding it an error
  rather than something that quietly takes a second.
- **Filtering happens after decryption.** In a private space, records have to be
  opened before `where` can look at them, so a narrow filter over a big space is
  not cheap. Links are outside the body and can be filtered without decrypting,
  which is worth knowing when designing a screen.
- **Keep queries plain data.** No functions in a `Filter`, ever. The day a daemon
  answers queries, anything that serialises keeps working and anything that does
  not has to be rewritten.
