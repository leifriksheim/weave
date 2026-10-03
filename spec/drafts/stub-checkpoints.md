# Draft: stub checkpoints

> **Draft.** Not normative, not planned yet, not built. A proposal for review.
> Nothing here changes what a peer does today. When it is agreed, the parts
> that are protocol move into [02 — Records](../02-records.md) §4.5–§4.7 and
> [05 — Sync and storage](../05-sync-and-storage.md) as **Planned**, with an
> issue.

## 1. The problem

Every superseded version is kept as a stub, forever, and synced like any
other version (02 §4.5). Stubs are what make §4.7 work: a later version must
follow the version its `prev` names, so a peer can check a chain link by link
back to the record's first version, refusing a version that skips `seq` or
moves to another collection.

So what a newcomer fetches, verifies and stores grows with every edit ever
made, not with what is visible. Measured with
`packages/core/tests/bench/churn.ts` (100 records, Node 24, in-memory stores,
1 ms fake latency), the time for a newcomer to settle:

| Edits per record | Versions | Settled in                                        |
| ---------------- | -------- | ------------------------------------------------- |
| 0                | 100      | 0.05 s                                            |
| 10               | 1,100    | 0.3 s                                             |
| 25               | 2,600    | 0.5–1.0 s                                         |
| 50               | 5,100    | 0.9 s (source initiates), 2.4–3.1 s (joiner does) |

Which side initiates is decided by the two session DIDs (05 §6.2), so it
varies from run to run.

Two costs are mixed in those numbers:

1. **Per version.** Every stub is an item in Negentropy, a signature to
   check, a standing to judge and an entry to store. About 0.2 ms each here,
   more on a phone and in IndexedDB. Only dropping stubs removes this.
2. **Per link.** When the joiner initiates, it asks for ids newest first. A
   version whose `prev` is missing waits, and only its direct `prev` and
   `genesis` are asked for at once (05 §8). A 50-deep chain is walked one link
   per round trip: about 190 wants for 5,100 versions, where 26 would do.
   When the source initiates, it now sends a record's versions together
   (05 §6.3), and the same history settles three times faster. **This cost
   needs no checkpoints** (§7.1). It should be fixed first.

## 2. Goals

- A peer may drop the stubs of a record's chain below a point, and a newcomer
  never fetches them.
- §4.7 stays meaningful: no version is accepted that skips `seq`, changes
  `collection`, or follows a version that was never valid.
- A deleted record is never brought back: not by a late copy of an old
  version, not by a peer returning from a long time offline.
- Every peer holding the same versions and checkpoints keeps the same set, so
  Negentropy converges.
- Nothing changes for retained versions (`retain: true`): the access history,
  `history: "all"`, first versions under `onePer` and `fixed`, versions under
  `check`. Only stubs are ever dropped.

Not goals: compacting the access history (that is #25, access-state
checkpoints); dropping first versions (§7.3); merging concurrent edits.

## 3. The checkpoint

A checkpoint is a record in a new access-history-like collection
`sys.checkpoint`, keyed `checkpoint:<record key>`, so each record has at most
one current checkpoint and later ones supersede earlier ones by §4.3. It is
retained (`retain: true`) and travels whole.

| Field     | Type   | Meaning                                                                     |
| --------- | ------ | --------------------------------------------------------------------------- |
| `key`     | string | The record it compacts.                                                     |
| `genesis` | string | Id of that record's first version, which stays.                             |
| `anchor`  | string | Id of the version from which everything is kept: the new base of the chain. |
| `seq`     | number | The anchor's `seq`.                                                         |

Example body, for a record whose first version is `bafy…a1` and whose 48th
version is `bafy…c9`:

```json
{ "key": "mfrggzdfmztwq2lknnwg23tpoa", "genesis": "bafy…a1", "anchor": "bafy…c9", "seq": 48 }
```

Because a version's id is the hash of a content that names its `prev`, the
anchor's id already commits to the whole chain below it. The checkpoint adds
one claim: _this chain was checked, link by link, by someone trusted to._

### 3.1 Who may write one

A checkpoint skips checks for everyone who trusts it, so it needs a signer
that a newcomer has reason to trust. Proposed:

- its author, as of its `seen`, holds `manage` in the space; or is named
  among the space's keepers (`sys.keepers`), whose job is already to hold the
  space whole;
- it is written by a person's root or a non-agent note, never by an agent
  (as for the access history, 03);
- the author's node MUST hold the whole chain from `genesis` to `anchor` and
  have accepted every link, and MUST NOT checkpoint a chain it holds a
  competing branch of below `seq` (§4.3).

The record creator alone, as 02 §4.7 hints, is not enough. In a record anyone
may edit, the creator could fence off everyone else's concurrent edits
(§4.2).

**Judged as of its `seen`, never withdrawn.** If a checkpoint could later be
withdrawn, like a record whose author was removed by a change they had not
seen (03 §5), the stubs it let peers drop could not come back, and newcomers
could no longer check what sits on the anchor. So a checkpoint stands or
falls on arrival, as of what it saw, like a citation in 02 §7.6. What a
rogue manager can do with this is bounded: they can drop history and fence
off concurrent branches (§4.2), but they cannot make any version count that
the chain check would have refused, because they can only anchor at a
version that is already held and valid.

### 3.2 When to write one

The node's own policy, not protocol: a keeper, or an always-on node of a
manager, writes a checkpoint for a record whose chain is longer than _n_
stubs (say 16), anchored at a version older than a horizon (say 30 days) and
at least _k_ versions below the current (say 1). The horizon is what makes a
fence (§4.2) unlikely to hit anyone who is merely slow.

## 4. What peers do

For a record `K` with a held, valid checkpoint `C` (anchor `A`, seq `s`):

- **Keep:** the first version `genesis`; `A`; every held version of `K` with
  `seq > s`. Everything else of `K`, which is every version with
  `0 < seq < s` and every version at `seq = s` other than `A`, is **below
  the checkpoint**.
- **Drop:** a peer MUST NOT keep a stub below the checkpoint, and drops the
  ones it holds once it holds both `C` and `A`. Never before it holds `A`:
  until then, those stubs are its only way to check what comes next.
- **Arrival:** a version below the checkpoint is not stored, and it is
  answered in `stored` anyway (so the sender does not resend it), the way a
  version of a collection a cache does not hold is passed over (05 §5).
  It is not a refusal: the version may be honest, just late.
- **Chain check (§4.7)** is unchanged above the anchor. `A` itself is accepted
  without its `prev` when `C` names it, after the usual checks on `A` alone
  (shape, signature, standing, `genesis` held with the same key and
  collection).
- **Retained versions** are never below a checkpoint. A peer MUST refuse a
  checkpoint whose chain from `genesis` to `A` contains a retained version
  other than `genesis`.

### 4.1 Deletes stay deleted

The delete is never dropped: a checkpoint anchors at or below the current
version, and everything from `A` up is kept. A late copy of any version below
`s`, whole or as a stub, is passed over. A late copy of the first version's
body is kept only if the first version is current or retained, as today.
Nothing a long-offline peer sends can raise a version over the delete,
because nothing below `s` is stored at all.

The cheapest case is the canvas: a record painted, deleted, painted again. Its
chain is `0, 1 (delete), 2`, with nothing between first version and anchor to
drop, so checkpoints do nothing for it. Dropping first versions (§7.3) would.

### 4.2 Peers back from a long time offline, and fences

A peer that wrote versions on top of a version now below a checkpoint holds a
branch that dips below `s`. Its versions with `seq ≤ s` are below the
checkpoint. Its versions with `seq > s` name a `prev` nobody keeps, so they
wait forever: **the checkpoint fences them off**, on every peer alike, even
where, without the checkpoint, that branch would have had the highest `seq`
and won (§4.3). That is a real change in meaning: a checkpoint is a point of
finality for one record.

What keeps that rare and survivable:

- the horizon (§3.2): only a peer away longer than it can be fenced off;
- the returning node learns why: its versions are not stored because of a
  named checkpoint. A node SHOULD offer to write its fenced edits again as the
  next version after the current one (a rebase), which is the same edit made
  later, judged as today;
- a fence never brings anything back and never takes a delete away; it only
  loses edits that would otherwise have won.

**Alternative (rejected for now):** let a branch that dips below `s` through
a version not on `A`'s chain keep its stubs, so it can be checked. Then which
stubs are kept depends on what each peer has seen, and convergence needs
every peer to have seen every branch, which is the problem being solved.

### 4.3 Negentropy and item sets

Items are the versions a peer keeps (05 §2), so dropping changes a
collection's sums. Two peers that both hold `C` and `A` drop the same stubs
and converge. In between:

- `sys.checkpoint` is a `sys.*` collection: every node holds it, and it is
  asked for ahead of the rest (05 §6.3). A peer learns of `C` before it is
  sent the stubs `C` lets it drop.
- A peer that does not hold `C` yet finds a difference and sends the stubs;
  the other side answers `stored` without keeping them (§4). One wasted round
  per peer, per checkpoint, until `C` reaches it.
- A peer that does not understand checkpoints at all would resend them every
  hello. Hence the switch in §6.

### 4.4 Keep lists, revocation, standing

- **Keep lists** (03 §5) name version ids that stay counted despite a
  removal. A dropped stub is never judged again, so a keep list naming it
  loses nothing. Versions kept above the anchor are judged as today.
- **Revocation.** A version above the anchor written under a note revoked
  later is withdrawn as today. The anchor itself can be withdrawn the same
  way. Then the record's current version may be a stub below the
  checkpoint, which nobody keeps, so the record reads as not held. A
  checkpoint SHOULD anchor at a version whose standing no longer depends on
  anything that could still arrive; for a delegated writer, that is a version
  written by a root, or old enough that a revocation it had not seen would
  already be here. Open question (§8).
- **Standing of the checkpoint** is judged like any `sys.*` record, as of its
  `seen`, and then not withdrawn (§3.1).

### 4.5 Caches, mirrors and private spaces

- Caches hold every `sys.*` collection, so they hold checkpoints and drop
  alike.
- A mirror's compaction (05 §16.4) writes only what the store keeps, so
  dropped stubs leave the bucket at the next compaction by their writer.
- In a private space a checkpoint's body is sealed like any `sys.*` body that
  is; the `anchor` and `genesis` ids it names are already in the clear in the
  versions themselves, so nothing new is shown. Peers without the key cannot
  read which stubs to drop and keep them, so they converge with each other
  but not with members. Open question (§8): whether `anchor` and `seq` go in
  the clear, as `seen` and `prev` do.

## 5. Prior art: Keyhive's sedimentree

Ink & Switch's Keyhive work syncs Automerge commit graphs, possibly encrypted,
through servers that cannot read them, using a structure they call a
sedimentree. As we understand it (check against their write-up before
relying on details):

- the history is cut into ranges at commits chosen by their hash, for
  example by how many leading zero bits it has, so every peer picks the same
  boundaries without talking to anyone;
- each range is compressed into one bundle, and deeper levels cover longer
  ranges, like the levels of an LSM tree, so a long history is a few large
  bundles plus a recent tail;
- peers compare bundles rather than commits, so sync cost follows the number
  of bundles, not the number of edits.

What carries over:

- **Boundaries by hash, not by signer.** Coordination-free compaction needs
  no trust. Weave's stubs are content-free, though: bundling them shrinks the
  item count and the round trips, but not the signatures a newcomer must
  check, because a stub's only content is what proves the link. Dropping
  needs trust; bundling does not. §7.2 sketches bundling as an alternative
  that needs no signer.
- **Ranges as items.** Even with checkpoints, a long chain above the anchor
  could be one Negentropy item per range rather than per version.

What does not: sedimentree keeps all history, compressed; it has no notion of
forgetting content, which is the point of stubs (02 §4.9).

Also related: Git's shallow clones (a cut the client chooses, trusted
because it is local), and Hypercore and Certificate Transparency's signed tree
heads (a signer vouches for a prefix), which is closest to §3 and to signed
writer logs (#13). Once writer logs land, a checkpoint could cite a log
position instead of a chain.

## 6. Migration

- **Nothing changes until a checkpoint is written.** Existing spaces keep
  every stub; no peer drops anything on its own.
- **A switch in the access history.** A peer that does not understand
  `sys.checkpoint` would keep sending dropped stubs every hello (§4.3). So
  checkpoints take effect in a space only once someone who manages it turns
  them on: a field in the space's settings record, part of the access
  history, so every peer agrees from the same point. A peer that sees the
  switch and does not implement checkpoints stops syncing the space and says
  why (as for an unknown `v` in a sync message).
- **The sync protocol version** (`v` in sync messages, 05 §4) goes up by one,
  so peers can tell before the switch is read.
- **Writing the first checkpoints** is the keeper's job (§3.2), in the
  background, oldest records first; nothing has to happen at once.
- **No backfill of trust.** Stubs already dropped can't be recovered, so a
  space should not turn the switch on until its apps implement it.

## 7. Alternatives and steps before this

### 7.1 Fix the chain walk first (no protocol change beyond 05 §6.3)

Most of today's cost is per link, not per version. Two library changes,
each small:

- **Ask for a record whole.** When a version waits for its `prev`, ask the
  same peer for every version of that key it holds, not just the `prev`. That
  needs one new message, `want-key { id, keys }`, answered with `versions`, or
  a `want` that names a key. This is protocol (05 §4), but it is what
  caches that fetch by key (05 §9.2, #27) need anyway.
- **Answer wants in whole records.** A responder could add the rest of a
  record's chain to a `want` answer, which 05 §8 would have to allow (today
  only versions asked for are taken).

Expected effect on the table in §1: "joiner initiates" close to "source
initiates" (0.9 s at 50 edits) without dropping anything.

### 7.2 Bundles without a signer

Sedimentree-style (§5): chain ranges cut at versions whose id has _d_ leading
zero bits travel and reconcile as one item each. No trust, no fences, nothing
forgotten, but every stub is still checked and stored. It shrinks the round
trips and the item count. It does not shrink the signature checks.

### 7.3 Dropping first versions, for deleted records

For a deleted record, a tombstone of first version plus delete is two items.
Dropping the first version as well needs the checkpoint to carry what later
versions check against it: `collection`, the creator's root, and, under
`onePer`, the unique values. Those are retained whole today and cannot be
dropped. Worth doing for canvases and chats with many deletes. It touches
§7.1 (`creator`), §7.3 and §7.4, so it comes after this.

## 8. Open questions

- **Signers.** `manage` or keepers (§3.1)? A quorum? Should a checkpoint by a
  keeper whose keeper status was later removed still stand? (Proposed: yes,
  judged as of `seen`.)
- **Never withdrawn.** Is "judged as of `seen`, never withdrawn" acceptable
  for something written by a manager who was removed concurrently?
- **Fences.** Is a fenced branch losing an edit that would have won by §4.3
  acceptable, given the horizon? Or should a checkpoint never anchor above a
  version whose `seq` a fenced branch could beat, which no peer can know?
- **Anchors that may be withdrawn** (§4.4): require a root-written anchor?
- **Private spaces** (§4.5): `anchor` and `seq` in the clear?
- **The switch** (§6): per space, or per collection in its definition?
- **Interaction with #13** (signed writer logs): a log entry below a
  checkpoint is "proven superseded" by the checkpoint, so completeness still
  holds. Check that once #13's design settles.

## 9. Tests it would need

- A newcomer after a checkpoint gets the first version, the anchor and what
  follows, nothing else, and reaches the same current version as an old peer.
- Two peers that dropped and two that did not converge once all hold the
  checkpoint; the round count stays bounded.
- A late stub below the checkpoint is answered `stored` and not kept.
- A deleted record stays deleted when every old version, whole and as a stub,
  is replayed at a peer holding the checkpoint.
- A branch written offline below the anchor is fenced off on every peer
  alike; a node offers its edit again on top.
- A checkpoint over a chain with a retained version, by an author without
  `manage`, by an agent, or naming an anchor whose chain skips `seq` is refused.
- The churn benchmark: settle time flat in edits per record.
