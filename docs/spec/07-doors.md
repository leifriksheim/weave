# 07 — Doors

A DID is a name, not an address: it is on everything an account signs, so
knowing it must not be enough to reach the account. Two people who share a
space can become contacts through it ([03 — Spaces](03-spaces.md), Contacts).
This part covers two people who share nothing yet.

A **door** is an address its owner hands out on purpose, and can close. It is
three things:

| | What it is | Who sees it | Changes? |
|---|---|---|---|
| **Door key** | A P-256 key pair derived from the contact key and the door's id | Its public half: whoever has the code | A new door is a new key |
| **Relays** | 1–3 relays whose mailboxes hold knocks on the door | Whoever has the code | Per door |
| **Door code** | The key, the relays and an optional name, encoded | Whoever it is given to | Closing the door makes it lead nowhere |

Someone holding a code **knocks**: they make a private space for the two of
them, and leave its invite, signed and sealed to the door key, in the door's
mailboxes. The owner's devices fetch knocks, check them, and **accept** one by
joining the space. From then on the two are ordinary contacts.

The account behind a door is never in the code, the topic, or anything a relay
sees. The knocker learns it only when the owner joins the space for two.

> Rationale: this is Nostr's outbox model (the address names its own relays,
> so relays never need to know about each other) with SimpleX-style addresses
> (an address is a revocable queue on servers the recipient picked, not an
> identity). No relay can take a door down while another it names is up, and
> an owner whose relays all go away opens a new door elsewhere.

---

## 1. The door key

A door's key pair is derived from the account's **contact key**
([01 — Identity](01-identity.md)) and the door's **id**:

```
ikm    = contact key private scalar (32 bytes)
info   = UTF-8("weave/p256-door-key/v1|" + doorId)
okm    = HKDF-SHA-256(ikm, salt = empty, info, L = 48 bytes)
scalar = okm reduced to a P-256 scalar exactly as the root key is (01 — Identity)
```

- `doorId` is 16 random bytes, base64url (22 characters). It MUST be at least
  16 characters.
- The public half is a **compressed** P-256 point (33 bytes), base64url: the
  same form as a contact key's public half.
- A door key is used only for ECDH (opening knocks). It MUST NOT sign.

Every device and app that holds the contact key derives the same door keys, so
all of them read the same knocks. The contact key's public half is published on
the account's profile in every space it writes in; a door key's is not, and
nothing links the two.

*Source: `src/identity/contact-key.ts` (`deriveDoorKeyBytes`). Tests: `tests/doors.test.ts` ("says nothing about the account").*

## 2. Doors as records

An account's doors are `std.door` records in its **contacts space**
([03 — Spaces](03-spaces.md)), which only the account can find and every one of
its devices holds.

| Field | Type | |
|---|---|---|
| `id` | string, 16–64 chars | The door id the key is derived from |
| `relays` | string[], 1–3 | Relay URLs, each passing the space relay check: `wss://`, or `ws://` on localhost only, ≤200 chars, no duplicates |
| `name` | string ≤64, optional | The name the code gives whoever knocks |
| `label` | string ≤64, optional | What the owner calls the door; never leaves the contacts space |

Rules: `onePer: ['id']`. A peer MUST only treat as a door a verified
`std.door` whose root is the account itself. **Closing** a door is deleting its
record: its knocks are no longer fetched, and knocks already opened stop being
offered.

*Source: `src/schemas/contacts.ts` (`door`), `src/node/node.ts` (Doors).*

## 3. The door code

```
code = base64url( canonicalJSON({ v: 1, key, relays, name? }) )
```

| Field | Type | |
|---|---|---|
| `v` | `1` | |
| `key` | string | The door key's public half (compressed point, base64url) |
| `relays` | string[], 1–3 | As in `std.door` |
| `name` | string ≤64, optional | Who the owner says they are. **It proves nothing.** |

Canonical JSON is defined in [02 — Records](02-records.md). A reader MUST
accept a bare code, or a link carrying one as `door=<code>` after `#`, `?` or
`&` (e.g. `https://app.example/#door=eyJr…`), and MUST reject a code whose
`key` is not a valid P-256 point or whose relays fail the check above.

Example (key and relay shortened):

```json
{"key":"A1b2…","name":"Anna","relays":["wss://relay.example"],"v":1}
```
→ `eyJrZXkiOiJBMWIy4oCmIiwibmFtZSI6IkFubmEiLCJyZWxheXMiOlsid3NzOi8vcmVsYXkuZXhhbXBsZSJdLCJ2IjoxfQ`

> Rationale: a code in a URL goes in the fragment, like an invite, so it isn't
> sent to the server that serves the page.

*Source: `src/doors/doors.ts` (`encodeDoorCode`, `parseDoorCode`, `checkDoorCode`). Tests: `tests/doors.test.ts` ("a door code").*

## 4. Topics

A door's knocks are filed under its **topic**:

```
topic = base64url( SHA-256( UTF-8("weave/door-topic/v1|" + key) ) )     — 43 characters
```

The relay sees only the topic. Knowing a topic lets anyone fetch its sealed
blobs, which open only with the door key.

*Not yet specified:* topics that change over time (e.g. per week), so a relay
can't follow one door across months. A future version would derive the topic
from the key and an epoch, and owners would fetch the current and previous one.

*Source: `src/doors/doors.ts` (`doorTopic`).*

## 5. The relay mailbox

Every relay ([04 — Network](04-network.md)) also runs a mailbox. It speaks JSON
text frames on the same WebSocket endpoint as signaling. A mailbox socket
needs no `join` and names no DID; the implementation opens a fresh socket for
each call.

### Messages

**drop** — leave a blob under a topic.

```json
→ { "type": "drop", "topic": "<43 chars>", "blob": "<base64url>", "ttl": 1209600 }
← { "type": "dropped", "topic": "<topic>", "id": "<base64url SHA-256 of blob>" }
← { "type": "refused", "topic": "<topic>", "reason": "This door is full" }
```

- `blob` MUST be non-empty base64url, at most 12,000 characters.
- `ttl` is seconds, optional. Default 14 days; the relay MUST cap it at 30 days.
- The relay files the blob under `id = base64url(SHA-256(UTF-8(blob)))`. Dropping
  a blob already held under that topic MUST answer `dropped` with the same id
  and store nothing new, so senders can retry freely.

**fetch** — read a topic's blobs.

```json
→ { "type": "fetch", "topic": "<topic>", "after": 0, "watch": false }
← { "type": "mail", "topic": "<topic>", "items": [ { "seq": 17, "id": "…", "at": 1790000000000, "blob": "…" } ], "more": false }
```

- `items` are the unexpired blobs with `seq > after`, oldest first. `seq`
  increases with every drop on that relay; `at` is when the relay took it, in
  ms. A page holds at most 16 items or 48 KiB of blobs; `more: true` means
  fetch again after the last `seq`.
- With `watch: true`, the relay also sends a `mail` message with one item each
  time a blob is dropped under the topic, for as long as the socket stays
  open or until the client sends `{ "type": "unwatch", "topic": "<topic>" }`.
  A socket watches at most 32 topics.

A relay MUST ignore mailbox messages whose `topic` is not 43 base64url
characters (no answer). There is no delete: blobs expire.

### Limits

| Limit | Value | On breach |
|---|---|---|
| Blob size | 12,000 chars | `refused` |
| Blobs per topic | 64 | `refused` ("This door is full") |
| Drops per topic per address per hour | 4 (an address is an IPv4 address or an IPv6 /64) | `refused` ("Too many knocks…") |
| Topics held | 50,000 | `refused` |
| Total held | 64 Mi blob characters | `refused` |
| TTL | default 14 days, max 30 | capped |
| Watches per socket | 32 | extra watches ignored |

The socket's message budget, size cap and heartbeat are the relay's usual ones
([04 — Network](04-network.md)). Expired blobs and old drop counts are swept on
the heartbeat.

A full door refuses new knocks rather than dropping old ones, so a flood can't
push out real knocks. Filling a door takes 16 addresses an hour. An owner
whose door is flooded closes it and opens another.

*Implementation detail:* this relay keeps the mailbox in memory, so a restart
loses what it held. Senders drop to every relay a door names for that reason.

*Source: `server/relay.mjs` (`handleMail`, `sweepMail`), `src/network/mailbox.ts`. Tests: `tests/doors.test.ts` ("the relay's mailbox").*

## 6. Knocks

### The body

A knock is a JSON object, signed by the knocker's **session key**:

| Field | Type | |
|---|---|---|
| `v` | `1` | |
| `door` | string | The door key knocked on. Binds the knock to this door. |
| `from` | DID | The knocker's account |
| `name` | string ≤64 | The name they give (defaults to "Someone"); nothing vouches for it |
| `invite` | string ≤6000 | An invite ([03 — Spaces](03-spaces.md)) to a private space `from` created, with its key and an editor secret |
| `note` | string ≤2000, optional | |
| `at` | integer | When it was signed, Unix seconds |
| `session` | DID | The session key that signed |
| `proof` | string ≤4096 | The knocker's note: a UCAN from `from` to `session` ([01 — Identity](01-identity.md)) |

```
sig    = ECDSA-P256-SHA256(session private key, UTF-8(canonicalJSON(body)))   — 64 bytes r‖s, base64url
sealed = sealFor(door, { body, sig }, context = "weave/knock/v1|" + door)
```

`sealFor` is the contact-key seal ([01 — Identity](01-identity.md)): a fresh
P-256 key pair per message, ECDH with the door key, HKDF-SHA-256 over the shared
secret and the ephemeral point (info `weave/contact-seal/v1`), AES-256-GCM with
a 12-byte IV and the context as additional data. The blob is
`base64url(ephemeral point (65 bytes) ‖ IV ‖ ciphertext)`.

### Opening a knock

A door's owner MUST treat a blob as a knock only if all of these hold, and
otherwise ignore it:

1. It opens with the door key under context `weave/knock/v1|<door public key>`.
2. `body.v` is 1 and `body.door` is this door's public key.
3. Every field has the type and size above; `at` is no more than 5 minutes in
   the future and no more than 30 days in the past.
4. `sig` verifies over `canonicalJSON(body)` with the public key of the
   `session` DID.
5. `proof` is not an agent's note, and its delegation chain resolves **with no
   proofs beyond itself** (one link), valid at `at`, with audience `session` and
   root `from`.
6. `invite` parses; its space's creator is `from`; it is private and carries
   its key; and the space checks out (its id is the hash of its genesis).

The knock's **id** is `base64url(SHA-256(UTF-8(blob)))`, the same on every relay.
A client MUST de-duplicate by it, computing it itself rather than trusting a
relay's `id`.

A client SHOULD also skip knocks from itself, from accounts its contact list
marks blocked, and whose space for two it already holds (accepted here or on
another device).

> Rationale: a space's genesis isn't signed, so the invite alone can't prove
> who made it. The signature under the account's note proves the knock came
> from `from` before anyone joins anything, exactly as a record's does. Binding
> `door` into the signed body stops a door owner from re-sealing someone's
> knock to another door as if it had been sent there. One-link proofs match
> what a connection accepts as an account's note (04 — Network).

*Source: `src/doors/doors.ts` (`sealKnock`, `openKnock`, `knockId`). Tests: `tests/doors.test.ts` ("a knock").*

## 7. The exchange

```
 Anna                                   relay(s)                                 Leif
  │ doors.open() → std.door, code                                                  │
  │ ── code, out of band (a link, a QR code, a bio) ─────────────────────────────▶ │
  │                                                         spaces.create(private) │
  │                                                         invite(role: editor)   │
  │                                     ◀── drop(topic, sealed knock) ── to each   │
  │                                                         std.knock { space }    │
  │ fetch(topic) ──▶                                                               │
  │ ◀── mail [knock]                                                               │
  │ open + check (§6)                                                              │
  │ accept: spaces.join(invite), std.contact { did: Leif, space }                  │
  │ ════════════════ the space for two syncs: Anna's member record ══════════════▶ │
  │                                          std.knock → std.contact { did: Anna } │
```

**Knocking.** The knocker:

1. parses the code, and refuses one of its own doors;
2. creates a private space named `"<own name> & <code name>"` with the `team`
   role preset, and an editor invite to it;
3. seals the knock (§6) and drops it at **every** relay the code names;
4. if no relay answers `dropped`, leaves the space and fails;
5. otherwise writes `std.knock { space, name, door }` in its contacts space.

**Accepting.** The owner joins the invite and writes
`std.contact { did: from, name, space: pairSpace }`, keeping a name it already
had for that account.

**Settling.** The knocker's devices look at each `std.knock`'s space: once an
account other than their own is a member, they write
`std.contact { did: <that account>, name: <their profile name, else the code's>, space }`
and delete the `std.knock`. A `std.knock` whose space is no longer held is
deleted.

`std.knock`: fields `space` (≤256), `name` (≤64), `door` (≤64), all required;
`onePer: ['space']`.

**Who may.** Knocking and accepting create or join a space, so they need a note
for every space (`with: '*'`), as `contacts.ask` does. Reading knocks needs the
contact key. Doors are the person's: a node whose note is an agent's
([01 — Identity](01-identity.md), agent notes) MUST refuse to open, close,
read, knock or accept, even if it was given the contact key, and a door owner
MUST refuse a knock signed under an agent's note (§6).

*Source: `src/node/node.ts` (Doors), `src/node/types.ts` (`NodeDoors`). Tests: `tests/doors.test.ts` ("node.doors").*

## 8. API

`node.doors` ([06 — Nodes, sessions and apps](06-nodes-and-sessions.md)):

| Call | Does |
|---|---|
| `list()` | Your open doors: `{ id, label?, name?, key, relays, code, createdAt }` |
| `open({ relays?, name?, label? })` | Opens a door. Relays default to this node's relays (up to 3); name to the account's name |
| `close(id)` | Deletes the `std.door` |
| `knock(code, { note? })` | §7, returns `{ space }` |
| `knocks()` | Fetches every open door's topic from every relay it names, opens and checks (§6), settles sent knocks; returns `{ id, door, from, name, note?, pairSpace, at }`, newest first |
| `sent()` | Your unanswered knocks: `{ space, name, at }` |
| `accept(id)` | §7, returns the new `ContactView` |

## 9. Security considerations

- **Spam.** Anyone with a code can knock. The mailbox caps each door at 64
  knocks, and each address at 4 knocks per door per hour. A knock only shows as
  a request; nothing in it runs or loads. Blocking hides an account's knocks on
  every door. A flooded door is closed and replaced; contacts made through it
  are untouched.
- **What a relay learns.** A topic, blob sizes, and the IP addresses that drop
  and fetch. Not whose door, not who knocked, not what was said. Topics are
  stable per door (§4).
- **What a knocker learns.** The code's name, which is only what the owner
  chose to put there, and nothing about the account until the owner accepts.
- **What the owner learns.** The knocker's account, proven, and the name and
  note they chose. The name proves nothing: the account DID is what to trust,
  and in person a code handed over directly is the proof.
- **Replays.** A knock re-dropped by anyone is the same blob (same id), and its
  space for two is the one the knocker made, so replaying it gains nothing.
  Knocks older than 30 days are refused.
- **Losing a relay.** A door names up to three relays, and knocks go to all of
  them. A relay can drop knocks but can't read, forge or reorder them into
  something else.

## 10. Not yet specified

- **Names.** Handles that resolve to a door, e.g. an ATProto handle whose
  repository holds a door record, so "@anna.example" can be pasted instead of a
  code. See `docs/blocks/BLOCK-24-names.md`.
- **Topics that change over time** (§4).
- **Retrying a knock** that reached no relay, or one whose relays lost it
  (restart), until it is answered or expires.
- **Ignoring a knock** without blocking its sender.
- **Live knocks.** The mailbox supports `watch`; `node.doors` only polls.
- **Proof of work** on `drop`, if public relays see abuse.
