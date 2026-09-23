# BLOCK-11 — Constraints, and where they can actually live

## What this delivers

"One reaction per person", "one vote per member", "one profile per author" — the
family of rules that say *at most one of these per something*. Declared in the
collection definition, applied where they can actually work, and honest about
where they cannot.

Plus the thing that makes it correct: a deterministic fold, so every peer picks
the same winner without talking to any other peer.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'links' src/types.ts && \
grep -q 'StoredCollection' src/schema/collection-def.ts && \
grep -q 'createStatefulGate' src/validation/stateful-gate.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — needs BLOCK-08 and BLOCK-09"
```

**Needs BLOCK-08** (somewhere to declare the constraint) **and BLOCK-09** (links,
because almost every constraint worth having is scoped by one).

---

## Start here: it cannot be enforced

This is the part to internalise before writing any code, because the obvious
design is wrong and it fails quietly.

Alice reacts 👍 on her laptop. Alice reacts ❤️ on her phone. The two devices have
not spoken. **Both writes are valid where they happen** — neither device can see
the other's. They merge, and now there are two reactions from one person.

No validation rule prevents this. The conflict is not created by a bad write, it
is created by the partition. Preventing it would need a node that can see every
write before it happens, which is the thing this protocol is built not to have.

So the line to draw, and it is a clean one:

> A gate can enforce anything checkable from **one expression plus its proof
> chain** — its shape, its signature, whether its author was allowed. It cannot
> enforce anything over a **set**, because no node ever holds the whole set.

Structural, crypto and capability are all in the first category, which is why
they work. Uniqueness is in the second.

### The rule that makes it worse

It is tempting to have the stateful gate reject a reaction when it already holds
one from that author. **Do not do this on incoming expressions.**

A peer that rejects on sync throws away data the other peer kept. The two never
converge, and which one "wins" depends on who synced first — so the same account
sees different results on different devices, permanently. A uniqueness check that
rejects is worse than no check at all.

---

## What to do instead

Move the rule from write time to read time, and make the read deterministic.

| Where | What happens |
|---|---|
| **Local write** | Supersede your own previous one. Covers changing your mind on one device, which is the common case, with no machinery. |
| **Sync** | Accept everything. Always. |
| **Read** | Fold duplicates by a rule every peer applies identically. |

Because the fold is deterministic, every peer shows the same single reaction
without any of them coordinating. The duplicate still exists in the data; it just
never reaches a screen.

### Declaring it

In the collection definition (BLOCK-08's `StoredCollection`):

```ts
export interface StoredCollection {
  // …name, body, links…

  /**
   * At most one record per distinct combination of these.
   *
   * Paths may name the author, or a link role. `['author', 'links.about']`
   * reads as: one per person, per thing reacted to.
   */
  readonly unique?: ReadonlyArray<string>;

  /**
   * Which one survives when there are several. Every peer must agree, so the
   * options are deliberately few and all deterministic.
   *
   * `last` — newest `createdAt`, ties broken by expression id
   * `first` — oldest, same tiebreak
   */
  readonly onConflict?: 'last' | 'first';
}
```

`sys.reaction` then declares:

```json
{ "name": "sys.reaction",
  "body": { "emoji": "string" },
  "links": { "about": { "to": "*", "cardinality": "one" } },
  "unique": ["author", "links.about"],
  "onConflict": "last" }
```

### The tiebreak is not optional

Two devices can write at the same millisecond, and clocks disagree anyway. So
`createdAt` alone is not a total order and two peers will pick differently.

**Always break ties on the expression id.** It is a content hash, so every peer
computes the same comparison from the same data, with no clock involved. This is
the same rule BLOCK-10 needs for stable paging, and for the same reason.

---

## Files

| File | Change |
|---|---|
| `src/schema/collection-def.ts` | `unique` and `onConflict` |
| `src/query/fold.ts` | **New.** The deterministic fold |
| `src/query/engine.ts` | Apply it to results and to `include` |
| `src/storage/storage-provider.ts` | Supersede on local write when declared |
| `src/validation/stateful-gate.ts` | Document that uniqueness is not its job |
| `tests/constraints.test.ts` | **New** |

### `src/query/fold.ts`

```ts
/** Groups by the unique key and keeps one, deterministically. */
export function foldUnique(
  expressions: ReadonlyArray<Expression>,
  unique: ReadonlyArray<string>,
  onConflict: 'last' | 'first',
): ReadonlyArray<Expression>;

/** The key a record falls under, or null when a path does not resolve. */
export function uniqueKey(expression: Expression, unique: ReadonlyArray<string>): string | null;
```

A record whose key cannot be computed — a missing link, say — is never folded
away. Dropping data because a path did not resolve is the same mistake as
rejecting on sync, in a quieter place.

---

## Steps

1. `fold.ts` and its tests first. Pure, synchronous, no storage.
2. Add `unique` / `onConflict` to the definition and its validator.
3. Apply the fold in the query engine, to top-level results and to each
   `include` — a reaction count that counts superseded reactions is the bug this
   block exists to prevent.
4. Supersede on local write: when a collection declares `unique` and this author
   already has a record with the same key **in this store**, remove it as part of
   the same write.
5. Add a note to the stateful gate saying what it is for, so the next person does
   not add a uniqueness check to it.
6. Show it: react twice in the example, see one reaction and one count.

---

## Testing

`tests/constraints.test.ts`

- Two reactions from one author on one target fold to one
- Two authors on one target both survive
- One author on two targets: both survive
- `last` and `first` pick opposite records from the same input
- **Same `createdAt`, different ids: every peer picks the same one.** Run the
  fold over both orderings of the same pair and assert the result matches.
- A record with an unresolvable key is kept, not dropped
- Writing twice locally leaves one record in the store
- A duplicate arriving by sync is **stored**, and folded only on read

The clock test is the one that matters. Build the fixture with identical
timestamps on purpose, because that is what two devices in a partition produce.

---

## Acceptance criteria

- [ ] Reacting twice on one device leaves one reaction
- [ ] Two devices reacting while apart both keep their write, and after syncing
      both show the same single reaction
- [ ] Nothing is rejected at sync time for uniqueness
- [ ] Counts through `include` reflect the fold
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

**Constraints needing global knowledge.** "At most 100 members", "this name is
taken" — nobody can check those without seeing everything. If one is genuinely
needed, it needs a designated authority for that operation, which is a different
design and should be argued for on its own terms rather than smuggled in here.

**Referential integrity.** A link to a record you do not hold stays valid — see
BLOCK-09. Uniqueness does not change that.

**Merging rather than picking.** `onConflict` chooses a winner; it does not
combine. Combining is a CRDT and belongs to whatever needs one.

---

## Gotchas

- **`onConflict: 'last'` means a duplicate from a peer with a fast clock wins.**
  There is no defence in a system with no shared clock. It is the right default
  because it matches what a person expects from "I changed my mind", and worth
  knowing when something surprising surfaces.
- **The superseded record is still there**, so it still syncs and still takes
  space. Garbage collecting it is BLOCK-03's problem, and doing it here would
  mean deleting data a peer has not folded yet.
- **A definition can change.** Adding `unique` to a collection with existing
  records suddenly hides some of them. That is probably what was wanted, but it
  should be a deliberate act, and the definition's `version` is there to make it
  visible.
- **Do not reach for the stateful gate.** It runs WebAssembly rules against one
  expression and the store it can see, which makes it exactly the wrong shape for
  this and exactly the tempting one.

---

## An alternative worth knowing about

The MST is keyed by expression id, which is a content hash — so two reactions
from one author land on two keys and both persist.

If a collection could declare its own key function, a reaction's MST key could be
`author|about|rel` instead. Then a second reaction **overwrites** the first in the
tree, and convergence becomes structural rather than a read-time concern.

It is tidier, and the cost is real: the MST stops being content-addressed, two
peers can hold different values at one key, and the merge needs the same
deterministic tiebreak anyway — so the fold does not go away, it moves. Worth
revisiting if read-time folding turns out to be a bottleneck, and not before.
