# BLOCK-09 — Links, and an annotation library

## What this delivers

One expression can point at another, in a named role, and you can ask what
points at a thing. Plus five collections shipped with the protocol — reactions,
comments, tags, attachments, references — so **every app gets reactions and
comments on every other app's data without anyone agreeing on anything**.

A reaction written by a chat app lands on a Kanban card, because both understand
`sys.reaction` and neither had to know about the other.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'readonly proof' src/types.ts && \
grep -q 'insertIntoMST' src/storage/mst.ts && \
grep -q 'createStructuralGate' src/validation/structural-gate.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — see below"
```

**Needs BLOCK-08** for the part that declares which links a collection may have.
The link field, the index and the `sys.*` collections all work without it — you
just cannot *check* that a card points at a column rather than at a todo. Start
here if you want the mechanism sooner; do BLOCK-08 first if you want it
enforced.

---

## The design, and why it is not a graph

The thing every one of these apps needs is *"this expression is about that one,
in a named role"*:

- a reaction is about one post
- a comment is about one thing, and maybe replies to another
- a card is in one column
- a tag is about many things

The subject is **always the expression doing the pointing**. That is not a
general graph — it is a link with a role, which is a much smaller thing. No
triples, no subject-predicate-object, nobody has to think in RDF.

### Strict nouns, polymorphic annotations

The rule that makes this work, and the one to hold onto when it is tempting to
generalise:

> A Kanban card is a Kanban card, not a generic Task. A reaction attaches to
> anything.

Polymorphism is almost never wanted for **nouns** — nobody wants their card
silently appearing in a todo app, and a subject class per overlapping concept is
how that ends up happening. It is almost always wanted for **annotations** — a
reaction that only worked on posts would be useless.

So nouns declare exactly what they point at. Annotations declare `"*"`, and that
escape hatch is deliberate, visible and rare.

---

## Files

| File | Change |
|---|---|
| `src/types.ts` | `links` on `Expression` and `UnsignedExpression` |
| `src/schema/expression.ts` | Links are canonicalised, so they are signed |
| `src/storage/link-index.ts` | **New.** The reverse index |
| `src/storage/storage-provider.ts` | Maintain the index; add `linked()` |
| `src/validation/structural-gate.ts` | Check links against the declared shape |
| `src/schema/collections/` | **New.** The `sys.*` library |
| `src/index.ts` | Exports |
| `tests/links.test.ts` | **New** |
| `tests/link-index.test.ts` | **New** |

### `src/types.ts`

```ts
/** What an expression is about. Signed along with the rest. */
export interface Link {
  /** The role, from the collection's declaration: 'about', 'in', 'replyTo' */
  readonly rel: string;
  /** The expression it points at */
  readonly to: string;
}

export interface Expression<T = unknown> {
  // …existing fields…
  readonly links?: ReadonlyArray<Link>;
}
```

Outside `body` on purpose — see *Gotchas*, because that choice has a cost.

### `src/storage/link-index.ts`

A second MST, keyed so that "everything pointing at X" is one prefix scan:

```
<to>|<rel>|<from>   →   <from>
```

```ts
export function indexLink(adapter, root, link, from): Promise<string>;
export function unindexLink(adapter, root, link, from): Promise<string>;
export function findLinked(adapter, root, to, rel?): Promise<ReadonlyArray<string>>;
```

It syncs, validates and merges exactly like the expression tree, because it is
the same structure — so this costs a second root pointer and no new machinery.

### `src/storage/storage-provider.ts`

```ts
/** Expressions pointing at this one, optionally in one role. */
linked(to: string, rel?: string): Promise<ReadonlyArray<Expression>>;
```

`addExpression` and `removeExpression` maintain the index. Keep both roots in
one place so a reconcile cannot leave them disagreeing.

### `src/schema/collections/`

The library. Small, and that is the point:

```ts
sys.reaction    { emoji: string }                      about → *
sys.comment     { text: string }                       about → *, replyTo → sys.comment
sys.tag         { label: string }                      about → *
sys.attachment  { name, mime, blob }                   about → *
sys.reference   { note?: string }                      about → *, to → *
```

Ship them as `StoredCollection` values (BLOCK-08's shape) so an app can publish
them into a space with one call, and so they are described by the same mechanism
as everything else rather than being special.

---

## Steps

1. Add `Link` and the `links` field. Make sure `canonicalize` includes it —
   an unsigned link is a link anyone can add to someone else's record.
2. Write `link-index.ts` against the memory adapter. Pure tree work, testable
   without a browser.
3. Wire it into the storage provider, both directions, and make the root
   pointers move together.
4. Add `linked()` and test one hop in both directions.
5. Extend the structural gate: when the collection declares `links`, check
   `rel` is known and the target's collection is allowed. **When the target is
   not held locally, pass** — see *Gotchas*.
6. Write the `sys.*` definitions and publish them alongside a space's own.
7. Show it: reactions on todos in the example, and a count that does not require
   decrypting anything.

---

## Testing

`tests/links.test.ts`

- Links are part of the signature: adding one to a signed expression invalidates it
- A link to a collection the definition does not allow is rejected
- A link to an expression not held locally is accepted — this is normal in a P2P
  system and must not be treated as invalid
- `"*"` accepts any target

`tests/link-index.test.ts`

- `findLinked` returns everything pointing at a target, filtered by `rel`
- Removing an expression removes its links from the index
- Two expressions pointing at the same target both appear
- Index and expression roots stay consistent across a reconcile
- Order-independence: the same links inserted in any order give the same root

---

## Acceptance criteria

- [ ] React to a todo; the reaction is an ordinary signed expression in `sys.reaction`
- [ ] `linked(todoId, 'about')` returns it
- [ ] A second app that knows nothing of todos can list and render reactions on them
- [ ] A reaction arriving before its target is kept, not rejected
- [ ] Deleting a todo leaves no dangling index entries
- [ ] The index syncs between peers
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

**Multi-hop traversal.** Every query these apps run is one hop from a node you
already have. If something later needs pattern matching, the index is the
substrate for it — but do not build a query language on speculation.

**Cardinality enforcement.** Declarations can say `"one"`, and nothing should
enforce it yet: in a P2P system two devices will legitimately write a second
`in` link before they meet, and the resolution is a merge question, not a
validation one.

**Cross-space links.** A link names a CID, which could live anywhere. Resolving
one into another space needs a fetching story. Leave it undefined rather than
half-working.

---

## Gotchas

- **Links outside `body` are readable when the body is not.** That is useful —
  count reactions on a private list without decrypting — and it is a leak: the
  shape of a private space becomes visible. How many comments, what is attached
  to what, who reacted. Make it a per-space choice rather than deciding for
  everyone, and decide before anyone has data.
- **Referential integrity has to be soft.** You will routinely hold a reaction
  before its post. A link to something absent is normal, not invalid. A gate
  that rejects it will quietly drop half the annotations on a slow sync.
- **The index is derived, so it must be rebuildable.** Follow the folder
  adapter's rule: the expression files are the truth, the index is a cache over
  them. A reconcile should be able to throw the index away and rebuild it.
- **Do not let `sys.*` grow.** Five collections cover the annotation layer of
  nearly every app. The sixth will be somebody's noun wearing a disguise, and
  once one is in, the argument against the seventh is gone.
