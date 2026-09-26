# 03 — Spaces

A **space** is the container every record lives in. This part specifies what a
space is and how its id is made; how roles, members and invites are recorded
inside it and replayed into one answer about who may do what; how a private
space encrypts its records and changes its key; and the few spaces and
collections built on top of that: the account registry, passes, subscriptions,
profiles and contacts.

What a record is, how it is signed, hashed and versioned, and how collection
rules are written is in [02 — Records](02-records.md). Seeds, DIDs, notes
(UCANs), the vault key and the contact key are in [01 — Identity](01-identity.md).
How peers connect and prove they may read is in [04 — Network](04-network.md).

- [1. The space and its id](#1-the-space-and-its-id)
- [2. Roles and permissions](#2-roles-and-permissions)
- [3. The access history](#3-the-access-history)
- [4. Replaying the access history](#4-replaying-the-access-history)
- [5. Judging a record against the history](#5-judging-a-record-against-the-history)
- [6. Changing who may do what](#6-changing-who-may-do-what)
- [7. Invites](#7-invites)
- [8. Private spaces: encryption](#8-private-spaces-encryption)
- [9. Key changes, member keys and boxes](#9-key-changes-member-keys-and-boxes)
- [10. Relays and keepers](#10-relays-and-keepers)
- [11. Profiles](#11-profiles)
- [12. The space manager](#12-the-space-manager)
- [13. The account registry](#13-the-account-registry)
- [14. Passes and carry spaces](#14-passes-and-carry-spaces)
- [15. Subscriptions (notify)](#15-subscriptions-notify)
- [16. Contacts](#16-contacts)
- [17. Not yet specified](#17-not-yet-specified)

Terms used throughout:

| Term | Meaning |
|---|---|
| **account** | An identity's root DID (`did:key:zDn…`, [01](01-identity.md)). What a role is held by. |
| **root** of a version | The account the signing key speaks for: the issuer at the root of the version's note chain, resolved as of the version's `createdAt`, or the author itself when there is no note ([01](01-identity.md), [02](02-records.md)). |
| **member** | An account that holds a role that still exists, in a given state of the history. |
| **reader** | Same as member, as far as key distribution is concerned (`readers()`). |
| **hex40(x)** | The first 20 bytes of SHA-256(UTF-8 `x`), as 40 lower-case hex characters. |
| **cid(x)** | `"b"` + lower-case RFC 4648 base32 (no padding) of SHA-256(`x`). The id format of [02](02-records.md). |

---

## 1. The space and its id

### 1.1 The space object

A space, as it is handed around (in invites, passes, the space manager), is a
JSON object:

| Field | Type | Notes |
|---|---|---|
| `id` | string | `cid(canonical(genesis))`, see 1.2 |
| `name` | string | Display name. **Not** part of the id; unauthenticated and may differ between copies. |
| `visibility` | `"public"` \| `"private"` | Fixed at creation. Private means record bodies are encrypted (§8). |
| `creator` | string | The creator's account DID. Starts holding `creatorRole`. |
| `roles` | Role[] | The roles it starts with (§2). 1–64 roles, names unique. |
| `creatorRole` | string | Name of one of `roles`. |
| `createdAt` | string | ISO 8601 timestamp. |
| `nonce` | string | base64url of 12 random bytes (16 characters). Keeps two spaces made alike apart. |
| `readKey` | string | Private only: the `did:key` of the space's first read key (§8.4). |
| `encryptionKeyId` | string | Private only: the id of the space's first key (§8.1). |

### 1.2 The genesis and the id

The **genesis** is the space object without `id` and `name`, with a version
field:

```
genesis = { v: 2, creator, visibility, roles, creatorRole, createdAt, nonce,
            readKey?,           // private only
            encryptionKeyId? }  // private only
id = cid( canonical-JSON(genesis) )
```

Canonical JSON is defined in [02 — Records](02-records.md) (sorted keys, no
whitespace). Role objects inside keep their fields as given (`title` omitted
when absent).

A peer handed a space — in an invite, a pass, from a host — **MUST** refuse it
unless all of these hold (`checkSpace`):

1. `id`, `nonce` and `creator` are strings;
2. `visibility` is `public` or `private`;
3. `roles` is a list of 1–64 well-formed roles (§2.1) with distinct names, and
   `creatorRole` names one of them;
4. a private space has both `readKey` and `encryptionKeyId`; a public space
   has neither;
5. `cid(canonical(genesis))` equals `id`.

> Rationale: nobody who passes a space on can change who started it, with which
> roles, or with which first key. The name is left out so it can change.

**Example.** Creator `did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg`
(the account of seed `01 02 … 10`), the `team` preset, a fixed time and nonce:

```
{"createdAt":"2026-01-01T00:00:00.000Z","creator":"did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg","creatorRole":"owner","nonce":"AAECAwQFBgcICQoL","roles":[{"name":"owner","permissions":["*"],"rank":100,"title":"Owner"},{"name":"editor","permissions":["invite","define"],"rank":10,"title":"Editor"}],"v":2,"visibility":"public"}
→ id biypcptbxz4vneknbgueo46ksdldc57anajp3kit5wuevkqeh4i6q
```

The same space made private with the AES key whose raw bytes are
`ff fe fd … e0` (base64url `__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA`):

```
{"createdAt":"2026-01-01T00:00:00.000Z","creator":"did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg","creatorRole":"owner","encryptionKeyId":"GGXACDHnP37iP8E8stD1iLnDQYNcp0cvjsA1q6S3idY","nonce":"AAECAwQFBgcICQoL","readKey":"did:key:zDnaem2ikLwS3eYm46gspC7nm6dmYYCMHUHU5yvVHNgARcsWf","roles":[…as above…],"v":2,"visibility":"private"}
→ id b63yb6wiefzfrngbgbmozhv7zcf5ikunjr4al6njqyxvbf62dvi7a
```

### 1.3 Creating a space

To create a space a peer picks the starting roles and `creatorRole`, takes the
current time and a fresh 12-byte random nonce, and for a private space
generates a space key (§8.1) and derives its read key (§8.4). Then it computes
the id. Nothing is written into the space at creation: the genesis alone
makes the creator a member.

*Implementation detail:* with no roles given the `solo` preset is used; with
roles but no `creatorRole`, the highest-ranked role is the creator's.

*Source: `src/space/space-access.ts` (`spaceGenesis`, `spaceIdOf`, `checkSpace`, `checkStartingRoles`), `src/space/space-manager.ts` (`create`), `src/types.ts` (`Space`). Tests: `tests/space.test.ts`, `tests/space-access.test.ts` ("the space vouches for itself").*

---

## 2. Roles and permissions

### 2.1 Roles

```
Role = { name: string, title?: string, rank: number, permissions: string[] }
```

A role is well-formed (`checkRole`) when:

- `name` matches `^[a-z0-9][a-z0-9._-]{0,39}$`;
- `title`, if present, is a string of at most 80 characters;
- `rank` is a finite number (any sign, may be fractional);
- `permissions` is a list of non-empty strings of at most 200 characters each.

### 2.2 Permissions and matching

A permission is a plain string. Three are checked by the protocol itself:

| Permission | Lets its holder |
|---|---|
| `manage` | change roles and members (§6), change the space key (§9), name relays and keepers (§10), change any collection definition |
| `invite` | open and close invites (§7) |
| `define` | define a new collection (§3.1) |

Every other permission belongs to a collection and is named
`<collection>/<permission>` — a rule `can:moderate` in collection `app.poll`
asks for `app.poll/moderate` ([02](02-records.md)).

A permission pattern in a role **matches** a permission when it is equal to it,
or is `*`, or — when it contains `*` — when the pattern, with each `*` read as
"any run of characters (possibly empty)" and everything else literal, matches
the whole permission. So `*` is every permission, `*/*` every collection
permission, `app.forum.*/moderate` matches `app.forum.post/moderate`. A role
**holds** a permission when any of its patterns matches it.

### 2.3 Presets

Presets are plain data for applications; the protocol never looks at a
preset's name. *Implementation detail.*

| Preset | Roles (name, rank, permissions) | Creator |
|---|---|---|
| `solo` | owner 100 `["*"]` | owner |
| `team` | owner 100 `["*"]`; editor 10 `["invite","define"]` | owner |
| `community` | admin 100 `["*"]`; moderator 50 `["invite","*/*"]`; member 0 `[]` | admin |

*Source: `src/space/roles.ts` (`checkRole`, `permissionMatches`, `roleHolds`), `src/space/presets.ts`, `src/records/rules.ts` (`permissionName`). Tests: `tests/roles.test.ts` ("permissions").*

---

## 3. The access history

Everything after the genesis that changes who may do what is a record in the
space itself. These records form the **access history**.

### 3.1 The access collections

Each access record lives at a fixed record key, derived from what it changes.
Bodies are JSON objects; `keep` is optional everywhere it appears (§6.3).

| Collection | Record key | Body | Event kind |
|---|---|---|---|
| `sys.role` | `role:<name>` | `{ name, title?, rank, permissions, keep? }` or `{ name, removed: true, keep? }` | `role` |
| `sys.member` | `member:<hex40(account DID)>` | `{ did, role: string \| null, keep?, invite?: { key, signature } }` | `member` |
| `sys.invite` | `invite:<hex40(invite DID)>` | `{ key: <invite DID>, role, open: boolean, keep? }` | `invite` |
| `sys.revoke` | `revoke:<hex40(cid(note))>` | `{ note: <encoded UCAN>, keep? }` | `revoke` |
| `sys.collection` | `collection:<name>` | a collection definition ([02](02-records.md)); may be encrypted | `definition` |
| `sys.key` | `key:space` | `{ keyId, readKey, earlier }` (§9) | `key` |
| `sys.relays` | `relays:space` | `{ relays: string[] }` (§10) | `relays` |
| `sys.keepers` | `keepers:space` | `{ keepers: [{ did, name }], copies: number \| null }` (§10) | `keepers` |

`cid(note)` is `cid` of the UTF-8 bytes of the encoded note string.

> Rationale: record keys are lower case and DIDs are not, so a key names a
> hash of the thing and the body names the thing itself.

Example keys for the account above: `member:4ac5085b5ad9c944bd682566b17bbfd1da9c5dab`;
for the invite DID `did:key:zDnaeVSCSBvS7JUHhskZ9mPRzhjsxsgTwSe6h5a9VSE1LJ2vw`:
`invite:fd8ebfa892a6c4bae7cd265123b7844e49fa50e8`.

### 3.2 Every record names what it saw

Every version written in a space — access record or not — carries `seen`: the
ids of the **heads** of the access history as its writer knew them (§4.6). A
writer **SHOULD** set `seen` to its current heads. The space id itself may
appear in `seen` and stands for the genesis. Access records **MUST** carry
`retain: true` ([02](02-records.md)); a version without it is not an access
event.

### 3.3 From a version to an event

A peer turns each stored version in an access collection into an **event**, or
into nothing. It **MUST** collect versions by record key prefix — every
version, not only current ones — and use only those whose collection is the
one the prefix belongs to (`role:`→`sys.role`, `member:`→`sys.member`,
`invite:`→`sys.invite`, `revoke:`→`sys.revoke`, `collection:`→`sys.collection`,
`key:`→`sys.key`, `relays:`→`sys.relays`, `keepers:`→`sys.keepers`).

A version yields no event when any of these hold:

- it lacks `retain`;
- it was written under an agent note ([01](01-identity.md)) — agents never change access;
- its signature, or the note chain behind it, does not verify ([02](02-records.md));
- it is not a `sys.collection` version and it is deleted, or its body is
  encrypted, or its body is not an object;
- the fields below do not check out.

Otherwise the event is `{ id: version.id, key: version.key, root, seen: version.seen ?? [], keep, kind, … }`,
where `keep` is `body.keep` if it is a list of strings (first 10 000 taken),
else `[]` (always `[]` for `definition`, `key`, `relays`, `keepers`), and:

| Kind | Checks | Event fields |
|---|---|---|
| `definition` | key starts with `collection:` | `name` = key after `collection:`; `deleted` = version is deleted |
| `role` | `body.name` is a string, key = `role:<name>` | `removed: true` → `role: null`; else `role = {name, title?, rank, permissions}` which must pass `checkRole` |
| `member` | `did` string, `role` string or null, key = `member:<hex40(did)>`; if `invite` present it must be `{key: string, signature: string}` and verify (§7.3) | `did`, `role`, `viaInvite` = `invite.key` when present |
| `invite` | `key` string, `role` string, `open` boolean, record key = `invite:<hex40(key)>` | `inviteKey`, `role`, `open` |
| `key` | record key `key:space`, `keyId` string ≤ 64 chars, `readKey` starts with `did:key:` | `keyId`, `readKey` |
| `relays` | record key `relays:space`, `relays` list of strings, ≤ 8 | `relays` |
| `keepers` | record key `keepers:space`, `checkKeepers(keepers, copies ?? null)` passes (§10) | `keepers`, `copies` |
| `revoke` | `note` string parsing as a UCAN; key = `revoke:<hex40(cid(note))>` | `note` = `cid(note)`, `issuer` = the note's `iss` |

A deleted version in any access collection other than `sys.collection` is
therefore ignored: access is taken away by writing a change, never by deleting.

### 3.4 Storing access records

Whether an access event *counts* can change as others arrive, so a peer stores
every well-formed one and lets the replay decide. A peer **MUST NOT** store an
access version from outside (a peer, a folder) unless:

1. its `space` is this space's id and it has `retain`;
2. it yields an event (§3.3);
3. everything its `seen` names is present and not waiting (§4.1);
4. its root is **named** by the history — the creator, or the `did` of any
   `member` event with a non-null role, whatever became of it — or it is a
   `member` event joining by an invite key that some held `invite` event
   names, or it is a `revoke` whose issuer is named.

> Rationale: a stranger who knows a space's id can mint signed records for
> free. Only accounts the history has heard of can get anything stored, and
> "named" only grows, so two peers never disagree for good.

*Source: `src/space/roles.ts` (collection constants), `src/space/space-access.ts` (record keys), `src/node/space-runtime.ts` (`buildEvent`, `loadAccess`, `admissible`). Tests: `tests/space-access.test.ts` ("a stranger who knows the space cannot write in it"), `tests/attacks.test.ts`.*

---

## 4. Replaying the access history

Every peer runs the same pure function over the same events and gets the same
state. This section is normative in full: a peer that orders differently will
disagree about who may write.

### 4.1 State

```
State = {
  roles:       Map<name, Role>,
  members:     Map<accountDid, roleName>,
  invites:     Map<inviteDid, { role, open, event }>,
  definitions: Map<collectionName, { event, definedBy }>,
  keys:        [{ keyId, readKey, event }],   // oldest first; last is current
  keyDue:      boolean,
  relays:      string[],
  keepers:     [{ did, name }],
  copies:      number | null,
}
```

The **start state** comes from the genesis: `roles` = the starting roles;
`members` = `{ creator → creatorRole }`; for a private space `keys` =
`[{ keyId: encryptionKeyId, readKey, event: <space id> }]`, else `[]`;
everything else empty, `false` or `null`.

`role(state, did)` is `state.roles[state.members[did]]`, or null when either
lookup fails. `rank(null)` is −∞. `readers(state)` is every `did` in `members`
whose role name is in `roles`.

### 4.2 Input and waiting

Input: the genesis and a set of events, deduplicated by `id` (first kept).
Call `G` the space id.

An event is **waiting** if its `seen` names itself, or names an id that is
neither `G` nor a held event, or names a waiting event. Compute this to a
fixed point. Waiting events are not placed; their status is `waiting`. All
others are **placeable**.

`ancestors(e)` is the transitive closure of `seen` from `e`, excluding `G`.
`children(e)` are the placeable events whose `seen` names `e`;
`leadsTo(e)` is `e` plus all its transitive children.

### 4.3 Order

Placement is Kahn's topological sort over `seen` (ignoring `G` and duplicate
parents): an event is **ready** once every parent has been placed (applied or
dropped). While any event is ready, compute for each ready event `e`, against
the **current** state `S`, the tuple:

```
p1 = min over steps s in leadsTo(e) that "may take away" of  −rank(role(S, s.root))
     (+∞ if there is none)
     where s may take away if:  s = e and (takesAway(e, S) or mayTakeAway(e))
                                s ≠ e and mayTakeAway(s)
p2 = 0 if takesAway(e, S) else 1
p3 = −rank(role(S, e.root))
p4 = e.id
```

and place the ready event with the lexicographically smallest
`(p1, p2, p3, p4)` (numbers ascending; `p4` by string comparison of ids).

`takesAway(e, S)`, judged against the state:

| Kind | Takes away when |
|---|---|
| `revoke` | always |
| `invite` | `open` is false |
| `member` | `role` is null; or the person has a role now and the new role's rank (−∞ if the role doesn't exist) is lower |
| `role` | the role exists now and: it is removed, or its rank goes down, or it loses any permission string it had |
| `definition`, `key`, `relays`, `keepers` | never |

`mayTakeAway(e)`, judged from the event alone (for events not yet reachable):

| Kind | May take away when |
|---|---|
| `revoke` | always |
| `invite` | `open` is false |
| `member` | `role` is null, or (`root ≠ did` and it is not joining by invite) |
| `role` | always |
| others | never |

> Rationale: among changes that did not see each other, taking away goes first
> — counting everything on the way to one, so a removal that also saw
> something not yet placed still beats a change it had not seen. Then the
> higher-ranked author, then the lower id.

### 4.4 Applying one event

When event `e` is placed:

1. **Rival.** If an event with the same `key` was already applied and is not
   in `ancestors(e)`, drop `e` ("a change to the same thing that it had not
   seen came first").
2. **As of what it saw.** Let `S_seen` be the start state with every applied
   event in `seen ∪ ancestors(seen)` (excluding `G`) applied again in replay
   order. If `refusal(e, S_seen)` is non-null, drop `e`.
3. **At its turn.** If `refusal(e, S)` is non-null, drop `e`.
4. Otherwise, record the **reductions** (§4.5), apply `e` to `S`, mark it
   `applied` with the next index, and remember it under its `key`.

Dropped events stay placed: their children may still become ready.

Applying (`apply`):

| Kind | Change to `S` |
|---|---|
| `role` | set `roles[name] = role`, or delete it when `role` is null |
| `member` | set `members[did] = role`, or delete it when `role` is null |
| `invite` | `invites[inviteKey] = { role, open, event: id }` |
| `revoke` | nothing (recorded separately: the first applied revoke of each note, with its keep list) |
| `definition` | delete `definitions[name]` when `deleted`; else set it to `{ event: id, definedBy }` where `definedBy` is the existing `definedBy`, or `root` if new |
| `key` | append `{ keyId, readKey, event: id }` to `keys`; set `keyDue = false` |
| `relays` | `relays = relays` |
| `keepers` | `keepers`, `copies` as given |

After any non-`key` event, if `keys` is non-empty and some account that was in
`readers(S)` before is not after, set `keyDue = true`.

### 4.5 Refusals — the rank rule

`refusal(e, S)` with `A = role(S, e.root)` is:

**`role`**
- `A` must hold `manage`;
- if the role exists, its rank must be below `A.rank`;
- removing: the role must exist;
- otherwise the new rank must be below `A.rank`, and every permission in the
  new role must be matched by some pattern of `A` (a `*` in `A`'s pattern
  matches anything, including a `*`).

**`member`**
- *Joining by invite* (`viaInvite` set): `root` must equal `did`; the invite
  must exist and be open; its role must equal `e.role`; `did` must have no
  role now; the invite's role must exist.
- *Leaving*: `root = did` and `role` null is allowed when `did` has a role now.
- *Otherwise*: `A` must hold `manage`; if `did` has a role now, its rank must
  be below `A.rank`; removing requires `did` to have a role; a new role must
  exist and its rank must be **at most** `A.rank`.

**`invite`**
- `A` must hold `invite`;
- if the invite exists and its current role exists, that role's rank must be
  at most `A.rank`;
- closing (`open: false`) requires the invite to exist;
- opening requires the role to exist with rank at most `A.rank`.

**`revoke`** — `root` must equal the note's issuer.

**`definition`**
- a new collection: `A` must hold `define`;
- an existing one (change or delete): `A` holds `manage`, or `A` is non-null
  and `root` is the collection's `definedBy`.

**`key`** — the space must have keys (private); `A` must hold `manage`; the
`keyId` and the `readKey` must both differ from every key already in `keys`.

**`relays`** — `A` must hold `manage`, and the list must pass `checkRelays` (§10).

**`keepers`** — `A` must hold `manage`, and the list must pass `checkKeepers` (§10).

A consequence of the rank rule: two accounts of equal rank can never remove or
demote each other, only themselves.

**Reductions.** Before applying an applied `member` or `role` event, for each
*affected* account — the `did` of a `member` event; every current holder of the
role for a `role` event — record `{ event: id, did, before: role(S, did), after: role(S', did) }`
where `S'` is the state after applying. Reductions drive §5.

### 4.6 What the replay exposes

- `current` — the final state.
- `status(id)` — `applied` (with index), `dropped` (with reason), `waiting`, or unknown.
- `heads()` — the ids of placeable events (applied **or** dropped) that no
  placeable event's `seen` names, sorted ascending. This is what a writer puts
  in `seen`.
- `at(seen)` — `S_seen` as in §4.4, or null when anything in `seen` (other
  than `G`) is missing or waiting.
- `revoked(noteCid)` — the first applied revoke of that note, and its keep set.
- `named(did)`, `knownInvite(inviteDid)` — as used in §3.4.

**Example (a removal against a concurrent ban).** Admin Alice makes Bob a
moderator and gives moderators `manage`, then adds Carol. Apart, Alice removes
Bob and Bob removes Carol; both saw Carol's addition. Both are ready together.
Alice's removal takes away with author rank 100 (`p1 = −100`); Bob's with rank
50 (`p1 = −50`). Alice's is placed first; Bob then holds no role at his turn,
so his removal of Carol is dropped. Every arrival order gives Bob: none,
Carol: member.

*Source: `src/space/roles.ts` (`replayAccess`, `takesAway`, `mayTakeAway`, `refusal`, `apply`). Tests: `tests/roles.test.ts` (all of "the rank rule", "invites", "offline conflicts"), `tests/key-change.test.ts` ("when a new key is due").*

---

## 5. Judging a record against the history

### 5.1 `judge`

Given a record's `id`, its root, its `seen`, the CID of the note it was
written under (if any), and a predicate `needs(role, state)`:

1. If anything in `seen` is missing or waiting → not yet (retry later).
2. If the note has been revoked (§6.4) and the revoke's `keep` does not list
   this record's id → refused.
3. `S_seen = at(seen)`. If `needs(role(S_seen, root), S_seen)` is false → refused.
4. For every reduction of `root` whose event is **not** in `seen ∪ ancestors(seen)`,
   and whose event's `keep` does not list this record's id: if
   `needs(before)` and not `needs(after)` → refused ("its author's access was
   taken away").
5. Otherwise it stands.

So a record stands if its author was allowed as of what it saw, and nothing it
had not seen took that away — unless that change kept it.

### 5.2 Standing of an ordinary record

A version outside the access collections **stands** when, in this order:

1. its `space` equals the space id;
2. its signature and note chain verify ([02](02-records.md)) — giving `root`;
3. in the account's own spaces (registry, contacts, carry spaces) it is not
   written under an agent note (*implementation detail*: `peopleOnly`);
4. its first version is present, is `seq` 0, has the same key and collection;
5. `at(seen)` is available (else: not yet);
6. with `rules` = the rules of the definition in force for its collection in
   `at(seen)` (none for `sys.*` collections, or when the definition is missing
   or unreadable), the action (`create` for `seq` 0, `delete` for a deleted
   version, else `edit`), and `creator` = whether the root of the first
   version is `root`:
   `needs(role) = role ≠ null and (no rules or allows(rule for action, { member: true, creator, can: p → role holds <collection>/p }))`
   ([02](02-records.md) for `allows`, `onePer`, `fixed` and topics);
7. `role(at(seen), root)` is non-null and satisfies `needs`;
8. `judge(...)` (§5.1) passes;
9. the [02](02-records.md) checks on topic tags, `onePer` keys and `fixed`
   fields pass (skipped where the body cannot be opened).

An access record stands when its event's status is `applied`.

A non-member — including someone holding only a view-only invite — can
therefore write nothing at all in a space, not even `sys.profile`.

*Source: `src/space/roles.ts` (`judge`), `src/node/space-runtime.ts` (`judgeStanding`, `rulesAt`). Tests: `tests/roles.test.ts` ("records against the history"), `tests/space-access.test.ts` ("who may write", "taking it back"), `tests/rules.test.ts`.*

---

## 6. Changing who may do what

### 6.1 Members and roles

- **Add or change a member:** write `sys.member` at `member:<hex40(did)>` with
  `{ did, role }`.
- **Remove a member:** the same with `role: null`.
- **Define or change a role:** write `sys.role` at `role:<name>` with the role.
- **Remove a role:** `{ name, removed: true }`. Its holders stay in `members`
  but hold nothing (they are no longer readers).

Each is judged by §4.5.

### 6.2 Leaving and handing over

**Leaving the space's history:** an account writes its own member record with
`role: null`. Anyone may do this, whatever their rank.

**Handing over:** someone at the top gives another account their own role
(allowed: a role up to your own rank), then removes themselves. The new holder
keeps managing.

**Leaving on a node** (`node.spaces.leave`) is local: the node deletes the
space's membership record in the account registry (§13), closes the space and
forgets it and its keys. *It does not write a `sys.member` change*, so the
space's history still lists the account, and no key change becomes due. Not
yet specified whether a protocol-level leave should also write the
self-removal.

### 6.3 Keep lists

A change that takes power from people — lowering or removing a member, lowering
or removing a role — **SHOULD** carry `keep`: the ids of the current versions,
outside the access collections, written by the affected accounts that the
writer has seen (at most 10 000). §5.1 step 4 lets those stand; anything else
the affected account wrote that relied on the lost power and had not seen the
change is refused, whatever point in history it claims.

`keep` on an `invite` event is parsed but has no effect on judging (only
`member` and `role` events produce reductions); an invite close decides who
got in by replay order alone (§4.3).

### 6.4 Revoking a note

Whoever signed a note (UCAN) may revoke it in a space by writing `sys.revoke`
at `revoke:<hex40(cid(note))>` with `{ note, keep? }`; `keep` lists the
versions written under that note that the revoker has seen and wants to stand.
From the first applied revoke on, every version written under that note
stands only if kept (§5.1 step 2) — whatever it saw.

*Source: `src/node/space-runtime.ts` (`setMember`, `putRole`, `removeRole`, `revoke`, `keepFrom`), `src/node/node.ts` (`spaces.leave`). Tests: `tests/roles.test.ts` ("handing over…", "a revoked note…"), `tests/space-access.test.ts` ("taking it back").*

---

## 7. Invites

### 7.1 Invite secret and invite key

An invite link that lets someone join with a role carries a **secret**: 32
random bytes. It stands for a P-256 key pair:

```
seed    = HKDF-SHA256(ikm = secret, salt = empty, info = "weave/space-invite/v1", L = 32)
keypair = deriveKeyPairFromSeed(seed)      // 01 — Identity
invite DID = did:key of the public key     // P-256 multicodec
```

Example: secret `00 01 02 … 1f` (base64url `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`)
→ `did:key:zDnaeVSCSBvS7JUHhskZ9mPRzhjsxsgTwSe6h5a9VSE1LJ2vw`.

A secret of any length other than 32 bytes **MUST** be refused.

### 7.2 Opening and closing an invite

An account holding `invite` opens one by writing `sys.invite` at
`invite:<hex40(inviteDid)>` with `{ key: inviteDid, role, open: true }`. Only
the invite's public key goes into the space; the secret goes only into the link.

It is closed by writing the next version of the same record with `open: false`
(same `key` and `role`). Deleting the record does **not** close it (§3.3). A
view-only invite (§7.5) has no record and cannot be closed; only a key change
(§9) stops it working for new records.

### 7.3 Joining with a secret

Once the invite's record has reached the joiner and is open in the current
state, the joiner writes **its own** member record:

```
sys.member at member:<hex40(joinerDid)>
{ did: joinerDid, role: <the invite's role>,
  invite: { key: inviteDid, signature: base64url(sig) } }

sig = ECDSA-P256-SHA256 (P1363, 64 bytes) by the invite private key over
      UTF-8 "weave/space-invite/v1|<spaceId>|<joinerDid>"
```

Verification imports the public key from `inviteDid` and checks `sig` over
the same bytes; a member record whose `invite` does not verify yields no event
(§3.3). The signature binds the join to one account and one space.

If the joiner already holds a role, joining is a no-op. If the invite's record
has not arrived yet, the joiner keeps the secret and tries again as records
arrive; once joined it forgets the secret. *Implementation detail:* this is
written even though the joiner is not yet a member (`joining: true`), and its
`seen` is the joiner's heads, which must include the invite event.

### 7.4 The invite string

An invite is `base64url( UTF-8( JSON.stringify(SpaceInvite) ) )` — plain
`JSON.stringify`, not canonical:

| Field | Type | Present |
|---|---|---|
| `space` | space object (§1.1), including `name` | always |
| `invitedBy` | string, the inviter's account DID | always; unauthenticated, for display |
| `key` | base64url of the raw 32-byte AES key | private spaces (the inviter's current key) |
| `invite` | base64url of the 32-byte secret | role invites only |
| `role` | string | role invites only; for display — the invite record is what counts |
| `relays` | string[] | when known: the space's relays (§10), else the inviter's own |

Example (private space of §1.2, role invite with the secret of §7.1), decoded:

```json
{"space":{"id":"b63yb6wiefzfrngbgbmozhv7zcf5ikunjr4al6njqyxvbf62dvi7a","visibility":"private","creator":"did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg","roles":[{"name":"owner","title":"Owner","rank":100,"permissions":["*"]},{"name":"editor","title":"Editor","rank":10,"permissions":["invite","define"]}],"creatorRole":"owner","createdAt":"2026-01-01T00:00:00.000Z","nonce":"AAECAwQFBgcICQoL","readKey":"did:key:zDnaem2ikLwS3eYm46gspC7nm6dmYYCMHUHU5yvVHNgARcsWf","encryptionKeyId":"GGXACDHnP37iP8E8stD1iLnDQYNcp0cvjsA1q6S3idY","name":"Plans"},"invitedBy":"did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg","key":"__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA","invite":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","role":"editor","relays":["wss://relay.example"]}
```

encoded: `eyJzcGFjZSI6eyJpZCI6ImI2M3liNndpZWZ6ZnJuZ2JnYm1vemh2N3pjZjVpa3VuanI0YWw2bmpxeXh2YmY2MmR2aTdhIiwidmlzaWJpbGl0eSI6InByaXZhdGUi…`
(the full string is the base64url of the JSON above).

A private-space invite carries the space key, so the whole string is a
secret. When embedded in a URL it **SHOULD** go in the fragment. A reader
**MUST** accept either the bare string or a link containing
`#invite=<string>` (also `?invite=` / `&invite=`), taking the value up to the
next `&` or whitespace.

### 7.5 View-only and role invites

- A **view-only** invite has no `invite` and no `role`. It gives the space
  (and, for a private space, the key) — enough to sync and read — and no
  standing: the holder writes nothing.
- A **role** invite also carries the secret of an open `sys.invite` record.

*Implementation detail* (`node.spaces.invite`): with no role given, the node
opens an invite for the lowest-ranked role strictly below the inviter's; when
there is none (e.g. `solo`) it makes a view-only invite. `write: false` forces
view-only. Each role invite gets its own fresh secret and record.

### 7.6 Accepting and previewing

On `join`, a peer **MUST**:

1. parse the string (reject if it is not base64url JSON with `space.id` and `space.name`);
2. refuse the space unless `checkSpace` passes (§1.2);
3. refuse a `key` for a public space;
4. refuse an `invite` secret that is not 32 bytes.

A carried `key` is imported as-is; its id is its hash (§8.1), so it is either
a key the history names or one that opens nothing. It is not checked against
`encryptionKeyId` (it may be a later key). Relays from the invite are a hint,
used only if they pass `checkRelays` and the node holds no relay list for the
space yet.

A **preview** decodes without storing: `{ space: {id, name, visibility, creator, createdAt}, invitedBy, carriesKey, carriesWrite, role }`
(`role` null for a view-only invite). *Implementation detail.*

Closing an invite by its link: derive the invite DID from the link's secret
(§7.1) and close that record.

*Source: `src/space/space-access.ts` (`generateInviteSecret`, `deriveInviteKey`, `signInvite`, `verifyInvite`), `src/space/space-manager.ts` (`encodeSpaceInvite`, `parseSpaceInvite`, `join`), `src/node/space-runtime.ts` (`openInvite`, `closeInvite`, `join`), `src/node/node.ts` (`spaces.invite`, `preview`, `join`, `closeInvite`, `bareInvite`). Tests: `tests/space-access.test.ts` ("the keys", "invites"), `tests/space.test.ts` ("invites"), `tests/roles.test.ts` ("invites").*

---

## 8. Private spaces: encryption

### 8.1 The space key

A space key is 32 random bytes used as an AES-256-GCM key. Its **key id** is
`base64url(SHA-256(raw key))` (43 characters). The first key's id is the
genesis's `encryptionKeyId`; later keys are named by `sys.key` (§9).

Example: raw `ff fe … e0` → id `GGXACDHnP37iP8E8stD1iLnDQYNcp0cvjsA1q6S3idY`.

### 8.2 What is encrypted

In a private space, the body of every version is encrypted **before signing**,
except in these collections, which stay in the clear:

`sys.role`, `sys.member`, `sys.invite`, `sys.revoke`, `sys.key`, `sys.box`,
`sys.memberkey`, `sys.relays`, `sys.keepers`.

Everything else is encrypted — application records, `sys.collection`
definitions, `sys.profile`, and the registry's own collections. The envelope
([02](02-records.md): `id`, `author`, `collection`, `space`, `key`, `seq`,
`seen`, `createdAt`, `proof`, `tags`, `retain`, `deleted`, signature) is
always in the clear; `links` are moved inside the ciphertext and omitted from
the envelope. A delete carries no body.

> Rationale: a peer holding no secret of the space — a relay-side mirror, a
> carrier, a host — must still replay the access history and reach the same
> verdict as a member. Definitions stay sealed: a peer that cannot read
> records has no use for their rules.

### 8.3 The encrypted body

```
plaintext  = UTF-8( JSON.stringify( links.length ? { body, links } : { body } ) )
iv         = 12 random bytes
ciphertext = AES-256-GCM(key, iv, plaintext)          // no additional data; 16-byte tag appended
body       = { ciphertext: base64url(ciphertext), iv: base64url(iv), keyId }
```

A writer **MUST** encrypt with the key the history names as current (the last
entry of `keys`); if it does not hold that key it **MUST NOT** write.

A reader treats a body as encrypted when it has string `ciphertext` and string
`iv`, looks up `keyId` among the keys it holds, decrypts, and takes `body` and
`links` from the result. A body it cannot open is shown as unreadable
(`body: null`), never refused for that reason.

Example (key of §8.1, plaintext `{"body":{"text":"hi"}}`):

```json
{"ciphertext":"nXyTdBm1FywtTGY8N_G5n-xLwRddVhSp8oqaULS-20O7Ay2RDMk","iv":"0nDFOs-BiAkLaQfC","keyId":"GGXACDHnP37iP8E8stD1iLnDQYNcp0cvjsA1q6S3idY"}
```

### 8.4 The read key

A private space has a **read key** pair per space key, so a peer can prove it
may read without anyone checking it holding the AES key:

```
readSeed = HKDF-SHA256(ikm = raw space key, salt = empty, info = "weave/space-read/v1", L = 32)
readKey  = deriveKeyPairFromSeed(readSeed)      // 01 — Identity; did:key P-256
```

The genesis names the first key's read DID (`readKey`); each `sys.key` names
the new one's. How a peer proves it holds the read key when connecting is in
[04 — Network](04-network.md).

Example: the key of §8.1 → `did:key:zDnaem2ikLwS3eYm46gspC7nm6dmYYCMHUHU5yvVHNgARcsWf`.

### 8.5 `sealWith` / `openWith`

A value sealed under a space key, bound to a context string (used by `sys.key`):

```
sealed = base64url( iv(12) ‖ AES-256-GCM(key, iv, UTF-8(JSON.stringify(value)), AAD = UTF-8(context)) )
```

Opening fails (returns nothing) for the wrong key, the wrong context, or a
changed value. Inputs longer than 1 000 000 characters are not tried.

### 8.6 Legacy helpers

`src/privacy/key-distribution.ts` (`wrapSpaceKey` — ECDH + AES-KW, algorithm
`"ECDH-AES-KW"`) and `src/privacy/privacy-guard.ts` are exported but used by
nothing in the node. They are **not** part of the protocol; key distribution is
§9.

*Source: `src/privacy/space-encryption.ts`, `src/node/space-runtime.ts` (`IN_THE_CLEAR`, `write`, `openBody`), `src/space/space-access.ts` (`deriveReadKey`, `deriveReadSeed`). Tests: `tests/space.test.ts` ("private space expressions"), `tests/space-access.test.ts` ("a view-only invite to a private space reads everything and writes nothing"; the read-key vector).*

---

## 9. Key changes, member keys and boxes

A private space's key changes when someone loses their place in it, so a
removed member reads nothing written afterwards.

### 9.1 Member keys (`sys.memberkey`)

Each account has, per space, a **member key**: a P-256 ECDH key pair derived
from the account's vault key and the space id ([01](01-identity.md),
`deriveMemberKeyBytes`: HKDF-SHA256(vault key, info
`"weave/p256-member-key/v1|<spaceId>"`, 48 bytes) reduced to a scalar).

Each member publishes its public half, in the clear:

```
sys.memberkey at memberkey:<hex40(accountDid)>
{ key: <compressed P-256 point, 33 bytes, base64url> }
```

A member key record counts only if it stands, its root's `hex40` matches its
record key, and `key` is a valid point; the newest such version of each
account wins. A member that can write **SHOULD** publish its member key
(implementation: on every upkeep when it differs from what is published).

> Rationale: one per space, so an account home can hand an app the member keys
> of exactly the spaces it grants.

### 9.2 When a key change is due

`keyDue` (§4.4) becomes true when any event leaves some former reader without
a role that exists (removed, left, their role deleted) and becomes false with
the next applied `key` event.

### 9.3 Changing the key (`sys.key`)

A member holding `manage` and the current key, seeing `keyDue`, **SHOULD**
change the key (the node does this by itself; `changeKey` does it by hand):

1. generate a new space key `K'`;
2. `earlier` = `sealWith(K', [base64url(raw) of every key it holds], "weave/space-earlier-keys/v1|<spaceId>|<K'.id>")`;
3. write `sys.key` at `key:space`: `{ keyId: K'.id, readKey: <K' read DID>, earlier }`;
4. seal `K'` to each member (§9.4).

Because every change is a version of `key:space`, two changes made apart are
rivals and one wins by replay order (§4.4 step 1). A key id or read key used
before is refused.

A peer holding any key named by a `key` event opens its `earlier` and takes
each raw key it contains (up to 1000); repeat until nothing new. So holding
the current key opens every earlier one.

### 9.4 Boxes (`sys.box`)

The current key is sealed to each reader's member key, in the clear:

```
sys.box at box:<hex40("<keyId>|<toDid>|<fromDid>")>
{ keyId, to: <recipient account DID>, sealed }

sealed = sealFor(recipientMemberKey, { key: base64url(raw K) },
                 "weave/space-key-box/v1|<spaceId>|<keyId>|<toDid>")
```

`sealFor` is the ECDH seal of [01 — Identity](01-identity.md) (and §16.4).

A manager seals the current key to every reader who has published a member key
and has no box for that key id yet from themselves or from anyone holding
`manage`.

A recipient opens every box with `to` = its account and `keyId` naming a key
it lacks in the history; it **MUST** accept the opened key only if its id
equals `keyId` and its derived read DID equals the history's `readKey` for
that key — whoever sealed it.

### 9.5 Writing and reading after a change

Writers use the current key (§8.3). A node without the current key cannot
write, and proves it may read with the newest key it holds (see
[04](04-network.md)). A view-only invite made before a change carries only the
old key; its holder is not a reader and gets no box.

*Source: `src/node/space-runtime.ts` (`learnKeys`, `rotateKey`, `boxForMembers`, `upkeep`, `loadMemberKeys`), `src/space/space-access.ts` (`MEMBER_KEY_COLLECTION`, `BOX_COLLECTION`, `boxKey`, `boxContext`, `earlierKeysContext`, `SPACE_KEY_RECORD`), `src/identity/contact-key.ts` (`deriveMemberKeyBytes`, `sealFor`). Tests: `tests/key-change.test.ts`.*

---

## 10. Relays and keepers

**`sys.relays`** at `relays:space`: `{ relays: string[] }` — where the
space's members meet. Valid (`checkRelays`) when it is a list of at most 8
distinct URLs, each at most 200 characters, each `wss://`, or `ws://` only on
`localhost`, `127.0.0.1` or `[::1]`. Only `manage` may set it. A node holding
`manage` in a space with no relays yet names its own. Until the space names
some, a node uses the relays from the invite that brought it.

**`sys.keepers`** at `keepers:space`: `{ keepers: [{ did, name }], copies }`
— nodes that hold every record of the space, and how many a write should
reach before a node holding only part lets go of it. Valid (`checkKeepers`)
when there are at most 16 keepers, each `did` starts with `did:key:` and is
at most 200 characters, each `name` a string of at most 80 characters, no
`did` twice, and `copies` is null or an integer 1–16. Only `manage` may set it.
What keepers do is in [05 — Sync and storage](05-sync-and-storage.md).

*Source: `src/space/roles.ts` (`checkRelays`, `checkKeepers`, `MAX_RELAYS`, `MAX_KEEPERS`), `src/node/space-runtime.ts` (`nameRelays`, `setRelays`, `setKeepers`). Tests: `tests/space-relays.test.ts`, `tests/carrier.test.ts` ("is named a keeper…").*

---

## 11. Profiles

An account tells a space who it is with one record:

```
sys.profile at profile:<hex40(accountDid)>
{ name: string (trimmed, 1–64 chars), contactKey?: <compressed P-256 point, base64url> }
```

It is encrypted in a private space (§8.2) and written with `retain`, so older
versions stay.

A reader resolves each profile key to one profile:

- consider versions newest first; skip any whose collection is not
  `sys.profile`, that does not verify, whose root's `hex40` is not the record
  key, or that does not stand;
- a deleted version ends the search (no profile);
- the first remaining version gives `name` (trimmed, first 64 characters;
  empty → no profile), `did` = root, `updatedAt` = its `createdAt`;
- `contactKey` is taken from the newest remaining version that carries a valid
  P-256 point, so a newer version written without one does not hide it.

A writer that does not hold the contact key **MUST** carry forward the
`contactKey` of its current profile. *Implementation detail:* the node
publishes the account's name (from the registry, §13) into every space it
opens and again on a rename, except the registry, the contacts space and
agent sessions; a non-member publishes nothing.

*Source: `src/node/space-runtime.ts` (`profileKey`, `loadProfiles`, `publishProfile`), `src/node/node.ts` (`publishProfile`). Tests: `tests/profiles.test.ts`, `tests/contacts.test.ts` ("the contact key"), `tests/attacks.test.ts` ("a contact key on a profile signed by another account is ignored").*

---

## 12. The space manager

*Implementation detail throughout.* The space manager keeps, per space, in a
storage adapter (sealed at rest, see [05](05-sync-and-storage.md)):

| Storage key | Value |
|---|---|
| `space:<id>` | JSON space object |
| `spacekey:<id>` | JSON `{ keys: [{ id, raw, createdAt, version }], current }` — every key held, `raw` base64url |
| `spaceinvite:<id>` | base64url invite secret, until used |
| `spacerole:<id>` | the role last held — a hint for listing, never a gate |
| `spacememberkey:<id>` | base64url member key scalar, for a node given it without the vault key |
| `spacerelays:<id>` | JSON relay list last heard |

`remove` deletes all six. Joining again with a secret while one is waiting
keeps the newer one.

*Source: `src/space/space-manager.ts`. Tests: `tests/space.test.ts` ("space manager").*

---

## 13. The account registry

### 13.1 Derived account spaces

An account derives private spaces that only it can find, the same on every
device, from its vault key ([01](01-identity.md), `deriveVaultKeyBytes`) and a
label:

```
nonce   = base64url( HKDF-SHA256(vaultKey, salt = empty, info = "<label>/nonce/v1", 32)[0..12] )
rawKey  = HKDF-SHA256(vaultKey, salt = empty, info = "<label>/key/v1", 32)
space   = { visibility: "private", creator: accountDid, roles: solo.roles, creatorRole: "owner",
            createdAt: "1970-01-01T00:00:00.000Z", nonce,
            readKey: readDid(rawKey), encryptionKeyId: base64url(SHA-256(rawKey)) }
id      = cid(canonical(genesis))            // §1.2
```

| Label | Space | Name |
|---|---|---|
| `weave/account-registry` | the account registry | `Account registry` |
| `weave/contacts` | the contacts space (§16) | `Contacts` |

Example (seed `01 02 … 10`): registry `bkbogrf2jtmudunoee5mtpgfdenyrwbdnagfkogw4jvphavoelteq`
(nonce `isIO1Hq-k9yg1wNZ`), contacts `by2fwk6cy2g73mni4fy3bjcbv2arn4xi5qsw7rzu22rpxnxvzmotq`.

> Rationale: the DID alone is not enough to find them — it appears on
> everything the account signs.

In these spaces only the account writes (a record whose root is another
account is ignored by readers), and agents write nothing.

### 13.2 What the registry records

| Collection | Record key | Body | Meaning |
|---|---|---|---|
| `sys.joined` | `space:<spaceId>` | `{ space: spaceId, invite }` | The account belongs to the space. `invite` is a **view-only** invite (§7.5) — secrets are never kept. Deleted: the account left. |
| `sys.profile` | `profile` | `{ name }` | The account's name. Newest wins. |
| `sys.carrier` | `carrier:<hex40(carrySpaceId)>` | `{ space, invite, did, name, since }` | A carrier the account uses (§14). |
| `sys.notify` | `notify:<base32 of 10 random bytes>` | `NotifyWhen` (§15) | A subscription. |
| `sys.hosting` | — | — | Hosting; see [06](06-nodes-and-sessions.md). |

A membership counts only if it verifies, its root is the account, and (unless
deleted) its key is `space:<body.space>`.

Every device of the account follows the registry: a live membership for a
space it does not hold → join its invite; a deleted membership for one it
holds → close and forget it locally; a space held but never recorded →
record it. When a space's key changes, a device that learns the new key
rewrites the membership with an invite carrying it, so new devices join with
the current key.

*Source: `src/space/account-registry.ts`, `src/node/node.ts` (`memberships`, `remember`, `forget`, `reconcileOnce`, `ownName`). Tests: `tests/node.test.ts` ("the account registry"), `tests/account.test.ts` ("the account name"), `tests/space-access.test.ts` ("invite secrets are never kept").*

---

## 14. Passes and carry spaces

A **carrier** (an extension, a host) stores and forwards a space it cannot
read. It gets a **carry space**: a private space the account creates (`solo`)
and shares with it by a view-only invite recorded in `sys.carrier` (§13.2). In
it the account keeps one **pass** per space to carry:

```
sys.pass at pass:<hex40(spaceId)>
{ v: 1, space: <space object>, read?: base64url(readSeed), readKey?: <read DID> }
```

- public space: `{ v: 1, space }`;
- private space: `read` = the read seed (§8.4) of the key the account holds
  now; `readKey` = its read DID, present only when that key is not the
  genesis key.

A pass holds no space key, no invite secret and no note. A carrier **MUST**
accept a pass only if `v` is 1, the space passes `checkSpace`, and — for a
private space — the read seed gives a read DID equal to `space.readKey` or to
the pass's `readKey`. (With a later key, the space's history is what vouches
for that read key: one it does not name gets the carrier nowhere.)

When the account stops using a carrier, it deletes the passes and writes
`sys.pass` at `carry:closed` with `{ v: 1, closed: true }`; a carrier that
reads it forgets everything. The account registry and contacts space are
passed too.

*Source: `src/space/pass.ts`, `src/node/node.ts` (`syncPasses`, `carriers`). Tests: `tests/carrier.test.ts` ("passes", "a carrier").*

---

## 15. Subscriptions (notify)

A subscription says what the account wants to hear about. It is kept in the
registry, sealed like everything there:

```
sys.notify at notify:<id>
NotifyWhen = { label, collection, spaces: "all" | spaceId[], topic?: { field, value },
               others?: boolean (default true), open?: url, paused?: boolean, since: ISO date }
```

Valid (`checkNotify`) when: `label` 1–120 characters, not blank; `collection`
matches `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$` and does not start with `sys.`;
`spaces` is `"all"` or 1–256 strings; `topic.field` is a valid topic field
([02](02-records.md)) and `topic.value` a string, number or boolean; `open`
an `https://` URL (or `http://` on localhost / 127.0.0.1); `since` a date.

Carriers cannot read, so each device with the account key copies every
subscription into every carry space with the value replaced by tags:

```
sys.subscription at notify:<id>   (same key)
CarriedSubscription = { v: 1, label, collection, spaces, tags?: { <spaceId>: [tag] },
                        others, open?, paused, since }
```

`tags[spaceId]` = `[topicTag(topicKey(space), collection, field, value)]`
([02](02-records.md)), for each space the subscription looks at; a private
space whose key the device lacks gets no entry (never matches). No `topic` →
no `tags`.

A carrier matches an arriving version when: not paused; same collection; `seq`
is 0 and not deleted; the space is in `spaces` (or `"all"`); its `createdAt`
is at or after `since` and within 24 hours of now; if `others`, its root is
not the account; and if `tags` is present, the version's `tags` include one of
`tags[spaceId]`. *Implementation detail:* the carrier then shows a
notification with `label`.

*Source: `src/space/notify.ts`, `src/node/node.ts` (`notifications`, `syncPasses`), `src/node/carrier.ts`. Tests: `tests/carrier.test.ts` ("notifications through a carrier").*

---

## 16. Contacts

A contact is someone you share a **private space for two** with. The protocol
knows nothing of contacts; they are two standard collections and a node
procedure. Asking someone you share **no** space with goes through a door; see
[07 — Doors](07-doors.md), which reuses the seal of §16.4.

### 16.1 The contacts space and `std.contact`

The list lives in the account's contacts space (§13.1, label
`weave/contacts`), one record per person:

```
std.contact  (rules: onePer ["did"])
{ did: string ≤256, name: string ≤200, space?: string ≤256, note?: string ≤2000, blocked?: boolean }
record key = onePerKey("std.contact", ["did"], …)
           = "one:" + hex40("std.contact\ndid=" + JSON.stringify(did))     // 02 — Records
```

`space` is the id of the space for two. `blocked` hides that person's contact
requests in every space. A reader **MUST** ignore a record whose root is not
the account, or whose key is not the one its `did` derives.

### 16.2 The contact key

Each account has a contact key: a P-256 ECDH key pair derived from its seed
([01](01-identity.md), `deriveContactKeyBytes`: HKDF-SHA256(seed, salt empty,
info `"weave/p256-contact-key/v1"`, 48 bytes) reduced to a scalar). Its public
half — a compressed point, base64url — is published as `contactKey` on the
account's profile in every space (§11).

### 16.3 `std.contact-request`

```
std.contact-request  (rules: edit "creator", delete "creator"; create: any member)
{ to: <askee account DID, ≤256>, sealed: string ≤16000 }
```

Posted in a space both people belong to. In a private space the body is also
encrypted with the space key (§8); other members see that `to` was asked, not
what.

### 16.4 How a request is sealed

```
value   = { invite: <role invite to the space for two>, note?: string ≤2000 }
context = "weave/contact-request|<spaceId>|<askerAccountDid>|<askeeAccountDid>"
sealed  = sealFor(askee.contactKey, value, context)
```

`sealFor(recipientPublic, value, context)`:

1. `E` = fresh ephemeral P-256 ECDH key pair; `Epoint` = its uncompressed
   point (65 bytes, `04 ‖ x ‖ y`);
2. `shared` = ECDH(E.private, recipientPublic) — the 32-byte x-coordinate;
3. `k` = HKDF-SHA256(ikm = `shared ‖ Epoint`, salt = empty, info = `"weave/contact-seal/v1"`, 32 bytes);
4. `iv` = 12 random bytes;
5. `ct` = AES-256-GCM(k, iv, UTF-8(JSON.stringify(value)), AAD = UTF-8(context)) (tag appended);
6. `sealed` = base64url(`Epoint ‖ iv ‖ ct`).

Opening reverses it; anything shorter than 78 bytes, the wrong key, a
different context or a changed byte opens nothing. A sealed `{"invite":"x"}`
is 65 + 12 + 14 + 16 = 107 bytes.

The receiver **MUST** open a request only when: the record verifies and
stands, is not written under an agent note, is in `std.contact-request`,
`to` is the receiver's account, `from` = the record's root equals the root of
the record's first version and is not the receiver; and **MUST** use the
context built from the space the record is in and that `from`. It **MUST**
then reject the value unless `invite` parses as an invite (§7.4) to a
**private** space whose `creator` is `from` and which carries a `key`.

> Rationale: binding the seal to the space and to who asked whom means a
> request copied into another space, or re-posted by someone else, does not
> open.

### 16.5 Asking, accepting and the rest

*Implementation detail* (`node.contacts`), except where the formats above apply:

- **ask(space, did, note?)** needs whole-account access and the askee's
  `contactKey` on their profile in that space. It defines
  `std.contact-request` in the space if missing (needs `define`), creates a
  private `team` space named `"<my name> & <their name>"`, opens an `editor`
  invite to it, writes a `std.contact` for them with that space, then posts
  the sealed request.
- **requests(space)** lists requests that open for this account, skipping
  blocked senders and requests whose space for two the account already holds.
- **accept(space, requestKey)** joins the invite (§7.6) and writes a
  `std.contact` for the asker with the space for two. There is no reply
  record: joining is the answer.
- **remove(did)** leaves the space for two (locally, §6.2) unless another
  contact names it, and deletes the `std.contact`.
- **block(did)** leaves the space for two likewise and writes the contact with
  `blocked: true`.
- **others(did)** lists accounts other than the two seen in the space for two
  (members, profiles, connected peers).

*Source: `src/schemas/contacts.ts`, `src/identity/contact-key.ts` (`sealFor`, `openSealed`, `deriveContactKeyBytes`), `src/node/node.ts` (contacts section: `requestContext`, `openRequest`, `contacts`), `src/space/account-registry.ts` (`deriveContactsSpace`). Tests: `tests/contacts.test.ts`, `tests/attacks.test.ts`.*

---

## 17. Not yet specified

- Whether leaving a space (§6.2) should also write a self-removal in its
  history, so that a key change becomes due.
- Any bound on how many events a history may hold, or on the replay's cost.
- Expiry or single use of invites: an open invite stays open until closed.
- A way to re-establish a space's key for members who lost every key they held
  other than a fresh role invite.
- `invitedBy` and the space `name` in invites are unauthenticated; no
  signature over the invite string exists.
