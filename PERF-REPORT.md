# Performance and sync fixes: report

Branch `worktree-perf-sync-fixes`, from `4a224d1`. Measured with Node 24.14
(not 22), in-memory stores, and the fake transport at 1 ms latency. No
browser or IndexedDB numbers were taken.

`join-bench.ts` and `sync-bench.ts`, which the brief and this report cite,
were measured on `4a224d1`. They were removed from main afterwards (the
v0.4.0 cleanup, `9d73d6f`), so to rerun them, check them out from
`4a224d1`. The Phase 4 regression test in `tests/reconcile.test.ts` covers
the same case without them.

Tests at the end: core 691/691, cli 107/107, relay 31/31, none skipped.
`npm run check` passes. The access oracle passes 10,000 random histories.

## Phases

| Phase | Commit    | What                                                       |
| ----- | --------- | ---------------------------------------------------------- |
| 0     | `e58a8bb` | Benchmarks and the randomized access convergence test      |
| 1     | `eddbed4` | `losesReader()` replaces the `readers()` comparison        |
| 2     | `d575363` | A cut that holds everything applied is a copy of the state |
| 3     | `0d57bbf` | `AccessHistory.extend()`, used by the runtime              |
| 3b    | `28e50bf` | A full replay does not copy the state for every change     |
| 4     | `a951b96` | A record's versions go in one message: no deleted flashes  |
| 5.1   | `1ad0d7b` | `push-update` only to peers that hold the collection       |
| 5.2   | `c53b174` | Hello cost measured: it is a one-time build                |
| 6     | `83e1a31` | Draft: `spec/drafts/stub-checkpoints.md`                   |

### Phase 0: harness

The four benchmark files the brief called attached were not anywhere on
disk, so I wrote them from their descriptions (`packages/core/tests/bench/`
`access.ts`, `access-prof.ts`, `churn.ts`, `common.ts`).

`tests/access-convergence.test.ts` covers these cases:

- random histories of 5–60 changes: several authors and ranks; member, role,
  invite, revoke, definition, key, relay and keeper changes;
- `seen` drawn from causal cuts, and sometimes a parent that never arrives;
- keep lists that name records.

It asserts that any arrival order (with duplicates) gives the same state,
statuses, order, heads, `at()`, `judge()`, `revoked()`, `named()` and
`knownInvite()`. It also asserts that `replayAccess` equals
`replayAccessReference`, a frozen copy of the 4a224d1 replay, and from
Phase 3 that adding one change at a time with `extend()` does too. It runs
500 histories, is seeded, prints the seed on failure, and takes about 10 s.

I checked the test by planting mutations. All 12 fail it:

- keyDue never set
- priority ignoring descendants
- the cut fold
- keep lists ignored
- the rival rule off
- the id tie-break reversed
- the whole-cut shortcut always taken
- no past-choice check
- the bound off by one
- no choices kept
- no heads check
- waiting parents ignored

### Phases 1–3: access replay

Time to add a member (`access.ts`):

| Members | Baseline  | Phase 1 | Phase 2 | Phase 3 |
| ------- | --------- | ------- | ------- | ------- |
| 100     | 1,017 ms  | 5.0 ms  | 5.2 ms  | 0.8 ms  |
| 200     | 15,866 ms | 18.8 ms | 15.9 ms | 1.2 ms  |
| 400     | –         | 68.6 ms | 56.9 ms | 1.7 ms  |
| 800     | –         | 309 ms  | 232 ms  | 2.9 ms  |
| 1600    | –         | –       | –       | 5–6 ms  |

Ordinary writes stay under 6 ms. Cost is now linear.

A full replay (initial load, or the fallback) of N member adds in a chain:

| N    | 4a224d1 | Now    |
| ---- | ------- | ------ |
| 100  | 465 ms  | 1.3 ms |
| 400  | 109.5 s | 1.5 ms |
| 1600 | –       | 4.1 ms |

Top self time, three adds at 800 members, with Phase 3 alone: `extended`
4.7 ms (the copy-on-extend), `standingOf` 4.2 ms, `judge` 3.0 ms, `toEvent`
3.0 ms, and storage 1.5 ms.

What Phase 3 changed:

- **`extend()`** is copy-on-extend: the history it is called on is never
  changed.
- **Ancestor sets** are now a placement-prefix summary, O(1) per change in a
  mostly linear history.
- **Reductions** are indexed by account. `named`, `knownInvite` and `heads`
  are lookups.
- **The runtime** extends its cached history from `recordsChanged(placed)`
  and in `write()`. It falls back to a full load when a version was unsettled,
  when a change arrives out of order, or when `extend` returns null.
- **A space-access test** checks that a node's kept-up history equals a fresh
  node's replay of its store.

## Where the brief and what I found differ

1. **Baseline.** I got 684 tests, all passing, 0 skipped, not 682/681/1.
2. **Phase 1 gave far more than predicted:** 5 ms at 100 members, where the
   brief expected ~60. The fix avoids building reader sets at all, rather than
   building them once. Only a member change, for that member, or a removed
   role, for its holders, can lose a reader. Phase 2 then added little.
3. **"seen = heads" is not enough to append (Phase 3).** Spec 03 §4.3 gives
   each ready change the strongest taking-away among all its descendants.
   A new change that saw every head descends from every earlier change. If it
   may take something away, it lowers p1 of every candidate at every past
   choice, and can turn a strict win into a tie that the rest of the key
   breaks the other way. So adding a change can reorder old, concurrent
   history. `extend` checks this exactly, with one bound per past choice
   (the proof is in the `Choice` comment in `roles.ts`), and falls back
   otherwise. The oracle fails without the check, so this is real, not
   theory.
   - **Spec question:** is that intended? A change that comes after
     everything can't be ordered against anything, so arguably only
     descendants not shared by all candidates should count. Changing the rule
     changes consensus, so I didn't. I added a non-normative note to 03 §4.3.
     This deserves an issue.
4. **Phase 4's hypothesis was wrong.** It isn't the `want` batches.
   - It happens only when the source initiates. Which side initiates is
     decided by the session DIDs, so about half of runs. The source then sends
     everything as unsolicited `versions`, newest first, before any want.
   - Items are ordered by the second they were written, then by id. So in a
     burst, deletes arrive long before the first versions they need. They wait
     as `later`, overflow the 1,000-version waiting cap and are evicted.
   - The first versions then go in alone and show. Every flashed record traced
     as `wait1 … evict1 store0 store1`.
   - With Bob initiating, his wants pull missing first versions ahead, and
     nothing flashed.
   - The fix: the sender puts a record's versions in one message
     (05 §6.3, SHOULD).
5. **Phase 4's numbers.** In runs where Alice initiates, the peak went from
   2,882–3,214 to 2,048, matching the final count in 6 of 6 runs. Settle time
   went from 3.1–3.3 s to 2.4 s, and versions sent from ~15,100 to 10,242.
   The brief's 3,730 peak and 6.8 s didn't reproduce here.
6. **The regression test needed a burst.** The existing reconcile harness
   spaces versions a second apart, which hides the bug. The new test writes
   everything in one second, and asserts both "never more than it ends with"
   and "never a pixel that ends cleared". Without the fix, the first holds
   and the second fails, with 261 cleared pixels shown.
7. **Hello (5.2) has no per-hello cost.** The first `sums()` builds the kept
   set: 425 ms for two 100k stores. That is the 426 ms "identical" figure in
   `sync-bench.ts` (1.15 s in the brief). Later hellos take 4–9 ms, also after
   a write, since sums are already kept up incrementally. Nothing to cache.
8. **Churn is not linear at ~1 ms per version.** It is bimodal by initiator.
   At 50 edits it settles in 0.9 s when the source initiates and 2.4–3.1 s
   when the joiner does. The slow mode walks each chain one link per round
   trip: about 190 wants for 5,100 versions. That cost needs no checkpoints;
   the draft says to fix it first (§7.1).

## Not done, and why

- **Follow-ups are issues:** the §4.3 append-reorder question (item 3) is
  #137, and the chain walk (draft §7.1) is #138.
- **Multi-peer convergence (#10)** is only half done. The replay part exists;
  peers with partitions and the gatekeeper do not. 05 §8's Planned note says
  so.
- **A race inside one batch remains.** A batch is stored one version at a
  time, first versions first. A `records.list` running in the middle could
  still see a first version before its delete. I never observed it.
- **The waiting cap still evicts** in other patterns, and every stored
  version still retries the whole waiting set (05 §8 Planned, #33).
- **The chain walk** (draft §7.1) is not implemented; it is protocol, and the
  brief scoped it out.
- **Memory.** `byRecord` loads every version of a session's `have` list
  before sending; before, it streamed 200 at a time. That is fine in memory,
  but worth watching for very large sessions on IndexedDB.
- **Copy-on-extend** is O(history) per access change: 0.3 ms at 800. It is
  linear and was not the bottleneck, so no persistent structures.
- **Stub checkpoints** are a draft only, as asked.
