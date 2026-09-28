# 07 — Doors

A DID is a name, not an address: it is on everything an account signs, so
knowing it must not be enough to reach the account. Two people who share a
space can become contacts through it ([03 — Spaces](03-spaces.md), Contacts).
This part covers two people who share nothing yet.

A **door** is an address its owner hands out on purpose, and can close:

|                      | What it is                                                                            | Who sees it                                                         |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Door key**         | A P-256 key pair knocks are sealed to, derived from the contact key and the door's id | Its public half: whoever has the code                               |
| **Door signing key** | A second P-256 key pair, derived likewise, that proves ownership of the door          | Its public half: whoever has the code; its hash is the door's topic |
| **Relays**           | 1–3 relays whose mailboxes hold knocks on the door                                    | Whoever has the code                                                |
| **Door code**        | The two public keys, the relays and an optional name, encoded                         | Whoever it is given to                                              |

Someone holding a code **knocks**: they make a private space for the two of
them, and leave its invite, signed and sealed to the door key, in the door's
mailboxes. The owner's devices fetch knocks, check them, and **accept** one by
joining the space and **answering** there, signed with the door signing key.
The answer is what makes the owner the knocker's contact.

The account behind a door is never in the code, the topic, or anything a relay
holds. The knocker learns it when the owner answers.

> Rationale: this is Nostr's outbox model (the address names its own relays,
> so relays never need to know about each other) with SimpleX-style addresses
> (an address is a revocable queue on servers the recipient picked, not an
> identity). No relay can take a door down while another it names is up, and
> an owner whose relays all go away opens a new door elsewhere.

---

## 1. Door keys

Both of a door's keys are derived from the account's **contact key**
([01 — Identity](01-identity.md)) and the door's **id**:

```
ikm         = contact key private scalar (32 bytes)
door key    = P-256 scalar from HKDF-SHA-256(ikm, salt = empty, info = UTF-8("weave/p256-door-key/v1|" + doorId), L = 48)
signing key = P-256 scalar from HKDF-SHA-256(ikm, salt = empty, info = UTF-8("weave/p256-door-sign-key/v1|" + doorId), L = 48)
```

The 48 bytes are reduced to a scalar exactly as the root key is
([01 — Identity](01-identity.md)).

- `doorId` is 16 random bytes, base64url (22 characters). It MUST be at least
  16 characters.
- Public halves are **compressed** P-256 points (33 bytes), base64url (44
  characters): the same form as a contact key's.
- The door key is used only for ECDH (opening knocks). The signing key is used
  only for ECDSA P-256 / SHA-256 signatures (P1363, 64 bytes, base64url), over
  the purge (§5) and answer (§7) messages. Neither is used for the other job.

Every device and app that holds the contact key derives the same door keys.
The contact key's public half is published on the account's profile in every
space it writes in; a door's keys are not, and nothing links them.

_Source: `packages/core/src/identity/contact-key.ts` (`deriveDoorKeyBytes`, `deriveDoorSignKeyBytes`, `signWithScalar`, `verifyWithPoint`). Tests: `packages/core/tests/doors.test.ts` ("a door code")._

## 2. Doors as records

An account's doors are `std.door` records in its **contacts space**
([03 — Spaces](03-spaces.md)), which only the account can find and every one of
its devices holds.

| Field    | Type                 |                                                                                                                   |
| -------- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`     | string, 16–64 chars  | The door id both keys are derived from                                                                            |
| `relays` | string[], 1–3        | Relay URLs, each passing the space relay check: `wss://`, or `ws://` on localhost only, ≤200 chars, no duplicates |
| `name`   | string ≤64, optional | The name the code gives whoever knocks                                                                            |
| `label`  | string ≤64, optional | What the owner calls the door; never leaves the contacts space                                                    |

Rules: `onePer: ['id']`. A peer MUST only treat as a door a verified
`std.door` whose root is the account itself. **Closing** a door is deleting its
record: its knocks are no longer fetched, and knocks already opened stop being
offered.

Lengths here and throughout this part count Unicode code points; text MUST be
shortened without splitting one.

_Source: `packages/core/src/schemas/contacts.ts` (`door`), `packages/core/src/node/node.ts` (Doors)._

## 3. The door code

```
code = base64url( canonicalJSON({ v: 1, key, sign, relays, name? }) )
```

| Field    | Type                 |                                                            |
| -------- | -------------------- | ---------------------------------------------------------- |
| `v`      | `1`                  |                                                            |
| `key`    | string               | The door key's public half                                 |
| `sign`   | string               | The door signing key's public half; MUST differ from `key` |
| `relays` | string[], 1–3        | As in `std.door`                                           |
| `name`   | string ≤64, optional | Who the owner says they are. **It proves nothing.**        |

Canonical JSON is defined in [02 — Records](02-records.md). A reader MUST
accept a bare code, or a link carrying one as `door=<code>` after `#`, `?` or
`&` (e.g. `https://app.example/#door=eyJr…`), and MUST reject a code whose keys
are not valid P-256 points or whose relays fail the check above.

> Rationale: a code in a URL goes in the fragment, like an invite, so it isn't
> sent to the server that serves the page.

_Source: `packages/core/src/doors/doors.ts` (`encodeDoorCode`, `parseDoorCode`, `checkDoorCode`)._

## 4. Topics

A door's knocks are filed under its **topic**, a hash of its signing key:

```
topic = base64url( SHA-256( UTF-8("weave/door-topic/v1|" + sign) ) )     — 43 characters
```

A relay can check that whoever clears a topic holds the key it came from (§5),
without learning anything else. Knowing a topic lets anyone fetch its sealed
blobs, which open only with the door key.

_Not yet specified:_ topics that change over time (e.g. per week), so a relay
can't follow one door across months.

_Source: `packages/core/src/doors/doors.ts` (`doorTopic`)._

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
- `ttl` is seconds, optional. The relay keeps a blob for its own TTL (default
  14 days) or the client's, whichever is shorter; a client can't ask for more.
- The relay files the blob under `id = base64url(SHA-256(UTF-8(blob)))`, and
  records `at`, when it took it (ms). Dropping a blob already held under that
  topic MUST answer `dropped` with the same id and store nothing new.

**fetch** — read a topic's blobs.

```json
→ { "type": "fetch", "topic": "<topic>", "after": 0, "watch": false }
← { "type": "mail", "topic": "<topic>", "items": [ { "seq": 17, "id": "…", "at": 1790000000000, "blob": "…" } ], "more": false }
```

- `items` are the unexpired blobs with `seq > after`, oldest first. `seq`
  increases with every drop on that relay. A page holds at most 16 items or
  48 KiB of blobs; `more: true` means fetch again after the last `seq`.
- With `watch: true`, the relay also sends a `mail` message with one item each
  time a blob is dropped under the topic, until the socket closes or the client
  sends `{ "type": "unwatch", "topic": "<topic>" }`. At most 32 per socket.

**challenge / purge** — the door's owner clears knocks.

```json
→ { "type": "challenge" }
← { "type": "challenge", "nonce": "<24 chars>" }
→ { "type": "purge", "topic": "<topic>", "sign": "<signing key public half>", "ids": ["<id>", …], "sig": "<base64url>" }
← { "type": "purged", "topic": "<topic>", "count": 2 }
```

- `sig` is the door signing key over
  `UTF-8("weave/door-purge/v1|" + topic + "|" + nonce + "|" + ids)`, where
  `ids` is the ids sorted and joined with `,`, or `*` when `ids` is absent
  (clear everything).
- The relay MUST check that `topic` is the hash of `sign` (§4) and that `sig`
  verifies against `sign`, and MUST refuse otherwise. A nonce is good for one
  purge on the socket that asked for it, whether or not the purge succeeds.

A relay MUST ignore mailbox messages whose `topic` is not 43 base64url
characters (no answer).

### Limits

An **address** is an IPv4 address or an IPv6 /64.

| Limit                                  | Default                                                                            | On breach                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| Blob size                              | 12,000 chars                                                                       | `refused`                                   |
| Blobs per topic                        | 64                                                                                 | `refused` ("This door is full")             |
| Drops per topic per address per hour   | 4                                                                                  | `refused` ("Too many knocks on this door…") |
| Drops per address per hour, all topics | 30                                                                                 | `refused` ("Too many knocks from here…")    |
| Topics held                            | 50,000                                                                             | `refused`                                   |
| Total held                             | 64 Mi chars, plus a reserve of 8 Mi only topics holding fewer than 2 blobs may use | `refused` ("The mailbox is full")           |
| TTL                                    | 14 days                                                                            | capped                                      |
| Watches per socket                     | 32                                                                                 | extra watches ignored                       |

Everything but the per-topic count and blob size is an operator setting
(`createRelay({ mailbox })`). The socket's message budget, size cap and
heartbeat are the relay's usual ones ([04 — Network](04-network.md)). Expired
blobs and old drop counts are swept on the heartbeat.

A full door refuses new knocks rather than dropping old ones, so a flood can't
push out real knocks; a full relay still takes a knock or two on every door,
from the reserve. An owner whose door is flooded clears it (purge), which
keeps its code working.

> **Known defect:** both budgets are weaker than this section and §9 promise.
> One IPv6 /64 counts as one address, so a home /56 (256 of them) can fill the
> mailbox within an hour. And a topic holding no blobs may use the reserve, so
> knocks on random new topics can spend it, after which a full relay takes no
> knock on an existing door. A fix budgets IPv6 at /64, /56 and /48 together,
> and keeps the reserve for topics that existed before the mailbox filled.
> Other implementations SHOULD NOT copy these limits. Tracked in
> [#23](https://github.com/leifriksheim/weave/issues/23).

_Implementation detail:_ this relay keeps the mailbox in memory, so a restart
loses what it held. Senders drop to every relay a door names for that reason.

_Source: `packages/relay/relay.mjs` (`handleMail`, `purge`, `sweepMail`, `MAILBOX_LIMITS`), `packages/core/src/network/mailbox.ts`. Tests: `packages/core/tests/doors.test.ts` ("the relay's mailbox")._

## 6. Knocks

### The body

A knock is a JSON object, signed by the knocker's **session key**:

| Field     | Type                   |                                                                                                              |
| --------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `v`       | `1`                    |                                                                                                              |
| `door`    | string                 | The door key knocked on. Binds the knock to this door.                                                       |
| `from`    | DID                    | The knocker's account                                                                                        |
| `name`    | string ≤64             | The name they give (defaults to "Someone"); nothing vouches for it                                           |
| `invite`  | string ≤6000           | An invite ([03 — Spaces](03-spaces.md)) to a private space `from` created, with its key and an editor secret |
| `note`    | string ≤2000, optional |                                                                                                              |
| `at`      | integer                | When it was signed, Unix seconds                                                                             |
| `session` | DID                    | The session key that signed                                                                                  |
| `proof`   | string ≤4096           | The knocker's note: a UCAN from `from` to `session` ([01 — Identity](01-identity.md))                        |

```
sig    = ECDSA-P256-SHA256(session private key, UTF-8(canonicalJSON(body)))   — 64 bytes r‖s, base64url
sealed = sealFor(door, { body, sig }, context = "weave/knock/v1|" + door)
```

`sealFor` is the contact-key seal ([01 — Identity](01-identity.md)): a fresh
P-256 key pair per message, ECDH with the door key, HKDF-SHA-256 over the shared
secret and the ephemeral point (info `weave/contact-seal/v1`), AES-256-GCM with
a 12-byte IV and the context as additional data. The blob is
`base64url(ephemeral point (65 bytes) ‖ IV ‖ ciphertext)`.

A knocker drops a knock as soon as it signs it.

### Opening a knock

A door's owner MUST treat a blob as a knock only if all of these hold, and
otherwise ignore it. `receivedAt` is the relay's `at` for the blob.

1. It opens with the door key under context `weave/knock/v1|<door public key>`.
2. `body.v` is 1 and `body.door` is this door's public key.
3. Every field has the type and size above.
4. **Time.** `at` is no more than 5 minutes after now and no more than 14 days
   before it; and no more than 5 minutes after `receivedAt` and no more than
   10 minutes before it.
5. `sig` verifies over `canonicalJSON(body)` with the public key of the
   `session` DID.
6. **Authority.** `proof` is not an agent's note; its delegation chain resolves
   **with no proofs beyond itself** (one link), valid at `at`, with audience
   `session` and root `from`; and it grants `{ with: "*", can: "expression/*" }`
   (or `can: "*"`): the whole account, to write.
7. `invite` parses; its space's creator is `from`; it is private and carries
   its key; and the space checks out (its id is the hash of its genesis).

The knock's **id** is `base64url(SHA-256(UTF-8(blob)))`, the same on every relay.
A client MUST de-duplicate by it, computing it itself rather than trusting a
relay's `id`. Where relays disagree about `receivedAt`, the earliest is used.

A client SHOULD also skip knocks from itself, from accounts its contact list
marks blocked, and whose space for two it already holds (accepted here or on
another device).

> Rationale.
>
> - A space's genesis isn't signed, so the invite alone can't prove who made
>   it. The signature under the account's note proves the knock came from
>   `from` before anyone joins anything, as a record's does. Binding `door`
>   stops an owner re-sealing someone's knock to another door as if sent there.
> - **Authority (6):** knocking makes a space and hands out its invite, so it
>   needs what `contacts.ask` needs: a note for the whole account. Every
>   connected app holds a root-signed note; one given a single space, or only
>   read access, must not be able to knock as the account.
> - **Time (4):** notes are judged when a knock was signed, since knocks are
>   read days later, long after an hour-long session note ran out. But `at` is
>   the signer's word. Tying it to when the relay took the knock, a time the
>   door's owner picked the keeper of, means a note that ran out can't be used
>   by dating a knock back to when it was good.

_Source: `packages/core/src/doors/doors.ts` (`sealKnock`, `openKnock`, `knockId`). Tests: `packages/core/tests/doors.test.ts` ("a knock")._

## 7. The exchange

```
 Anna                                   relay(s)                                 Leif
  │ doors.open() → std.door, code                                                  │
  │ ── code, out of band (a link, a QR code, a bio) ─────────────────────────────▶ │
  │                                          spaces.create(private), define answers│
  │                                                         invite(role: editor)   │
  │                                     ◀── drop(topic, sealed knock) ── to each   │
  │                                                         std.knock { space, … } │
  │ fetch(topic) ──▶ ◀── mail [knock]                                              │
  │ open + check (§6)                                                              │
  │ accept: spaces.join(invite); std.contact { did: Leif, space, door }            │
  │         purge(knock) ──▶                                                       │
  │ once a member there: std.knock-answer { sig }                                  │
  │ ═════════════════ the space for two syncs ═══════════════════════════════════▶ │
  │                           answer checks out: std.contact { did: Anna }, invite │
  │                                                    closed, std.knock deleted   │
```

**Knocking.** The knocker:

1. parses the code, and refuses one of its own doors;
2. creates a private space named `"<own name> & <code name>"` with the `team`
   role preset, defines `std.knock-answer` in it, and makes an editor invite;
3. seals the knock (§6) and drops it at **every** relay the code names;
4. if no relay answers `dropped`, leaves the space and fails;
5. otherwise writes `std.knock { space, name, door, sign, invite }` in its
   contacts space.

**Accepting.** The owner joins the invite and writes
`std.contact { did: from, name, space, door: <door id> }`, keeping a name it
already had for that account. It SHOULD purge the knock from the door's relays.
Once its membership in the space for two has landed, it writes the **answer**:

```
std.knock-answer { sig }      sig = door signing key over UTF-8("weave/knock-answer/v1|" + space + "|" + own account DID)
```

and rewrites the contact without `door`. Until then the contact carries the
door id, so any device of the account can write the answer.

**Settling.** For each `std.knock`, the knocker's devices look in its space for
a verified `std.knock-answer` whose author is a member other than themselves
and whose `sig` checks out against the `std.knock`'s `sign`. When one does, they
write `std.contact { did: <that author>, name: <their profile name, else the code's>, space }`,
close the invite, and delete the `std.knock`. Anyone else who joined with the
invite (it may have been passed on) is never taken for the person behind the
door, and nobody joins after.

A `std.knock` nobody answered within the knock TTL plus a day is let go: the
knocker leaves the space and deletes the record. One whose space is no longer
held is deleted.

**Dismissing** a knock purges it from the door's relays; nothing else is
written, and the knocker is not blocked. **Clearing** a door purges all of its
knocks and keeps the door open.

| Collection         | Fields                                                                          | Rules                | Where                    |
| ------------------ | ------------------------------------------------------------------------------- | -------------------- | ------------------------ |
| `std.knock`        | `space` ≤256, `name` ≤64, `door` ≤64, `sign` ≤64, `invite` ≤8000 (all required) | `onePer: ['space']`  | Knocker's contacts space |
| `std.knock-answer` | `sig` ≤200 (required)                                                           | edit/delete: creator | The space for two        |
| `std.contact`      | adds `door` ≤64, optional                                                       | as before            | Owner's contacts space   |

**Who may.** Knocking and accepting create or join a space, so they need a note
for every space (`with: '*'`), as `contacts.ask` does, and the contact key.
Doors are the person's: a node whose note is an agent's MUST refuse to open,
close, clear, read, knock, accept or dismiss, and an account home MUST NOT give
an agent the contact key.

_Source: `packages/core/src/node/node.ts` (Doors), `packages/core/src/node/types.ts` (`NodeDoors`), `packages/core/src/schemas/contacts.ts`, `packages/core/src/session/auth.ts` (`grant`). Tests: `packages/core/tests/doors.test.ts` ("node.doors"), `packages/core/tests/agents.test.ts`._

## 8. API

`node.doors` ([06 — Nodes, sessions and apps](06-nodes-and-sessions.md)):

| Call                               | Does                                                                                                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list()`                           | Your open doors: `{ id, label?, name?, key, sign, relays, code, createdAt }`                                                                                                                                                           |
| `open({ relays?, name?, label? })` | Opens a door. Relays default to this node's relays (up to 3); name to the account's name                                                                                                                                               |
| `close(id)`                        | Deletes the `std.door`                                                                                                                                                                                                                 |
| `clear(id)`                        | Purges every knock at the door, from every relay it names                                                                                                                                                                              |
| `knock(code, { note? })`           | §7, returns `{ space }`                                                                                                                                                                                                                |
| `knocks()`                         | Fetches every open door's topic from every relay it names, opens and checks (§6; opened results are cached by id), settles sent knocks and writes owed answers; returns `{ id, door, from, name, note?, pairSpace, at }`, newest first |
| `sent()`                           | Your unanswered knocks: `{ space, name, at }`                                                                                                                                                                                          |
| `accept(id)`                       | §7, returns the new `ContactView`                                                                                                                                                                                                      |
| `dismiss(id)`                      | Purges one knock                                                                                                                                                                                                                       |

## 9. Security considerations

- **What a relay learns.** Topics, blob sizes and times, and the addresses of
  the sockets that drop, fetch and purge, so it can see that some address
  knocked on a topic that another address fetches. Not whose door it is, not
  which account knocked, not what was said. Topics are stable per door (§4).
- **What a knocker learns.** The code's name, which is only what the owner put
  there. The owner's account only once they answer.
- **What the owner learns.** The knocker's account, proven, and the name and
  note they chose. The name proves nothing: the account DID is what to trust,
  and a code handed over in person is the proof of whose door it is.
- **Spam.** Anyone with a code can knock. Each address gets 4 knocks per door
  and 30 in all per hour; each door holds 64. A single IPv6 /56 holds 256 /64s,
  so a determined flood can fill one door: its owner **clears** it, which keeps
  every printed code and bio link working, and blocking hides an account's
  knocks on every door. A knock only shows as a request; nothing in it runs.
- **Filling a relay.** The per-address budget across topics bounds what one
  address can hold; the reserve keeps every door able to take a knock or two
  when the relay is full; the TTL can't be raised by clients. Both budgets are
  weaker than that today (see the known defect in §5).
- **Authority.** Only a note for the whole account, to write, can knock (§6).
  A note that ran out can't be used by backdating (§6). _Known limitation:_ a
  note that was **revoked** but hasn't run out yet (an app disconnected at the
  home, whose note lasts up to its grant's days) can still knock, because the
  owner can't see the knocker's revocations. Revoking a session's note when
  it ends is planned in [01 §7.4](01-identity.md)
  ([#26](https://github.com/leifriksheim/weave/issues/26)).
- **Leaked invites.** The invite in a knock is multi-use until the knocker
  closes it. Only the answer, signed with the door's key, makes someone the
  knocker's contact; the invite is closed then. Anyone who joined with a leaked
  invite first shows up in `contacts.others` for the knocker to see.
- **Replays.** A knock re-dropped by anyone is the same blob (same id). Dropped
  again later, it fails the time check (§6, 4).
- **Losing a relay.** A door names up to three relays, and knocks go to all of
  them. A relay can drop knocks but can't read, forge or alter them.

## 10. Planned: names

> **Planned.** Not normative. A handle that leads to a door, so a person can
> paste `@anna.bsky.social`, sent to them anywhere, where a code works today.

A name is a pointer to a door, never to the identity. It resolves to a door
code, and never to the account DID: that would link everything the account
ever signed to the handle. The first name provider is ATProto, whose handles
are domains checked both ways against a DID. ATProto is used only to publish
one record, never to sign in: its signing keys usually live with the PDS, the
opposite of "the seed is the account".

**Resolving a handle** (read only, no sign-in):

1. **Handle → DID.** DNS TXT `_atproto.<handle>` (`did=did:plc:…`), else
   `https://<handle>/.well-known/atproto-did`. Browsers can't read TXT
   records: use the HTTPS path, then a configurable DNS-over-HTTPS resolver.
   The DID document's `alsoKnownAs` MUST name the handle back.
2. **DID → PDS**, from the DID document's `AtprotoPersonalDataServer` service
   (`did:plc` through the PLC directory, `did:web` through the domain).
3. **PDS → door.** `com.atproto.repo.getRecord`, collection
   `org.weaveprotocol.door`, key `self`:
   `{ "$type": "org.weaveprotocol.door", "code": "<door code>", "createdAt": "…" }`.
   The repository is signed, so the record is the handle owner's word.
4. `node.doors.knock` accepts a handle wherever it takes a code.

**A checked handle on a knock.** A knock gains an optional `handle` and a
`handleProof`: the knocker's own door signing key over
`weave/knock-handle/v1|<door knocked on>|<knock at>`. The owner resolves the
handle, reads the knocker's own door record, and checks the proof against the
`sign` key in that code. This proves the knocker controls the handle's
repository and a door, without their account DID becoming public. Shown as
"@leif.bsky.social ✓" when it checks out, as the plain name otherwise.

**Linking a handle** happens at the account home: ATProto OAuth (PAR, PKCE,
DPoP) asking only to write `org.weaveprotocol.door`; the home opens or picks a
door and writes the record. Unlinking deletes it; rotating writes another
door's code into it. The account registry remembers which door a handle points
at.

**Who may knock.** A door gains a policy in its `std.door` record (never
published): `anyone` (default), `follows` or `mutuals` on the handle's network.
Follows are `app.bsky.graph.follow` records in the owner's own repository, read
from their PDS, with no AppView. Knocks that don't match are kept but shown
apart.

**Trade-offs.** The PLC directory, a DoH resolver and `bsky.social` owning its
subdomains become dependencies of _discovery_ only: contacts already made are
Weave spaces and survive them. A door record makes "this handle uses Weave"
public, which is opt-in. A second provider should follow: plain DNS,
`_weave.<domain>` TXT holding a door code, for people with a domain and no
ATProto account.

## 11. Not yet specified

- **Topics that change over time** (§4).
- **Retrying a knock** that reached no relay, or whose relays lost it
  (restart), until it is answered or expires. A retry is a fresh knock, signed
  and dropped at once.
- **Live knocks.** The mailbox supports `watch`; `node.doors` only fetches.
- **Proof of work** on `drop`, if public relays see abuse.
- **Revocation** checks on a knocker's note (§9).
