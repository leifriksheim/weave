# BLOCK-08 — Spaces that describe themselves

## What this delivers

A space carries its own vocabulary. Open one in an app that has never seen it
and you can ask what collections it holds, what shape their records are, and
render them — instead of finding `collection: "app.p2p-todo.item"` and having no
idea what that means.

Schemas stop being code the app happens to have and become data the space
happens to hold.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'registerCollection' src/schema/schema-engine.ts && \
grep -q 'queryExpressions' src/types.ts && \
grep -q 'createSpaceManager' src/space/space-manager.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — see below"
```

**If it prints NOT READY:** either the schema engine has moved, the storage
adapter no longer exposes `queryExpressions`, the space manager is gone, or the
project does not typecheck. Fix the typecheck first.

**Depends on no other block.** Free to start. BLOCK-09 depends on this one.

---

## The problem, concretely

`createSchemaEngine()` is a runtime registry. The example registers one
collection when it opens a space:

```ts
// example/src/space-session.ts
schemaEngine.registerCollection({ name: COLLECTION, schema: todoSchema });
```

Three things follow, and all of them undercut "apps are views on your data":

- `listCollections()` lists what **this app registered**, not what the space
  contains. It is a registry of the app's own assumptions.
- `queryExpressions(collection, …)` needs the name up front. There is no way to
  ask what is in here.
- The structural gate validates against whatever schema the running app
  supplied. Two apps can disagree about what `app.p2p-todo.item` means and both
  will happily report "valid".

A view needs to know what it is looking at. Right now a second app can read your
files but not your meaning.

## Why Standard Schema cannot simply be stored

`StandardSchemaV1` is a runtime interface — an object carrying a
`validate(value)` function. It is deliberately not serialisable. A Zod schema
cannot be written into a file and used by another app.

So this is not a matter of finding somewhere to put the existing thing. The
declarative form has to be a *different* representation, with Standard Schema
demoted to the adapter that runs it locally.

**JSON Schema** is the obvious choice: widely implemented, expresses what these
records need, and every language has a validator. The cost is that schemas can
only say what JSON Schema can say, which is shape and not much else — see
*Out of scope*.

---

## Files

| File | Change |
|---|---|
| `src/schema/collection-def.ts` | **New.** The stored shape, and its validator |
| `src/schema/json-schema.ts` | **New.** Thin wrapper over `@cfworker/json-schema` |
| `src/schema/schema-engine.ts` | Load definitions from a space; keep the runtime registry as an override |
| `src/space/space-catalog.ts` | **New.** Reading and writing definitions in a space |
| `src/storage/storage-provider.ts` | `listCollections()` over what is actually stored |
| `src/index.ts` | Exports |
| `tests/collection-def.test.ts` | **New** |
| `tests/space-catalog.test.ts` | **New** |
| `example/src/space-session.ts` | Publish the todo definition on first open |

### `src/schema/collection-def.ts`

What a space stores about a collection. Note it is a *record*, not a class — it
travels as an ordinary expression and is signed like anything else.

```ts
/** A collection, as a space describes it to whoever opens it. */
export interface StoredCollection {
  readonly name: string;            // 'app.p2p-todo.item'
  readonly title?: string;          // 'Todo'
  readonly description?: string;
  /** JSON Schema for the record body */
  readonly body: JsonSchema;
  /** Bumped when the shape changes; older records keep their version */
  readonly version: number;
}

/** The reserved collection that collection definitions live in. */
export const CATALOG_COLLECTION = 'sys.collection';
```

### `src/schema/json-schema.ts`

Use [`@cfworker/json-schema`](https://github.com/cfworker/cfworker/tree/main/packages/json-schema)
for validation — JSON Schema has a long tail of edge cases and a validator is a
solved problem (see `docs/DEPENDENCIES.md`). It has no dependencies and
interprets schemas rather than compiling them, so it works under a strict
Content Security Policy and inside extensions. Do **not** use Ajv: it generates
code with `new Function`, which a strict CSP forbids.

Still restrict what a *published* definition may use to the subset these
records need — `type`, `properties`, `required`, `items`, `enum`,
`minimum`/`maximum`, `minLength`/`maxLength` — so every app, in any language,
agrees on what a stored schema means. The subset is a rule about what spaces
contain, not about what the validator can do.

```ts
export interface JsonSchema { readonly [key: string]: unknown }

/** Validates a value, returning Standard Schema issues so gates are unchanged. */
export function validateJsonSchema(schema: JsonSchema, value: unknown): ReadonlyArray<StandardSchemaIssue>;

/** Wraps a JSON Schema as a Standard Schema, so existing callers do not change. */
export function asStandardSchema(schema: JsonSchema): StandardSchemaV1;
```

### `src/space/space-catalog.ts`

```ts
/** Reads every collection definition a space holds. */
export function readCatalog(storage: StorageProvider): Promise<ReadonlyArray<StoredCollection>>;

/** Publishes or updates one, as a signed expression in `sys.collection`. */
export function publishCollection(
  storage: StorageProvider,
  signer: Signer,
  key: CryptoKey,
  definition: StoredCollection,
): Promise<Expression>;
```

### `src/storage/storage-provider.ts`

```ts
/** Every collection that actually has records in this space. */
listCollections(): Promise<ReadonlyArray<{ name: string; count: number }>>;
```

This is the discovery half, and it is separate from the catalogue on purpose: a
space can hold records whose definition was never published, and an app should
be able to see that rather than pretend they do not exist.

---

## Steps

1. Write `json-schema.ts` and its tests first. Pure functions, no browser, no
   storage — get it green before anything depends on it.
2. Write `collection-def.ts`. It is types plus a validator for the stored shape.
3. Add `listCollections()` to the storage provider. The MST is keyed by
   expression id, so this walks keys and groups — fine at current scale, and
   BLOCK-09 adds the index that makes it cheap.
4. Write `space-catalog.ts`: read the catalogue, publish a definition.
5. Teach `schema-engine.ts` to take a catalogue: `fromCatalog(definitions)`
   builds a registry from stored definitions. Keep `registerCollection` as a
   local override, so an app can still supply a richer validator than JSON
   Schema can express.
6. In the example, publish the todo definition the first time a space is opened,
   and read the catalogue on open.
7. Show it: add a panel listing what the space says it holds.

---

## Testing

`tests/collection-def.test.ts`

- Every type in the supported subset validates and rejects correctly
- An unknown keyword is ignored rather than throwing — a space written by a
  newer app must stay readable
- `asStandardSchema` produces issues in the shape the structural gate expects

`tests/space-catalog.test.ts`

- A published definition round-trips through a space
- Publishing the same name twice supersedes rather than duplicating
- A definition is an ordinary expression: signed, and rejected by the crypto
  gate if tampered with
- `listCollections()` reports a collection with records but no definition
- Two spaces in one store do not see each other's catalogues

---

## Acceptance criteria

- [ ] Open a space in an app with no hardcoded schema, list its collections, and
      render records against the stored definition
- [ ] A record failing the stored schema is rejected by the structural gate
- [ ] A collection with records but no published definition still appears in
      `listCollections()`, marked as undescribed
- [ ] The catalogue syncs between peers like any other data
- [ ] The only new runtime dependency is `@cfworker/json-schema`, recorded in `docs/DEPENDENCIES.md`
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

**Semantics beyond shape.** Knowing a record is `{text, completed, order}` does
not tell a Kanban board it can render it, or how a card relates to a column.
That is relationships, and it is BLOCK-09.

**Schema migration.** `version` is recorded so a later block can act on it.
Records keep the version they were written under; nothing rewrites them.

**Cross-space schema references.** A definition describes records in its own
space. Sharing vocabularies between spaces needs a resolution story, and there
is no need for one yet.

---

## Gotchas

- **JSON Schema is a large specification and you want a small part of it.**
  Pick the subset, write it down in the module docstring, and reject the rest
  loudly at publish time rather than silently at validation time.
- **A space written by a newer app must stay readable.** An unknown keyword is
  ignored, not fatal. The alternative is that one app upgrading makes the space
  unopenable elsewhere.
- **The catalogue is data, so it is signed, and so it is attributable.** In a
  shared space, decide who may publish a definition — the capability gate
  already has the machinery, and an open space where anyone can redefine a
  collection is a way to make other people's records invalid.
- **Do not delete the runtime registry.** JSON Schema cannot express everything
  a Zod schema can, and an app that wants a stricter local check should still
  be able to have one.
