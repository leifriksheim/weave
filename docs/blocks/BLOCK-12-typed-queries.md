# BLOCK-12 — Typed queries

## What this delivers

Autocomplete for collection names, field paths and operators, and a result type
that knows what you included:

```ts
const cards = await db.query({
  collection: 'app.kanban.card',        // ← completes from your collections
  where: { archived: false },           // ← keys completed, values checked
  include: {
    reactions: { rel: 'about', from: 'sys.reaction' },
  },
});

cards[0].body.points;                   // number
cards[0].reactions[0].body.emoji;       // string
cards[0].reactions[0].body.nope;        // ✗ compile error
```

No code generation and no build step. The types come from the same schemas the
runtime already validates with.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'readonly input: Input' src/types.ts && \
grep -q 'runQuery' src/query/engine.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — needs BLOCK-10"
```

**Needs BLOCK-10.** This is a typed surface over the query engine; there has to
be an engine.

---

## Why this is cheap

`StandardSchemaV1` already carries a phantom `types` slot:

```ts
readonly types?: { readonly input: Input; readonly output: Output };
```

Zod, Valibot and ArkType all populate it. So the static type of a record is
already sitting in the schema the app registered — it has just never been read.
One conditional type turns a schema into the type it validates:

```ts
export type Infer<S> = S extends StandardSchemaV1<unknown, infer Out> ? Out : never;
```

Everything else in this block is arranging that.

---

## The shape

```ts
export const collections = defineCollections({
  'app.kanban.card': cardSchema,     // any Standard Schema validator
  'sys.reaction': reactionSchema,
});

const db = createClient(storage, collections);
```

`defineCollections` does nothing at runtime beyond freezing the map. Its whole
job is preserving literal key types so `keyof` gives the collection names rather
than `string`.

### What has to be typed, and how

**Collection names.** `keyof Collections`. Free.

**Field paths in `where`.** `keyof Body`, plus dotted paths into nested objects.
A recursive conditional type produces `"a" | "a.b" | "a.b.c"` — real, and where
the compile-time cost lives. See *Gotchas*.

**Operator values.** `Operators<T>` parameterised by the field's type, so
`$gte` on a `string` field takes a string and `$in` takes an array of the field's
type.

**The result of `include`.** The valuable one, and a mapped type over the
include map:

```ts
type Result<C extends keyof Collections, I> =
  Expression<Infer<Collections[C]>> & {
    readonly [K in keyof I]: I[K] extends { from: infer F extends keyof Collections }
      ? ReadonlyArray<Result<F, I[K] extends { include: infer N } ? N : {}>>
      : never;
  };
```

Recursive, and TypeScript handles it — this is the same trick Prisma uses for
`include`. It is also the part that will make error messages ugly when it goes
wrong, which is the main reason to keep the depth cap from BLOCK-10 tight.

---

## Files

| File | Change |
|---|---|
| `src/query/infer.ts` | **New.** `Infer`, `Paths`, `Operators<T>`, `Result` |
| `src/query/client.ts` | **New.** `defineCollections`, `createClient` |
| `src/index.ts` | Exports |
| `tests/typed-query.test-d.ts` | **New.** Type-level tests |
| `example/src/collections.ts` | **New.** The example's collections in one place |
| `example/src/space-session.ts` | Use the typed client |

### Type-level tests

These assert on types rather than values, so they need a runner that typechecks
rather than executes. `tsd` is the usual choice; a dependency-free version is a
file of `expectType` helpers that fails `tsc` when wrong:

```ts
/** Fails to compile unless the two types are identical. */
export type Expect<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _text: Expect<typeof card.body.text, string> = true;
```

Ugly, zero dependencies, and it fails in CI on `npx tsc --noEmit`, which is where
it needs to fail.

---

## Steps

1. `infer.ts`, starting with `Infer` and `Operators<T>`. Test each with `Expect`
   before building on them.
2. `Paths<T>` with a depth cap. Start at 3 and only raise it if something real
   needs more.
3. `defineCollections` and `createClient`, typed `query()` delegating straight to
   `runQuery`. No runtime behaviour changes.
4. The `Result` mapped type, one level of `include` first, then nested.
5. Move the example onto it and delete the hand-written `Todo` interface — if it
   is still needed, the inference is not working.

---

## Acceptance criteria

- [ ] A misspelled collection name is a compile error
- [ ] A field not in the schema is a compile error in `where`
- [ ] `$gte: 'x'` on a numeric field is a compile error
- [ ] `include` results are typed without annotation
- [ ] The example has no hand-written record interfaces left
- [ ] Zero new runtime dependencies
- [ ] `npx tsc --noEmit` clean, and completes in a sane time — see *Gotchas*

---

## Out of scope

**Code generation from a space.** BLOCK-08 stores JSON Schema in the space, so a
CLI could read one and emit a `.d.ts` — Prisma's model. That is genuinely useful
for an app opening a space it did not create, and it needs a build step, a CLI
and a story for schemas changing underneath you. Worth its own block if anyone
asks for it.

**Typed link roles.** `rel: 'about'` could be checked against the collection's
declared links. Doable with the same machinery; left out to keep the first
version's type errors readable.

---

## Gotchas

- **Types are a belief, not the truth.** The space's stored catalogue is what
  records were actually validated against. If an app's TypeScript disagrees, it
  compiles and then fails at runtime. Worth a dev-time check comparing the
  declared schemas against the space's catalogue and warning on divergence —
  cheap, and it turns a confusing runtime failure into a startup warning.
- **Recursive conditional types get expensive.** `Paths<T>` over a deep object
  can multiply out badly, and a slow editor is a worse outcome than a missing
  completion. Cap the depth, measure `tsc` before and after, and treat a large
  regression as a bug in this block rather than a cost of doing business.
- **Error messages degrade fast.** When a deep `include` fails to match,
  TypeScript prints the whole expanded type. Keep the nesting cap low and give
  the common mistakes their own overloads where it helps.
- **`defineCollections` must not widen.** Without `as const` semantics on the
  keys, `keyof` gives `string` and every completion disappears. Get this right
  first — everything else depends on it.
