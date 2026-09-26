# BLOCK-22 — Keepers and caches: not every node holds everything

> **Status (2026-09-26):** part 1 built on branch `keepers-and-caches`: the
> Merkle tree is gone and sync is Negentropy, one collection at a time. Where
> the build differs from the plan below, part 1 says so. Parts 2–4 are still
> ahead.

## What this delivers

Today every node holds a full copy of every space it's in. An app connected
to your account home joins each space it was granted and syncs all of it
into its own IndexedDB (`startConnectedNode` in `src/session/connect.ts`).
Five apps on one laptop means five full copies, plus the home's, plus the
extension's.

When this block is done:

- a node holds **as much of a space as it wants**: all of it (a host, the
  extension, the pod home), the collections its screens use (an app), or
  only its own writes until others have them (a phone low on room);
- nodes sync **whatever part they both hold**, both ways. A cache repairs a
  keeper that lost data as readily as the other way round;
- there is **no one keeper**. A space can have several hosts and several
  extensions, owned by different members. A write is let go only once enough
  of them hold it, and a node can widen what it holds when too few are
  around;
- the Merkle Search Tree is gone. Sync compares sets directly (Negentropy),
  and nothing is stored for it but one index entry per version;
- you can **subscribe across spaces** ("any `chat.message` that mentions
  me"), and your keepers wake your device with a Web Push even when every tab
  is closed, without being able to read what they're passing on.

The apps' side of the API barely changes: `query` and `watch` work as before,
and a result says whether it is `complete`.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'export function createSyncEngine' src/sync/sync-engine.ts && \
grep -q 'export function createStorageProvider' src/storage/storage-provider.ts && \
grep -q "RELAYS_COLLECTION = 'sys.relays'" src/space/roles.ts && \
grep -q 'export async function createCarryCore' src/node/carrier.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — sync, storage, space relays or the carrier are not where this block expects, or the project does not typecheck"
```

**Depends on no other block.** Parts 1 and 2 stand alone. Part 4 uses the
carry space from BLOCK-17 and the host from BLOCK-07, both built.

---

## Where it comes from

Nothing here is new. It's well-known designs put together:

| Part | Borrowed from |
|---|---|
| Comparing two sets by fingerprints of ranges, narrowing to where they differ | Range-based set reconciliation (Aljoscha Meyer), as **Negentropy**: Nostr's NIP-77, strfry |
| Each peer says what part it cares about; two peers sync only the overlap | **Willow**'s "areas of interest" (the Earthstar successor) |
| A target number of copies; nodes widen what they hold when peers go missing | **Holochain**'s storage arcs and redundancy factor |
| The relay/filter split: the always-on node matches the outside of a record, the client does the rest | **Nostr** relays and REQ filters; **Matrix** push rules for encrypted rooms |
| Matching on a keyed hash of a value instead of the value | Blind indexes (CipherSweet); Holochain's anchors |
| Waking a device with an encrypted payload it decrypts itself | **Web Push** (RFC 8030, 8291, 8292), the way Signal and Matrix push |
| A write kept locally until the other side confirms it | An outbox; Replicache's pending mutations |
| Results that say whether they're final | Zero's `complete` / `unknown` result types |

Weave only adds the glue: an "area" is a set of collections in a space, the
outside of a record is the envelope that's already unencrypted, and the
keepers of a space are named the same way its relays are.

---

## Words used below

- **Holds**: what a node keeps of a space. Either `all`, or a list of
  collections. The space's access history (every `sys.*` collection) is always
  held: without it nothing else can be checked.
- **Keeper**: a node that holds `all` of a space and is named as a keeper in
  it. A host, an extension, a pod home, a desktop daemon.
- **Cache**: a node that holds less. Anything it holds it can drop and fetch
  again, except its own writes nobody else has yet.

A keeper and a cache run the same code. The only difference is how much they
hold, which is the Holochain idea: one kind of node, holding a bigger or
smaller slice.

---

## 1. Negentropy replaces the tree

### Why the tree has to go

The MST has **one root per space**. Its nodes don't line up with collection
boundaries, so there's no way to ask "are we equal on `chat.message`?". The
nodes near the edge of a collection mix in the neighbouring ones. Partial sync
over an MST would mean a tree per collection, and all the costs of the tree
multiplied.

The tree is also most of the storage code's difficulty: every write rewrites
a path and leaves orphans behind, so there's compaction, a grace period so
other tabs aren't cut off, a lock so two changes don't lose each other
(`exclusively`), and a folder whose tree has to be rebuilt from its files.

### What replaces it

Negentropy compares two sets of items, each an (ordering value, id) pair.
Each side sorts its items, and they swap **fingerprints of ranges**. Equal
ranges are done; unequal ones are split and compared again, until each side
knows exactly which ids the other lacks. A range's fingerprint is, in
essence, **the sum of the ids in it** (then hashed with the count).

A sum can be kept up to date on every write: add the id when a version is
stored, subtract it when one is dropped. So:

- each space has **a sum per collection**, kept in memory. "Are we equal on
  `chat.message`?" is one 16-byte comparison, with no scan;
- "are we equal on everything we both hold?" is **the sum of those sums**.
  It's the old "equal roots, done", for any mix of collections;
- the items are **the versions a store keeps** (current, first, and retained
  ones), the same set the tree indexed. The ordering value is the version's
  `createdAt`, in whole seconds. That's only for speed: recent writes cluster at the end, where
  a range split finds them quickly. **Time never decides what's held.** A
  writer who lies about the clock makes its own records slower to sync, and
  that's all.

| | MST today | Negentropy |
|---|---|---|
| Sync a part of a space | no | any set of collections |
| Stored for sync | a tree, a path rewritten per write | one index entry per version |
| Cleaning up | orphaned nodes, grace period, lock | nothing to clean |
| Folder | tree rebuilt from the files | files plus an index, as now |
| Equal sets | 1 round trip | 1 round trip |
| Different sets | about the tree's depth in round trips | about log(n) round trips |

### Storage

`StorageAdapter` doesn't change. `StorageProvider` keeps what it knows as
**plain entries** instead of tree entries:

```
r/<key>                      → current version id        (as before, now a plain entry)
g/<key>                      → first version id
h/<key>/<seq>/<id>           → retained version id
i/<collection>/<time>/<id>   → one per version kept: what sync compares
```

**As built:** the sums are not stored. The `i/` entries are listed once, when
sync first needs them, and the sorted sets and their sums are kept in memory,
updated by every change made through the provider. When another writer
changes the same store (another tab, which nudges over its BroadcastChannel,
or a folder reload that found new files), `storage.invalidate()` drops them
and they are read again. An `i/` entry is added or removed per version, never
rewritten, so two writers can't lose each other's.

`getCurrent` becomes one lookup instead of a walk down the tree.
`addExpression` becomes one batch: the version, its `r/` and `i/` entries,
and the old version's removal. Changes still take turns in memory, since each
reads the current version before writing.

**Deleted:** `src/storage/mst.ts`, `src/sync/anti-entropy.ts`, compaction
and its condemned-node bookkeeping, `getRootCid`. **Rewritten:**
`src/sync/sync-engine.ts`, `src/storage/storage-provider.ts`, and the tree
parts of `folder-reconcile.ts`, `copy.ts` and `mirror.ts` (which only used
`entries()` to list ids; now `versionIds()`). `status().root` becomes
`status().fingerprint`. The IndexedDB version is bumped to 3, and old
databases are dropped and resynced, as the last bump did (pre-release: no
migration). A folder reconcile now places every file that appeared since the
last pass, even one already indexed: placing is idempotent, and it corrects a
current entry the other writer's race left wrong.

### Messages (sync protocol v4)

```ts
// On connecting, on the heartbeat, and after taking in something new:
{ type: 'hello', sums: Record<collection, hex fingerprint>, reply?: true }
// Per collection whose fingerprints differ:
{ type: 'reconcile', id, collection, message }   // NIP-77 wire format, base64url
{ type: 'reconciled', id, message }              // the answer
{ type: 'want', id, ids }                        // "send me these versions"
{ type: 'versions', id?, versions }              // the answer, or (no id) what the other side lacks
{ type: 'push-update', expression }              // a write, sent straight away, as before
```

**As built:** the peer whose session DID sorts first starts reconciling, so
two peers don't both do it. The other answers a hello with its own
(`reply: true`), which starts the first. The initiator ends up knowing both
sides' gaps: it asks for what it lacks and sends what the other lacks. A
session stops at 64 rounds, and a message at 32 KB. `holds` in the hello and
`stored` wait for part 2.

Two details the tree used to hide:

- **Versions that lose.** A peer may still offer a version this store has
  already replaced. It's fetched, loses to the current one, and is dropped.
  After both sides have synced they hold the same set, so it doesn't repeat.
- **Versions that are refused.** A version the gatekeeper refuses would show
  up as "missing" on every round. The ids of refused versions are
  remembered (the last 10,000) and not asked for again.

### Library or ours

**As built:** ours, `src/sync/negentropy.ts`, ported from the reference
(hoytech/negentropy, MIT). The reference JavaScript is CommonJS with Node's
`crypto` and 32-bit varints, so it couldn't be used in the browser build as
is. `tests/reconcile.test.ts` checks a fingerprint and a whole first message
byte for byte against what the reference produced, and the two were also run
against each other, in both roles, on sets up to 25,000 items. The 256-bit
sums use `BigInt`.

### Done when

- `sync.test.ts`, `mirror.test.ts`, `folder-adapter.test.ts`, `carrier.test.ts`,
  `host.test.ts` pass unchanged in what they check; `mst.test.ts` and
  `anti-entropy.test.ts` are replaced by `reconcile.test.ts`;
- two stores that differ by one version of 2,000 exchange under 8 KB in
  all, hellos included (`tests/reconcile.test.ts`);
- the same versions arriving in any order give the same sums (a property
  test, as the tree's convergence test did).

---

## 2. Holding part of a space

### How much a node holds

`NodeConfig.holds`: `'all'` (default) or `'used'`. `startConnectedNode`
passes `'used'` for a space **only when the space names at least one keeper**
(below). A space with no keeper keeps its apps as full copies, because then
they're the backups.

A node holding `'used'` holds:

1. every `sys.*` collection, always;
2. the collections the app **declares** when it connects (the grant carries
   the app's collections, as BLOCK-18 proposals already list them). They start
   syncing straight away;
3. the collections its queries **touch**: the query's own collection, and
   every `include … from`.

A query's `where`, `sort` and paging run locally, as now. That's what lets
this work with a blind keeper: it's only ever asked for whole collections,
and collection names are already on the outside of every record.

An `include` without `from` could reach any collection. In a cache it fetches
the records it links to by key, keeps them, and doesn't keep them in sync. When
the query runs again it asks again.

### Sync is the overlap, both ways

Two nodes reconcile the collections **both** hold. A keeper with a cache:
the cache's collections. Two caches: what they share. This also covers
repair: a host whose disk cache was wiped gets back, from every app that
reconnects, whatever those apps hold.

### Naming keepers: `sys.keeper`

A space names its keepers the way it names its relays: one `sys.keeper`
record per keeper, giving the keeper node's DID and a label ("Leif's host",
"Anna's Chrome"). Whoever may name relays may name keepers. Adding hosting
or the extension writes one; removing it deletes it.

- The **record** says a keeper exists, even while it's offline. It's what
  decides `'used'` versus full.
- The **`hello`** says it's online now, and what it holds.

Keepers of one space sync with each other like any two peers. Several hosts
and several extensions, owned by different members, heal one another with no
coordinator.

### Own writes are kept until other copies exist

A cache can drop anyone's records, because they can be fetched again. Its
**own** writes are different: until some other node has them, the cache is
the only copy, and dropping them would lose them. So its own writes go into
**pending**, which is never dropped. They're pushed to every keeper it meets,
and a keeper answers `stored` once it has one. Once enough keepers have
answered, the write leaves pending and is treated like any other record.

**What's protocol and what's a choice.** The protocol only says how a keeper
confirms (`stored`, and only from a DID named in `sys.keeper`). *How many*
confirmations to wait for isn't protocol. It's the writing node's own choice,
because it's the writing node's storage and its data at risk:

- a space can say how many copies it would like, in one `sys.copies`
  record, set by whoever may name keepers. That's Holochain's
  redundancy factor, which is also a setting of each network, not a constant;
- a node waits for that many, or for every named keeper if there are fewer.
  With nothing stated, it waits for 2;
- `NodeConfig.cache.copies` overrides it for a node that wants to be more
  careful. Waiting for more is always allowed; stopping at fewer means risking
  your own writes, not anyone else's.

With no keeper online, pending just waits. Nothing is lost: the write is on
the device that made it, as today.

### Results say whether they're complete

`QueryResult` gains `complete: boolean`:

- `true` once every collection the query needs has been reconciled with at
  least one keeper since it was added (or the node holds `all`);
- `false` while the first sync of a newly touched collection is under way, or
  when no keeper has been reachable yet.

`watch` calls back again when it becomes `true`. `useQuery` passes it
through, so a screen can say "Loading…" instead of showing an empty list.

### Dropping, and holding more

Like the number of copies, **all of this is each node's own choice**, not
protocol. Other nodes never depend on what a cache holds, so nobody else is
affected by it. The app decides, because it's the app's storage, through
`NodeConfig.cache`:

```ts
cache: {
  unusedAfterDays: 30,   // drop a collection no query has touched for this long
  maxBytes: undefined,   // drop least recently used first above this
  copies: undefined,     // see above
}
```

- Nothing in pending is ever dropped. Collections the app didn't declare go
  before ones it did.
- The browser has the last word: when storage runs low it can clear a site's
  data whatever we decide. The cache watches `navigator.storage.estimate()`
  and trims itself first, least recently used first.
- The person doesn't see any of this. A dropped collection syncs back the next
  time a screen needs it, with `complete: false` until it has.

**Widening** means a node holding part of a space starting to hold all of it,
because it notices too few keepers are online. For example, if the only host
of a space is down, an app on a laptop with plenty of room could step in as a
temporary extra copy. It's how Holochain heals: nodes grow their share when
others go missing. It stays **off** in this block, as an opt-in
(`cache.widen: true`), because done automatically it could fill someone's
disk at a bad moment. Once we have numbers from real use, we can decide when
it should happen on its own.

### Done when

- an app connected to a space with a keeper holds only `sys.*` and the
  collections it used; a test counts versions in its store;
- a write made in a cache with no keeper online reaches the keeper when it
  appears, and leaves pending only after as many keepers as the space asks
  for (2 when it doesn't say) confirm it;
- a keeper whose store is wiped gets back what a cache holds;
- a space with no `sys.keeper` keeps its apps full, as today;
- `complete` is `false` on a fresh app and becomes `true` after the first sync.

---

## 3. Topic tags: letting a blind keeper match content

Anything that must be matched without reading the body must be on the
outside. For a few fields a collection chooses, the writer puts a **keyed
hash of the value** there.

```ts
defineCollection({
  name: 'chat.message',
  topics: ['channel', 'mentions'],   // new
  ...
})
```

On write, for each topic field (each element, for a list):

```
tagKey = HKDF(space key, "weave topic tags")
tag    = first 16 bytes of HMAC(tagKey, collection ‖ field ‖ canonical value)
```

and the version carries `tags: [...]`, signed with the rest. A public space
derives `tagKey` from the space id instead, so the code is the same and
anyone can compute the tags (as with Nostr's `#t`).

- **What a keeper learns:** which records share a topic, and how often. Not
  which topic, and it can't guess, since it doesn't have the key. That's the
  cost, and it's limited to fields the collection's author marks.
- **Checking tags.** Any node that can read the body recomputes the tags and
  refuses a version whose tags don't match. A blind keeper can't check, so a
  lying writer can cause a pointless push (the device drops it) or hide from
  one. The first is a rule broken in a way anyone who can read can prove.
- **Key changes.** After a member is removed, the space key changes (already
  built), and so do its tags. Subscriptions are worked out again with the new
  key; old records keep their old tags.
- Adding `topics` to a definition is a harmless change under BLOCK-19.

In this block tags serve subscriptions (part 4). They also make **subsets by
topic** possible later ("hold only the channels I've opened"), which a blind
keeper can serve by tag.

---

## 4. Subscriptions and pushes

### A subscription is a record

`sys.subscription`, kept in the **account's carry space**, so every keeper
of the account (its host, its extensions) reads it:

```ts
{
  collection: 'chat.message',
  spaces: 'all' | string[],
  author?: { not: string } | { in: string[] },   // matched on the envelope
  tags?: Record<spaceId, string[]>,              // any of these, per space
  push: { endpoint, p256dh, auth },              // the device's Web Push subscription
  device: 'Leif's phone',
}
```

API:

```ts
const stop = await node.notify({
  collection: 'chat.message',
  spaces: 'all',
  where: { '@author': { $ne: me }, mentions: { $contains: me } },
});
```

`notify` splits the filter by what a blind node can see, as part 2 splits a
query:

| Part of the filter | Who checks it |
|---|---|
| spaces, collection, `@author` | the keeper, from the envelope |
| exact values of topic fields (`$eq`, `$in`, `$contains` on a list) | the keeper, by tag |
| anything else (text contains, ranges, fields that aren't topics) | the device, after decrypting |

It refuses a filter whose keeper part is only a busy collection with no tag,
saying which fields to mark as topics. That's because browsers require
**every push to show a notification**: Chrome makes a site promise it on
subscribing (`userVisibleOnly`), and Safari cancels a site's permission if
pushes arrive without one. The device can narrow a small stream, but it can't
throw most of a stream away.

### Keepers send, devices decide

- A keeper that stores a new version matching a subscription (envelope and
  tags) sends a **Web Push** to its endpoint: the version as it has it
  (encrypted body and all) if it fits in about 3 KB, otherwise just its id and
  space. Sending is one HTTPS POST (VAPID-signed, payload encrypted per RFC
  8291), so the host and the extension share one WebCrypto implementation.
- The push service sees timing and size, never content.
- The push carries RFC 8030's `Topic` header, derived from the version id, so
  when several keepers send the same record, the push service replaces the
  undelivered copies. On the device, the notification's `tag` is the record
  key, so duplicates that got through replace each other.
- **The device's service worker** receives it with every tab closed. A
  helper, `@weaveprotocol/core/push`, opens the space key from the app's
  IndexedDB, decrypts, checks the rest of the filter and the tags, and shows
  the notification. The text comes from the app's callback, or from the
  collection's title field once definitions carry UI hints. Tapping it opens
  the record.

Notifications come from **your own** keepers, for the spaces they carry. A
space none of your keepers carries notifies only while an app has it open.
The extension carries all your spaces, so with it installed that covers
everything.

It works on phones: iOS supports Web Push for home-screen apps since 16.4.

### Who may write subscriptions

A node holding the account key writes the carry space already. An app with a
narrower grant gets a `notify` permission in its grant, which lets it write
`sys.subscription` records for its own device and nothing else in the carry
space.

### In the apps

- The home: Settings → **Notifications**, listing subscriptions per device,
  with remove.
- The example chat: "Notify me when I'm mentioned", and per channel "Notify me
  about new messages".

### Done when

- with the host running and no tab open, a message that mentions you in a
  private space shows a notification with its text, in Playwright Chromium
  with a real push service;
- a message in the same channel that doesn't mention you sends no push;
- two keepers carrying the space produce one notification;
- a keeper's logs and stores hold no decrypted body or topic value.

---

## Not in this block

- **Subsets smaller than a collection.** By topic (with tags) or by count
  ("the latest 500", by key order or a keeper's arrival order). Never by the
  writer's clock.
- **Widening on by default**, and holding part of a space by key range
  (Holochain's arcs in full). Only worth it once spaces outgrow a device.
- **Mirrors laid out per collection**, so a cache could read a mirror
  directly. Today only full nodes use mirrors, which is fine.
- **Passing on proof of broken rules** (Holochain's warrants), so caches can
  skip an author who wrote invalid records. Belongs with BLOCK-14.
- **Encrypted collection names**, which would also hide what a cache holds
  from a keeper (see "Collection names travel in the clear" in the README).

## Security notes

- **A keeper can hide records**, as any peer can today. A cache talks to
  every keeper it can reach, and any peer holding the collection, so hiding
  needs all of them.
- **Sums can be made to collide.** Someone who can write can, with effort,
  craft records whose ids make two different ranges look equal, and sync
  would skip that range. That's a stall, never a forgery: every version is
  still signed and checked. Nostr accepts the same trade.
- **A keeper learns what a cache holds.** Collection names are on the outside
  already.
- **A keeper learns a device's push endpoint,** and a topic's frequency.
- Sync limits from BLOCK-14 (rate per peer, sizes) apply to `reconcile` as
  they did to tree walks. The "make it walk the whole tree" attack disappears
  with the tree.

## Order and size

| Part | Size |
|---|---|
| 1. Negentropy replaces the tree | ~1 week |
| 2. Holding part of a space | ~1 week |
| 3. Topic tags | ~2 days |
| 4. Subscriptions and pushes | ~1½ weeks |

Part 1 is worth doing on its own. Part 2 needs it. Parts 3 and 4 need
neither of the others, only each other.
