# BLOCK-14 — Records with a stable key, ordered versions, and history on request

> **Done (2026-09-23).** `src/records/version.ts` (the rule), the `r/` `g/` `h/`
> tree in `src/storage/storage-provider.ts`, keyed records throughout the node.
> Tests: `tests/versions.test.ts` (order-independence over every permutation,
> replay, delete-stays-deleted, 1,000 edits → 2 stored, verifiable retained
> chain, concurrent edits converging) and the existing suites, moved onto keys.
> Verified in two browsers: a member ticks another's todo and both see one
> ticked todo; the full two-person, same-account and name flows pass.
>
> Where the build differs from the plan below:
>
> - **The catalogue always retains its versions** (`collection:<name>`, with
>   `retain` on every version). The fold must judge each version by its author
>   — creator or owner — and can only do that with the versions still held.
> - **`put` on a deleted key writes its next version**, so it comes back; `put`
>   on a live key is refused ("update it instead").
> - **Sync cost at N = 10,000** with one differing record rose from 25 KB to
>   47 KB (at N = 1,000 it fell, 22 KB → 8.7 KB): the tree now holds keys and
>   version ids rather than one id twice, which changes its shape. Still inside
>   BLOCK-01's 50 KB bound and still flat in N.
> - **Only display order uses `createdAt`** — lists, space order. Nothing that
>   decides a winner does.

## What this delivers

A record keeps its identity when it changes. Ticking a todo writes a new
**version** of the same record — same `key`, next `seq`, a hash link to the
version it replaces — instead of today's "write a new record, delete the old
one". Every device agrees which version is current without trusting anyone's
clock, a replayed old version can never roll a record back, and a space stores
the current state rather than every edit ever made, unless a collection asks
for its history to be kept.

Links (BLOCK-09), queries (BLOCK-10) and the "one per person" fold (BLOCK-11)
all need this: a comment on a todo must not disappear when the todo is ticked.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'TOMBSTONE_COLLECTION' src/node/space-runtime.ts && \
grep -q 'collectReachableCids' src/storage/mst.ts && \
grep -q 'missingKeys' src/sync/anti-entropy.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — needs the Node API (BLOCK-13) and the tree-walk sync (BLOCK-01)"
```

**Depends on BLOCK-13 and BLOCK-01**, both done. **Do it before BLOCK-09**, so
links point at keys from the start.

---

## Why: what is wrong today

An update is two records: the new body, and a `sys.tombstone` naming the old
one. That is the worst of both worlds:

| | Today |
|---|---|
| **Identity** | The id changes on every edit. Anything pointing at the old id is left pointing at a deleted record. |
| **Storage** | Every version is kept, plus a tombstone per edit — the space grows with activity. |
| **Order** | Nothing links a version to the one before it. "Which is newer" falls back on `createdAt`. |
| **History** | Present, but as an unconnected pile, not a chain anyone can follow. |

And `createdAt` cannot be trusted. It is whatever the writer put there; the
capability gate only refuses times more than five minutes in the future. A
member with a fast clock — or one who sets every edit five minutes ahead — wins
every conflict that is decided by time. Today time decides list order, which
collection definition wins, and which profile name wins.

## The design, and why this one

Two designs were weighed (see the discussion that led here):

- **Replace in place** (Bluesky, Nostr): one version per record. No bloat, and a
  new device downloads only current state — but ordering by timestamp is
  forgeable, and a late-arriving old version can roll a record back.
- **Full hash chain** (Holochain, git): every version kept and linked. Order you
  can prove — but the space grows with every edit forever, a new device
  downloads everything, and nothing can ever be taken back.

The insight: **trustworthy ordering does not need the history kept, only
carried.** Each version records its own place in the order, and storage keeps
the current one.

### The fields

Four signed fields on every record, outside `body` (so they are part of the
signature, and a peer without the space key can still order versions it
relays):

```ts
export interface Expression<T = unknown> {
  // …existing: id, author, collection, space, createdAt, body, proof, signature
  /** The record's identity, stable across versions. Links point here. */
  readonly key: string;
  /** 0 for the first version; each later version is one more than the one it replaces */
  readonly seq: number;
  /** Hash (id) of the version this one replaces. Absent on seq 0. */
  readonly prev?: string;
  /** Hash (id) of the record's first version — who created it. Absent on seq 0. */
  readonly genesis?: string;
  /** Keep this version after it is superseded. Set by the writer; see "History". */
  readonly retain?: true;
  /** This version deletes the record. Body is empty. */
  readonly deleted?: true;
}
```

### The ordering rule

For two versions of one key: **higher `seq` wins; on a tie, the lower `id`
wins.** Every node applies it to the same data and gets the same answer.
`createdAt` decides nothing — it is shown to people, never compared.

What that buys, concretely:

- **Replays are harmless.** An old version is still validly signed, but its
  `seq` is lower than the current one's. It loses, and is discarded.
- **Deletes stay deleted.** A delete is a version with a higher `seq`. An old
  version turning up from an offline device loses to it.
- **Clocks do not matter.** A version dated next week with `seq: 3` loses to one
  dated last year with `seq: 4`.
- **Concurrent edits converge.** Two devices editing the same record while apart
  both write `seq: n+1`. The tie goes to the lower id — on every device. The
  next edit (`seq: n+2`, with `prev` naming the winner) moves on from there.

**What it deliberately does not stop:** a member claiming `seq: 1000000` to win
the next tie. They could equally have just edited the record — they are allowed
to write. Protecting records from members you let in is a *permission* question
(see Out of scope: creator-only editing), not an ordering one.

### Keys

- Random, 128 bits, base32 — created when the record is: `newRecordKey()`.
  Random rather than time-based, so a key reveals nothing about when.
- Or chosen, for records that are singletons by nature — the charset
  `[a-z0-9:._-]`, at most 128 characters: the account profile is key `profile`, a
  collection definition is `collection:app.todo.item`, a registry membership is
  `space:<id>`.
- Unique within a space. A key belongs to one collection for life: a later
  version in a different collection is invalid.

### Storage and the tree

The Merkle tree maps **keys to version ids** instead of ids to themselves:

```
r/<key>          → id of the current version      (every record)
g/<key>          → id of seq 0                     (only once the record has been edited)
h/<key>/<seq>/<id> → id                            (superseded versions marked `retain`)
```

- When a version arrives, compare it with the one at `r/<key>` using the rule.
  The winner goes to `r/<key>`; the loser's body is dropped from the expression
  store — **unless it is seq 0** (kept, under `g/`, as proof of who created the
  record) **or marked `retain`** (kept, under `h/`, as history).
- A record never edited costs one entry: `r/` points at seq 0 and no `g/` is
  needed.
- Delete markers (`deleted: true`) stay at `r/<key>` for good. They are a few
  hundred bytes; dropping them would let an old device resurrect the record.
  Compacting them away after a horizon is BLOCK-03's business, not this one's.

### History is chosen by the writer, not the reader

A collection definition (BLOCK-08) gains `history: 'latest' | 'all'`, default
`latest`. The writing app reads it and sets `retain: true` on versions of
collections that keep history.

**It must be a signed flag on each version, not a local decision.** If each
node decided from its own copy of the collection definition, two nodes that
had seen different definitions would store different `h/` entries, their trees
would differ, and sync would never converge. A flag on the version means every
node keeps exactly the same things.

With `history: 'all'`, the `prev` links make a record's history a verifiable
chain: `records.history(space, key)` returns the versions newest first, and
anyone can check each one's signature and its link to the one before.

### Sync

Today a walk asks "do I have this key?" — a key and its value were the same id.
Now two peers can hold the **same key with different values**:

- `missingKeys` becomes `differingEntries`: for each `(key, value)` in a remote
  node, look up the local value (`lookupInMST`); if it is absent or different,
  fetch the remote version.
- An arriving version goes through the gates as today, then through the
  ordering rule. The losing side of a disagreement fetches the winner and keeps
  it; the winning side fetches the loser, sees it lose, and drops it. Both end
  with the same tree.
- BLOCK-01's property holds: identical subtrees are still skipped, so cost still
  follows the difference.

### Validation

A new check, as part of the structural gate — it looks at one version alone,
which is what a gate may do (BLOCK-11):

- `key` well-formed; `seq` an integer ≥ 0
- `seq === 0` ⇔ no `prev` and no `genesis`
- `seq > 0` ⇒ `prev` and `genesis` present, and different from the version's own id
- `deleted` ⇒ empty body

What it must **not** check at sync time: that `prev` exists, that `seq` is
exactly `prev.seq + 1`, or that the key's collection matches its earlier
versions. Each depends on what else a node happens to hold, and a check that
depends on that makes nodes disagree forever. They are applied when folding —
a version whose collection differs from the genesis's is ignored on read — so
the result is the same everywhere once the data is.

### Access and privacy

- **Who may write a version** is unchanged: the capability gate — the owner in a
  personal space, anyone invited in a shared one. Editing and deleting are
  writing.
- **Visible to non-members:** `key`, `seq`, `prev`, `genesis`, `deleted`,
  `retain` are outside the encrypted body, as `collection` and `author` already
  are. Someone relaying a private space learns how many records it has and how
  often each is edited — not what they say. Worth stating in the README.

---

## API changes

```ts
node.records.put(space, collection, body, { key? })  → NodeRecord   // seq 0
node.records.get(space, key)                          → NodeRecord | null   // current, or null if deleted
node.records.update(space, key, body)                 → NodeRecord   // next seq, same key
node.records.delete(space, key)                       → void         // a deleted version
node.records.history(space, key)                      → NodeRecord[] // what is retained, newest first
node.records.list(space, options)                     → NodeRecord[] // current versions only
```

`NodeRecord` gains `key`, `seq`, `version` (the id of this version), and
`createdBy` (the root that wrote seq 0, when held). `id` is removed in favour of
`key` + `version` — two names for two different things.

Actions follow: `records_get/update/delete` take `key`; `records_history` is new.

### What moves onto keys

| Today | Becomes |
|---|---|
| `sys.tombstone` + new record on update | Next version of the same key — `sys.tombstone` is deleted |
| Account profile: newest `createdAt` wins | Key `profile`; ordering rule |
| Registry membership + tombstone on leave | Key `space:<id>`; leaving is a delete version, rejoining the next seq |
| Collection definition: highest `version`, then time | Key `collection:<name>`; ordering rule. "First definer or owner may redefine" becomes "`createdBy` of the key, or the owner". |
| List order by `createdAt` | Still `createdAt` of seq 0, for display — it decides nothing. |

---

## Files

| File | Change |
|---|---|
| `src/types.ts` | `key`, `seq`, `prev`, `genesis`, `retain`, `deleted` on `Expression` / `UnsignedExpression` |
| `src/schema/expression.ts` | `createExpression` takes them; canonicalised with the rest, so signed |
| `src/records/version.ts` | **New.** `newRecordKey`, `nextVersion(current)`, `compareVersions(a, b)`, `checkVersionShape(e)` — pure |
| `src/storage/storage-provider.ts` | `applyVersion(e)` replaces `addExpression`: the rule, `r/` `g/` `h/`, dropping losers. `getCurrent(key)`, `history(key)`, `listCurrent(collection?)` |
| `src/sync/anti-entropy.ts`, `sync-engine.ts` | `differingEntries`; admit through `applyVersion` |
| `src/validation/structural-gate.ts` | The version-shape check |
| `src/schema/collection-def.ts` | `history?: 'latest' \| 'all'` |
| `src/node/space-runtime.ts` | Records by key; drop tombstones; set `retain` from the definition; fold ignores versions whose collection differs from genesis |
| `src/node/node.ts`, `types.ts`, `actions.ts` | API above |
| `src/space/account-registry.ts` | Profile and memberships as keyed records |
| `src/node/copy.ts` | Copies `r/`, `g/`, `h/` — the union rule still holds: the ordering rule decides each key |
| `example/src/space-session.ts` | Todos by key; toggle is `update` |
| `tests/versions.test.ts` | **New** |

---

## Steps

1. `src/records/version.ts` and its tests first — pure functions, no storage.
   Get the ordering rule right in isolation, including the tie.
2. The new fields on `Expression`, signed. Old-shape records are not supported
   (nothing is released; there is nothing to migrate).
3. `applyVersion` in the storage provider, with the `r/` `g/` `h/` layout and
   loser-dropping. Test it without sync: apply versions in every order, assert
   the same tree root.
4. The version-shape check in the structural gate.
5. Sync: `differingEntries`, admission through `applyVersion`. Re-run
   `tests/anti-entropy.test.ts` and the BLOCK-01 harness — cost must still
   follow the difference.
6. The node: records by key, `update` as next version, `delete` as a deleted
   version, `history`. Remove `sys.tombstone` and `putSystem`'s tombstone path.
7. Move profile, memberships and collection definitions onto keys.
8. `retain` from `history: 'all'`; `records.history`.
9. The example: todos by key. The toggle bug of 2026-09-23 cannot recur by
   construction — there is no second record to leave behind.
10. Update the README's record model and the privacy note.

---

## Testing

`tests/versions.test.ts`

- The rule: higher `seq` wins; equal `seq` → lower id; `createdAt` never matters
  (a version dated a year ahead with lower `seq` loses)
- **Order-independence:** apply the same set of versions in every permutation —
  identical root every time
- **Replay:** after `seq: 3`, re-applying `seq: 1` changes nothing
- **Delete stays deleted:** delete at `seq: 4`, then an offline device's
  `seq: 2` arrives — still deleted
- **Concurrent edits:** two nodes each write `seq: 1` while apart → after sync
  both show the same winner; the next edit from either continues from it
- **Storage:** 1,000 edits of one record with `history: 'latest'` → one current
  version plus genesis stored, not 1,000
- **History:** the same with `history: 'all'` → 1,000 versions, each `prev`
  linking to the one before, every signature valid
- **Two nodes, different definitions:** one has seen `history: 'all'`, the other
  not — their trees are still identical (the `retain` flag, not the definition,
  decides)
- A key reused in another collection is ignored on read
- The shape check rejects `seq: 0` with a `prev`, `seq: 2` without `genesis`, a
  `deleted` version with a body

Existing suites must pass after being moved onto keys — `tests/sync.test.ts`
and `tests/anti-entropy.test.ts` are the correctness net.

---

## Acceptance criteria

- [ ] Ticking a todo keeps its `key`; nothing named by the key breaks
- [ ] A replayed old version never changes the current one
- [ ] A clock set ahead cannot win: ordering uses `seq` and id only
- [ ] Two devices editing the same record apart converge on the same version
- [ ] A space with `history: 'latest'` stores current state, not every edit
- [ ] A space with `history: 'all'` returns a verifiable chain through `records.history`
- [ ] Peers that have seen different collection definitions still converge
- [ ] `sys.tombstone` is gone; deletes are versions
- [ ] BLOCK-01's cost-follows-difference numbers still hold
- [ ] Example verified in two browsers: tick, untick, delete, from both sides
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

**Creator-only editing.** `edit: 'creator'` in a collection definition —
versions from anyone but `createdBy` ignored on read. Needs the genesis to be
present before a version can be judged, so it belongs in the fold, not a gate.
The fields here make it possible; build it when a collection needs it.

**Merging rather than picking.** Two concurrent versions: one wins, the other
is dropped (or kept under `h/` if retained). A version listing *both* as `prev`
— a merge, as in git — is a natural extension of `prev` to a list. Not needed
for todos.

**Field-level or character-level co-editing.** CRDTs (Automerge, Yjs) for
collaborative text. A later body type for collections that want it; it sits on
top of this.

**Per-author chains** (Holochain's source chain): proof that a peer is not
withholding an author's records. Breaks with several devices per account;
per-device, as its own layer, if ever.

**Delete-marker compaction.** Kept forever here. Dropping them safely needs a
horizon every peer respects — BLOCK-03.

---

## Gotchas

- **The ordering rule is load-bearing forever.** Changing it — even the
  tiebreak direction — makes nodes on two versions of the code disagree about
  which version is current. Pin it with tests on fixed inputs, as the DID
  derivation is pinned.
- **Never compare `createdAt`.** It is tempting in a sort, a fold, a "newest"
  helper. Every such comparison is a place a skewed or dishonest clock wins.
  Grep for it at the end.
- **Do not let local knowledge decide what is stored in the tree.** The
  `retain` flag exists because of this; the same trap waits for any "keep it
  if the definition says so" shortcut.
- **Deleted is not absent.** `get` returns null for both, but the tree must keep
  the delete marker, or the record comes back.
- **A key is not a secret.** Keys appear outside the encrypted body. Do not put
  meaning in a chosen key of a private space that its members would not want a
  relay to see (`space:<id>` and `profile` are fine; `diagnosis:…` is not).
- **`seq` inflation is allowed, and fine.** Resist adding a "must be exactly
  prev + 1" check at sync time — see Validation for why it would split nodes.
