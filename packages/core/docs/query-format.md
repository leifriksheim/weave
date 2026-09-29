# The query format

A query is plain JSON data: it can be written by hand, sent over a wire, or
produced by an agent. It runs against the records one node holds of one space.

> Not protocol: peers never exchange queries, so another implementation may
> offer any query language, and a better one later is not a protocol change.
> Open, in [#28](https://github.com/leifriksheim/weave/issues/28): the
> interface another query language plugs into, which reports the collections
> it read so a cache ([holding part of a space](node.md#holding-part-of-a-space)) keeps them; and the
> small filter a screen's `weave.list(collection, { where })` takes (field
> equality and `link:<rel>`, `packages/core/src/schemas/screens.ts`), which
> apps that run [screens](apps-as-records.md#screens) have to agree on.

## Grammar

```
Query      = { "collection": CollName,
               ?"where":   Filter,
               ?"include": IncludeMap,
               ?"sort":    { *(Field: "asc" | "desc") },
               ?"limit":   Int≥0,
               ?"cursor":  string }

Filter     = { *( Field: Condition
                | "$and": [ *Filter ]
                | "$or":  [ *Filter ]
                | "$not": Filter ) }

Condition  = Operators          ; a non-empty object whose every member name starts with "$"
           | Value              ; anything else: deep equality

Operators  = { 1*( "$eq": Value | "$ne": Value
                 | "$gt": Value | "$gte": Value | "$lt": Value | "$lte": Value
                 | "$in": [ *Value ] | "$nin": [ *Value ]
                 | "$exists": boolean
                 | "$contains": Value ) }

Field      = MetaField | LinkField | BodyPath
MetaField  = "@key" | "@author" | "@root" | "@createdBy" | "@createdAt"
           | "@updatedAt" | "@seq" | "@collection"
LinkField  = "link:" rel                  ; rel as spec 02 §5.1
BodyPath   = segment *( "." segment )     ; not starting with "@", "$" or "link:"

IncludeMap = { *( Name: Include ) }
Include    = { "rel": string,
               ?"from":      CollName,
               ?"direction": "in" | "out",      ; default "in"
               ?"where":     Filter,
               ?"include":   IncludeMap,        ; nesting depth ≤ 3
               ?"limit":     Int≥0,
               ?"count":     boolean }
```

A query is refused, with a reason, before it runs if: it is not an object;
`collection` is missing or empty; a filter is not an object, or `$and`/`$or`
is not a list; a member name starts with `$` and is not `$and`, `$or` or
`$not`; a `@` field is not a MetaField; a `link:` field is not a LinkField; an operator object names an unknown
operator; an include lacks `rel`, has a non-string `from`, a bad `direction`,
or a non-integer or negative `limit`; includes nest more than 3 deep; a `sort`
direction is not `asc`/`desc` or names an unknown `@` field; `limit` is not a
non-negative integer; `cursor` is not a string.

_Implementation detail:_ the TypeScript API also accepts a definition object
as `collection` or `from`; it is replaced by its `name` before the query runs.

## Candidates

A query considers the **current, non-deleted** version of every record in
`collection` that stands ([spec 02 §9.5](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)) and whose body this node can read. Records it
cannot open are left out — here and in every include — so a result's `body` is
never `null`.

> **Planned: leaving out records that do not conform.** Records whose body or
> links do not fit the definition are kept and flagged ([spec 02 §9.6](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)), but queries,
> includes and counts use them like any other, so a tally can count a record
> the definition says is malformed. The plan: queries and includes leave out
> records with `conforms: false` unless the query asks for them (a new
> optional member, e.g. `"nonconforming": true`). Rules are already enforced
> on arrival ([spec 02 §9.4](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)), so this is about shape, not about who wrote it.

## Field values

| Field         | Value                                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@key`        | the record key                                                                                                                                                                                                                               |
| `@author`     | the DID that signed this version                                                                                                                                                                                                             |
| `@root`       | the account it acted for                                                                                                                                                                                                                     |
| `@createdBy`  | the root of the record's first version (or null)                                                                                                                                                                                             |
| `@createdAt`  | `createdAt` of the record's first version (the creator's clock)                                                                                                                                                                              |
| `@updatedAt`  | `createdAt` of this version                                                                                                                                                                                                                  |
| `@seq`        | `seq`                                                                                                                                                                                                                                        |
| `@collection` | `collection`                                                                                                                                                                                                                                 |
| `link:<rel>`  | the `to` of the record's first link with that `rel`, as checks' `link` and `onePer` read it; missing when it has none. `{ "link:channel": key }` finds a channel's messages, `{ "link:channel": { "$exists": false } }` those in no channel. |
| body path     | Walk the body: at each segment, the current value must be a non-null object or array, and the segment is a member name (or array index, as a string); otherwise the value is _missing_.                                                      |

## Operators

`value` is the field's value (possibly missing); `x` the operand. _Equal_
means deep equality: same JSON type; objects with the same member names
(order ignored) and equal values; arrays with equal elements in order.

| Operator                  | Holds when                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bare value `x`            | `value` equals `x`                                                                                                                                           |
| `$eq`                     | `value` equals `x`                                                                                                                                           |
| `$ne`                     | `value` does not equal `x` — **true for a missing field**                                                                                                    |
| `$gt` `$gte` `$lt` `$lte` | both are numbers, or both strings (compared by UTF-16 code units), and the comparison holds. Any other pairing, including missing, is false.                 |
| `$in`                     | `x` is a list containing an element equal to `value`                                                                                                         |
| `$nin`                    | `x` is a list containing no element equal to `value` (false if `x` is not a list)                                                                            |
| `$exists`                 | `(value is not missing) == x`. `null` exists.                                                                                                                |
| `$contains`               | `value` and `x` are strings and `lower(x)` is a substring of `lower(value)`; or `value` is a list with an element equal to `x`. Otherwise false. Not search. |

> **Planned: full-text search.** `$contains` scans every candidate, which is
> honest at browser scale but is not search. Ranking and prefix matching need
> an inverted index kept beside the records, and a query operator or member
> for it. Not designed. _Open:_ whether the index is a node's local business
> (specified here only as query syntax and result order) or something peers
> share; and, for private spaces, that the index holds plaintext and must be
> kept like the bodies it came from ([05](https://github.com/leifriksheim/weave/blob/main/spec/05-sync-and-storage.md)).

Several operators on one field must all hold; several fields in one filter
must all hold. `$and`: all subfilters hold; `$or`: at least one; `$not`: the
subfilter does not hold.

## Sort, limit and cursor

- `sort` is applied field by field in the **order the members appear** in the
  `sort` object (JSON member order is significant here). Default:
  `{ "@createdAt": "asc" }`.
- Values compare: missing or `null` first; two numbers numerically; two
  booleans `false < true`; anything else by their string forms. `desc`
  reverses a field's order (so missing sorts last).
- Ties always break on `@key`, ascending — a total order that is the same on
  every node holding the same records.
- `limit` takes at most that many records after the cursor; absent means all.
  There is no maximum.
- The result's `cursor` is the key of the last record returned when more
  records follow it, else `null`. Passing it back resumes after the record with
  that key in the re-sorted candidates.
- If no candidate has the cursor's key any more, the query is meant to resume
  from where that record would have been. _Open:_ how "where it
  would have been" is found once the record is gone.

> **Known defect:** when the cursor's key is gone, the reference starts again
> from the first record (`packages/core/src/query/engine.ts`), so a caller paging through
> sees records twice. A fix will resume after the cursor's position.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20).

## Include

For each record returned, each named include finds related records:

- `direction: "in"` (default): current, readable, non-deleted records that
  have a link `{ rel, to: <this record's key> }`, optionally only those in
  `from`; ordered by `@createdAt`, then `@key`.
- `direction: "out"`: this record's own links with that `rel`, in link order,
  each resolved to the target's current, readable, non-deleted version,
  optionally only those in `from`. A target not held finds nothing.

Then `where` filters them. With `count: true` the include's value is the
number found (after `where`, ignoring `limit`). Otherwise it is the first
`limit` of them (all when absent), each expanded by its own nested `include`.
Every returned record has an `included` object, empty when there were no
includes.

## Result

```json
{ "records": [ … ], "cursor": "mfrggzdfmztwq2lknnwg23tpoa", "complete": true }
```

`complete` is false only on a node that holds part of a space while a
collection the query needs is still arriving
([05 — Sync and storage](https://github.com/leifriksheim/weave/blob/main/spec/05-sync-and-storage.md)). The shape of each record
object is the node's record view ([06 — Nodes, sessions and apps](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).

_Source: `packages/core/src/query/types.ts`, `packages/core/src/query/filter.ts` (`checkQuery`, `matches`, `fieldValue`, `MAX_INCLUDE_DEPTH`), `packages/core/src/query/engine.ts` (`runQuery`, `sortRecords`, `expand`). Tests: `packages/core/tests/query.test.ts` (all; "link:<rel> is where the first link…" for link fields), `packages/core/tests/typed-query.test.ts`._
