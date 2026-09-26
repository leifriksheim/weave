# 02 — Records

A **record** is a signed, versioned JSON document in a **collection** of a
**space**. This part says exactly what one looks like, how it is encoded,
hashed and signed, which of its versions counts, how records point at each
other, how a space describes its collections and their rules, how records are
queried, and what a peer checks before it keeps one.

Out of scope here, and specified elsewhere:

- Keys, DIDs and the UCAN delegations carried in `proof`: [01 — Identity](01-identity.md).
- Roles, the access history that `seen` refers to, encrypted bodies and space keys: [03 — Spaces](03-spaces.md).
- How versions travel and how they are stored: [05 — Sync and storage](05-sync-and-storage.md).
- The node API that reads and writes records: [06 — Nodes, sessions and apps](06-nodes-and-sessions.md).

**Terms.** An *expression* is one signed version of a record — the unit that is
hashed, signed, stored and synced. A *record* is every expression that shares
one `key` in a space. The *author* is the key that signed an expression
(usually a session key); the *root* is the account that key acts for, found by
walking its `proof` ([01 — Identity](01-identity.md)), or the author itself when
there is no proof.

---

## 1. Canonical JSON

Every hash of, and every signature over, a JSON value in Weave is over its
**canonical form**, defined here. The canonical form of a value is a string;
its bytes are that string in UTF-8.

A value is first read as the JSON data model: objects, arrays, strings, numbers
as IEEE 754 binary64, `true`, `false`, `null`. Then:

| Value | Canonical form |
|---|---|
| `null` | `null` |
| `true` / `false` | `true` / `false` |
| number | The ECMAScript `Number::toString` form of the binary64 value: shortest round-tripping digits, `-0` → `0`, exponent form from `1e21` upward (`1.5e+21`) and below `1e-6` (`1e-7`). NaN and ±Infinity cannot occur in JSON. |
| string | As ECMAScript `JSON.stringify` writes it: in double quotes; `"` → `\"`, `\` → `\\`; U+0008, U+0009, U+000A, U+000C, U+000D → `\b` `\t` `\n` `\f` `\r`; other code points below U+0020 → `\u00xx` with **lower-case** hex; a lone surrogate → `\udxxx` in lower-case hex; every other character, including `/`, non-ASCII and U+2028/U+2029, written as itself. |
| array | `[` + canonical forms of the elements, in order, separated by `,` + `]` |
| object | `{` + `"name":value` pairs, separated by `,`, members sorted by name in ascending order of **UTF-16 code units**, + `}`. Names are encoded as strings (above). |

No whitespace appears anywhere outside strings.

- A producer MUST NOT emit an object with two members of the same name. (What
  a reader does with one is not specified; this implementation keeps the last.)
- Because the form is computed from the *parsed* value, how a value was
  formatted on the wire does not matter: `1.0`, `1` and `1e0` are the same
  number and hash the same. A reader in a language whose JSON numbers are not
  binary64 MUST convert them to binary64 before canonicalizing, or hashes will
  differ for numbers that do not survive the round trip.
- *Implementation detail:* the reference `canonicalize()` also accepts
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

*Source: `src/schema/expression.ts` (`canonicalize`). Tests: `tests/validation.test.ts`, `tests/versions.test.ts` (ids and signatures depend on it throughout).*

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

*Source: `src/utils/hash.ts` (`cidFromBytes`, `cidDigest`, `cidOfDigest`, `base32Encode`, `base32Decode`), `src/schema/expression.ts` (`getExpressionId`). Tests: `tests/validation.test.ts` ("rejects an id that does not match the content"), `tests/sync.test.ts`.*

---

## 3. Expressions

### 3.1 Fields

An expression is a JSON object with these members. Optional members are
**absent** when they do not apply — never `null`, never `false`, never an empty
list unless a list is meant (an absent member and a present one hash differently).

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `id` | string | yes | Content id of the signed part (§2). Not itself signed. |
| `author` | string | yes | The `did:key` of the P-256 key that signed ([01 — Identity](01-identity.md)). |
| `collection` | string | yes | The collection the record is in, e.g. `app.todo.item`. |
| `space` | string | in a space | Id of the space it belongs to. Signed, so it cannot be replayed into another space. A peer MUST refuse an expression whose `space` is not the space it arrived for. |
| `createdAt` | string | yes | ISO 8601 time the writer's clock gave, e.g. `2026-09-26T12:00:00.000Z`. Decides no ordering (§4.3); used for judging the delegation (§9.3), for display, and as a sync hint ([05](05-sync-and-storage.md)). |
| `body` | any JSON | yes | The content. `null` on a delete. In a private space, an encryption envelope `{ "ciphertext", "iv", "keyId" }` ([03 — Spaces](03-spaces.md)). |
| `proof` | string | no | Encoded UCAN delegating to `author` the right to write here ([01 — Identity](01-identity.md)). Absent when the author signs for itself. |
| `key` | string | yes | The record's identity within the space, stable across versions (§4.1). |
| `seq` | integer | yes | `0` for the first version; each later version one more than the one it replaces. |
| `prev` | string | seq > 0 | Id of the version this one replaces. |
| `genesis` | string | seq > 0 | Id of the record's first version. |
| `retain` | `true` | no | Keep this version after it is superseded (§4.5). |
| `seen` | string[] | no | Ids of the latest changes to the space's access history the writer knew of; the version is judged as of those ([03 — Spaces](03-spaces.md)). At most 64, each 1–128 characters. |
| `deleted` | `true` | no | This version deletes the record; `body` MUST be `null`. |
| `links` | Link[] | no | What this record points at (§5). Public spaces only; in a private space links are sealed inside the body and this member is absent. |
| `tags` | string[] | no | Blind topic tags (§8). |
| `signature` | string | yes | base64url (no padding) of the 64-byte ECDSA P-256 / SHA-256 signature, IEEE P1363 form (r ‖ s), over the signed part. |

A reader MUST keep and re-hash every member it receives, including ones it does
not know: the signed part is "everything except `id` and `signature`" (§3.2),
not a fixed list.

*Implementation detail:* the reference writer always includes `seen` on
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
- MAY cache a *passing* verdict under the pair (`id`, `signature`).

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

Whether the author was *allowed* to write is a separate question (§9.3–9.4).

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

*Source: `src/types.ts` (`Expression`, `UnsignedExpression`, `Link`), `src/schema/expression.ts` (`createExpression`, `signedPart`, `getExpressionId`, `serializeExpression`), `src/schema/signer.ts`, `src/validation/crypto-gate.ts`. Tests: `tests/validation.test.ts` ("crypto gate"), `tests/identity.test.ts` ("expressions signed by an identity verify against its DID"), `tests/links.test.ts` ("links are signed"), `tests/attacks.test.ts` ("a stranger sending a mangled copy first…").*

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

| Version | `seq` | `prev` | `genesis` |
|---|---|---|---|
| first | `0` | absent | absent |
| later | previous `seq` + 1 | id of the version it replaces | id of the first version (for seq 1 that is `prev`) |

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
- A version with a higher `seq` than the one it names in `prev` is not checked
  against it: `prev` is **not verified** by readers, and `seq` gaps are not
  refused. See *Not yet specified* below.

> Rationale: no clock is trusted, because every clock is whatever its writer
> typed. The rule is load-bearing forever — two peers running different rules
> would disagree about what is current.

### 4.4 Deletes

A delete is an ordinary later version with `deleted: true` and `body: null`. It
carries no `links` and no `tags`. It is judged under the collection's `delete`
rule (§7). Writing the key again produces the next version after the delete,
judged as an **edit** (only `seq 0` is a create).

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

*Implementation detail:* the reference writer also sets `retain` on
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

*Not yet specified:* whether `prev` must name a held version, and whether a
`seq` may skip. Today neither is checked, so a writer allowed to edit a record
can choose any higher `seq`.

*Source: `src/records/version.ts` (`newRecordKey`, `supersedes`, `byVersion`, `nextVersion`, `checkVersionShape`, `RECORD_KEY_PATTERN`, `MAX_SEEN`), `src/storage/storage-provider.ts` (`addExpression`, `demote`, `keepOrDrop`), `src/node/space-runtime.ts` (`firstOf`, `consistent`, `write`, `after`). Tests: `tests/versions.test.ts` (all), `tests/attacks.test.ts` ("a version cannot escape its record's rules by naming another record as its first").*

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

*Implementation detail:* the node's `update` carries a record's links over
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

| Member | Type | Meaning |
|---|---|---|
| (name) | — | The `rel`, `^[a-z][a-zA-Z0-9]{0,63}$` |
| `to` | `"*"` or non-empty string[] | Collections the target may be in; `"*"` for any |
| `cardinality` | `"one"` \| `"many"` | How many links of this role one record may carry. Default `"many"`. |
| `description` | string | Optional |

A record's links **conform** when: the collection is undefined (nothing to
check), or it is defined and every link's `rel` is declared (a defined
collection without `links` declares none), every role declared `"one"` appears
at most once, and every link whose target is held, current and not deleted
points into one of the `to` collections.

Conformance is a writer's check and a reader's flag, **never a reason to refuse
a record on arrival** (§9.6): whether a link conforms depends on which
definition and which target a peer holds. A writer SHOULD NOT write links that
do not conform; the reference node refuses to.

*Source: `src/records/links.ts` (`checkLinks`, `LINK_REL_PATTERN`, `MAX_LINKS`, `LinkDeclaration`), `src/node/space-runtime.ts` (`openBody`, `linkIssues`, `write`). Tests: `tests/links.test.ts` (all).*

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

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `name` | string | yes | Reverse-DNS, lower case, at least one dot: `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`. MUST NOT start with `sys.`. The record's key MUST be `collection:` + this. |
| `title` | string | no | Display name |
| `description` | string | no | The author's words |
| `schema` | object | yes | JSON Schema for a record's `body`, in the subset of §6.2 |
| `version` | integer ≥ 1 | yes | Shape version (§6.3) |
| `history` | `"latest"` \| `"all"` | no | Default `"latest"`. `"all"`: writers mark every version `retain` (§4.5). |
| `links` | object | no | Link declarations (§5.2) |
| `permissions` | string[] | no | Permissions its rules may name, each `^[a-z][a-zA-Z0-9]{0,39}$` (§7.1) |
| `rules` | object | no | §7 |
| `topics` | string[] | no | §8 |
| `screen` | string | no | One HTML document, at most 48 KiB of UTF-8, non-blank. What runs it: [06 — Nodes, sessions and apps](06-nodes-and-sessions.md). |

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
    "properties": { "choice": { "type": "integer", "minimum": 0, "x-choicesFrom": { "rel": "about", "field": "options" } } },
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

| Keyword | Value |
|---|---|
| `type` | one of, or a non-empty list of: `object`, `array`, `string`, `number`, `integer`, `boolean`, `null` |
| `properties` | object of schemas |
| `required` | list of strings |
| `items` | one schema |
| `enum` | non-empty list |
| `const` | any |
| `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems` | finite number |
| `additionalProperties` | boolean only |
| `title`, `description` | string |
| `oneOf` | non-empty list of `{ "const": …, "title"?: string, "description"?: … }` — labelled choices only, not general composition |
| `x-choicesFrom` | `{ "rel": <link role>, "field": <non-empty string> }` |

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

*Implementation detail:* validation uses `@cfworker/json-schema` (draft
`2020-12`, not short-circuiting). A validator that describes itself as JSON
Schema (Standard JSON Schema: Zod 4.2+, ArkType 2.1.28+, Valibot) is converted
with target `draft-2020-12` before storing, and the result is checked like any
other.

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

*Implementation detail:* the reference node refuses to delete a definition
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
  (Appendix A), **not reserved**: any member allowed to define collections may
  define a `std.*` name with any shape. Apps agree by using the same
  definitions, not by any privilege.
- Any other name is the space's to use. Records in a collection nobody has
  defined are still stored and synced; they simply have no schema or rules.

*Source: `src/schema/collection-def.ts` (`StoredCollection`, `CATALOG_COLLECTION`, `checkStoredCollection`, `checkPublishableSchema`, `validateJsonSchema`, `toJsonSchema`, `asStandardSchema`, `MAX_SCREEN_BYTES`), `src/node/space-runtime.ts` (`definitionIn`, `loadCatalog`, `define`, `undefine`), `src/space/roles.ts` (`definition` events). Tests: `tests/space-catalog.test.ts` (all), `tests/schemas.test.ts` ("schemas from a validator you already use"), `tests/attacks.test.ts` ("a member cannot take down a collection's definition they did not write").*

---

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

`create`, `edit` and `delete` each take one *who* or a non-empty list of them
(a list means any of them):

| Who | Holds when |
|---|---|
| `member` | The writer's root holds any role in the space (as of `seen`). |
| `creator` | The writer's root is the root of the record's first version (§4.6). A fact about the record; nobody grants it. |
| `can:<p>` | The writer's role holds the permission `<collection>/<p>`, e.g. `app.poll/moderate` ([03 — Spaces](03-spaces.md)). `<p>` MUST match `^[a-z][a-zA-Z0-9]{0,39}$` and MUST be listed in the definition's `permissions`. |

Defaults: `create` → `member`; `edit` → `member`; `delete` → whatever `edit`
is. `create` MUST NOT include `creator`.

### 7.2 Which rule applies

For a version of a collection that has a valid definition in force (as of its
`seen`):

| Version | Action | Rule |
|---|---|---|
| `seq == 0` | create | `create` |
| `seq > 0`, `deleted` | delete | `delete`, else `edit` |
| `seq > 0`, not deleted | edit | `edit` (including re-creating a deleted key) |

Independently of rules, the writer's root MUST hold a role in the space as of
`seen`. With no definition in force, or in a `sys.*` collection, only that
applies here (the access collections have their own checks, in
[03 — Spaces](03-spaces.md)).

### 7.3 `onePer`: unique by construction

`onePer` is a non-empty list of parts. At most one record exists per
combination of their values — not by searching other records (no peer holds
them all) but because the record's **key is derived from them**. A second
vote by the same person on the same poll *is* the next version of the first.

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

`JSON(v)` is the JSON text of the value as the reference implementation's
`JSON.stringify` writes it. For a string, number, boolean or `null` this is the
canonical form (§1); a `null` field is present and gives `field=null`.

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

*Not yet specified:* the encoding of an object- or array-valued body field in
`onePer`. The reference writes it with `JSON.stringify`, whose member order is
the order of the parsed object, not canonical order; two implementations can
derive different keys for the same object. Use scalar fields.

### 7.4 `fixed`

`fixed` is a non-empty list of top-level body fields that keep the value the
record was created with. A peer MUST refuse a later, non-delete version in
which any listed field differs from the record's first version — compared as
`JSON.stringify` output, so "absent" equals "absent" — when it can read both
bodies. The same caveat as §7.3 applies to object- and array-valued fields.

### 7.5 Checking a definition's rules

`rules` MUST be an object with no members other than `create`, `edit`,
`delete`, `onePer`, `fixed`, each valid as above (`onePer` and `fixed`:
non-empty lists of non-empty strings). A definition with anything else is
invalid (§6.1).

> Rationale: a rule names either a fact any peer can check from the record
> (`creator`) or a permission a person decided (`can:…`). "Did a person have to
> decide it?" is the test for which one to use.

*Source: `src/records/rules.ts` (`checkRules`, `allows`, `onePerKey`, `changedFixedField`, `permissionName`, `PERMISSION_PATTERN`), `src/node/space-runtime.ts` (`judgeStanding`, `rulesAt`, `mayNow`, `put`). Tests: `tests/rules.test.ts` (all), `tests/schemas.test.ts` ("a poll: one vote per person…").*

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

*Source: `src/records/topics.ts` (`checkTopics`, `topicValues`, `topicKey`, `topicTag`, `tagsFor`, `sameTags`, `MAX_TOPICS`, `MAX_TAGS`), `src/node/space-runtime.ts` (`tagKey`, `tagProblem`, `write`). Tests: `tests/topics.test.ts` (all).*

---

## 9. Validation: what a peer checks before keeping a version

A version arriving from anywhere — a peer, a folder, a mirror — or written
locally, passes the same checks. The order below is the reference order; a
version refused by any step is refused.

### 9.1 Shape (the structural gate)

The version-alone checks of §4.6. A body that is an encryption envelope
(`ciphertext`, `iv`, `keyId` all strings) is not inspected further.

Body shape against the collection's schema is **not** checked here on arrival
(§9.6).

*Implementation detail:* the structural gate can also validate bodies against
registered Standard Schemas and refuse unknown collections; the node
configures it with no schemas and `allowUnknownCollections`, so on arrival it
performs only the shape check.

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

### 9.4 Standing (the stateful check)

Given a valid signature and root, whether the version *stands* in this space:

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

*Implementation detail:* the validation engine also has a pluggable
WebAssembly "stateful gate", run after the capability gate: a module
exporting `memory`, `validate(ptr, len) → i32` and optionally
`alloc(size) → ptr`, given the expression as `JSON.stringify` UTF-8 bytes;
`0` passes. The node registers no modules, so it always passes. It is not part
of the protocol.

### 9.5 What a peer does with a refused version

A check can end three ways:

| Outcome | When | What the peer does |
|---|---|---|
| **stands** | every check passes | Stores it; the ordering rule (§4.3) decides whether it becomes current. |
| **later** | it depends on something not held: its first version, or access changes named in `seen` | Holds it aside (at most 1,000, oldest dropped) and re-judges waiting versions whenever something new is stored. Nothing is reported. |
| **refused** | any other failure | Does not store it, does not pass it on, and reports it (a `rejected` event with the peer and reason). Remembers the refusal as (peer, id) — at most 10,000 — only so it does not ask that peer again. |

A peer MUST NOT remember a refusal by id alone, and MUST NOT cache a failing
verdict: a copy with a mangled signature shares the genuine version's id
(§3.2). A peer MAY cache passing verdicts by (`id`, `signature`).

Whether a stored version stands can change as the access history grows (a
removal, a revoked note — [03](03-spaces.md)). When reading, a peer uses the
current version if it stands; otherwise the newest held version of that record
that does; otherwise the record is absent.

*Implementation detail:* when admitting a batch, the reference sorts
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

*Source: `src/validation/validation-engine.ts`, `src/validation/structural-gate.ts`, `src/validation/crypto-gate.ts`, `src/validation/capability-gate.ts` (`MAX_CLOCK_SKEW_SECONDS`), `src/validation/stateful-gate.ts`, `src/node/space-runtime.ts` (`writeCapability`, `judge`, `judgeStanding`, `admit`, `currentOf`, `contentIssues`), `src/sync/sync-engine.ts` (`admit`, `retryWaiting`, `MAX_WAITING`, `MAX_REFUSED`). Tests: `tests/validation.test.ts` (all), `tests/rules.test.ts` ("a forged edit is refused by every peer…", "arriving in any order"), `tests/space-catalog.test.ts` ("a record that does not fit is kept and flagged"), `tests/links.test.ts` ("declared links"), `tests/topics.test.ts` ("a record whose tags don't match…"), `tests/attacks.test.ts`.*

---

## 10. Describing a collection

A definition's `title` and `description` are its author's words and may say
anything. What a collection actually allows is worked out from its rules, as
fixed sentences, so a person deciding whether to add a collection reads what
every peer will enforce.

`describe(definition)` returns, in this order:

1. Who may add: "Anyone in the space can add a vote." / "Only … can add …".
2. Who may change and remove — one sentence when `edit` and effective `delete`
   are the same set, else one each: "Only whoever added a vote can change or
   remove it."
3. `onePer`: "One vote per person per poll — adding another changes the
   first." (with `@author`); otherwise "… — anyone adding another replaces the
   first." when `edit` includes `member`, else "… — whoever adds it first holds
   it."
4. `fixed`: "Once a poll is added, its “options” can't be changed."
5. One per declared link: "Each vote points at one thing: a poll (“about”)." or
   "A comment can point at anything in the space (“about”)."
6. `permissions`: "Roles in the space can be given permission to “moderate”."
7. `history: "all"`: "Every earlier version of a … is kept."

Nouns come from `title`, else the last segment of `name`; field labels from
the schema's `title`s, else the field name in words. A rule the describer does
not know MUST make it fail rather than stay silent.

This is presentation, not wire format; the exact wording is an
*implementation detail*, but the rule that every rule produces a sentence is
not.

*Source: `src/records/describe.ts`. Tests: `tests/agents.test.ts` ("what a collection allows, in words").*

---

## 11. Queries

A query is plain JSON data: it can be written by hand, sent over a wire, or
produced by an agent. It runs against the records one node holds of one space.

### 11.1 Grammar

```
Query      = { "collection": CollName,
               ?"where":   Filter,
               ?"include": IncludeMap,
               ?"sort":    { *(Field: "asc" | "desc") },
               ?"limit":   Int≥0,
               ?"cursor":  string }

Filter     = { *( Field: Condition
                | "$and": [ *Filter ]
                | "$or":  [ *Filter ]
                | "$not": Filter ) }

Condition  = Operators          ; a non-empty object whose every member name starts with "$"
           | Value              ; anything else: deep equality

Operators  = { 1*( "$eq": Value | "$ne": Value
                 | "$gt": Value | "$gte": Value | "$lt": Value | "$lte": Value
                 | "$in": [ *Value ] | "$nin": [ *Value ]
                 | "$exists": boolean
                 | "$contains": Value ) }

Field      = MetaField | BodyPath
MetaField  = "@key" | "@author" | "@root" | "@createdBy" | "@createdAt"
           | "@updatedAt" | "@seq" | "@collection"
BodyPath   = segment *( "." segment )     ; not starting with "@" or "$"

IncludeMap = { *( Name: Include ) }
Include    = { "rel": string,
               ?"from":      CollName,
               ?"direction": "in" | "out",      ; default "in"
               ?"where":     Filter,
               ?"include":   IncludeMap,        ; nesting depth ≤ 3
               ?"limit":     Int≥0,
               ?"count":     boolean }
```

A query is refused, with a reason, before it runs if: it is not an object;
`collection` is missing or empty; a filter is not an object, or `$and`/`$or`
is not a list; a member name starts with `$` and is not `$and`, `$or` or
`$not`; a `@` field is not a MetaField; an operator object names an unknown
operator; an include lacks `rel`, has a non-string `from`, a bad `direction`,
or a non-integer or negative `limit`; includes nest more than 3 deep; a `sort`
direction is not `asc`/`desc` or names an unknown `@` field; `limit` is not a
non-negative integer; `cursor` is not a string.

*Implementation detail:* the TypeScript API also accepts a definition object
as `collection` or `from`; it is replaced by its `name` before the query runs.

### 11.2 Candidates

A query considers the **current, non-deleted** version of every record in
`collection` that stands (§9.5) and whose body this node can read. Records it
cannot open are left out — here and in every include — so a result's `body` is
never `null`.

### 11.3 Field values

| Field | Value |
|---|---|
| `@key` | the record key |
| `@author` | the DID that signed this version |
| `@root` | the account it acted for |
| `@createdBy` | the root of the record's first version (or null) |
| `@createdAt` | `createdAt` of the record's first version (the creator's clock) |
| `@updatedAt` | `createdAt` of this version |
| `@seq` | `seq` |
| `@collection` | `collection` |
| body path | Walk the body: at each segment, the current value must be a non-null object or array, and the segment is a member name (or array index, as a string); otherwise the value is *missing*. |

### 11.4 Operators

`value` is the field's value (possibly missing); `x` the operand. *Equal*
means deep equality: same JSON type; objects with the same member names
(order ignored) and equal values; arrays with equal elements in order.

| Operator | Holds when |
|---|---|
| bare value `x` | `value` equals `x` |
| `$eq` | `value` equals `x` |
| `$ne` | `value` does not equal `x` — **true for a missing field** |
| `$gt` `$gte` `$lt` `$lte` | both are numbers, or both strings (compared by UTF-16 code units), and the comparison holds. Any other pairing, including missing, is false. |
| `$in` | `x` is a list containing an element equal to `value` |
| `$nin` | `x` is a list containing no element equal to `value` (false if `x` is not a list) |
| `$exists` | `(value is not missing) == x`. `null` exists. |
| `$contains` | `value` and `x` are strings and `lower(x)` is a substring of `lower(value)`; or `value` is a list with an element equal to `x`. Otherwise false. Not search. |

Several operators on one field must all hold; several fields in one filter
must all hold. `$and`: all subfilters hold; `$or`: at least one; `$not`: the
subfilter does not hold.

### 11.5 Sort, limit and cursor

- `sort` is applied field by field in the **order the members appear** in the
  `sort` object (JSON member order is significant here). Default:
  `{ "@createdAt": "asc" }`.
- Values compare: missing or `null` first; two numbers numerically; two
  booleans `false < true`; anything else by their string forms. `desc`
  reverses a field's order (so missing sorts last).
- Ties always break on `@key`, ascending — a total order that is the same on
  every node holding the same records.
- `limit` takes at most that many records after the cursor; absent means all.
  There is no maximum.
- The result's `cursor` is the key of the last record returned when more
  records follow it, else `null`. Passing it back resumes after the record with
  that key in the re-sorted candidates.
- If no candidate has the cursor's key any more, the reference starts again
  from the first record. *Not yet specified:* whether that is intended — the
  code's own comment says it resumes "from where it would have been".

### 11.6 Include

For each record returned, each named include finds related records:

- `direction: "in"` (default): current, readable, non-deleted records that
  have a link `{ rel, to: <this record's key> }`, optionally only those in
  `from`; ordered by `@createdAt`, then `@key`.
- `direction: "out"`: this record's own links with that `rel`, in link order,
  each resolved to the target's current, readable, non-deleted version,
  optionally only those in `from`. A target not held finds nothing.

Then `where` filters them. With `count: true` the include's value is the
number found (after `where`, ignoring `limit`). Otherwise it is the first
`limit` of them (all when absent), each expanded by its own nested `include`.
Every returned record has an `included` object, empty when there were no
includes.

### 11.7 Result

```json
{ "records": [ … ], "cursor": "mfrggzdfmztwq2lknnwg23tpoa", "complete": true }
```

`complete` is false only on a node that holds part of a space while a
collection the query needs is still arriving
([05 — Sync and storage](05-sync-and-storage.md)). The shape of each record
object is the node's record view ([06 — Nodes, sessions and apps](06-nodes-and-sessions.md)).

*Source: `src/query/types.ts`, `src/query/filter.ts` (`checkQuery`, `matches`, `fieldValue`, `MAX_INCLUDE_DEPTH`), `src/query/engine.ts` (`runQuery`, `sortRecords`, `expand`). Tests: `tests/query.test.ts` (all), `tests/typed-query.test.ts`.*

---

## 12. Limits

| Limit | Value |
|---|---|
| Record key | 1–128 chars of `[a-z0-9:._-]` |
| `seen` | ≤ 64 ids, each 1–128 chars |
| Links per version | ≤ 32 |
| Link role | `^[a-z][a-zA-Z0-9]{0,63}$` |
| Topic fields per collection | ≤ 8, ≤ 4 path segments |
| Tags per version | ≤ 64 |
| Permission name | `^[a-z][a-zA-Z0-9]{0,39}$` |
| Definition `screen` | ≤ 48 KiB UTF-8 |
| Include nesting | ≤ 3 |
| Future-dated `createdAt` (delegated writes) | ≤ 300 s ahead |
| Size of a body or an expression | *Not yet specified* — no limit is enforced |
| Collection name on a record | *Not yet specified* — only definitions constrain names; a record may name any string |

---

## Appendix A. The standard schemas

An optional library of ordinary definitions (`@weaveprotocol/core/schemas`).
The protocol knows none of them; a space learns one when someone defines it
there. All are `version` 1 when first defined. "About" below is
`{ "to": "*", "cardinality": "one" }`.

**Annotations** — attach to any record:

| Name | Body | Links | Permissions | Rules |
|---|---|---|---|---|
| `std.reaction` | `emoji` string 1–16, required | `about` | — | edit, delete: `creator`; `onePer: [@author, link:about, emoji]` |
| `std.comment` | `text` string 1–10000, required | `about`; `replyTo` → `std.comment`, one | `moderate` | edit: `creator`; delete: `creator`, `can:moderate` |
| `std.tag` | `label` string 1–100, required | `about` → `*`, many | `moderate` | edit: `creator`; delete: `creator`, `can:moderate` |
| `std.attachment` | `name`, `mime` strings ≥1 required; `size` integer ≥ 0; `url` string | `about` | `moderate` | edit: `creator`; delete: `creator`, `can:moderate` |
| `std.reference` | `note` string | `about`; `to` (both `*`, one) | `moderate` | edit: `creator`; delete: `creator`, `can:moderate` |

**Nouns** — shared by apps that do the same thing:

| Name | Body | Links | Permissions | Rules |
|---|---|---|---|---|
| `std.message` | `text` string 1–10000, required | `replyTo` → `std.message`, one; `shares` → `*`, one | `moderate` | edit: `creator`; delete: `creator`, `can:moderate` |
| `std.column` | `name` string 1–200, required; `position` string 1–200 | — | — | defaults |
| `std.task` | `title` string 1–500, required; `notes` string ≤ 10000; `position` string 1–200 | `column` → `std.column`, one | — | defaults |
| `std.poll` | `question` string 1–500, required; `options` string[] (each 1–200), required; `closed` boolean | — | `moderate` | edit: `creator`; delete: `creator`, `can:moderate`; `fixed: [options]` |
| `std.vote` | `choice` integer ≥ 0, required, `x-choicesFrom: {rel: about, field: options}` | `about` → `std.poll`, one | — | edit, delete: `creator`; `onePer: [@author, link:about]` |
| `std.call` | `status` enum `missed`/`ended`, required; `startedAt` string ≤ 64, required; `to` string ≤ 256; `endedAt` string ≤ 64; `people` string[] (≤ 64, each ≤ 256) | — | — | edit, delete: `creator` |

**Also exported** from the same module (specified with their features):

| Name | Body | Rules | Where |
|---|---|---|---|
| `std.contact` | `did` ≤ 256 and `name` ≤ 200, required; `space` ≤ 256; `note` ≤ 2000; `blocked` boolean | `onePer: [did]` | [03 — Spaces](03-spaces.md) |
| `std.contact-request` | `to` ≤ 256 and `sealed` ≤ 16000, required | edit, delete: `creator` | [03 — Spaces](03-spaces.md) |
| `std.app` | `title` 1–100 and `needs` (1–10 objects), required; `description` ≤ 1000; `from` ≤ 300 | edit: `creator`; delete: `creator`, `can:moderate`; permission `moderate` | [06 — Nodes, sessions and apps](06-nodes-and-sessions.md) |

**Positions.** `position` is a string that sorts (by plain string comparison)
where a record goes in a hand-made order. Digits are `0–9a–z`; a position
never ends in `0`, so there is always room between two. Equal positions sort by
key. A record without one goes at the end. `positionBetween(before, after)` in
the library makes one; any string that sorts correctly is valid.

*Source: `src/schemas/index.ts`, `src/schemas/contacts.ts`, `src/schemas/apps.ts`. Tests: `tests/schemas.test.ts`, `tests/contacts.test.ts`, `tests/agents.test.ts`.*
