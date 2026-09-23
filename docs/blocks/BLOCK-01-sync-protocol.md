# BLOCK-01 — Sync protocol: exchange subtree CIDs, not every key

> **Done (2026-09-23).** `src/sync/`. Tests: `tests/anti-entropy.test.ts`; the
> five tests in `tests/sync.test.ts` pass unmodified. Harness:
> `npx tsx tests/bench/sync-bench.ts`.
>
> | N | one entry differs, before | after | identical, after |
> |---:|---:|---:|---:|
> | 100 | 5.7 KB | 10.0 KB | 210 B, 1 round trip |
> | 1,000 | 51.3 KB | 22.3 KB | 210 B |
> | 10,000 | 508 KB | 24.8 KB | 210 B |
>
> Small spaces cost a little more than before, because both sides now walk;
> from about 500 entries up the new protocol wins, and its cost stays flat. A
> cold peer pulls 10,000 entries in 128 messages and converges exactly.
>
> Where the build differs from the plan below:
>
> - **"Already have it" means "part of my current tree"**, not `adapter.has()`.
>   A store keeps orphaned nodes from older versions; skipping a subtree because
>   an orphan shares its CID would miss entries. The walk takes the set of CIDs
>   reachable from the local root (`collectReachableCids`, exported from the MST
>   as BLOCK-03 wanted) once per walk.
> - **Requests carry an id**, echoed in the reply. Requests are served
>   concurrently, so replies arrive out of order even on an ordered channel.
> - **Both sides pull from one exchange**: the side answering a `sync-request`
>   starts its own walk too, so one message reconciles both directions.
> - **Only content-addressed nodes are served** — a requested key is sent only
>   if its bytes hash to it — and only requested records are accepted.
> - `findMissingExpressions` / `findLocalOnlyExpressions` and `remoteKeys` are
>   gone. The protocol is `v: 2`; other versions are dropped.
>
> Found on the way: **concurrent writes to one store lost entries from the
> tree** (each read the same root). Writes through `createStorageProvider` now
> take turns; regression test in `tests/anti-entropy.test.ts`.

## What this delivers

Two peers reconcile by comparing Merkle subtree CIDs and descending only where
they differ, instead of shipping their entire key list on every round. Sync cost
goes from O(total entries) to O(entries that actually differ).

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'readonly height: number' src/storage/mst.ts && \
node --import tsx --test tests/mst.test.ts >/dev/null 2>&1 && \
echo READY || echo "NOT READY — the MST rewrite is missing or its tests fail"
```

**If it prints NOT READY:** the MST rewrite this block builds on isn't in place.
Nothing else in this document will work — the whole design depends on subtree
CIDs being stable, which only a real tree gives you. Check `src/storage/mst.ts`
has a `height` field on `MSTNode`.

**Depends on no other block.** Free to start.

---

## Background: why this is worth doing

Measured on two peers with 10,000 expressions each, differing by nothing at all:

```
N        A.gets   A.getExpr   B.gets   B.puts   messages   wire
10000       663       10000    62606    52603          3   2.87 MB
```

2.87 MB crosses the wire and peer A performs 10,000 individual `getExpression`
calls — for a sync where the two peers might be identical. The cost is the same
whether one entry differs or all of them do.

The cause is in `src/sync/sync-engine.ts:117`:

```ts
case 'sync-request': {
  const hasChanges = compareRoots(localRoot, msg.rootCid);
  if (hasChanges) {
    const localKeys = await listMSTKeys(adapter, localRoot);   // ← every key, every time
    sendToPeer(peerId, encodeSyncMessage({
      type: 'sync-response', rootCid: localRoot, hasChanges: true, remoteKeys: localKeys
    }));
  }
```

`src/sync/anti-entropy.ts` has the same shape — both `findMissingExpressions` and
`findLocalOnlyExpressions` call `listMSTKeys` over the whole tree.

The MST rewrite made the fix possible: nodes are content-addressed and the tree
is deterministic, so **if two peers hold the same CID, that entire subtree is
identical and can be skipped**. `diffMST` in `src/storage/mst.ts` already does
this locally — this block extends the same idea across the network.

---

## Design

### The walk

Reconciliation becomes a top-down fetch of the nodes a peer is missing:

1. A sends `sync-request { rootCid }`.
2. B compares with its own root. Equal → emit `synced`, done, one message.
3. Different → B asks for A's root node: `node-request { cids: [rootCidOfA] }`.
4. A replies `node-response { nodes: [{ cid, bytes }] }` — the bytes are exactly
   what `adapter.get(cid)` returns, so serving costs nothing.
5. B deserializes. For each child CID in the node, B checks `adapter.has(cid)`.
   - Already has it → that subtree is identical, **skip it entirely**.
   - Missing → add to the next `node-request` batch.
6. Repeat until no CIDs are outstanding. The keys found in fetched nodes are the
   expression ids B may be missing.
7. B requests those with the existing `diff-request` / `diff-response` pair.

Both sides run the same walk, so it's symmetric — each ends up with what the
other has.

### Why this is O(differences)

Identical subtrees hash identically. The walk never descends into one. Two trees
differing by a single entry exchange only the nodes on the path from root to that
entry — about `log₁₆(N)` nodes, so 3–4 nodes at N = 10,000 instead of 10,000 keys.

### Batching

Request up to `MAX_CIDS_PER_REQUEST` (start at 64) per round so a large
divergence doesn't become thousands of round trips. Tune with the harness.

### Protocol version

Add a `v: 1` field to every message and drop messages carrying an unknown
version. Old and new peers cannot reconcile, and failing loudly beats a silent
half-sync.

---

## Files

| File | Change |
|---|---|
| `src/sync/sync-messages.ts` | Add `node-request` / `node-response` to the `SyncMessage` union; add `v` to every variant |
| `src/sync/sync-engine.ts` | Handle the new messages; replace the `listMSTKeys` branch with the walk; track outstanding CIDs per peer |
| `src/sync/anti-entropy.ts` | Add `missingChildCids(adapter, node)`; keep the old helpers until nothing calls them, then delete |
| `src/storage/mst.ts` | Export `deserializeNode` usage is already public; no change expected |
| `tests/sync.test.ts` | Extend — the existing 5 tests must keep passing unchanged |
| `tests/anti-entropy.test.ts` | New |

### Message shapes

```ts
| { readonly type: 'node-request';  readonly v: 1; readonly cids: ReadonlyArray<string> }
| { readonly type: 'node-response'; readonly v: 1; readonly nodes: ReadonlyArray<{
      readonly cid: string;
      readonly bytes: string;   // base64url — reuse base64UrlEncode from utils/encoding.js
    }> }
```

Node bytes are small (~235 B for a root, under 1 KB typical), so base64 in JSON
is fine and keeps the wire format debuggable. Revisit only if profiling says so.

---

## Steps

1. **Measure first.** Copy the harness described under *Testing* below and record
   the current numbers. You need a before to prove an after.
2. Add the two message types and the `v` field to `sync-messages.ts`. Update
   `encodeSyncMessage` / `decodeSyncMessage` if they need to reject bad versions.
3. Add `missingChildCids(adapter, node): Promise<string[]>` to `anti-entropy.ts` —
   returns the children of a node that `adapter.has()` says are absent locally.
4. Add per-peer walk state to the sync engine. A `Map<peerId, Set<string>>` of
   outstanding CIDs is enough; clear it when the peer disconnects so a dropped
   peer can't leak memory.
5. Implement the `node-request` handler: `adapter.get(cid)` for each, skip any
   that are missing (do not throw — a peer can legitimately ask for a node that
   was just compacted away).
6. Implement the `node-response` handler: deserialize, collect keys, queue
   missing child CIDs, and when the queue empties fall through to the existing
   `diff-request` path.
7. Rewrite the `sync-request` handler to start the walk instead of calling
   `listMSTKeys`.
8. Delete `findMissingExpressions` / `findLocalOnlyExpressions` once nothing
   imports them, and drop `remoteKeys` from `sync-response`.
9. Re-run the harness and record the after.

---

## Testing

The existing `tests/sync.test.ts` drives two peers through the real engine with
the validation gate in front — **all 5 of its tests must still pass untouched.**
That's your correctness net; treat any change to them as a red flag.

New tests for `tests/anti-entropy.test.ts`:

- Identical trees → one round trip, zero nodes transferred
- One entry differs out of 2,000 → fewer than 20 nodes transferred
- Empty peer pulls a full tree → converges, every key present
- Both peers hold entries the other lacks → both converge (symmetry)
- A peer that answers `node-request` with a missing CID doesn't crash the walk
- A message with `v: 99` is dropped rather than half-processed

### Measurement harness

Instrument a memory adapter with counters and run two engines against each other
in-process, counting `sendToPeer` bytes and adapter calls on each side. Build
peer A with N expressions and peer B with N−1, so exactly one entry differs.

Record: messages, wire bytes, `A.gets`, `B.gets`, round trips — at N = 100,
1,000 and 10,000.

---

## Acceptance criteria

- [ ] Two identical 10,000-entry peers sync in **1 message round, under 1 KB**
- [ ] Two 10,000-entry peers differing by **one entry** exchange **under 50 KB**
      (today: 2.87 MB regardless of how much differs)
- [ ] A cold empty peer still converges fully at N = 10,000
- [ ] All 5 existing sync tests pass **unmodified**
- [ ] `npx tsc --noEmit` clean, full suite green
- [ ] Before/after numbers recorded in the PR description

---

## Out of scope

- **Compaction and garbage collection** — BLOCK-03. Relevant here only because a
  peer may request a node that was collected; handle that gracefully (step 5) and
  move on.
- **Changing the transport.** This block is pure protocol; it works over whatever
  `sendToPeer` happens to be.
- **Expression batching in `diff-response`.** Shipping 10,000 expressions in one
  message is its own problem. Note it, don't fix it here.

---

## Gotchas

- **`adapter.has()` is the hot path.** It's called once per child CID during the
  walk. Make sure whatever adapter is in play implements it efficiently — the
  IndexedDB one currently does a full `get`. Worth checking.
- **Don't trust peer-supplied node bytes.** Deserialize defensively: a malicious
  peer can send a node whose CID doesn't match its content. Re-hash what arrives
  and drop it on mismatch, otherwise you'll poison the local store with nodes
  that can never be found again.
- **Cycles.** Content addressing makes them impossible in a well-formed tree, but
  a hostile peer could craft one. Cap walk depth (16 is generous — a real tree at
  N = 10⁹ is about 7 deep).
- **The `synced` event currently fires in several places.** Make sure the walk
  fires it exactly once per reconciliation, or `tests/sync.test.ts` will hang
  waiting for an event that already fired.
