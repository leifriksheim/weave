# 02 — Records

A **record** is a signed, versioned JSON document in a **collection** of a
**space**. This part says exactly what one looks like, how it is encoded,
hashed and signed, which of its versions counts, how records point at each
other, how a space describes its collections and their rules, and what a
peer checks before it keeps one.

Out of scope here, and specified elsewhere:

- Keys, DIDs and the UCAN delegations carried in `proof`: [01 — Identity](01-identity.md).
- Roles, the access history that `seen` refers to, encrypted bodies and space keys: [03 — Spaces](03-spaces.md).
- How versions travel and how they are stored: [05 — Sync and storage](05-sync-and-storage.md).
- Not protocol, and described in the package docs instead: querying records
  ([query format](../packages/core/docs/query-format.md)), the optional standard collections
  ([standard library](../packages/core/docs/standard-library.md)), and apps kept in a space,
  their review and their screens ([apps as records](../packages/core/docs/apps-as-records.md)).

**Terms.** An _expression_ is one signed version of a record — the unit that is
hashed, signed, stored and synced. A _record_ is every expression that shares
one `key` in a space. The _author_ is the key that signed an expression
(usually a session key); the _root_ is the account that key acts for, found by
walking its `proof` ([01 — Identity](01-identity.md)), or the author itself when
there is no proof.

---

## 1. Canonical JSON

Every hash of, and every signature over, a JSON value in Weave is over its
**canonical form**, defined here. The canonical form of a value is a string;
its bytes are that string in UTF-8.

A value is first read as the JSON data model: objects, arrays, strings, numbers
as IEEE 754 binary64, `true`, `false`, `null`. Then:

| Value            | Canonical form                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `null`           | `null`                                                                                                                                                                                                                                                                                                                                                         |
| `true` / `false` | `true` / `false`                                                                                                                                                                                                                                                                                                                                               |
| number           | The ECMAScript `Number::toString` form of the binary64 value: shortest round-tripping digits, `-0` → `0`, exponent form from `1e21` upward (`1.5e+21`) and below `1e-6` (`1e-7`). NaN and ±Infinity cannot occur in JSON.                                                                                                                                      |
| string           | As ECMAScript `JSON.stringify` writes it: in double quotes; `"` → `\"`, `\` → `\\`; U+0008, U+0009, U+000A, U+000C, U+000D → `\b` `\t` `\n` `\f` `\r`; other code points below U+0020 → `\u00xx` with **lower-case** hex; a lone surrogate → `\udxxx` in lower-case hex; every other character, including `/`, non-ASCII and U+2028/U+2029, written as itself. |
| array            | `[` + canonical forms of the elements, in order, separated by `,` + `]`                                                                                                                                                                                                                                                                                        |
| object           | `{` + `"name":value` pairs, separated by `,`, members sorted by name in ascending order of **UTF-16 code units**, + `}`. Names are encoded as strings (above).                                                                                                                                                                                                 |

No whitespace appears anywhere outside strings.

- A producer MUST NOT emit an object with two members of the same name. (What
  a reader does with one is not specified; this implementation keeps the last.)
- Because the form is computed from the _parsed_ value, how a value was
  formatted on the wire does not matter: `1.0`, `1` and `1e0` are the same
  number and hash the same. A reader in a language whose JSON numbers are not
  binary64 MUST convert them to binary64 before canonicalizing, or hashes will
  differ for numbers that do not survive the round trip.
- _Implementation detail:_ the reference `canonicalize()` also accepts
  JavaScript values that JSON cannot carry (an object member whose value is
  `undefined` is left out; `undefined` in an array becomes `null`). Nothing on
  the wire depends on this.

For every value that is valid I-JSON (RFC 7493: no lone surrogates, no
duplicate names), this is the same output as the JSON Canonicalization Scheme,
RFC 8785 — same number form, same string escaping, same member order.

**Example.** The value

```json
{ "b": [1, "x", null, true, { "c": 1.5e21 }], "a": "é\ud800", "B": -0, "10": 1, "9": 2, "Z": 0.1 }
```

has canonical form

```
{"10":1,"9":2,"B":0,"Z":0.1,"a":"é\ud800","b":[1,"x",null,true,{"c":1.5e+21}]}
```

(`"10"` sorts before `"9"`: names compare as strings, not numbers; upper case
sorts before lower case.)

> Rationale: sorted keys and no whitespace are the smallest rule that makes two
> independent writers produce the same bytes. Reusing ECMAScript's number and
> string output means a browser gets it from `JSON.stringify` for free.

_Source: `packages/core/src/schema/expression.ts` (`canonicalize`). Tests: `packages/core/tests/validation.test.ts`, `packages/core/tests/versions.test.ts` (ids and signatures depend on it throughout)._

---

## 2. Content ids

The **id** of an expression, and the content id of anything else hashed the
same way (a space's genesis, a UCAN note in [01](01-identity.md) and
[03](03-spaces.md)), is:

```
id = "b" ‖ lowercase( base32( SHA-256( bytes ) ) )
```

- `base32` is the RFC 4648 §6 alphabet (`A–Z2–7`), **without padding**,
  written in lower case.
- 32 bytes of digest give 52 base32 characters, so an id is always **53
  characters**: `b` followed by 52 of `[a-z2-7]`. The last character carries
  1 bit of the digest; its 4 low bits are zero.
- For an expression, `bytes` is the UTF-8 of the canonical form of its signed
  part (§3.2).

A reader decoding an id back to its digest MUST refuse anything that is not
53 characters starting with `b`, contains a character outside the alphabet
(either case is accepted), or has non-zero padding bits.

The leading `b` is the multibase prefix for base32, but an id is **not** a
CIDv1: there is no version, codec or multihash prefix before the digest.

Example: `bh7mi3b35uek5zf46drxzvkhqopnu3z2y3dp3r6din5zfbubiro2a` (the id of the
expression in §3.4).

_Source: `packages/core/src/utils/hash.ts` (`cidFromBytes`, `cidDigest`, `cidOfDigest`, `base32Encode`, `base32Decode`), `packages/core/src/schema/expression.ts` (`getExpressionId`). Tests: `packages/core/tests/validation.test.ts` ("rejects an id that does not match the content"), `packages/core/tests/sync.test.ts`._

---

## 3. Expressions

### 3.1 Fields

An expression is a JSON object with these members. Optional members are
**absent** when they do not apply — never `null`, never `false`, never an empty
list unless a list is meant (an absent member and a present one hash differently).

| Field        | Type     | Req.       | Meaning                                                                                                                                                                                                     |
| ------------ | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | string   | yes        | Content id of the signed part (§2). Not itself signed.                                                                                                                                                      |
| `author`     | string   | yes        | The `did:key` of the P-256 key that signed ([01 — Identity](01-identity.md)).                                                                                                                               |
| `collection` | string   | yes        | The collection the record is in, e.g. `app.todo.item`.                                                                                                                                                      |
| `space`      | string   | in a space | Id of the space it belongs to. Signed, so it cannot be replayed into another space. A peer MUST refuse an expression whose `space` is not the space it arrived for.                                         |
| `createdAt`  | string   | yes        | ISO 8601 time the writer's clock gave, e.g. `2026-09-26T12:00:00.000Z`. Decides no ordering (§4.3); used for judging the delegation (§9.3), for display, and as a sync hint ([05](05-sync-and-storage.md)). |
| `body`       | any JSON | yes        | The content. `null` on a delete. In a private space, an encryption envelope `{ "ciphertext", "iv", "keyId" }` ([03 — Spaces](03-spaces.md)).                                                                |
| `proof`      | string   | no         | Encoded UCAN delegating to `author` the right to write here ([01 — Identity](01-identity.md)). Absent when the author signs for itself.                                                                     |
| `key`        | string   | yes        | The record's identity within the space, stable across versions (§4.1).                                                                                                                                      |
| `seq`        | integer  | yes        | `0` for the first version; each later version one more than the one it replaces.                                                                                                                            |
| `prev`       | string   | seq > 0    | Id of the version this one replaces.                                                                                                                                                                        |
| `genesis`    | string   | seq > 0    | Id of the record's first version.                                                                                                                                                                           |
| `retain`     | `true`   | no         | Keep this version after it is superseded (§4.5).                                                                                                                                                            |
| `seen`       | string[] | no         | Ids of the latest changes to the space's access history the writer knew of; the version is judged as of those ([03 — Spaces](03-spaces.md)). At most 64, each 1–128 characters.                             |
| `deleted`    | `true`   | no         | This version deletes the record; `body` MUST be `null`.                                                                                                                                                     |
| `links`      | Link[]   | no         | What this record points at (§5). Public spaces only; in a private space links are sealed inside the body and this member is absent.                                                                         |
| `tags`       | string[] | no         | Blind topic tags (§8).                                                                                                                                                                                      |
| `signature`  | string   | yes        | base64url (no padding) of the 64-byte ECDSA P-256 / SHA-256 signature, IEEE P1363 form (r ‖ s), over the signed part.                                                                                       |

A reader MUST keep and re-hash every member it receives, including ones it does
not know: the signed part is "everything except `id` and `signature`" (§3.2),
not a fixed list.

_Implementation detail:_ the reference writer always includes `seen` on
records written in a space (possibly `[]`), and never includes an empty `links`
or `tags`.

### 3.2 What is signed

The **signed part** of an expression is the expression with the `id` and
`signature` members removed — every other member, known or not.

```
signed   = expression − { id, signature }
payload  = UTF-8( canonical( signed ) )
id       = "b" ‖ base32lower( SHA-256( payload ) )
signature = base64url( ECDSA-P256-SHA256-sign( authorKey, payload ) )    // 64 bytes, r ‖ s
```

The id does not cover the signature, and ECDSA signatures are not unique (a
signer may produce many valid signatures, and a third party can turn one valid
signature into another). So two copies with the same `id` can carry different
signatures, one valid and one not. A peer:

- MUST verify the signature of each copy it receives, not trust an id it has
  seen before;
- MUST NOT let a refused copy cause a later copy with the same id, from anyone,
  to be refused (see §9.5);
- MAY cache a _passing_ verdict under the pair (`id`, `signature`).

### 3.3 Signing and verifying

To sign: build the signed part, canonicalize it, sign the UTF-8 bytes with the
author's private key, compute the id from the same bytes, and emit
`{ id, ...signed, signature }`.

To verify, in this order:

1. Recompute the id from the signed part. If it differs from `id`, the
   expression is invalid.
2. Resolve `author` to a P-256 public key ([01 — Identity](01-identity.md)). If
   it cannot be resolved, the expression is invalid.
3. base64url-decode `signature` and verify it over the payload. If it does not
   verify, the expression is invalid.

Whether the author was _allowed_ to write is a separate question (§9.3–9.4).

### 3.4 Example

A first version of a to-do, in a public space, signed by the key derived from
the 16-byte seed `07 07 … 07` ([01 — Identity](01-identity.md)), with no
delegation. Signed part, canonical (one line in reality, wrapped here only
between members):

```
{"author":"did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ",
"body":{"done":false,"text":"Buy milk"},"collection":"app.todo.item",
"createdAt":"2026-09-26T12:00:00.000Z","key":"mfrggzdfmztwq2lknnwg23tpoa",
"links":[{"rel":"about","to":"list.groceries"}],
"seen":["b2adwpfsyvp6w5qyvo54kgtomdh4iqdg5xhrwwyva7qq54lh74gpq"],"seq":0,
"space":"bimjoifogypbqrtuich3e375d67y43znkjsjnp4q4qhe7gwf7u74a"}
```

The expression:

```json
{
  "id": "bh7mi3b35uek5zf46drxzvkhqopnu3z2y3dp3r6din5zfbubiro2a",
  "author": "did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ",
  "collection": "app.todo.item",
  "body": { "text": "Buy milk", "done": false },
  "createdAt": "2026-09-26T12:00:00.000Z",
  "space": "bimjoifogypbqrtuich3e375d67y43znkjsjnp4q4qhe7gwf7u74a",
  "key": "mfrggzdfmztwq2lknnwg23tpoa",
  "seq": 0,
  "seen": ["b2adwpfsyvp6w5qyvo54kgtomdh4iqdg5xhrwwyva7qq54lh74gpq"],
  "links": [{ "rel": "about", "to": "list.groceries" }],
  "signature": "KJsCE7NIyImnYm7sEUTc7s1C6ZavuFKd0-dEUTwPK3v3zoxGhQHhd2MqYTECYf2ux8PbjdLcsi8QjyPXQDSanw"
}
```

Member order on the wire is irrelevant. The id is reproducible from the
canonical text above; the signature is not (ECDSA uses a fresh nonce), but any
valid signature verifies.

_Source: `packages/core/src/types.ts` (`Expression`, `UnsignedExpression`, `Link`), `packages/core/src/schema/expression.ts` (`createExpression`, `signedPart`, `getExpressionId`), `packages/core/src/schema/signer.ts`, `packages/core/src/validation/crypto-gate.ts`. Tests: `packages/core/tests/validation.test.ts` ("crypto gate"), `packages/core/tests/identity.test.ts` ("expressions signed by an identity verify against its DID"), `packages/core/tests/links.test.ts` ("links are signed"), `packages/core/tests/attacks.test.ts` ("a stranger sending a mangled copy first…")._

---

## 4. Versions

### 4.1 Keys

A record keeps one `key` for life, and links point at keys (§5), so a comment
stays on a to-do however often the to-do changes.

- A key MUST match `^[a-z0-9:._-]{1,128}$`.
- Keys are unique within a **space**, not within a collection. A later version
  whose `collection` differs from its record's first version is ignored by
  readers (§4.6).
- A fresh key is 16 random bytes (128 bits), base32 lower case without padding:
  26 characters of `[a-z2-7]`, e.g. `mfrggzdfmztwq2lknnwg23tpoa`. Writers SHOULD
  use fresh random keys unless the key is chosen or derived for a reason.
- A key MAY be chosen, for a record there is one of by nature (`profile`).
  The protocol derives some itself: `collection:<name>` for a definition (§6),
  `one:<hex>` under a `onePer` rule (§7.3), and the access-history keys of
  [03 — Spaces](03-spaces.md) (`role:…`, `member:…`, `invite:…`, `revoke:…`).

> Rationale: random rather than time-based, so a key says nothing about when
> the record was made.

### 4.2 Version fields

| Version | `seq`              | `prev`                        | `genesis`                                          |
| ------- | ------------------ | ----------------------------- | -------------------------------------------------- |
| first   | `0`                | absent                        | absent                                             |
| later   | previous `seq` + 1 | id of the version it replaces | id of the first version (for seq 1 that is `prev`) |

The next version after `current` has `key = current.key`,
`seq = current.seq + 1`, `prev = current.id`, and
`genesis = current.seq == 0 ? current.id : current.genesis`.

A writer MUST derive the next version from the version it currently holds as
current — including a delete — so re-creating a deleted key produces the
version after the delete, not a new `seq 0`.

### 4.3 Which version wins

Of two versions `a` and `b` of the same key, **`a` supersedes `b` if and only if**

```
a.seq > b.seq   or   ( a.seq == b.seq  and  a.id < b.id )
```

where `a.id < b.id` compares the id strings character by character (all ids
are ASCII, so this is also byte order). The **current version** of a record is
the one no other held version supersedes.

- Every peer MUST use exactly this rule. `createdAt` MUST NOT affect it.
- Consequences: a replayed old version loses to the current one; a delete
  (which has a higher `seq`) stays deleted when an older version turns up; two
  devices that edited apart pick the same winner; the same set of versions,
  received in any order, gives the same current version.
- A writer MUST set `prev` and `seq` as in §4.2. How a reader checks them is
  not yet specified (§4.6).

> **Known defect:** readers never check `prev` and accept `seq` gaps, so a
> writer allowed to edit a record can skip to any higher `seq` and win under
> this rule. Nothing in the reference implementation reads `prev`
> (`packages/core/src/records/version.ts`). A fix will bind a later version to the version
> it names in `prev`; other implementations MUST NOT rely on gaps being accepted.
> Planned in §4.7.
> Tracked in [#14](https://github.com/leifriksheim/weave/issues/14).

> Rationale: no clock is trusted, because every clock is whatever its writer
> typed. The rule is load-bearing forever — two peers running different rules
> would disagree about what is current.

### 4.4 Deletes

A delete is an ordinary later version with `deleted: true` and `body: null`. It
carries no `links` and no `tags`. It is judged under the collection's `delete`
rule (§7). Writing the key again produces the next version after the delete,
judged as an **edit** (only `seq 0` is a create).

A delete hides a record; it does not forget what the record said. The first
version is kept (§4.5) and synced ([05](05-sync-and-storage.md)), so a peer
that was offline, or a member who joins later, still receives the deleted
content beside the delete. Deletes that forget are planned in §4.9.

### 4.5 What is kept: `retain` and history `all`

When a version is superseded, a peer keeps it only if:

- it is the record's **first version** (`seq 0`) — kept as proof of who
  created the record. If several `seq 0` versions exist for one key (two devices
  chose the same key), the one with the lowest id is kept as the first version;
  or
- it carries `retain: true`.

Everything else superseded is dropped. `retain` is decided by the **writer**
and signed; readers never decide it from their own view of the definition.

A writer MUST set `retain: true` when:

- the collection's definition in force says `history: "all"` (§6); or
- the collection is one of the access-history collections (`sys.role`,
  `sys.member`, `sys.invite`, `sys.revoke`, `sys.collection`, `sys.key`,
  `sys.relays`, `sys.keepers`) — a peer MUST refuse a version of one of these
  without `retain` ([03 — Spaces](03-spaces.md)).

_Implementation detail:_ the reference writer also sets `retain` on
`sys.profile`, `sys.box` and `sys.memberkey`.

A record whose versions all carry `retain` has a verifiable history: listed
newest first by §4.3, each version's `prev` is the id of the next one, and each
verifies on its own.

> Rationale: if each reader decided from the definition it happened to have
> seen, two peers would keep different sets of versions and never converge.

### 4.6 Shape of a version, alone

A peer MUST refuse, on arrival, a version that fails any of these — all
decidable from the version alone:

1. `key` is a string matching §4.1.
2. `seq` is an integer, `0 ≤ seq ≤ 2^53 − 1`.
3. If `seq == 0`: `prev` and `genesis` are absent.
4. If `seq > 0`: `prev` and `genesis` are strings, and neither equals the
   version's own `id`.
5. `seen`, if present, is a list of at most 64 strings, each 1–128 characters.
6. `deleted`, if present, is `true`; `retain`, if present, is `true`.
7. If `deleted`, `body` is `null`.
8. `links`, if present, is well formed (§5.1).

Checks that depend on what else a peer holds are **not** shape checks:

- A later version's first version is looked up by the id in `genesis`. It
  counts only if it has `seq 0`, the same `key` and the same `collection`;
  otherwise the version is refused ("the first version it names is not this
  record's"). If it is not held yet, judging waits (§9.5).
- A current version whose `collection` differs from the record's held first
  version is ignored when reading, as if absent.

_Not yet specified:_ whether `prev` must name a held version, and whether a
`seq` may skip. See the known defect in §4.3, and the plan in §4.7.

_Source: `packages/core/src/records/version.ts` (`newRecordKey`, `supersedes`, `byVersion`, `nextVersion`, `checkVersionShape`, `MAX_SEEN`), `packages/core/src/records/key.ts` (`RECORD_KEY_PATTERN`), `packages/core/src/storage/storage-provider.ts` (`addExpression`, `demote`, `keepOrDrop`), `packages/core/src/node/space-runtime.ts` (`firstOf`, `consistent`, `write`, `after`). Tests: `packages/core/tests/versions.test.ts` (all), `packages/core/tests/attacks.test.ts` ("a version cannot escape its record's rules by naming another record as its first")._

### 4.7 Planned: versions whose history can be checked

Fixes the known defect in §4.3 and settles the "not yet specified" in §4.6.
Tracked in [#14](https://github.com/leifriksheim/weave/issues/14), part of
the audit in [#10](https://github.com/leifriksheim/weave/issues/10).

**Why.** `seq` is whatever the writer puts there, and superseded versions are
dropped, so nobody can check that a version is one more than the one before.
Two attacks follow, open to any member of a shared space:

- **Freezing a record.** A member allowed to edit writes
  `seq: 2^53 − 1`. Nothing can outrank it: `seq + 1` is not a safe integer,
  and every peer refuses it (§4.6). With a `sys.*` or other foreign
  `collection`, it also hides the record, because a version whose collection
  differs from its first version is ignored on read (§4.6).
- **Taking over a creator.** The first version kept is the `seq 0` with the
  lowest id (§4.5). A member writes their own `seq 0` for someone else's key
  and retries `createdAt` values until its id sorts lower; a few tries on
  average. `@createdBy`, the `creator` rule (§7.1) and the "first defined by"
  standing of a definition (§6.3) then name the attacker.

**Design.**

- **Checkable `seq`.** Every peer keeps a small signed header for every
  version, even after its body is dropped: key, `seq`, `prev`, author, and the
  id of the full version. A later version is accepted only if `prev` names a
  held header with `seq − 1` whose own chain reaches the record's first
  version. About a hundred bytes per edit. A long history might later be
  compacted by a checkpoint the record's creator signs.
- **Keys that belong to their creator.** A fresh key becomes
  `hash(creator's root DID ‖ nonce)`, the nonce carried in the first version,
  so a `seq 0` by anyone else fails the check. A key the caller chooses
  (`collection:<name>`, `put({ key })`) gets the creator's root in its
  namespace, as profile keys already do ([03 — Spaces](03-spaces.md)), or a
  rule that the owner's first version beats everyone else's. Derived keys
  (`one:…`, access-history keys) need a decision each.
- **Refuse, not hide.** Once both hold, a version whose `collection` differs
  from its first version can be refused on arrival instead of ignored on read.

The ordering rule (§4.3) itself does not change, but which versions reach it
does. Nodes running the old and new checks would disagree about what is
current, so the new check is pinned by tests like the ordering rule. Pre-release:
nothing to migrate.

**Related.** Signed writer logs
([#13](https://github.com/leifriksheim/weave/issues/13)) add a per-writer,
per-collection log position and Merkle root to each version, to prove a copy
complete and to detect a key signing two histories. They check a different
thing (a writer's log, not a record's chain), and leave §4.3 unchanged too.
Headers here and stubs there are the same idea: an envelope kept without its
body. Design them together.

**Open questions.** The header's exact format and whether it syncs as its own
item ([05](05-sync-and-storage.md)); who may sign a checkpoint for a record
anyone may edit; how derived keys prove their creator.

### 4.8 Planned: merging inside one record

Two devices editing different fields of one record while apart make two
versions with the same `seq`, and one wins whole (§4.3): the other edit is
lost. Field-level merging, or a text CRDT for long text, would keep both. It
is a question about bodies only: storage, sync and the ordering rule stay as
they are. Not designed.

Open questions: whether a merge is a new version any reader computes the same
way (so every peer converges on it); which `prev` a merged version names when
it has two parents (and how that meets §4.7's chain check); how merging meets
`fixed` (§7.4) and encrypted bodies.

### 4.9 Planned: deletes and edits that forget

Changes what §4.4 and §4.5 keep. Tracked in
[#47](https://github.com/leifriksheim/weave/issues/47).

**Why.** The first version is kept whole as proof of who created a record,
and sync sends it (§4.5, [05 §1](05-sync-and-storage.md)). So a message
deleted before its recipient came online still reaches them, a member who
joins after the delete receives it too, and editing a record to take
something out (a pasted password) leaves the original in `seq 0`. Nothing
shows it, because apps skip deleted records, but every store holds
it and every sync passes it on.

**What it can promise.** Nothing can take content back from a peer that
already had it. What the protocol can do is make honest software forget, so
that nobody who did not have the content gets it: not a member who joins
later, and not a device that was offline.

**Design.**

- **Sign the body's hash.** The signed part carries `bodyHash`, the content
  id (§2) of the canonical body, in place of `body`. The body travels beside
  the signed part, and a peer MUST refuse a version whose body does not hash
  to `bodyHash`. A delete has no `bodyHash`. The envelope (author, key,
  `seq`, `prev`, `genesis`, `links`, `tags`, `seen`) then verifies alone.
- **Superseded versions keep a stub.** When a version is superseded and does
  not carry `retain`, a peer drops its body. A first version is kept as a
  **stub**, its signed part without the body, and still decides who created
  the record (§4.5, §7.1). Everything else superseded is dropped, as now.
- **Forgetting is enforced on arrival.** A peer that holds a later version
  of a record MUST drop the body of an older one when it arrives, whoever
  sends it and from wherever: a lagging peer, or an old blob-store segment
  ([05 §16](05-sync-and-storage.md)). A peer MUST NOT send a body it would
  not keep. A stub and a whole version have the same id, so sync is unchanged.

In a private space `bodyHash` covers the encryption envelope, so a stub
reveals nothing more than the version did. `links` stay in the envelope of a
public space; they name records, not content.

The stub is the header of §4.7 and the stub of signed writer logs
([05 §9.1](05-sync-and-storage.md)): an envelope kept without its body.
Design them together.

Open questions:

- **Checks that read a first body.** A peer that receives only a stub cannot
  recompute a `onePer` key from body fields (§7.3), or check a first version
  against its definition (§9). Either a stub is accepted only beside a later
  version that passed, or such checks move into the envelope.
- **Retained history.** Whether a delete also strips the bodies of retained
  versions in a `history: "all"` collection (§6). Never in the access-history
  collections, whose bodies are the access history.
- **Blob stores.** Segments never change and only their writer compacts them
  ([05 §16.4](05-sync-and-storage.md)), so a body deleted by someone else
  stays in the bucket until its writer compacts. Readers drop it on the way
  in; the bytes remain.
- **Crypto-shredding.** A key per record, destroyed on delete, would reach
  immutable storage too. The key record then has the same keep-or-drop
  question, so it is a later addition, not a replacement.

Pre-release: changing what is signed needs no migration.

---

## 5. Links

A link says "this record is about that one, in a named role". The subject is
always the record carrying the link.

### 5.1 Format

```json
{ "rel": "about", "to": "mfrggzdfmztwq2lknnwg23tpoa" }
```

- `rel`: lower camel case, `^[a-z][a-zA-Z0-9]{0,63}$`.
- `to`: a record key (§4.1) — never a version id.
- No other members.
- At most **32** links per version.

A version that breaks any of these is malformed (§4.6).

Links point at keys in the same space. A link to a key not held (yet) is
normal and not an error: a reaction may arrive before its post.

**Where links live.** In a public space, links are the `links` member of the
expression, signed with the rest. In a private space, `links` is absent from
the expression, and the links are sealed with the body: the plaintext of the
encrypted body is `{"body": <body>, "links": [<link>…]}` (`links` left out
when there are none) — see [03 — Spaces](03-spaces.md). A reader that opens a
sealed body with malformed links treats the record as having none.

A delete carries no links.

_Implementation detail:_ the node's `update` carries a record's links over
to the next version unless new ones are given.

### 5.2 Link declarations

A collection declares the link roles its records may carry, in its definition
(§6):

```json
"links": {
  "about":   { "to": ["std.poll"], "cardinality": "one", "description": "The poll voted on" },
  "replyTo": { "to": "*" }
}
```

| Member        | Type                        | Meaning                                                             |
| ------------- | --------------------------- | ------------------------------------------------------------------- |
| (name)        | —                           | The `rel`, `^[a-z][a-zA-Z0-9]{0,63}$`                               |
| `to`          | `"*"` or non-empty string[] | Collections the target may be in; `"*"` for any                     |
| `cardinality` | `"one"` \| `"many"`         | How many links of this role one record may carry. Default `"many"`. |
| `description` | string                      | Optional                                                            |

A record's links **conform** when: the collection is undefined (nothing to
check), or it is defined and every link's `rel` is declared (a defined
collection without `links` declares none), every role declared `"one"` appears
at most once, and every link whose target is held, current and not deleted
points into one of the `to` collections.

Conformance is a writer's check and a reader's flag, **never a reason to refuse
a record on arrival** (§9.6): whether a link conforms depends on which
definition and which target a peer holds. A writer SHOULD NOT write links that
do not conform; the reference node refuses to.

_Source: `packages/core/src/records/links.ts` (`checkLinks`, `LINK_REL_PATTERN`, `MAX_LINKS`, `LinkDeclaration`), `packages/core/src/node/space-runtime.ts` (`openBody`, `linkIssues`, `write`). Tests: `packages/core/tests/links.test.ts` (all)._

### 5.3 Planned: references to other spaces

> **Planned.** Not normative. Issue:
> [#38](https://github.com/leifriksheim/weave/issues/38). A link points only
> within its space, but following a public space, reposting from another
> space, and a list whose items live in several spaces all point elsewhere.
> The plan is a **reference**: a string naming a space and a key, such as
> `weave:<space>/<key>`, carried in a body field rather than as a link, so
> links stay same-space and checkable against the definitions (§5.2). A
> reader resolves it only if it can read that space. _Open:_ the exact form;
> whether it may pin a version; whether a private space's id in a public
> record says too much ([03 — Spaces](03-spaces.md) §8.6).

---

## 6. Collection definitions

A space describes its collections as data, so an app or agent that has never
seen the space can learn what it holds.

### 6.1 The definition record

A definition is a record in the reserved collection **`sys.collection`** with
key **`collection:<name>`** and a body in the format below. It is part of the
space's access history ([03 — Spaces](03-spaces.md)): it carries `retain: true`
and `seen`, and which definition is in force is decided by replaying that
history. In a private space its body is encrypted like any other record's.

| Field         | Type                  | Req. | Meaning                                                                                                                                                                                                                                                                                                                                 |
| ------------- | --------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string                | yes  | Lower case, at least one dot (local to the space, §6.4): `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`. MUST NOT start with `sys.`. The record's key MUST be `collection:` + this.                                                                                                                                                            |
| `title`       | string                | no   | Display name                                                                                                                                                                                                                                                                                                                            |
| `description` | string                | no   | The author's words                                                                                                                                                                                                                                                                                                                      |
| `schema`      | object                | yes  | JSON Schema for a record's `body`, in the subset of §6.2                                                                                                                                                                                                                                                                                |
| `version`     | integer ≥ 1           | yes  | Shape version (§6.3)                                                                                                                                                                                                                                                                                                                    |
| `history`     | `"latest"` \| `"all"` | no   | Default `"latest"`. `"all"`: writers mark every version `retain` (§4.5).                                                                                                                                                                                                                                                                |
| `links`       | object                | no   | Link declarations (§5.2)                                                                                                                                                                                                                                                                                                                |
| `permissions` | string[]              | no   | Permissions its rules may name, each `^[a-z][a-zA-Z0-9]{0,39}$` (§7.1)                                                                                                                                                                                                                                                                  |
| `rules`       | object                | no   | §7                                                                                                                                                                                                                                                                                                                                      |
| `topics`      | string[]              | no   | §8                                                                                                                                                                                                                                                                                                                                      |
| `screen`      | string                | no   | One HTML document, at most 48 KiB of UTF-8, non-blank. Peers only check its size; how an app runs it: [screens](../packages/core/docs/apps-as-records.md#screens).                                                                                                                                                                      |
| `network`     | string[]              | no   | The exact origins its `screen` may reach: at most 8, distinct, each `^(https\|wss)://` + a lower-case host with at least one dot + an optional `:port`, no path (`https://api.open-meteo.com`). Only with a `screen`. Peers only check the format; how an app enforces it: [screens](../packages/core/docs/apps-as-records.md#screens). |

A definition body that fails any check in this section is **invalid**. A peer
MUST treat an invalid definition as no definition at all: its collection then
has no schema, no rules and no topics. The same holds for a definition version
that is a delete, or whose key does not match its `name`.

Example (the standard `std.vote`, as stored):

```json
{
  "name": "std.vote",
  "title": "Vote",
  "description": "A vote on a poll: one per person, changed by voting again.",
  "schema": {
    "type": "object",
    "properties": {
      "choice": { "type": "integer", "minimum": 0, "x-choicesFrom": { "rel": "about", "field": "options" } }
    },
    "required": ["choice"]
  },
  "version": 1,
  "links": { "about": { "to": ["std.poll"], "cardinality": "one", "description": "The poll voted on" } },
  "rules": { "edit": "creator", "delete": "creator", "onePer": ["@author", "link:about"] }
}
```

### 6.2 The schema dialect

A stored schema is JSON Schema, draft 2020-12, restricted to a fixed subset so
every app in any language agrees on what it means.

**Publishing.** A definition is valid only if its `schema`, and recursively
every schema under `properties` and `items`, uses only these keywords, with
these value types:

| Keyword                                                                | Value                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `type`                                                                 | one of, or a non-empty list of: `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`                      |
| `properties`                                                           | object of schemas                                                                                                        |
| `required`                                                             | list of strings                                                                                                          |
| `items`                                                                | one schema                                                                                                               |
| `enum`                                                                 | non-empty list                                                                                                           |
| `const`                                                                | any                                                                                                                      |
| `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems` | finite number                                                                                                            |
| `additionalProperties`                                                 | boolean only                                                                                                             |
| `title`, `description`                                                 | string                                                                                                                   |
| `oneOf`                                                                | non-empty list of `{ "const": …, "title"?: string, "description"?: … }` — labelled choices only, not general composition |
| `x-choicesFrom`                                                        | `{ "rel": <link role>, "field": <non-empty string> }`                                                                    |

Anything else (`pattern`, `$ref`, `format`, `anyOf`, a schema-valued
`additionalProperties`, …) makes the definition invalid. A `$schema` member is
not part of the subset; a writer converting from a validator library drops it.

**Validating.** A body is checked against a stored schema as draft 2020-12
JSON Schema, with **unknown keywords ignored**, so a space written by a newer
app that allows more stays readable by an older one. Validation reports every
failing leaf (not only the first) with a JSON Pointer to the value.

`x-choicesFrom` says a value picks from a list in another record — the record
this one links to as `rel`, in its field `field`. A number is a position in
that list; anything else is the option itself. It is a display hint and is
never checked when validating.

_Implementation detail:_ validation uses `@cfworker/json-schema` (draft
`2020-12`, not short-circuiting). A validator that describes itself as JSON
Schema (Standard JSON Schema: Zod 4.2+, ArkType 2.1.28+, Valibot) is converted
with target `draft-2020-12` before storing, and the result is checked like any
other.

> **Planned: `pattern` and `format`.** Left out on purpose: every member's
> app checks every record, in whatever language, regex dialects differ, and a
> slow regex such as `^(a+)+$` in a schema could freeze every member's app.
> The plan to add them:
>
> - `pattern` accepts only **I-Regexp** (RFC 9485), the regex subset that
>   means the same in every language (as JSONPath, RFC 9535, uses): no
>   backreferences, no lookaround. A definition with nested repeats such as
>   `(a+)+` is invalid, because backtracking engines can still stall on them
>   in I-Regexp. (The alternative is a linear-time matcher, a dependency.)
> - `format` accepts only formats with exact definitions: `date-time`
>   (RFC 3339), `date`, `uri`. Not `email`.
> - Compatibility (§6.5) treats two patterns as compatible only when they are
>   identical.
>
> Older apps ignore unknown keywords when validating, and a record that does
> not fit is still kept and flagged (§9.6), so a space using `pattern` stays
> readable by an app that predates it.
>
> _Open:_ the publishing check above makes a definition that uses `pattern`
> **invalid** to an older peer, and an invalid definition counts as none
> (§6.1), so that peer would enforce none of its rules. Either the publishing
> check must tolerate these keywords before any app writes them, or such a
> definition needs a higher protocol version that older peers recognise.

### 6.3 Versions of a definition

A definition's `version` is a whole number from 1. Records do not name the
definition version they were written under; a record is judged by the
definition **in force as of the access changes it saw** (`seen`), which every
peer computes the same way ([03 — Spaces](03-spaces.md)).

The definition in force for a collection is the latest change to
`collection:<name>` that counted in the access-history replay — not the one
with the highest `version`. Who may make such a change is also the replay's
question: creating a definition needs the permission `define`; changing or
deleting one needs `manage`, or being whoever first defined it (while still a
member). A definition written under an agent's delegation never counts
([01 — Identity](01-identity.md), agent notes).

A writer SHOULD give each new definition of a collection a `version` higher
than the one in force; the reference node refuses otherwise. Peers do not check
it.

_Implementation detail:_ the reference node refuses to delete a definition
while its collection still has records.

### 6.4 Reserved names

- **`sys.*`** belongs to the protocol. A definition MUST NOT name one. Records in
  `sys.*` collections have no schema, rules or topics from a definition; their
  formats and checks are specified where they are used:
  `sys.collection` (here); the access history, keys, profiles and the account
  registry — `sys.role`, `sys.member`, `sys.invite`, `sys.revoke`, `sys.key`,
  `sys.box`, `sys.memberkey`, `sys.relays`, `sys.keepers`, `sys.profile`,
  `sys.joined` — in [03 — Spaces](03-spaces.md); carriers, passes, hosting and
  notifications — `sys.carrier`, `sys.pass`, `sys.hosting`, `sys.notify`,
  `sys.subscription` — in [06 — Nodes, sessions and apps](06-nodes-and-sessions.md)
  (`sys.relays` and `sys.keepers` also in [05](05-sync-and-storage.md)).
- **`std.*`** is a naming convention for the optional standard library
  ([standard library](../packages/core/docs/standard-library.md)), **not reserved**: any
  member allowed to define collections may define a `std.*` name with any
  shape. Apps agree by using the same definitions, not by any privilege.
  (Planned to change: §6.5.)
- Any other name is the space's to use. Records in a collection nobody has
  defined are still stored and synced; they simply have no schema or rules.

Names are **local to a space**. Nothing registers or owns a name across
spaces, so a name never says what shape a collection has; its definition in
that space does. Two apps sharing a space settle a clash over a name before
anything is defined, when a person reads what each would define (the
reference: [the app review](../packages/core/docs/apps-as-records.md#the-app-review)).

_Source: `packages/core/src/schema/collection-def.ts` (`StoredCollection`, `CATALOG_COLLECTION`, `checkStoredCollection`, `checkPublishableSchema`, `validateJsonSchema`, `toJsonSchema`, `asStandardSchema`, `MAX_SCREEN_BYTES`, `checkScreenNetwork`, `MAX_SCREEN_ORIGINS`), `packages/core/src/node/space-runtime.ts` (`definitionIn`, `loadCatalog`, `define`, `undefine`), `packages/core/src/space/roles.ts` (`definition` events). Tests: `packages/core/tests/space-catalog.test.ts` (all), `packages/core/tests/schemas.test.ts` ("schemas from a validator you already use"), `packages/core/tests/attacks.test.ts` ("a member cannot take down a collection's definition they did not write")._

### 6.5 Planned: compatible definitions

Issues: [#11](https://github.com/leifriksheim/weave/issues/11) (content-addressed
definitions), [#12](https://github.com/leifriksheim/weave/issues/12) (definition
tiers, additive-only). This section is the one plan for both, and for the
compatibility check that was drafted separately; where they differ, it says so.

**Why.** An app decides it can open a space by finding a collection with the
right **name**. Chat opens any `std.message`, whatever its fields and whoever
its rules let edit it. And a space whose definition is a little older than the
app's (a `std.message` without the `shares` link) stays that way, because the
library skips a collection the space already has.

#### The check: `compare(held, wanted)`

`held` is the definition the space has; `wanted` the one the app was built
with. The result is two lists of breaks, each a path and a plain sentence:

```ts
interface Compatibility {
  read: Break[]; // why the app might meet a record it can't read; empty: it can read them all
  write: Break[]; // why a record the app writes might not fit, or be refused; empty: it can write
}
interface Break {
  path: string;
  message: string;
} // 'rules.edit', "Anyone can edit anyone's messages here; this app assumes only their author"
```

An app that only shows records needs `read` empty; one that writes needs both.
Anything the checker cannot decide is a break.

- **Fields.** Reading needs every body the space accepts to be one the app
  accepts (held ⊆ wanted); writing needs wanted ⊆ held. Over the §6.2 keywords
  this is a walk of both schemas: `type` sets contained (`integer` inside
  `number`); a field one side relies on is `required` on the other; numeric
  and length ranges contained; `enum`, `const` and `oneOf` value sets
  contained; recurse into `properties` and `items`. `title`, `description`
  and `x-choicesFrom` are ignored.
- **Links.** A link role the app uses is declared in the space; where it may
  point is contained (`["app.poll"]` is inside `"*"` for reading, not for
  writing); `"one"` is inside `"many"`. Roles the app does not know are
  ignored when reading.
- **Rules: never looser.** Stricter rules are never a safety problem (at worst
  the app cannot write, which `can` already reports), so rules are checked one
  way: the space's rule must be an **attenuation** of the app's, as in UCAN.
  For `create`, `edit`, `delete`, every who in the space's list is covered by
  one in the app's (`member` covers everyone; `creator` and `can:<p>` cover
  themselves; defaults count). `onePer`: the space promises at least the
  uniqueness the app relies on (fewer parts is a stronger promise). `fixed`:
  the space keeps at least the fields the app expects fixed. `permissions`: a
  permission the app's rules name is declared.

#### What uses it

Until #12 makes it a peer's check (below), `compare` is an app's: to open a
collection only when it is compatible, to apply a harmless update of a
standard definition, and to show a person the breaks in an app review. How
the reference library uses it is in [apps as records](../packages/core/docs/apps-as-records.md#compatible-definitions).

A writer SHOULD NOT define a `std.*` name that is not compatible with the
standard library's. Peers do not refuse one on arrival (refusing depends on
what each peer knows, and leaves peers disagreeing, as in §9.6); an app
treats an incompatible `std.message` as not a message.

#### Where #11 and #12 go further

- **Content-addressed definitions (#11).** A definition's id is the hash of its
  content and never changes; a new one names `supersedes: <hash>`, and
  `sys.collection` becomes a pointer from a name to the current hash. Identical
  hashes are trivially compatible, so `compare` runs only on a real change.
  #11 also has each record store the hash it was written against. Today a
  record is judged by the definition in force as of `seen` (§6.3), and the
  writer names none: a writer-chosen definition was removed because a writer
  could name an older, looser one (vote ten times under a definition from
  before "one vote per person"). So a pin **adds** a check and never removes
  one: a pinned record is accepted only if it is valid under the pinned
  definition **and** under the definition in force as of `seen`. The pin tells
  readers what shape the writer meant; it can't let a record in that the
  space's current definition refuses.
- **Tiers and additive-only (#12).** `std.*` frozen by the spec; publisher
  definitions under `<did>/name`, signed by the publisher and followed
  automatically; space definitions changed by space roles. Under one name
  only additive changes are valid, **enforced by peers**; a breaking change
  needs a new name (`name/2`), and may ship upgrade steps as data. Apps declare
  the names or hashes they support. Here the plan differs: the compatibility
  draft keeps the check on the app side and lets a person approve a breaking
  change; #12 makes "additive" a validation rule. Peers can enforce it only
  on something every peer sees the same way, which content-addressed
  definitions and their `supersedes` chain (#11) provide. `compare` is the
  check "additive" needs, in both directions (below). #12 depends on #11, and on key rotation
  ([#9](https://github.com/leifriksheim/weave/issues/9)), because a stolen
  publisher key could push "additive" versions spaces pick up automatically.

#### Direction: what "additive" means

Classified as **oasdiff** classifies OpenAPI changes, treating a collection's
schema as a request body and a response body at once: apps write records
(a request) and apps read them (a response).

- **As a request**, a change must not **tighten**: a new required field, a
  narrower type, a smaller range or length, fewer `enum`/`const`/`oneOf`
  values, a link that may point at less. Apps on the old definition could no
  longer write.
- **As a response**, a change must not **loosen**: a field no longer
  required, a wider type, a larger range, more `enum` values, a link that may
  point at more. Apps on the old definition would meet records they misread
  (a status they don't switch on).

A change under the same name is **additive** when oasdiff would report no
error-level break for it on either side. That leaves: new optional fields,
new optional link roles, and changes to `title`, `description` and other
annotations. Anything else needs a new name (`name/2`). Findings oasdiff
reports as warnings or information stay that. The catalogue of checks is
oasdiff's, mapped onto the §6.2 keywords and links; a keyword it has no check
for is a break.

**Rules are not shape.** `create`, `edit`, `delete`, `onePer`, `fixed` and
`permissions` are the space's governance: a space may tighten them under the
same name (at worst an app can't write, which `can` reports), and may never
loosen them past what an app relies on (§6.5, "never looser").

Unknown fields follow the same convention: a field only one side mentions is
ignored, unless that side requires it or closes the schema
(`additionalProperties: false`).

#### Open questions

- **Rules only apply from now on.** A space that was loose last month and
  strict today holds records written under the loose rules. Either `compare`
  looks at every definition the collection has had, or "compatible" is stated
  to describe records written from now on. Probably the second.
- **Translating instead of refusing** (lenses between versions, as in
  Cambria), so an app can read a definition it is not compatible with. Later.

Depends on: nothing built yet on the peer side; the app-side check is in the package docs.

## 7. Rules

A definition's `rules` say who may create, edit and delete its records, what
must be unique, and which fields are fixed. Every peer enforces them on every
version it receives.

```json
"rules": {
  "create": "member",
  "edit":   "creator",
  "delete": ["creator", "can:moderate"],
  "onePer": ["@author", "link:about"],
  "fixed":  ["options"]
}
```

### 7.1 Who

`create`, `edit` and `delete` each take one _who_ or a non-empty list of them
(a list means any of them):

| Who       | Holds when                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `member`  | The writer's root holds any role in the space (as of `seen`).                                                                                                                                                        |
| `creator` | The writer's root is the root of the record's first version (§4.6). A fact about the record; nobody grants it.                                                                                                       |
| `can:<p>` | The writer's role holds the permission `<collection>/<p>`, e.g. `app.poll/moderate` ([03 — Spaces](03-spaces.md)). `<p>` MUST match `^[a-z][a-zA-Z0-9]{0,39}$` and MUST be listed in the definition's `permissions`. |

Defaults: `create` → `member`; `edit` → `member`; `delete` → whatever `edit`
is. `create` MUST NOT include `creator`.

### 7.2 Which rule applies

For a version of a collection that has a valid definition in force (as of its
`seen`):

| Version                | Action | Rule                                         |
| ---------------------- | ------ | -------------------------------------------- |
| `seq == 0`             | create | `create`                                     |
| `seq > 0`, `deleted`   | delete | `delete`, else `edit`                        |
| `seq > 0`, not deleted | edit   | `edit` (including re-creating a deleted key) |

Independently of rules, the writer's root MUST hold a role in the space as of
`seen`. With no definition in force, or in a `sys.*` collection, only that
applies here (the access collections have their own checks, in
[03 — Spaces](03-spaces.md)).

### 7.3 `onePer`: unique by construction

`onePer` is a non-empty list of parts. At most one record exists per
combination of their values — not by searching other records (no peer holds
them all) but because the record's **key is derived from them**. A second
vote by the same person on the same poll _is_ the next version of the first.

Parts:

- `@author` — the writer's **root** DID (the account, not the session key).
- `link:<rel>` — the `to` of the **first** link with that `rel`.
- anything else — a **top-level** field of the body (no dotted paths).

The key is:

```
lines  = [ collection ]
for each part, in order:
  "@author"     → "@author=" ‖ rootDid
  "link:<rel>"  → "link:<rel>=" ‖ link.to            (no such link → no key)
  field         → field ‖ "=" ‖ JSON(body[field])    (field absent → no key)
digest = SHA-256( UTF-8( join(lines, "\n") ) )
key    = "one:" ‖ lowercase-hex( digest[0..20) )     // 44 characters
```

`JSON(v)` is the canonical JSON (§1) of the value. A `null` field is present
and gives `field=null`.

> **Known defect:** the reference writes `JSON(v)` with `JSON.stringify`, not
> canonical JSON (`packages/core/src/records/rules.ts`, `onePerKey`). For a string, number,
> boolean or `null` the two agree. For an object or array, `JSON.stringify`
> keeps the member order of the parsed object, so the key depends on member
> order. A fix will use canonical JSON; until then, use scalar fields.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20).

Example — `std.vote` (`onePer: ["@author", "link:about"]`) by
`did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ` about the record
`mfrggzdfmztwq2lknnwg23tpoa`:

```
std.vote
@author=did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ
link:about=mfrggzdfmztwq2lknnwg23tpoa
```

SHA-256 = `121a1c3e8daf7aaa6fc4f8d7458ee419eac70ca3e3f8bcfd9025ef331ecd4093`, so
the key is `one:121a1c3e8daf7aaa6fc4f8d7458ee419eac70ca3`.

Checking: a peer MUST refuse a `seq 0` version of a collection with `onePer` in
force whose `key` is not the derived key (including when a part is missing and
there is no key). The check is made only on `seq 0`, and only by a peer that
can read the body; in a private space a peer without the key accepts it on the
other checks. Later versions keep the key they have.

A writer derives the key and writes the next version after whatever it holds
at that key (§4.2) — so "adding another" is an edit of the existing record,
and the `edit` rule decides whether it is allowed.

> **Planned: private `onePer` keys.** The key is a plain hash of the
> collection, the author, the link target and body fields, and it travels in
> the clear even in a private space. So anyone holding the ciphertext (a relay
> peer, a host, a mirror's provider) can guess and check who voted on which
> poll, and, where a field has few possible values, the value too. The plan:
> in a private space, derive the key with HMAC-SHA-256 under a key derived
> from the space key (a new label in [01](01-identity.md) §5), so only readers
> can compute or check it. Every reader derives the same key, so rules still
> check the same everywhere; a peer without it already accepts `onePer` on the
> other checks. The change is also the moment to fix the `JSON.stringify`
> known defect above.
> `profile` keys leak the same way (anyone can confirm which known accounts
> are in a space; [03 — Spaces](03-spaces.md)). Pairs with encrypting
> collection names. _Open:_ which space key: a record's key must outlive key
> changes, so it cannot simply be the key its body was sealed with (as topic
> tags use, §8.2); and how a reader finds a record written under an earlier
> key.

> **Planned: uniqueness that cannot be a key.** `onePer` works only when the
> unique parts can be known before writing ("one per person per poll").
> Uniqueness over something that cannot be derived in advance ("one booking
> per room per hour" with free-form times, a unique display name) would need a
> **deterministic fold on read** instead: every reader keeps the same one of
> the clashing records, by a rule like §4.3, and treats the rest as not
> current. Not designed. _Open:_ the rule's syntax; how a reader that holds
> only part of a collection folds; and that a definition with an unknown rule
> is invalid to older peers (§7.5), so a new rule needs care in rollout.

### 7.4 `fixed`

`fixed` is a non-empty list of top-level body fields that keep the value the
record was created with. A peer MUST refuse a later, non-delete version in
which any listed field differs from the record's first version — compared as
canonical JSON (§1), with "absent" equal to "absent" — when it can read both
bodies.

> **Known defect:** the reference compares `JSON.stringify` output, not
> canonical JSON (`packages/core/src/records/rules.ts`, `changedFixedField`), so an object-
> or array-valued field whose members are reordered counts as changed. A fix
> will compare canonical JSON.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20).

### 7.5 Checking a definition's rules

`rules` MUST be an object with no members other than `create`, `edit`,
`delete`, `onePer`, `fixed`, each valid as above (`onePer` and `fixed`:
non-empty lists of non-empty strings). A definition with anything else is
invalid (§6.1).

> Rationale: a rule names either a fact any peer can check from the record
> (`creator`) or a permission a person decided (`can:…`). "Did a person have to
> decide it?" is the test for which one to use.

_Source: `packages/core/src/records/rules.ts` (`checkRules`, `allows`, `onePerKey`, `changedFixedField`, `permissionName`, `PERMISSION_PATTERN`), `packages/core/src/node/space-runtime.ts` (`judgeStanding`, `rulesAt`, `mayNow`, `put`). Tests: `packages/core/tests/rules.test.ts` (all), `packages/core/tests/schemas.test.ts` ("a poll: one vote per person…")._

---

## 8. Topics and blind tags

A collection may name up to eight body fields as **topics** (`channel`,
`mentions`). Each record then carries, on its outside, a keyed hash of each
value of each topic field — so a keeper that cannot read a private body can
still match "messages in #design" or "messages that mention me", learning which
records share a topic but not which topic.

### 8.1 Topic fields

`topics` is a list of at most 8 distinct field paths, each matching
`^[a-zA-Z_][a-zA-Z0-9_]{0,63}(\.[a-zA-Z_][a-zA-Z0-9_]{0,63}){0,3}$` (up to
four dotted segments).

The **values** of a topic field in a body: follow the path one segment at a
time, through objects only (an array or a scalar on the way gives no values).
At the end:

- a string, a boolean, or a finite number → that one value;
- an array → each element that is a string, boolean or finite number (others skipped);
- anything else, or missing → no values.

### 8.2 The tag key

```
IKM  = public space:  UTF-8( "weave/public-topics/v1|" ‖ spaceId )
       private space: the 32 raw bytes of the AES-256 space key whose id is the body's keyId
PRK/OKM = HKDF-SHA-256( IKM, salt = "" (zero length), info = UTF-8("weave/topic-tags/v1"), L = 32 )
tagKey  = OKM, used as an HMAC-SHA-256 key
```

In a public space anyone can compute the tags, as anyone can read the records.
In a private space the key is tied to the space key the body was sealed with
([03 — Spaces](03-spaces.md)).

### 8.3 Tags

```
tag = base64url( HMAC-SHA-256( tagKey, UTF-8( collection ‖ 0x00 ‖ field ‖ 0x00 ‖ canonical(value) ) )[0..16) )
```

— 16 bytes, 22 base64url characters. `canonical(value)` is §1, so the string
`"design"` is hashed with its quotes and differs from the number or boolean of
the same spelling. The collection and field are included, so one value in two
places gives two tags.

A record's `tags` are the tags of every value of every topic field of its
body, **each once, sorted** (ascending by UTF-16 code units), **truncated to
the first 64**. A record with no topic values carries no `tags` member. A
delete carries none.

Example: public space `bimjoifogypbqrtuich3e375d67y43znkjsjnp4q4qhe7gwf7u74a`,
collection `app.chat.message`, field `channel`, value `"design"` →
`77UGGhMoLC5C1rXEcsqWKw`.

### 8.4 Checking

A peer that can read a non-delete version's body, and holds the key it was
sealed with, MUST recompute its tags under the `topics` in force (as of `seen`)
and refuse the version if the recomputed set differs from the set in `tags`
(order and duplicates ignored). With no topics in force, a version carrying
any tag is refused. A peer that cannot read the body does not check.

To ask a keeper for records on a topic, a reader computes the tag the same way
([05 — Sync and storage](05-sync-and-storage.md)).

> Rationale: a blind index (as in CipherSweet) — equality only, never ranges or
> substrings. The keeper learns co-occurrence and frequency, nothing more.

_Source: `packages/core/src/records/topics.ts` (`checkTopics`, `topicValues`, `topicKey`, `topicTag`, `tagsFor`, `sameTags`, `MAX_TOPICS`, `MAX_TAGS`), `packages/core/src/node/space-runtime.ts` (`tagKey`, `tagProblem`, `write`). Tests: `packages/core/tests/topics.test.ts` (all)._

---

## 9. Validation: what a peer checks before keeping a version

A version arriving from anywhere — a peer, a folder, a mirror — or written
locally, passes the same checks. The order below is the reference order; a
version refused by any step is refused.

### 9.1 Shape

The version-alone checks of §4.6. The body is not inspected: body shape against
the collection's schema is **not** checked on arrival (§9.6).

### 9.2 Signature (the crypto gate)

§3.3: the id matches the signed part, `author` resolves to a P-256 key, and the
signature verifies.

### 9.3 Delegation (the capability gate)

The capability every write in space `S` needs is
`{ "with": "space:<S>", "can": "expression/write" }`.

- No `proof`: the author signs for itself; its root is `author`.
- With `proof`:
  1. `createdAt` MUST parse as a time; else refuse.
  2. `createdAt` MUST NOT be more than **300 seconds** ahead of the checking
     peer's clock; else refuse.
  3. The UCAN chain MUST be valid **at `createdAt`** (not now) — so records
     outlive the session that signed them ([01 — Identity](01-identity.md)).
  4. The chain's audience MUST equal `author`.
  5. Some capability in the chain MUST cover the one required.
  6. The root is the chain's root issuer.

> **Known defect:** a chain deeper than one link never validates here, because
> no proof resolver is wired and a record carries only its leaf token
> ([01 — Identity](01-identity.md) §7.5). Planned there: "Proof chains that
> travel".
> Tracked in [#17](https://github.com/leifriksheim/weave/issues/17).

### 9.4 Standing (the stateful check)

Given a valid signature and root, whether the version _stands_ in this space:

1. `space` equals this space's id.
2. If written under an agent's note in a space that admits only the account
   itself: refused ([06](06-nodes-and-sessions.md)).
3. Access-history collections: judged by the replay ([03 — Spaces](03-spaces.md)).
4. Otherwise:
   1. The first version (§4.6) is held and is this record's.
   2. The access state as of `seen` is known ([03](03-spaces.md)).
   3. The root holds a role as of `seen`, and the rule for the action allows it (§7.2), and the access history's own judgement of the writer passes (revoked notes, removals — [03](03-spaces.md)).
   4. If a definition is in force and the version is not a delete: tags check (§8.4).
   5. If rules are in force and the version is not a delete: `onePer` (§7.3) on `seq 0`, `fixed` (§7.4) on `seq > 0`.

### 9.5 What a peer does with a refused version

A check can end three ways:

| Outcome     | When                                                                                   | What the peer does                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **stands**  | every check passes                                                                     | Stores it; the ordering rule (§4.3) decides whether it becomes current.                                                                                                                               |
| **later**   | it depends on something not held: its first version, or access changes named in `seen` | Holds it aside (at most 1,000, oldest dropped) and re-judges waiting versions whenever something new is stored. Nothing is reported.                                                                  |
| **refused** | any other failure                                                                      | Does not store it, does not pass it on, and reports it (a `rejected` event with the peer and reason). Remembers the refusal as (peer, id) — at most 10,000 — only so it does not ask that peer again. |

A peer MUST NOT remember a refusal by id alone, and MUST NOT cache a failing
verdict: a copy with a mangled signature shares the genuine version's id
(§3.2). A peer MAY cache passing verdicts by (`id`, `signature`).

Whether a stored version stands can change as the access history grows (a
removal, a revoked note — [03](03-spaces.md)). When reading, a peer uses the
current version if it stands; otherwise the newest held version of that record
that does; otherwise the record is absent.

_Implementation detail:_ when admitting a batch, the reference sorts
`sys.collection` versions first, then by ascending `seq`, so little has to wait.

### 9.6 What is never a reason to refuse

A peer MUST NOT refuse a version on arrival because:

- its body does not fit the collection's schema, or
- its links do not conform to the collection's link declarations, or
- its collection is not defined.

Each of these depends on which definition, schema or target a peer happens to
hold, and refusing would leave peers disagreeing forever. Readers flag such a
record instead (the node reports `conforms: false` with the issues). A writer
checks them before signing and SHOULD NOT write what does not conform.

_Source: `packages/core/src/validation/check-version.ts` (`createVersionCheck`), `packages/core/src/validation/crypto-gate.ts`, `packages/core/src/validation/capability-gate.ts` (`MAX_CLOCK_SKEW_SECONDS`), `packages/core/src/node/space-runtime.ts` (`writeCapability`, `judge`, `judgeStanding`, `admit`, `currentOf`, `contentIssues`), `packages/core/src/sync/sync-engine.ts` (`admit`, `retryWaiting`, `MAX_WAITING`, `MAX_REFUSED`). Tests: `packages/core/tests/validation.test.ts` (all), `packages/core/tests/rules.test.ts` ("a forged edit is refused by every peer…", "arriving in any order"), `packages/core/tests/space-catalog.test.ts` ("a record that does not fit is kept and flagged"), `packages/core/tests/links.test.ts` ("declared links"), `packages/core/tests/topics.test.ts` ("a record whose tags don't match…"), `packages/core/tests/attacks.test.ts`._

---

## 10. Limits

| Limit                                       | Value                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Record key                                  | 1–128 chars of `[a-z0-9:._-]`                                                        |
| `seen`                                      | ≤ 64 ids, each 1–128 chars                                                           |
| Links per version                           | ≤ 32                                                                                 |
| Link role                                   | `^[a-z][a-zA-Z0-9]{0,63}$`                                                           |
| Topic fields per collection                 | ≤ 8, ≤ 4 path segments                                                               |
| Tags per version                            | ≤ 64                                                                                 |
| Permission name                             | `^[a-z][a-zA-Z0-9]{0,39}$`                                                           |
| Definition `screen`                         | ≤ 48 KiB UTF-8                                                                       |
| Definition `network`                        | ≤ 8 origins                                                                          |
| Future-dated `createdAt` (delegated writes) | ≤ 300 s ahead                                                                        |
| Size of a body or an expression             | _Not yet specified_ — no limit is enforced                                           |
| Collection name on a record                 | _Not yet specified_ — only definitions constrain names; a record may name any string |
