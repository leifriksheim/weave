# 05 — Sync and storage

How two peers that hold the same space find out which record versions each
lacks and exchange them, and how a node keeps what it holds: the store and
its entries, storage adapters, the data folder that several clients share,
sealing at rest, and mirrors in dumb file stores.

What a version *is* (its fields, id, signature, and which of two versions
wins) is in [02 — Records](02-records.md). Who may write what, and what a
space is, is in [03 — Spaces](03-spaces.md). How sync messages reach a peer is
in [04 — Network](04-network.md). This part only moves and keeps versions.

**Contents**

1. [Overview](#1-overview)
2. [Items: what sync compares](#2-items-what-sync-compares)
3. [Negentropy wire format](#3-negentropy-wire-format)
4. [Sync messages](#4-sync-messages)
5. [What a node holds](#5-what-a-node-holds)
6. [The exchange](#6-the-exchange)
7. [Pushing writes live](#7-pushing-writes-live)
8. [Taking in versions](#8-taking-in-versions)
9. [Keepers and caches](#9-keepers-and-caches)
10. [The store](#10-the-store)
11. [Storage adapters](#11-storage-adapters)
12. [Stores a node opens](#12-stores-a-node-opens)
13. [IndexedDB adapter](#13-indexeddb-adapter)
14. [The data folder](#14-the-data-folder)
15. [Sealing at rest](#15-sealing-at-rest)
16. [Blob stores and mirrors](#16-blob-stores-and-mirrors)
17. [Constants](#17-constants)
18. [Not yet specified](#18-not-yet-specified)

---

## 1. Overview

- Sync works **per space** and, inside a space, **per collection**. Each
  collection's set of kept versions is reconciled on its own.
- The set compared is the set of **version ids** a store keeps: current
  versions, first versions, and retained ones (§10). There is no tree and no
  other sync state on disk.
- Two peers first exchange a `hello` with one 16-byte fingerprint per
  collection. Equal fingerprints mean the same versions: nothing more is said
  about that collection.
- For each collection that differs, one peer (the **initiator**) runs
  Negentropy range-based set reconciliation (§3) with the other. When it ends,
  the initiator knows which versions it lacks (it asks for them with `want`)
  and which the other lacks (it sends them in `versions`).
- A version written locally is also pushed to every connected peer at once
  (`push-update`, §7).
- Every version that arrives from a peer, a folder or a mirror passes the
  same gatekeeper before it is stored (§8).

> Rationale: cost follows the difference, not the size. Two stores of 2,000
> versions that differ by one exchange under 8 KB in total
> (`tests/reconcile.test.ts`).

*Source: `src/sync/sync-engine.ts`, `src/sync/negentropy.ts`. Tests:
`tests/reconcile.test.ts`, `tests/sync.test.ts`.*

---

## 2. Items: what sync compares

An **item** is one kept version, as the pair `(timestamp, id)`:

| Field | Type | Value |
|---|---|---|
| `id` | 32 bytes | The SHA-256 digest inside the version's content id. A version id is `"b"` followed by 52 characters of lower-case RFC 4648 base32 (no padding) of that digest ([02 — Records](02-records.md)); the item id is the decoded 32 bytes. |
| `timestamp` | unsigned integer, seconds | `floor(Date.parse(createdAt) / 1000)` of the version's `createdAt`; `0` when `createdAt` does not parse or is not positive. |

- Items are sorted by `timestamp`, then by `id` compared as unsigned bytes,
  lexicographically (a shorter prefix sorts first).
- Two items with equal `(timestamp, id)` are one item.
- A peer MUST derive items this way: a peer that derived timestamps
  differently would place the same id in a different range and never match.

The timestamp **only orders** items. It never decides which versions are
compared or which one wins (that is `seq` and id, [02](02-records.md)). A
writer whose clock is wrong makes its own versions slower to find, nothing
else.

Example: the version id
`baeaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` has the item id
`01 00 00 … 00` (0x01 followed by 31 zero bytes).

*Source: `src/storage/storage-provider.ts` (`syncTime`, `parseItemKey`),
`src/utils/hash.ts` (`cidDigest`, `cidOfDigest`). Tests:
`tests/reconcile.test.ts` ("content ids as Negentropy ids").*

---

## 3. Negentropy wire format

This is Negentropy protocol version 1 as Nostr uses it (NIP-77), ported from
Doug Hoyte's reference implementation. It is byte-for-byte compatible with
the reference: `tests/reconcile.test.ts` pins a 40-item vector produced by
`hoytech/negentropy`'s JavaScript implementation.

### 3.1 Varints

A varint is an unsigned integer in base 128, **most significant group
first**. Every byte but the last has the high bit (`0x80`) set.

| Value | Bytes |
|---|---|
| 0 | `00` |
| 127 | `7f` |
| 128 | `81 00` |
| 1700000004 | `86 aa cf e2 04` |

A decoder MUST reject a varint whose value exceeds 2^53 − 1.

### 3.2 Message layout

```
message   = version-byte range*
version   = 0x61                        (protocol version 1)
range     = bound mode payload
bound     = varint(encoded-timestamp) varint(id-length) id-prefix[id-length]
mode      = varint: 0 Skip | 1 Fingerprint | 2 IdList
payload   = (Skip)        nothing
          | (Fingerprint) 16 bytes
          | (IdList)      varint(count) id[32]*count
```

- A **range** covers every item from the previous range's upper bound
  (inclusive) up to its own bound (exclusive). The first range starts at
  `(0, empty)`. Ranges are contiguous; the last one in a message SHOULD end at
  infinity.
- **Timestamps** in bounds are delta-encoded within one message. `0` means
  infinity (past every real timestamp); otherwise the encoded value is
  `timestamp − previous + 1`, where `previous` starts at `0` for each message
  and is the last timestamp decoded (or encoded). Once infinity has appeared,
  every later timestamp in the message is infinity.
- The **id prefix** of a bound is 0 to 32 bytes; a decoder MUST reject a
  longer one. A bound compares with items by `(timestamp, prefix)` in the item
  order of §2. An encoder uses the shortest bound that falls after the last
  item of the range and not after the first item of the next: an empty prefix
  when their timestamps differ, otherwise the shared prefix plus one byte.
- A message whose first byte is outside `0x60..0x6f` is not a Negentropy
  message and MUST be rejected. A responder given a version it does not speak
  (`0x60..0x6f`, not `0x61`) answers with the single byte `61`; an initiator
  given one fails.
- An unknown mode MUST be rejected.

### 3.3 Fingerprints

A fingerprint of a range of items:

1. Sum the ids, each read as a **little-endian** 256-bit unsigned integer,
   modulo 2^256.
2. Write the sum as 32 bytes little-endian, then append `varint(count)`.
3. Take SHA-256 of that, and keep the **first 16 bytes**.

The fingerprint of the empty set is `7f9c9e31ac8256ca2f258583df262dbc`. The
fingerprint of the single id `01 00 … 00` is
`2e255099d6d6bee307c8e7075acc78f9`.

Because a sum can be taken apart and put together, a store keeps one running
sum per collection and adds or subtracts as versions come and go (§10).

### 3.4 The algorithm

**Splitting a range** `[lower, upper)` of `n` items:

- If `n < 32`, send it as one `IdList` range with all `n` ids.
- Otherwise split it into 16 buckets. Bucket `i` (0-based) holds
  `floor(n/16) + (i < n mod 16 ? 1 : 0)` items. Each bucket is sent as a
  `Fingerprint` range; its bound is the minimal bound before the next
  bucket's first item, and the last bucket's bound is the range's own upper
  bound.

**Initiating.** The initiator sends `0x61` followed by the whole set split as
above, with upper bound infinity. An empty set gives `61 00 00 02 00`.

**Answering** (both sides, each message). For each incoming range, find the
local items in it, then:

| Incoming mode | Initiator | Responder |
|---|---|---|
| Skip | nothing | nothing |
| Fingerprint, equal to local | nothing | nothing |
| Fingerprint, different | split the local range and send it | split the local range and send it |
| IdList | records ids it holds that the list lacks as **have**, ids in the list it lacks as **need**; sends nothing | replies with its own `IdList` for the range |

Consecutive "nothing"s are coalesced into one `Skip` range, written only
before the next range that says something (a trailing Skip is not written).

The **initiator is done** when its answer would be the version byte alone:
it then sends nothing more. A responder always answers, even with the version
byte alone. Only the initiator learns `have` and `need`; the responder is
stateless between messages.

**Frame size limit.** A reconciler may be given a limit `L` in bytes (`0` for
none; otherwise `L` MUST be at least 4096). Output stops once it would exceed
`L − 200` bytes:

- inside a responder's `IdList`, the ids that do not fit are left out and the
  list's bound becomes the first left-out item (its full 32-byte id);
- after any range, if the message so far plus that range's output would
  exceed the limit, that range's output is dropped and the message ends with
  one range to infinity carrying the `Fingerprint` of every local item from
  the end of the current range onward. The other side sees it differ and asks
  again next round.

This matches the reference implementation, which can also name an id in more
than one round when a round was cut short; an implementation MUST tolerate
seeing the same id in `have` or `need` twice.

### 3.5 Example

Initiator A holds `id1 = 01 00…00` at 1700000000 and `id2 = 02 00…00` at
1700000005. Responder B holds `id1` and `id3 = 03 00…00` at 1700000009.

```
A → B   61 00 00 02 02 <id1> <id2>
        │  │  │  │  │
        │  │  │  │  └ count 2
        │  │  │  └ mode IdList
        │  │  └ bound id length 0
        │  └ bound timestamp: infinity
        └ version 1
        base64url: YQAAAgIBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
B → A   61 00 00 02 02 <id1> <id3>
A:      have = [id2], need = [id3], done (nothing more to send)
```

With 40 items, A's first message instead starts
`61 86aacfe204 00 01 <16-byte fingerprint> …`: bound timestamp
1700000003 (encoded 1700000004), empty prefix, mode Fingerprint — the first of
16 buckets.

*Source: `src/sync/negentropy.ts`. Tests: `tests/reconcile.test.ts`
("Negentropy": reference vector, exact have/need, equal sets, frame limit,
malformed input, sums).*

---

## 4. Sync messages

A sync message is a JSON object. It travels as the `payload` of the network
envelope `{ "type": "sync", "from": <sender session DID>, "payload": … }`
([04 — Network](04-network.md)); this part does not encode it again.

Every message carries `"v": 4` (`SYNC_PROTOCOL_VERSION`). A peer MUST drop a
message that is not an object, whose `v` is not the version it speaks, or
whose `type` is not a string. It MUST NOT answer it.

> Rationale: two versions that cannot reconcile should fail loudly, not leave
> a quiet partial sync.

Ids below are version ids (strings, §2). Byte strings are `base64url`.

### `hello`

"Here is what I hold, and a fingerprint of each collection I keep."

| Field | Type | Meaning |
|---|---|---|
| `type` | `"hello"` | |
| `holds` | `"all"` \| `string[]` | Optional. `"all"`, or the collections held besides `sys.*` (§5). Absent means `"all"`. |
| `sums` | `{ [collection]: string }` | For each held collection the sender keeps at least one version of: the collection's fingerprint (§3.3) over all its items, as 32 lower-case hex characters. |
| `reply` | `true` | Optional. Marks a hello sent in answer to one; it is never answered by another hello. |

Example (fingerprint values illustrative):

```json
{ "v": 4, "type": "hello", "holds": "all",
  "sums": { "app.todo.item": "2e255099d6d6bee307c8e7075acc78f9",
            "sys.role": "0fc7e595db07fda274b7780656316457" } }
```

A receiver MUST ignore a hello whose `sums` is not an object or names more
than 1000 collections. A `holds` that is neither absent, `"all"`, nor an array
of at most 1000 entries counts as holding only `sys.*`; non-string entries
are ignored.

### `reconcile`

One round of reconciling one collection, initiator to responder.

| Field | Type | Meaning |
|---|---|---|
| `type` | `"reconcile"` | |
| `id` | number | The session id, chosen by the initiator, echoed in the answer. |
| `collection` | string | The collection being reconciled. |
| `message` | string | A Negentropy message (§3), base64url. At most 32,000 bytes before encoding. |

### `reconciled`

The responder's answer to one `reconcile`.

| Field | Type | Meaning |
|---|---|---|
| `type` | `"reconciled"` | |
| `id` | number | The `reconcile`'s `id`. |
| `message` | string | The responder's Negentropy message, base64url. `""` when `held` is `false`. |
| `held` | `false` | Optional. The responder does not hold this collection (§5); the session ends. |

### `want`

"Send me these versions."

| Field | Type | Meaning |
|---|---|---|
| `type` | `"want"` | |
| `id` | number | Request id, echoed in the reply. |
| `ids` | `string[]` | Version ids. A sender puts at most 200 in one `want`; a receiver serves at most the first 200 and skips entries that are not version ids. |

### `versions`

Versions, as they are on the wire ([02 — Records](02-records.md)).

| Field | Type | Meaning |
|---|---|---|
| `type` | `"versions"` | |
| `id` | number | Present: the answer to the `want` with that id. Absent: versions the sender found the receiver lacks while reconciling. |
| `versions` | `Expression[]` | At most 200. |

A `want` MUST always be answered with a `versions` carrying its `id`, even
when none of the ids are held (`versions: []`): the asker counts answers to
know it is done.

### `push-update`

| Field | Type | Meaning |
|---|---|---|
| `type` | `"push-update"` | |
| `expression` | `Expression` | A version written just now (§7). |

### `stored`

"I have these now."

| Field | Type | Meaning |
|---|---|---|
| `type` | `"stored"` | |
| `ids` | `string[]` | Ids of versions the sender just took in from the receiver (from `versions` or `push-update`) and that passed its gatekeeper — newly stored or already held. A receiver considers at most the first 2,000 string entries. |

*Source: `src/sync/sync-messages.ts`, `src/sync/sync-engine.ts`. Tests:
`tests/reconcile.test.ts`, `tests/sync.test.ts`.*

---

## 5. What a node holds

A node holds either every collection of a space (`"all"`), or a set of
collections. Whatever else it holds, **every node holds every `sys.*`
collection** (the space's own: roles, members, definitions, keys, keepers…,
see [03 — Spaces](03-spaces.md)).

- A node MUST say what it holds in every `hello` (`holds`), asked afresh each
  time: what it holds can change while connected.
- Two peers reconcile **only collections both hold** — their overlap.
- A node MUST NOT store a version of a collection it does not hold, from
  whatever source (`versions`, `push-update`); such versions are passed over
  silently and not acknowledged in `stored`.
- A node asked to `reconcile` a collection it does not hold MUST answer
  `reconciled` with `message: ""` and `held: false`.

Which collections a node chooses to hold is the node's own choice; how this
implementation chooses is in §9.

*Source: `src/sync/sync-engine.ts` (`Holds`, `holdsCollection`, `readHolds`).
Tests: `tests/reconcile.test.ts` ("holding part of a space").*

---

## 6. The exchange

### 6.1 Peers

A sync peer is a connected, authenticated peer of the space, named by its
session DID ([04 — Network](04-network.md)). Messages from a peer are handled
**strictly in the order they arrived**: a `hello` must not overtake the
`versions` sent before it. Messages from a peer not yet added (connection not
yet up) are ignored; each side says hello once it adds the other, so nothing
said before then is needed. When a peer disconnects, every session and
request with it is forgotten.

### 6.2 Hello

A node sends a `hello` (without `reply`):

- as soon as a peer connects;
- to every peer every **heartbeat** (30 s by default);
- shortly (≈100 ms) after it took in something new from a peer, a folder or a
  mirror, so a version passed along does not wait a heartbeat at every hop;
- whenever what it holds changes (§9).

On a `hello` from peer P:

1. Record what P holds.
2. Compute its own sums for the collections it holds.
3. Consider every collection named in P's `sums`, in its own sums, or in its
   own `holds` list; keep those **both** hold. That includes a collection one
   side has none of yet (absent from `sums`), so it comes across whole.
4. A collection is **level** when both sums are present and equal. For each
   level collection, the node records that it is level with P.
5. If none differ, and nothing is in flight with P, the node is **synced**
   with P. Stop.
6. Otherwise choose the initiator. The **initiator is the peer whose DID sorts
   first** (plain string comparison of the two session DIDs). If the node is
   not the initiator, it answers with its own `hello` marked `reply: true`
   (unless the hello it got was itself a reply) and waits. If it is, it begins
   a session for each differing collection.

A node that does not know its own id MAY initiate on every difference; it is
harmless, only sometimes twice the work.

> Rationale: two peers that hear each other's hello at once must not both do
> the work; the non-initiator's reply is what starts the initiator when only
> the non-initiator noticed a difference.

### 6.3 Sessions (initiator)

For each differing collection the initiator:

1. Builds its item set for the collection and sends `reconcile` with a fresh
   `id` and the output of *initiate* (§3.4), with a frame limit of 32,000
   bytes. If a session for that collection with that peer is already running
   and has heard something in the last 30 s, it does not start another; it
   marks the running one to run **again** once it ends.
2. On each `reconciled` with the session's `id`:
   - `held: false` ends the session.
   - Otherwise it feeds `message` to its reconciler. A message that fails to
     parse ends the session with an error.
   - For ids in `have` not already handled in this session, it sends the
     versions in `versions` messages **without** `id`, at most 200 per
     message.
   - For ids in `need` not already handled in this session, and not refused
     from this peer before (§8), it sends `want` messages of at most 200 ids,
     each with a fresh request id, and remembers them.
   - If the reconciler produced a next message, it sends it as another
     `reconcile` with the same session id — up to 64 rounds; past that the
     session is abandoned as runaway.
   - Otherwise the session ends.
3. When a session has ended and every `want` it made has been answered, the
   collection is **level** with that peer (as far as could be taken in). The
   initiator then sends the peer a `hello` with `reply: true`, so the peer
   learns where things stand too without starting another round.
4. If the session was marked to run again, a new session begins.

A session that has heard nothing for 30 s is dropped at the next heartbeat.

### 6.4 Answering (responder)

- On `reconcile`: if the collection is not held, answer `held: false`.
  Otherwise build the item set, run one *answer* step as responder (§3.4)
  with the 32,000-byte frame limit, and send `reconciled` with the same `id`.
- On `want`: answer with `versions` carrying the same `id` and every asked
  version it holds (first 200 ids only).

### 6.5 Done

A node is **synced** with a peer when no session and no `want` is in flight
with it. This implementation reports `synced` and `level` as events; §9 uses
them, and records whether the peer holds `"all"`.

### 6.6 Sequence

```
A (initiator: its DID sorts first)                       B
   ◀──────────────────── hello {sums} ─────────────────────   B connected
   ── hello {sums} ──────────────────────────────────────▶    A connected
   (app.note differs)
   ── reconcile {id:7, collection:"app.note", message} ──▶
   ◀──────────────── reconciled {id:7, message} ──────────
   … more rounds while A's reconciler has something to say …
   ── versions {versions:[…]} ───────────────────────────▶    what B lacks
   ── want {id:8, ids:[…]} ──────────────────────────────▶    what A lacks
   ◀────────────────────────── stored {ids} ──────────────    B took them in
   ◀──────────────── versions {id:8, versions:[…]} ───────
   ── stored {ids} ──────────────────────────────────────▶
   ── hello {sums, reply:true} ──────────────────────────▶    A is level on app.note
```

*Source: `src/sync/sync-engine.ts`, `src/node/space-runtime.ts` (wiring:
heartbeat, `announceSoon`, peer connect). Tests: `tests/reconcile.test.ts`
("sync by reconciliation"), `tests/sync.test.ts`.*

---

## 7. Pushing writes live

When a node writes a version locally, it sends `push-update` with that
version to **every** connected peer at once, without waiting for a hello.
The sender does not filter by what the peer holds; the receiver drops what it
does not hold (§5).

A receiver treats the pushed version exactly like one in `versions` (§8),
including answering with `stored` when it takes it in. A push that is lost is
not retried: the next hello finds the difference.

*Source: `src/sync/sync-engine.ts` (`onLocalChange`). Tests:
`tests/sync.test.ts` ("pushes a local change to a peer").*

---

## 8. Taking in versions

Nothing a peer sends is taken on trust. Before storing a version from a peer,
a folder another writer can reach (§14.5), or a mirror (§16), a node MUST run
it through the validation pipeline of [02 — Records](02-records.md) and the
access rules of [03 — Spaces](03-spaces.md), and MUST NOT store it unless it
passes. Shape (schema conformance) is **not** a reason to refuse a version on
arrival; see 02.

The gatekeeper gives one of three answers:

| Answer | Meaning | What happens |
|---|---|---|
| valid | passes | stored (§10) |
| later | depends on something not here yet: the record's first version, the definition or access change it was written under | held in memory (at most 1,000; the oldest give way) and tried again whenever another version is stored; asked for again on the next round if still waiting |
| invalid | refused | dropped; remembered as refused **from that peer** (at most 10,000 entries) and not asked of that peer again |

> Rationale: a refusal is keyed on peer and id, not id alone. A version id
> does not cover the signature, so a stranger's mangled copy shares the real
> version's id; refusing the id outright would stop the node fetching the
> genuine one from someone else (`tests/attacks.test.ts`).

A batch of versions (one `versions` or `push-update`) is taken in this order:

1. Drop entries that are not objects or have no string `collection`.
2. Drop versions of collections this node does not hold.
3. Sort: `sys.collection` versions first, then by `seq` ascending — what
   others depend on comes first.
4. Run each through the gatekeeper and store what passes.
5. If any were taken in, send the sender `stored` with their ids, then retry
   the waiting versions until no more go in.

A `versions` with an `id` is only considered if it answers a `want` this node
has in flight with that peer, and only versions whose `id` was asked for are
taken. A `versions` without `id` is limited to its first 200 entries.

*Source: `src/sync/sync-engine.ts` (`admit`, `admitAll`, `retryWaiting`),
`src/node/space-runtime.ts` (`admit`). Tests: `tests/sync.test.ts` (forged
expression, no capability, schema), `tests/reconcile.test.ts` ("a refused
version is not asked for again"), `tests/attacks.test.ts`.*

---

## 9. Keepers and caches

A space MAY name **keepers**: nodes that keep it whole (a host, the
extension), and a number of `copies`. They are named in the space's access
history (`sys.keepers`, record key `keepers:space`, body `{ keepers:
[{ did, name }], copies }`; at most 16 keepers; only someone who manages the
space may name them). That record is specified in [03 — Spaces](03-spaces.md).

What is **protocol** here is how a keeper confirms it has a write:

- by `stored` naming its id (§4), or
- by being **level** with the writer on the write's collection (equal sums in
  a `hello`, or a finished session, §6).

Only a peer whose session DID is among the space's named keepers counts.

How much a node holds is **its own choice**. This implementation's policy for
a node configured with a cache (`NodeConfig.cache`; an app connected to an
account home, [06](06-nodes-and-sessions.md)):

- **Whole or part.** The node holds part of the space when the space names at
  least one keeper, or when it has not yet been synced with a peer that holds
  `"all"` (until then it cannot know whether keepers are named). Otherwise it
  holds the space whole and may itself be one of its copies. When this
  changes it says hello to every peer.
- **What part.** The collections the app declared (`cache.collections`), plus
  every collection a query has used; a newly used collection triggers a hello
  to every peer. A query's result is **complete** only once each collection
  it uses has been level with a peer holding `"all"`.
- **Pending writes.** Each of the node's own non-`sys.*` writes is pending
  until `target = min(number of keepers, max(copies ?? 2, cache.copies ?? 0))`
  distinct keepers have confirmed it.
- **Dropping.** On opening the space and every 6 hours, a collection no query
  has used for `unusedAfterDays` (default 30) is dropped — its versions
  removed and it is no longer held — unless the app declared it or it holds a
  pending write. It is un-held *before* its versions go, so nothing syncs it
  back meanwhile.

Implementation detail — the state is kept in the space's own store (§12):

| Key | Value (UTF-8 JSON) |
|---|---|
| `cache` | `{ "settled": boolean, "used": { [collection]: ms }, "level": { [collection]: ms } }` — `settled`: has synced with a whole-space peer; `used`: when a query last used it; `level`: when it was first level with a whole-space peer |
| `pending/<version id>` | `{ "collection": string, "by": [keeper DID…] }` — deleted once `by` reaches the target |

*Source: `src/node/space-runtime.ts` ("Holding part of the space"),
`src/node/types.ts` (`CacheConfig`), `src/space/roles.ts` (`Keeper`,
`checkKeepers`). Tests: `tests/caches.test.ts`, `tests/reconcile.test.ts`
("holding part of a space").*

---

## 10. The store

A space's store holds record versions, and small **entries** (key → value)
saying which is which. Every entry value below is the UTF-8 of a version id.

| Entry key | Present for | Names |
|---|---|---|
| `r/<record key>` | every record | its current version (possibly a delete) |
| `g/<record key>` | a record that has been edited | its first version (`seq` 0) |
| `h/<record key>/<seq>/<id>` | a superseded version its writer marked `retain` | that version; `seq` is decimal, zero-padded to 15 digits |
| `i/<collection>/<time>/<id>` | every version kept (current, first, retained) | that version; `<collection>` is `encodeURIComponent(collection)`, `<time>` is the item timestamp (§2) in decimal |

Record keys contain no `/` ([02](02-records.md)). The `i/` entries are the
only sync state: the item set of a collection is exactly the parseable `i/`
entries for it. An `i/` entry whose id is not a version id, whose time is not
a non-negative safe integer, or that has more than four `/`-separated parts is
ignored.

### 10.1 Placing a version

Taking in version `V` of record `k` is idempotent, and the same set of
versions gives the same entries in any arrival order:

1. If `r/k` already names `V`, stop.
2. Let `C` be the version `r/k` names, if any. If `C` exists and `V` does not
   supersede `C` (the ordering rule, [02 — Records](02-records.md)), **demote**
   `V` against `C`, and stop.
3. Otherwise keep `V`, set `r/k = V`, and if `C` exists, demote `C` against
   `V`.

**Demote** a version `D` against the current `W`:

- If `D.seq == 0` and `W.seq > 0` (a first version): let `G` be what `g/k`
  names. If `G == D`, stop. If there is no `G`, or `D.id < G` (string
  comparison), keep `D`, set `g/k = D`, and treat the displaced `G` (if any)
  by *keep or drop*. Stop.
- Otherwise *keep or drop* `D`.

**Keep or drop** `D`: if `D.retain`, keep it and set its `h/` entry;
otherwise drop it.

**Keep** writes the version's body and its `i/` entry. **Drop** removes its
`i/` entry and deletes its body. The entry writes of one placement are made
in one batch; bodies of dropped versions are deleted only after that batch
lands, so no entry ever names a version that is gone.

> Rationale: the first version is kept as proof of who created the record —
> the lowest id wins if several devices each created the same chosen key.

**Removing** a version (used when a folder file vanished, §14.5, or a
collection is dropped, §9) unsets `r/k` and `g/k` if they name it, unsets its
`h/` entry, and drops it. It does not promote an older version.

Changes to one store are applied one at a time, never interleaved.

### 10.2 In memory

The item sets and each collection's running sum (§3.3) are read from the `i/`
entries once, kept in memory, and updated by every change made through this
store. When another writer changed the same store (another tab, another
origin or device on a shared folder) the node MUST re-read them
(`invalidate`). This implementation notifies other tabs of one browser through
a `BroadcastChannel` named `weave-node:<root DID>:<space id>` (*implementation
detail*).

The store's overall **fingerprint** (for status and tests) is the §3.3
fingerprint of the sum of every collection's sum, as hex.

*Source: `src/storage/storage-provider.ts`, `src/records/version.ts`. Tests:
`tests/versions.test.ts` ("a store of versions"), `tests/reconcile.test.ts`
("a superseded version leaves the set", "a store written by someone else is
read again once told").*

---

## 11. Storage adapters

The store runs over an adapter with this contract (all methods async):

| Method | Contract |
|---|---|
| `get(key)` | Entry bytes, or null |
| `put(key, bytes)` | Set an entry |
| `delete(key)` | Remove an entry; absent is fine |
| `has(key)` | Whether an entry exists |
| `list(prefix?)` | Every entry key starting with `prefix`, in no guaranteed order |
| `batch(ops)` | Apply `{type:'put',key,value}` / `{type:'delete',key}` ops; SHOULD be atomic |
| `putExpression(v)` | Store a version body by its `id` |
| `getExpression(id)` | A version body, or null |
| `deleteExpression(id)` | Remove a version body |
| `queryExpressions(collection, limit=50, cursor?)` | Version bodies in a collection (every body kept, not only current), after the version with id `cursor` |
| `close()` | Release it |

Entry keys are strings; values are bytes. Adapters: IndexedDB (§13), data
folder (§14), the sealing wrapper (§15), and an in-memory one for tests.

*Source: `src/types.ts` (`StorageAdapter`, `BatchOp`). Tests:
`tests/folder-adapter.test.ts`, `tests/helpers/memory-adapter.ts`.*

---

## 12. Stores a node opens

A node opens stores **by path**, and a store factory maps a path to an
adapter:

| Path | Holds | Sealed (§15) |
|---|---|---|
| `registry` | the spaces this node holds, and their keys | yes, on a node given a vault key |
| `spaces/<space id>` | one space: §10 entries and bodies, plus §9 `cache` and `pending/…` | no |
| `mirrors/<space id>/<n>` | a mirror's writer state (§16.4); `n` is the mirror's index | no |
| `host` | a host's subscriptions (`subscription:<id>`) — see [06](06-nodes-and-sessions.md) | no |

**Registry entries.** One space's registry entries, each keyed by space id:

| Key | Value | Sealed by default |
|---|---|---|
| `space:<id>` | UTF-8 JSON of the `Space` ([03](03-spaces.md)) | yes |
| `spacekey:<id>` | UTF-8 JSON `{ "keys": [{ "id", "raw" (base64url AES-256 key), "createdAt", "version" }], "current": <key id> }` | yes |
| `spaceinvite:<id>` | UTF-8 base64url of an invite secret, until used | yes |
| `spacerole:<id>` | UTF-8 role name this account last held (a listing hint) | yes |
| `spacememberkey:<id>` | UTF-8 base64url of this account's member key for the space | **no** — see §18 |
| `spacerelays:<id>` | UTF-8 JSON array of relay URLs | no |

Forgetting a space deletes all six.

**Factories** (*implementation detail* for IndexedDB, normative for folders):

- IndexedDB: one database per path, named `<prefix>:<path with / → :>`. For
  an account: prefix `weave:<dataPath with / → :>`, e.g.
  `weave:accounts:k3x9q2:stores:spaces:<space id>`. For an app connected to
  an account home: prefix `weave-app:<grant DID>`.
- Folder: a folder adapter (§14) at `<dataPath>/<path>` under the data
  folder; the `registry` store wrapped by the sealing adapter under the
  account's vault key.

*Source: `src/node/stores.ts`, `src/session/places.ts` (`storesFor`),
`src/space/space-manager.ts`, `src/node/node.ts`, `src/node/space-runtime.ts`.
Tests: `tests/account-vault.test.ts` ("encryption at rest"),
`tests/node.test.ts`.*

---

## 13. IndexedDB adapter

*Implementation detail*: only this origin reads it.

- Database version **3**. Opening a database of version 1 or 2 (which held a
  Merkle tree) deletes its object stores: it is a local copy, rebuilt by
  syncing.
- Object store `kv`: out-of-line string keys; values are `ArrayBuffer`s (the
  entry bytes). `list(prefix)` is a key-range cursor over
  `[prefix, prefix + "￿"]`.
- Object store `expressions`: key path `id`; indexes `collection`, `author`,
  `createdAt` (non-unique). Values are the version objects.
- `batch` is one `readwrite` transaction over `kv`. Bodies are written in
  their own transactions.

Accounts kept in a browser live in database `weave-accounts`, object store
`accounts` ([01 — Identity](01-identity.md)). A remembered data-folder handle
lives in database `weave-folder`, object store `handles`, key `data-folder`
(§14.7).

*Source: `src/storage/indexeddb-adapter.ts`, `src/storage/directory-access.ts`.
Tests: none directly (the adapter needs a browser).*

---

## 14. The data folder

A data folder is a directory the user picked. Several origins (and the CLI
or a daemon on the same machine, and other devices behind a file-sync
service) read and write it at once. Its format is **normative**: a client
that follows this section can share a folder with this one.

### 14.1 Layout

```
<folder>/
  accounts.json                         the accounts here (01 — Identity)
  accounts/<account id>/account.json    that account's locked keys (01)
  accounts/<account id>/stores/         that account's data path
    registry/
      kv/<encoded key>                  one file per entry
      expressions/                      (empty for a registry)
    spaces/<space id>/
      kv/<encoded key>
      expressions/<version id>.json     one file per version body
    mirrors/<space id>/<n>/kv/…
```

- `<account id>` matches `^[a-z0-9]{1,12}$`. An account's `dataPath` in
  `accounts.json` MUST be `accounts/<its id>/stores`, or `stores` for a folder
  written before it held more than one account (then its data is at
  `<folder>/stores/…`). A reader MUST skip rows with any other id or data
  path, and MUST NOT resolve a path from them.
- A store at path `a/b/c` is the directory `<dataPath>/a/b/c`, each segment
  encoded as in §14.2. Each store directory has exactly two subdirectories,
  `kv` and `expressions`, created on open.
- Legacy single-account folders also have `weave-account.json` and
  `README.txt` at the root ([01 — Identity](01-identity.md)).

### 14.2 File name encoding

Entry keys and path segments become file names by percent-encoding their
UTF-8 bytes: every byte **not** in `a-z 0-9 . _ -` becomes `%` and two
**upper-case** hex digits. Decoding reverses it.

| Key | File name |
|---|---|
| `r/k3x9q2abcd` | `r%2Fk3x9q2abcd` |
| `i/app.todo.item/1700000000/bae…` | `i%2Fapp.todo.item%2F1700000000%2Fbae…` |
| `space:bafy…` | `space%3Abafy…` |

A writer MUST use exactly this encoding; a reader MUST decode it.

> Rationale: upper-case letters are escaped because macOS and Windows file
> systems are case-insensitive by default; `space:Abc` and `space:abc` would
> otherwise be one file.

### 14.3 Files

- **Entry files** `kv/<encoded key>`: the entry value, raw bytes (for the §10
  entries, the UTF-8 version id; for sealed keys, §15).
- **Version files** `expressions/<encoded id>.json`: the version exactly as on
  the wire ([02](02-records.md)), as UTF-8 JSON. Version ids are lower-case
  base32, so the name is the id itself. The file is named by its own content
  hash and never changes once written. JSON formatting is not significant; a
  reader MUST parse, not compare bytes. A file that does not parse (for
  instance half-written) MUST be treated as absent.
- Names that end in `.tmp` are a writer's work in progress and MUST be
  ignored. Only names ending in `.json` in `expressions/` are versions.

A writer SHOULD replace a file atomically (write elsewhere, then rename). The
browser's File System Access API does this on `close()`; the Node/Bun
directory used by the CLI writes `<name>.<uuid>.tmp` with mode `0600` and
renames it into place. Directories are created with mode `0700`.

### 14.4 Safety

A folder may be synced or shared, so its contents are not necessarily this
device's writes. A client MUST NOT let a name read from the folder reach
outside it: names equal to `""`, `.`, `..`, or containing `/`, `\` or NUL are
refused as path segments, and symbolic links are neither followed nor listed.

### 14.5 Convergence without locks

There is no lock file. Version files are immutable and content-addressed, so
two writers either write different files or identical ones. The entries are
derived state, and the rule is: **the set of version files wins.**

Any client sharing a folder SHOULD re-read it periodically (this
implementation: every 2 s while a space is open) and reconcile:

1. List `expressions/`. Note files that appeared since the last pass and files
   that vanished. If anything moved, re-read the in-memory sync state (§10.2).
2. For every version file that is not indexed, **or appeared since the last
   pass**, read it, pass it through the gatekeeper (§8), and place it (§10.1).
   Placing again is idempotent and corrects a current entry a race left wrong.
   A version refused now stays on disk and is asked about again next pass.
3. For every indexed version whose file is gone (and still cannot be read),
   remove it (§10.1).

With nothing new on disk this is two directory listings and no writes.

### 14.6 Account files

`accounts.json` (`{ "version": 1, "accounts": [AccountSummary…] }`) and
`account.json` (the locked vault) are specified in
[01 — Identity](01-identity.md). The list is readable without unlocking;
opening an account needs one of its wraps or the recovery code.

### 14.7 Getting the folder (browser)

*Implementation detail.* The folder comes from `showDirectoryPicker` with
`id: "weave-pod"`, `mode: "readwrite"`, `startIn: "documents"`, which needs a
user gesture. The handle is remembered in IndexedDB (§13); on a later visit
`readwrite` permission is queried, and requested again only from a gesture.
Browsers without the API (Firefox, Safari, mobile) keep data in IndexedDB
instead.

*Source: `src/storage/folder-adapter.ts`, `src/storage/folder-reconcile.ts`,
`src/storage/directory-access.ts`, `src/identity/account-store.ts`,
`cli/src/fs-directory.ts`, `src/node/space-runtime.ts` (watch loop). Tests:
`tests/folder-adapter.test.ts`, `tests/path-safety.test.ts`.*

---

## 15. Sealing at rest

A private space's bodies are encrypted before signing ([03](03-spaces.md)),
but its key sits in the registry of the same folder. So a folder's registry
is sealed under the account's **vault key** (AES-256-GCM, derived from the
seed with HKDF, label `weave-vault-key-v1`, [01 — Identity](01-identity.md)).

Values of entries whose key starts with one of the sealed prefixes —
`space:`, `spacekey:`, `spaceinvite:`, `spacerole:` — are stored as:

```
offset  size  field
0       8     magic  77 65 61 76 65 65 02 00   ("weavee", version 2, 0)
8       12    IV, random per write
20      n+16  AES-GCM ciphertext and tag of the value,
              additional data = UTF-8 of the entry key
```

- A reader MUST refuse (not fall back to raw) a value under a sealed prefix
  that lacks the magic or fails to decrypt. Binding the key as additional
  data means a sealed value moved to another entry does not open.
- Entry keys, other entries, and version bodies are not sealed: a folder
  shows each record's author, timestamp and collection, and anything in a
  public space.

*Source: `src/storage/encrypted-adapter.ts`, `src/node/stores.ts`. Tests:
`tests/account-vault.test.ts` ("encryption at rest").*

---

## 16. Blob stores and mirrors

A **mirror** keeps a space in a dumb file store — a bucket or an app folder —
and syncs with it like a peer that never runs code. This implementation uses
mirrors for carriers ([06](06-nodes-and-sessions.md)).

### 16.1 Blob stores

A blob store keeps bytes by name and is assumed slow, eventually consistent,
and without atomic operations:

| Method | Contract |
|---|---|
| `get(key)` | bytes, or null when absent |
| `put(key, bytes)` | create or replace |
| `delete(key)` | remove; absent is fine |
| `list(prefix)` | every key under `prefix`, any order |
| `changes?(prefix, cursor)` | optional: keys added/removed since `cursor`; not used by the mirror yet |

Drivers:

- **Memory** — for tests.
- **S3-compatible** (R2, B2, MinIO, Wasabi, AWS): path-style URLs
  `<endpoint>/<bucket>/<prefix/><key>`, each `/`-separated part
  `encodeURIComponent`-ed; SigV4-signed (`aws4fetch`), region default
  `auto`; `list` is `ListObjectsV2` (`list-type=2`) following continuation
  tokens; `get` 404 → null; `delete` 404 is success; 429 and 5xx are retried
  up to 5 attempts, waiting `Retry-After` seconds if given, else
  `min(200·2^attempt, 5000) ms` × a random factor in [0.5, 1).

### 16.2 Layout

```
<space id>/
  <writer id>/000001-<hash>.seg     immutable: written once, never changed
  <writer id>/000002-<hash>.seg
  <other writer id>/…
```

A **writer** is one store on one device, with its own random id: 32
lower-case hex characters (128 random bits), never a DID. A writer MUST only
create files under its own `<space id>/<writer id>/` prefix, so nothing is
written twice, overwritten, or needs a lock.

### 16.3 Segment format

A segment is UTF-8 JSON:

```json
{"v":1,"versions":[ <Expression>, … ]}
```

The versions are exactly as on the wire — private bodies still sealed. A
reader MUST treat bytes that are not JSON, or `v` other than `1`, or a
missing `versions` array, as holding nothing; entries that are not objects
with a string `id` are skipped.

Its name is `<counter>-<hash>.seg`: the writer's counter (from 1, decimal,
zero-padded to 6 digits) and the first 8 bytes of SHA-256 of the segment's
bytes, as 16 lower-case hex. The empty segment `{"v":1,"versions":[]}` written
first is `000001-ca1cf99cf9ccaa1b.seg`. Only names ending `.seg` are segments.

> Rationale: the counter sorts a listing for people reading it; the hash
> means a retried upload lands on the same name.

### 16.4 Push, pull, compaction

Writer state (*implementation detail*), in the store `mirrors/<space>/<n>`:
`mirror:writer` (the writer id), `mirror:counter` (decimal), `mirror:read:<segment key>` = `1`
for each segment read or written, `mirror:known:<version id>` = `1` for each
version known to be in the blob store.

**Push.** Soon after a change (5 s after the first by default), and on close:
collect every version the store keeps (§10) that is not known to be in the
blob store; pack them into segments of about 256 KiB (a segment is closed
once it reaches that size); upload each; mark its versions known. "Known" is
everything this writer uploaded **or read**, so nobody re-uploads everyone
else's versions. If the writer then has 32 or more segments, compact.

**Pull.** List `<space id>/`; for every segment not under the writer's own
prefix and not yet read, in name order: fetch it (skip it if it is gone —
its writer compacted it), and run every version through the gatekeeper (§8),
passing over the remainder repeatedly while any go in (versions depend on
each other). Mark each judged version known. Mark the segment read only if
none are still waiting; otherwise it is read again next time.

The blob store is untrusted: it can hide versions (the mesh fills the gap)
but not forge them.

**Compaction.** A writer may rewrite its own segments: read them all, keep
only versions its store still keeps, write those into new segments, **then**
delete the old ones. A reader in between sees duplicates, which are harmless.

**Deleting a space** from a blob store deletes every key under
`<space id>/`.

*Source: `src/storage/blob-store.ts`, `src/storage/blob/memory.ts`,
`src/storage/blob/s3.ts`, `src/storage/segment.ts`, `src/storage/mirror.ts`,
`src/node/space-runtime.ts` ("Mirrors"). Tests: `tests/mirror.test.ts`.*

---

## 17. Constants

| Name | Value | Where |
|---|---|---|
| `SYNC_PROTOCOL_VERSION` | 4 | `v` on every sync message |
| Negentropy version byte | `0x61` | §3 |
| Id size / fingerprint size | 32 / 16 bytes | §3 |
| IdList threshold / buckets | < 32 items / 16 | §3.4 |
| `FRAME_SIZE_LIMIT` | 32,000 bytes (before base64) | §6 |
| Minimum frame limit / headroom | 4,096 / 200 bytes | §3.4 |
| `MAX_IDS_PER_REQUEST` | 200 | `want`, `versions` |
| `stored` ids considered | 2,000 | §4 |
| Collections per hello | 1,000 | §4 |
| Rounds per session | 64 | §6.3 |
| Session stale after | 30 s | §6.3 |
| Heartbeat | 30 s | §6.2 |
| Hello after taking something in | 100 ms | §6.2 |
| Waiting versions / refusals remembered | 1,000 / 10,000 | §8 |
| Folder re-read | 2 s | §14.5 |
| Mirror flush | 256 KiB or 5 s; compact at 32 segments | §16.4 |
| Cache: drop unused after | 30 days, checked every 6 h | §9 |
| Keepers per space | 16 | §9 |

---

## 18. Not yet specified

- **Stale requests.** Sessions silent for 30 s are dropped, but a `want`
  whose answer never comes is not: it keeps the peer "busy" (never `synced`)
  until the peer disconnects.
- **Responder errors.** A responder that cannot parse a `reconcile` sends
  nothing; the initiator's session then goes stale after 30 s.
- **Widening a cache** when too few keepers are online (BLOCK-22) is not
  implemented; a cache only widens as queries use collections.
- **`BlobStore.changes`** is defined but no mirror uses it; pull always lists.
- **Other blob drivers** (Dropbox, OneDrive, Drive app folders) are not
  implemented; only memory and S3-compatible.
- **Member key at rest.** `spacememberkey:` registry entries are not in the
  default sealed prefixes, so a folder copy exposes each space's member key
  in the clear, although it is what new space keys are sealed to
  (`sys.box`, [03](03-spaces.md)). Whether it should be sealed is open.
