# 05 — Sync and storage

How two peers that hold the same space find out which record versions each
lacks and exchange them, and how what a node holds is kept where others can
read it: the store and its entries, the data folder that several clients
share, sealing at rest, and mirrors in dumb file stores. How the library
paces sync and keeps its own stores (IndexedDB, adapters, blob store drivers)
is in [Sync and storage in the library](../packages/core/docs/storage.md).

What a version _is_ (its fields, id, signature, and which of two versions
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
- The set compared is the set of **version ids** a store keeps: every version
  it took in, current and retained ones whole, the rest as stubs (§10). There
  is no tree and no other sync state on disk. A stub and the whole version
  share an id, so sync never tells them apart; a peer sends what it keeps.
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
> (`packages/core/tests/reconcile.test.ts`).

_Source: `packages/core/src/sync/sync-engine.ts`, `packages/core/src/sync/negentropy.ts`. Tests:
`packages/core/tests/reconcile.test.ts`, `packages/core/tests/sync.test.ts`._

---

## 2. Items: what sync compares

An **item** is one kept version, as the pair `(timestamp, id)`:

| Field       | Type                      | Value                                                                                                                                                                                                                               |
| ----------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | 32 bytes                  | The SHA-256 digest inside the version's content id. A version id is `"b"` followed by 52 characters of lower-case RFC 4648 base32 (no padding) of that digest ([02 — Records](02-records.md)); the item id is the decoded 32 bytes. |
| `timestamp` | unsigned integer, seconds | `floor(Date.parse(createdAt) / 1000)` of the version's `createdAt`; `0` when `createdAt` does not parse or is not positive.                                                                                                         |

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

_Source: `packages/core/src/storage/storage-provider.ts` (`syncTime`, `parseItemKey`),
`packages/core/src/utils/hash.ts` (`cidDigest`, `cidOfDigest`). Tests:
`packages/core/tests/reconcile.test.ts` ("content ids as Negentropy ids")._

---

## 3. Negentropy wire format

This is Negentropy protocol version 1 as Nostr uses it (NIP-77), ported from
Doug Hoyte's reference implementation. It is byte-for-byte compatible with
the reference: `packages/core/tests/reconcile.test.ts` pins a 40-item vector produced by
`hoytech/negentropy`'s JavaScript implementation.

### 3.1 Varints

A varint is an unsigned integer in base 128, **most significant group
first**. Every byte but the last has the high bit (`0x80`) set.

| Value      | Bytes            |
| ---------- | ---------------- |
| 0          | `00`             |
| 127        | `7f`             |
| 128        | `81 00`          |
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

| Incoming mode               | Initiator                                                                                                 | Responder                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Skip                        | nothing                                                                                                   | nothing                                     |
| Fingerprint, equal to local | nothing                                                                                                   | nothing                                     |
| Fingerprint, different      | split the local range and send it                                                                         | split the local range and send it           |
| IdList                      | records ids it holds that the list lacks as **have**, ids in the list it lacks as **need**; sends nothing | replies with its own `IdList` for the range |

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

Initiator A holds `id1 = 01 00…00` at 1700000000 and `id2 = 02 00…00` at 1700000005. Responder B holds `id1` and `id3 = 03 00…00` at 1700000009.

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

_Source: `packages/core/src/sync/negentropy.ts`. Tests: `packages/core/tests/reconcile.test.ts`
("Negentropy": reference vector, exact have/need, equal sets, frame limit,
malformed input, sums)._

---

## 4. Sync messages

A sync message is a JSON object. It travels as the `payload` of the network
envelope `{ "type": "sync", "from": <sender session DID>, "payload": … }`
([04 — Network](04-network.md)); this part does not encode it again.

Every message carries `"v": 5` (`SYNC_PROTOCOL_VERSION`). A peer MUST drop a
message that is not an object, whose `v` is not the version it speaks, or
whose `type` is not a string. It MUST NOT answer it.

> Rationale: two versions that cannot reconcile should fail loudly, not leave
> a quiet partial sync.
>
> Version 5 came with the envelope of [02 §3.2](02-records.md): a version
> signs its body's hash, not its body, so a version 4 peer would refuse every
> version a version 5 peer sends.

Ids below are version ids (strings, §2). Byte strings are `base64url`.

### `hello`

"Here is what I hold, and a fingerprint of each collection I keep."

| Field   | Type                       | Meaning                                                                                                                                                     |
| ------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`  | `"hello"`                  |                                                                                                                                                             |
| `holds` | `"all"` \| `string[]`      | Optional. `"all"`, or the collections held besides `sys.*` (§5). Absent means `"all"`.                                                                      |
| `sums`  | `{ [collection]: string }` | For each held collection the sender keeps at least one version of: the collection's fingerprint (§3.3) over all its items, as 32 lower-case hex characters. |
| `reply` | `true`                     | Optional. Marks a hello sent in answer to one; it is never answered by another hello.                                                                       |

Example (fingerprint values illustrative):

```json
{
  "v": 5,
  "type": "hello",
  "holds": "all",
  "sums": {
    "app.todo.item": "2e255099d6d6bee307c8e7075acc78f9",
    "sys.role": "0fc7e595db07fda274b7780656316457"
  }
}
```

A receiver MUST ignore a hello whose `sums` is not an object or names more
than 1000 collections. A `holds` that is neither absent, `"all"`, nor an array
of at most 1000 entries counts as holding only `sys.*`; non-string entries
are ignored.

### `reconcile`

One round of reconciling one collection, initiator to responder.

| Field        | Type          | Meaning                                                                     |
| ------------ | ------------- | --------------------------------------------------------------------------- |
| `type`       | `"reconcile"` |                                                                             |
| `id`         | number        | The session id, chosen by the initiator, echoed in the answer.              |
| `collection` | string        | The collection being reconciled.                                            |
| `message`    | string        | A Negentropy message (§3), base64url. At most 32,000 bytes before encoding. |

### `reconciled`

The responder's answer to one `reconcile`.

| Field     | Type           | Meaning                                                                       |
| --------- | -------------- | ----------------------------------------------------------------------------- |
| `type`    | `"reconciled"` |                                                                               |
| `id`      | number         | The `reconcile`'s `id`.                                                       |
| `message` | string         | The responder's Negentropy message, base64url. `""` when `held` is `false`.   |
| `held`    | `false`        | Optional. The responder does not hold this collection (§5); the session ends. |

### `want`

"Send me these versions."

| Field  | Type       | Meaning                                                                                                                                   |
| ------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `type` | `"want"`   |                                                                                                                                           |
| `id`   | number     | Request id, echoed in the reply.                                                                                                          |
| `ids`  | `string[]` | Version ids. A sender puts at most 200 in one `want`; a receiver serves at most the first 200 and skips entries that are not version ids. |

### `versions`

Versions, as they are on the wire ([02 — Records](02-records.md)).

| Field      | Type           | Meaning                                                                                                                 |
| ---------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `type`     | `"versions"`   |                                                                                                                         |
| `id`       | number         | Present: the answer to the `want` with that id. Absent: versions the sender found the receiver lacks while reconciling. |
| `versions` | `Expression[]` | At most 200.                                                                                                            |

A `want` MUST always be answered with a `versions` carrying its `id`, even
when none of the ids are held (`versions: []`): the asker counts answers to
know it is done.

### `push-update`

| Field        | Type            | Meaning                          |
| ------------ | --------------- | -------------------------------- |
| `type`       | `"push-update"` |                                  |
| `expression` | `Expression`    | A version written just now (§7). |

### `stored`

"I have these now."

| Field  | Type       | Meaning                                                                                                                                                                                                                  |
| ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type` | `"stored"` |                                                                                                                                                                                                                          |
| `ids`  | `string[]` | Ids of versions the sender just took in from the receiver (from `versions` or `push-update`) and that passed its gatekeeper — newly stored or already held. A receiver considers at most the first 2,000 string entries. |

A version the gatekeeper holds back until what it names arrives (its first
version, or the one before it) MUST be acknowledged when it goes in, to the
peer that sent it, as it would be had it gone in at once. The sender would
otherwise not learn it was taken until the next round of sync.

> **Planned: binary sync messages.** Sync messages travel as JSON, and their
> one binary part, the Negentropy `message`, as base64url, a third over its
> size. A binary encoding would save that. It needs a new `v`, since peers
> that disagree on `v` drop each other's messages. Open: which encoding
> (CBOR, or a fixed layout for `reconcile`/`reconciled` only), and whether
> versions inside `versions` stay JSON.

_Source: `packages/core/src/sync/sync-messages.ts`, `packages/core/src/sync/sync-engine.ts`. Tests:
`packages/core/tests/reconcile.test.ts`, `packages/core/tests/sync.test.ts`._

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
library chooses is in
[the node: holding part of a space](../packages/core/docs/node.md#holding-part-of-a-space).

_Source: `packages/core/src/sync/sync-engine.ts` (`Holds`, `holdsCollection`, `readHolds`).
Tests: `packages/core/tests/reconcile.test.ts` ("holding part of a space")._

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

A node MUST send a `hello` (without `reply`):

- as soon as a peer connects;
- whenever what it holds changes (§5).

It SHOULD also say hello to every peer at a regular interval, and soon after
it took in something new from a peer, a folder or a mirror, so a version
passed along does not wait for the next interval at every hop. How often is
the node's own; the library's values are in
[Sync and storage in the library](../packages/core/docs/storage.md#pacing-sync).

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
   `id` and the output of _initiate_ (§3.4), with a frame limit of 32,000
   bytes.
2. On each `reconciled` with the session's `id`:
   - `held: false` ends the session.
   - Otherwise it feeds `message` to its reconciler. A message that fails to
     parse ends the session with an error.
   - It notes the ids in `have` and in `need` not already handled in this
     session, leaving out those refused from this peer before (§8).
   - If the reconciler produced a next message, it sends it as another
     `reconcile` with the same session id. The initiator MAY abandon a
     session that runs to too many rounds.
   - Otherwise the session ends.

   When the session ends, however it ends, the initiator asks for every id
   noted in `need` (below) and sends the versions noted in `have` in
   `versions` messages **without** `id`, at most 200 per message. Both go
   **newest first**: the reverse of the order the rounds found them in, which
   is oldest first. The versions it sends of one record SHOULD go in the same
   message, in the place of that record's newest; a record with more than 200
   to send goes over several, newest first.

   > Rationale: a record's later versions are newer than its first. Sent
   > oldest first, a joining peer would show every deleted or edited record
   > as it first was until the version that changed it arrived — a canvas
   > filling with pixels long since cleared. Newest first, the later version
   > comes first and waits for its first version (§8), and both go in
   > together. But a sender sends every message of a session before it hears
   > a `want`, and versions are ordered by the second they were written, then
   > by id: a burst of deletes can arrive long before the first versions they
   > need, and more of them than a peer keeps waiting. Those pushed out go
   > in without the delete and show until a later round brings it. Sent in
   > one message, a record's versions are taken in at once (§8), and nothing
   > waits.

   **Asking.** A node asks a peer for ids in `want` messages of at most 200
   ids of one collection, each with a fresh request id. How many it keeps
   unanswered at once, and in what order it asks, is its own
   ([Sync and storage in the library](../packages/core/docs/storage.md#pacing-sync)).

3. When a session has ended and every `want` for its collection has been
   answered and none is queued, the collection is **level** with that peer
   (as far as could be taken in). The
   initiator then sends the peer a `hello` with `reply: true`, so the peer
   learns where things stand too without starting another round.

A node MAY give up on a session or a `want` that has heard nothing for a
while. What a dropped `want` asked for is found again on the next round.

### 6.4 Answering (responder)

- On `reconcile`: if the collection is not held, answer `held: false`.
  Otherwise build the item set, run one _answer_ step as responder (§3.4)
  with the 32,000-byte frame limit, and send `reconciled` with the same `id`.
- On `want`: answer with `versions` carrying the same `id` and every asked
  version it holds (first 200 ids only).

Not yet specified: how a responder reports a `reconcile` whose `message` it
cannot parse (§18).

> **Known defect:** a responder that cannot parse a `reconcile` sends no reply
> at all (`packages/core/src/sync/sync-engine.ts`, `onReconcile`), so the initiator waits
> until it gives up on the session (§6.3; 30 s in this library). A fix will
> answer at once.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20).

> **Planned: limits per peer.** Every `hello` and every `reconcile` round
> costs the answering side a pass over a collection's in-memory item set, as
> often as a peer asks. Today only a message (32,000 bytes), a `want` (200
> ids) and a hello (1,000 collections) are bounded by the protocol, and a
> session's rounds by this library. A
> node will also limit, per peer per minute, the hellos it answers and the
> sessions it serves, and the collections one hello may make it compare. A
> peer over its limit is ignored until the minute is out, not disconnected.
> Open: the numbers, and whether a node says it is refusing (so the other
> side does not wait until it gives up). Byte rates per connection
> belong to [04 — Network](04-network.md). Tracked in [#33](https://github.com/leifriksheim/weave/issues/33).

### 6.5 Done

A node is **synced** with a peer when no session and no `want` is in flight
with it, and no id is queued to ask it for.

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

_Source: `packages/core/src/sync/sync-engine.ts` (`onReconciled`, `byRecord`, `want`),
`packages/core/src/node/space-runtime.ts` (peer connect). Tests: `packages/core/tests/reconcile.test.ts`
("sync by reconciliation", "joining, a deleted record never shows as it once
was", "joining, a canvas cleared and half painted again never shows a pixel
that ends cleared", "a want whose answer is lost is given up, and the peer is
synced again"), `packages/core/tests/sync.test.ts`._

---

## 7. Pushing writes live

When a node writes a version locally, it sends `push-update` with that
version to **every** connected peer at once, without waiting for a hello.
The sender does not filter by what the peer holds; the receiver drops what it
does not hold (§5).

A receiver treats the pushed version exactly like one in `versions` (§8),
including answering with `stored` when it takes it in. A push that is lost is
not retried: the next hello finds the difference.

_Source: `packages/core/src/sync/sync-engine.ts` (`onLocalChange`). Tests:
`packages/core/tests/sync.test.ts` ("pushes a local change to a peer")._

---

## 8. Taking in versions

Nothing a peer sends is taken on trust. Before storing a version from a peer,
a folder another writer can reach (§14.5), or a mirror (§16), a node MUST run
it through the validation pipeline of [02 — Records](02-records.md) and the
access rules of [03 — Spaces](03-spaces.md), and MUST NOT store it unless it
passes. Shape (schema conformance) is **not** a reason to refuse a version on
arrival; see 02.

The gatekeeper gives one of three answers:

| Answer  | Meaning                                                                                                                                           | What happens                                                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| valid   | passes                                                                                                                                            | stored (§10)                                                                                                                                                                                                                                                       |
| later   | depends on something not here yet: the record's first version, the version its `prev` names, the definition or access change it was written under | held and tried again whenever another version is stored; asked for again on the next round if still waiting. If it names a first version (`genesis`) or a previous version (`prev`) this node does not hold, that version is asked of the same peer at once (§6.3) |
| invalid | refused                                                                                                                                           | dropped; remembered as refused **from that peer** and not asked of that peer again                                                                                                                                                                                 |

How many versions a node keeps waiting, and how many refusals it remembers,
is its own ([Sync and storage in the library](../packages/core/docs/storage.md#pacing-sync)).

> Rationale: a refusal is keyed on peer and id, not id alone. A version id
> does not cover the signature, so a stranger's mangled copy shares the real
> version's id; refusing the id outright would stop the node fetching the
> genuine one from someone else (`packages/core/tests/attacks.test.ts`).

A batch of versions (one `versions` or `push-update`) is taken in this order:

1. Drop entries that are not objects or have no string `collection`.
2. Drop versions of collections this node does not hold.
3. Sort: `sys.collection` versions first, then by `seq` ascending — what
   others depend on comes first.
4. Run each through the gatekeeper and store what passes.
5. If any were taken in, send the sender `stored` with their ids, then retry
   the waiting versions until no more go in.
6. Ask the sender for the first and previous versions still missing that
   waiting versions name (above).

A `versions` with an `id` is only considered if it answers a `want` this node
has in flight with that peer, and only versions whose `id` was asked for are
taken. A `versions` without `id` is limited to its first 200 entries.

> **Planned: bounding waiting versions.** This library caps the waiting set
> by count ([1,000](../packages/core/docs/storage.md#pacing-sync)) but not by
> size, and every version stored retries all of it. A peer
> can fill it with large versions that never become valid. A node will cap
> the total bytes held waiting, and the retries done per version stored. Open:
> the numbers, and whether waiting versions are counted per peer so one peer
> cannot push out another's. Tracked in [#33](https://github.com/leifriksheim/weave/issues/33).

> **Planned: access convergence** ([#10](https://github.com/leifriksheim/weave/issues/10)).
> A randomized test with several peers, partitions and heals, role changes,
> removals and key changes, asserting that every peer reaches the same access
> state and current versions whatever order versions arrive in, and that
> nothing a removed member wrote after the removal is taken in anywhere. The
> gatekeeper and the `later` retry above are what it exercises.

_Source: `packages/core/src/sync/sync-engine.ts` (`admit`, `admitAll`, `retryWaiting`),
`packages/core/src/node/space-runtime.ts` (`admit`). Tests: `packages/core/tests/sync.test.ts` (forged
expression, no capability, schema), `packages/core/tests/reconcile.test.ts` ("a refused
version is not asked for again", "a version that waits for its first version
asks for it at once"), `packages/core/tests/rules.test.ts` ("an edit that came
before its first version counts once the first version comes"),
`packages/core/tests/attacks.test.ts`._

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

How much a node holds is **its own choice** (§5), and so is when it counts
a write as kept well enough. The library's policy for a node that holds part
of a space (which part, when a query's result is complete, how many keepers a
write waits for, when an unused collection is dropped, and the store keys it
keeps this in) is in
[The node: holding part of a space](../packages/core/docs/node.md#holding-part-of-a-space).

Today a node that holds part of a space cannot check it has everything: it
can only trust the keepers and whole-space peers it was level with. §9.1 plans
a check.

_Source: `packages/core/src/node/space-runtime.ts` ("Holding part of the space"),
`packages/core/src/space/roles.ts` (`Keeper`, `checkKeepers`). Tests: `packages/core/tests/caches.test.ts`, `packages/core/tests/reconcile.test.ts`
("holding part of a space")._

### 9.1 Planned: completeness from signed writer logs

> **Planned** ([#13](https://github.com/leifriksheim/weave/issues/13)). Not
> normative. Replaces the library's definition of **complete**
> ([docs](../packages/core/docs/node.md#holding-part-of-a-space)).

Every writer keeps a signed, append-only log per `(account, writer, space,
collection)`, `sys.*` included; each version carries its writer id, its
position `n`, and a Merkle Mountain Range root over entries `0..n` (new
envelope fields, to be specified in [02 — Records](02-records.md) with the
version format; 02 §4.7 names the overlap). Logs add checks; they
do not change which version wins. What changes here:

- **Heads in `hello`.** Peers exchange the highest signed `(n, root)` they
  hold per log, for the collections both hold.
- **Complete.** A collection is complete when, for every log, taking the
  highest head seen from **any** peer, each entry `0..n` is held, or proven
  superseded by a later version of the same record that is held. Superseded
  entries are the **stubs** a store already keeps (§10), so logs stay
  checkable while bodies are forgotten.
- **What it guarantees.** One keeper can still hide a writer's newest entries
  if no other peer has seen them. Withholding then needs every peer the reader
  syncs with to collude. It is not a guarantee.
- **`prove`.** A new message, `prove { log, n }` → `{ envelope, proof }`,
  serves one version with an MMR proof against a signed head, so a cache can
  check a single record without syncing the collection. Useful on its own.
- **Legacy.** Versions without log fields are accepted, but a collection
  holding any is never complete.

Depends on: the log fields, and a fork rule (two entries at the same `n`
freeze the log, and the proof spreads as a `sys.fork` record), both still to
be written into 02. Open: how heads are
encoded in `hello` without breaking its 1,000-collection bound, and how many
heads a hello may carry.

### 9.2 Planned: caches that fetch by key, and hold subsets

> **Planned.** Not normative. Both need something new on the wire. Widening a
> cache when keepers go missing, and trimming it by size, are a node's own and
> planned in [the docs](../packages/core/docs/node.md#planned-caches-that-widen-and-trim).

- **Links outside what is held.** An `include` without `from` can reach any
  collection. Today it finds only what the node already holds. A cache will
  fetch the linked records by record key, keep them, and not keep them in
  sync; the next run asks again. Sync has no way to ask for a record by key
  (`want` takes version ids), so this needs a message, or `prove` above.
- **Subsets smaller than a collection**, by topic tag ("only the channels I
  opened"), which a blind keeper can serve ([02 — Records](02-records.md),
  topics), or by count: the most recent by each keeper's own arrival order,
  which a writer cannot forge. Never ordered by the writer's clock. A topic
  may bucket a date field the writer chose (`start` → `2026-10`), which is
  acceptable because a bucket only decides what is fetched, never what is
  allowed. Needs `holds` to name more than collections, and sync a way to ask
  for a subset. Tracked in [#27](https://github.com/leifriksheim/weave/issues/27).

---

## 10. The store

A space's store holds record versions, and small **entries** (key → value)
saying which is which. Every entry value below is the UTF-8 of a version id.

| Entry key                    | Present for                                     | Names                                                                                                            |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `r/<record key>`             | every record                                    | its current version (possibly a delete)                                                                          |
| `g/<record key>`             | a record that has been edited                   | its first version (`seq` 0)                                                                                      |
| `h/<record key>/<seq>/<id>`  | a superseded version its writer marked `retain` | that version, whole; `seq` is decimal, zero-padded to 15 digits                                                  |
| `i/<collection>/<time>/<id>` | every version kept, whole or a stub             | that version; `<collection>` is `encodeURIComponent(collection)`, `<time>` is the item timestamp (§2) in decimal |

A version is stored **whole** if it is current or retained, and otherwise as
a **stub**, without its body ([02 §4.5](02-records.md)).

Record keys contain no `/` ([02](02-records.md)). The `i/` entries are the
only sync state: the item set of a collection is exactly the parseable `i/`
entries for it. An `i/` entry whose id is not a version id, whose time is not
a non-negative safe integer, or that has more than four `/`-separated parts is
ignored.

### 10.1 Placing a version

Taking in version `V` of record `k` is idempotent, and the same set of
versions gives the same entries in any arrival order:

1. If `r/k` already names `V`: if the store holds `V` as a stub and this
   copy is whole, keep this copy. Stop.
2. Let `C` be the version `r/k` names, if any. If `C` exists and `V` does not
   supersede `C` (the ordering rule, [02 — Records](02-records.md)), **demote**
   `V` against `C`, and stop.
3. Otherwise keep `V`, set `r/k = V`, and if `C` exists, demote `C` against
   `V`.

**Demote** a version `D` against the current `W`:

- If `D.retain`: keep `D` whole (if `D` came as a stub and the store holds
  the whole of it, keep that), and set its `h/` entry.
- Otherwise keep `D`'s stub.
- If `D.seq == 0` and `W.seq > 0` (a first version): let `G` be what `g/k`
  names. If there is no `G`, or `D.id < G` (string comparison), set
  `g/k = D`.

**Keep** writes the version (whole or its stub), unless the store holds it
already in the same form, and its `i/` entry. Keeping a stub over a whole
version replaces it: the body is deleted. **Drop** removes a version's `i/`
entry and deletes it; only removing (below) drops. The writes of one
placement land together or not at all: with an adapter that can write
atomically ([`commit`](../packages/core/docs/storage.md#storage-adapters)), versions, entries and deletes in one atomic write; without, versions
first, then the entries in one batch, then the deletes, so no entry ever
names a version that is not there.

> Rationale: the first version decides who created the record — the lowest id
> wins if several devices each created the same chosen key. It is kept as a
> stub like any other version, unless retained.

**Removing** a version (used when a folder file vanished, §14.5, or a
collection is dropped, §9) unsets `r/k` and `g/k` if they name it, unsets its
`h/` entry, and drops it. It does not promote an older version.

Changes to one store are applied one at a time, never interleaved, each
seeing the ones before it. Those that come in while earlier ones are landing
land together, as one write: a burst of writes costs a few writes to the
adapter, not one each. A change that fails leaves nothing of itself in the
write and does not stop the others.

### 10.2 In memory

A node may keep what it read from a store in memory. When another writer
changed the same store (another tab, another origin or device on a shared
folder, §14.5) the node MUST read it again before it trusts what it kept. How
this library caches a store, tells other tabs, and computes the fingerprint it
shows in status is in
[Sync and storage in the library](../packages/core/docs/storage.md#the-store-in-memory).

_Source: `packages/core/src/storage/storage-provider.ts` (`change`, `land`, `invalidate`), `packages/core/src/records/version.ts`. Tests:
`packages/core/tests/versions.test.ts` ("a store of versions"), `packages/core/tests/reconcile.test.ts`
("a superseded version stays in the set as a stub", "a store written by someone else is
read again once told", "changes that come in while one lands land together;
one that fails leaves nothing")._

---

## 11. Storage adapters

Not protocol: how a store reaches its bytes is the library's interface, and
only one node reads it. The adapter contract is in
[Sync and storage in the library](../packages/core/docs/storage.md#storage-adapters).

---

## 12. Stores a node opens

A node opens stores **by path**, and a store factory maps a path to an
adapter:

| Path                     | Holds                                                            | Sealed (§15)                     |
| ------------------------ | ---------------------------------------------------------------- | -------------------------------- |
| `registry`               | the spaces this node holds, and their keys                       | yes, on a node given a vault key |
| `spaces/<space id>`      | one space: §10 entries and bodies, and what the node keeps on it | no                               |
| `mirrors/<space id>/<n>` | a mirror's writer state (§16.4); `n` is the mirror's index       | no                               |

Other entries a node keeps in a space's store, and what a mirror's writer
keeps in its store, are the node's own (the library's are in
[the node](../packages/core/docs/node.md#holding-part-of-a-space) and
[mirrors](../packages/core/docs/storage.md#mirrors)).

**Registry entries.** One space's registry entries, each keyed by space id:

| Key                   | Value                                                                                                           | Sealed by default          |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `space:<id>`          | UTF-8 JSON of the `Space` ([03](03-spaces.md))                                                                  | yes                        |
| `spacekey:<id>`       | UTF-8 JSON `{ "keys": [{ "id", "raw" (base64url AES-256 key), "createdAt", "version" }], "current": <key id> }` | yes                        |
| `spaceinvite:<id>`    | UTF-8 base64url of an invite secret, until used                                                                 | yes                        |
| `spacerole:<id>`      | UTF-8 role name this account last held (a listing hint)                                                         | yes                        |
| `spacememberkey:<id>` | UTF-8 base64url of this account's member key for the space                                                      | **no** — known defect, §15 |
| `spacerelays:<id>`    | UTF-8 JSON array of relay URLs                                                                                  | no — known defect, §15     |

Forgetting a space deletes all six.

In a data folder, a store at a path is a folder adapter (§14) at
`<dataPath>/<path>`, and the `registry` store is sealed under the account's
vault key (§15). Where a node keeps its stores otherwise (IndexedDB, and a
host's own store) is its own; the library's naming is in
[Sync and storage in the library](../packages/core/docs/storage.md#indexeddb).

_Source: `packages/core/src/node/stores.ts`, `packages/core/src/session/places.ts` (`storesFor`),
`packages/core/src/space/space-manager.ts`, `packages/core/src/node/node.ts`, `packages/core/src/node/space-runtime.ts`.
Tests: `packages/core/tests/account-vault.test.ts` ("encryption at rest"),
`packages/core/tests/node.test.ts`._

---

## 13. IndexedDB adapter

Not protocol: only the origin that wrote an IndexedDB database reads it. The
library's databases, object stores and transactions are in
[Sync and storage in the library](../packages/core/docs/storage.md#indexeddb).

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

| Key                               | File name                               |
| --------------------------------- | --------------------------------------- |
| `r/k3x9q2abcd`                    | `r%2Fk3x9q2abcd`                        |
| `i/app.todo.item/1700000000/bae…` | `i%2Fapp.todo.item%2F1700000000%2Fbae…` |
| `space:bafy…`                     | `space%3Abafy…`                         |

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

A writer SHOULD replace a file atomically: write it under a name ending in
`.tmp`, then rename it into place. How the library does it is in
[Sync and storage in the library](../packages/core/docs/storage.md#data-folders).

### 14.4 Safety

A folder may be synced or shared, so its contents are not necessarily this
device's writes. A client MUST NOT let a name read from the folder reach
outside it: names equal to `""`, `.`, `..`, or containing `/`, `\` or NUL are
refused as path segments, and symbolic links are neither followed nor listed.

### 14.5 Convergence without locks

There is no lock file. Version files are immutable and content-addressed, so
two writers either write different files or identical ones. The entries are
derived state, and the rule is: **the set of version files wins.**

Any client sharing a folder SHOULD re-read it periodically while a space is
open, and reconcile:

1. List `expressions/`. Note files that appeared since the last pass and files
   that vanished. If anything moved, read the store again (§10.2).
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

Not protocol: how a client gets hold of the folder is its own. The library's
use of `showDirectoryPicker` is in
[Sync and storage in the library](../packages/core/docs/storage.md#data-folders).

_Source: `packages/core/src/storage/folder-adapter.ts`, `packages/core/src/storage/folder-reconcile.ts`,
`packages/core/src/identity/account-store.ts`,
`packages/cli/src/fs-directory.ts` (path safety). Tests:
`packages/core/tests/folder-adapter.test.ts`, `packages/cli/tests/path-safety.test.ts`._

---

## 15. Sealing at rest

A private space's bodies are encrypted before signing ([03](03-spaces.md)),
but its key sits in the registry of the same folder. So a folder's registry
is sealed under the account's **vault key** (AES-256-GCM, derived from the
seed with HKDF, label `weave-vault-key-v1`, [01 — Identity](01-identity.md)).

Values of entries whose key starts with one of the sealed prefixes —
`space:`, `spacekey:`, `spaceinvite:`, `spacerole:`, `spacememberkey:`,
`spacerelays:` — are stored as:

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

Every registry entry of §12 that belongs to one space is sealed.

Folders written before `spacememberkey:` and `spacerelays:` were sealed hold
them in the clear. A reader that finds no entry `sealed:v1` MUST seal every
entry under those two prefixes that lacks the magic, then write `sealed:v1`
(sealed, value `01`), before it reads any of them. After that, those two
prefixes are refused in the clear like the rest.

_Source: `packages/core/src/storage/encrypted-adapter.ts` (`DEFAULT_ENCRYPTED_PREFIXES`, `createEncryptedAdapter`), `packages/core/src/node/stores.ts`. Tests:
`packages/core/tests/account-vault.test.ts` ("encryption at rest")._

---

## 16. Blob stores and mirrors

A **mirror** keeps a space in a dumb file store — a bucket or an app folder —
and syncs with it like a peer that never runs code. This implementation uses
mirrors for carriers and hosts ([06](06-nodes-and-sessions.md)).

### 16.1 Blob stores

A blob store keeps bytes by name (a key, `/`-separated) and is assumed slow,
eventually consistent, and without atomic operations: a mirror asks it only
to get, put, delete and list keys under a prefix. How a node talks to one
(the library's interface and its drivers) is not protocol; see
[Sync and storage in the library](../packages/core/docs/storage.md#blob-stores).

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

A host keeps its subscriptions in the same bucket, outside any space, under
`host/subscriptions/` ([06](06-nodes-and-sessions.md)). A mirror carries
spaces and nothing else: never an account file, whose wraps could be attacked
offline by anyone holding the store.

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

A writer keeps what it needs to remember (its writer id, its counter, the
segments it has read, the versions it knows are in the blob store) in its own
store (§12); the library's keys are in
[Sync and storage in the library](../packages/core/docs/storage.md#mirrors).

**Push.** After local changes, and on close: collect every version the store
keeps (§10) that is not known to be in the blob store; pack them into
segments; upload each; mark its versions known. "Known" is everything this
writer uploaded **or read**, so nobody re-uploads everyone else's versions.
When and how big is the writer's own.

**Pull.** List `<space id>/`; for every segment not under the writer's own
prefix and not yet read, in name order: fetch it (skip it if it is gone —
its writer compacted it), and run every version through the gatekeeper (§8),
passing over the remainder repeatedly while any go in (versions depend on
each other). Mark each judged version known. Mark the segment read only if
none are still waiting; otherwise it is read again next time.

The blob store is untrusted: it can hide versions (the mesh fills the gap)
but not forge them.

**Compaction.** A writer may rewrite its own segments: read them all, keep
only versions its store still keeps, write its store's copy of each into new
segments (a stub where the store holds one, so a superseded body is not
carried forward), **then** delete the old ones. A reader in between sees
duplicates, which are harmless.

**Deleting a space** from a blob store deletes every key under
`<space id>/`.

_Source: `packages/core/src/storage/segment.ts`, `packages/core/src/storage/mirror.ts`,
`packages/core/src/node/space-runtime.ts` ("Mirrors"), `packages/core/src/node/host.ts`. Tests:
`packages/core/tests/mirror.test.ts`._

### 16.5 Planned: mirrors in your own storage

> **Planned.** Not normative. The rest of the mirror design that other
> writers must agree on. Mirrors on any node, change feeds, more drivers and
> the request budget they must fit are the library's, planned in
> [Sync and storage in the library](../packages/core/docs/storage.md#planned-mirrors-in-your-own-storage).

- **Restore.** The account registry is a space, sealed under a key from the
  seed, so it mirrors like any other. Recovery code, then connect storage, and
  every space comes back. Segments are **not** sealed with the space key: a
  blind host that must read the store to restart would then need the key.
- **Absorbing a quiet writer.** A lost phone leaves its folder forever. Any
  writer MAY absorb a writer whose newest segment is older than
  `absorbAfterDays` (default 30): copy the versions its own store still keeps
  from one of that writer's segments into a new segment of its own, then
  delete that segment. Safe because segments never change; two writers
  absorbing the same segment write the same versions, which is harmless.
  Together with compaction, this is the only deleting there is. Open: how to
  date a segment without trusting the store's modified times, which services
  report differently.
- **Files and avatars** fit the same store later, as
  `<space id>/files/<hash>`: content-addressed and immutable, so any writer
  may write the same one. Not designed further.

Open: mirrors laid out per collection, so a node holding part of a space
(§9) could read only what it holds; today only whole-space nodes mirror.

### 16.6 Planned: files

> **Planned.** Not normative. Issue:
> [#37](https://github.com/leifriksheim/weave/issues/37). Records cannot
> carry file bytes today; `std.attachment` has only a `url`, outside the
> space's access rules and sync. The plan is a **blob reference** in a body,
> `{ hash, size, mime, name? }`, where `hash` is the SHA-256 of the bytes as
> stored. The bytes are stored and synced by hash, apart from records, and
> fetched only when wanted; the fetcher checks the hash. In a private space
> they are encrypted under the space key before hashing, so keepers and
> mirrors hold ciphertext. Bytes no current record references may be dropped.
> _Open:_ how a peer asks for bytes it lacks (the sync connection, a host, a
> mirror); chunking large files so they resume and don't hold up a sync
> round; which key when the space key changes; limits per blob and per space.

---

## 17. Constants

The values a peer relies on. Timers, caps and sizes a node keeps for itself
are in [Sync and storage in the library](../packages/core/docs/storage.md#pacing-sync).

| Name                           | Value                        | Where                     |
| ------------------------------ | ---------------------------- | ------------------------- |
| `SYNC_PROTOCOL_VERSION`        | 5                            | `v` on every sync message |
| Negentropy version byte        | `0x61`                       | §3                        |
| Id size / fingerprint size     | 32 / 16 bytes                | §3                        |
| IdList threshold / buckets     | < 32 items / 16              | §3.4                      |
| `FRAME_SIZE_LIMIT`             | 32,000 bytes (before base64) | §6                        |
| Minimum frame limit / headroom | 4,096 / 200 bytes            | §3.4                      |
| `MAX_IDS_PER_REQUEST`          | 200                          | `want`, `versions`        |
| `stored` ids considered        | 2,000                        | §4                        |
| Collections per hello          | 1,000                        | §4                        |
| Keepers per space              | 16                           | §9                        |

---

## 18. Not yet specified

- **Responder errors.** How a responder reports a `reconcile` it cannot
  parse. See the known defect in §6.4.
- **Member key at rest.** How to move `spacememberkey:` and `spacerelays:`
  entries written unsealed to sealed ones. See the known defect in §15.
