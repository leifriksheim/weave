# Doors

A door is an address an account hands out on purpose, so that someone it
shares no space with can ask to become a contact. The keys, the door code, the
topic, the relay mailbox and the sealed knock are protocol
([spec 07](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md)):
a relay and a door's owner check them.

What this page covers is a convention built on them, not part of the protocol:
where an account keeps its doors, how a knock becomes a space for two, and the
answer that tells the knocker who was behind the door. Peers that have never
heard of `std.door`, `std.knock` or `std.knock-answer` sync, store and judge
them like any other record. Only the devices of one account, and the two
people at either side of a door, have to agree on what follows.

## `std.door`

An account's doors are `std.door` records in its **contacts space**
([spec 03](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)),
which only the account can find and every one of its devices holds.

| Field    | Type                 |                                                                                                                                       |
| -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | string, 16–64 chars  | The door id both keys are derived from ([spec 07 §1](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md))               |
| `relays` | string[], 1–3        | Relay URLs, each passing the door code's relay check ([spec 07 §3](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md)) |
| `name`   | string ≤64, optional | The name the code gives whoever knocks                                                                                                |
| `label`  | string ≤64, optional | What the owner calls the door; never leaves the contacts space                                                                        |

Rules: `onePer: ['id']`. A device treats as a door only a verified `std.door`
whose root is the account itself. **Closing** a door is deleting its record:
its knocks are no longer fetched, and knocks already opened stop being
offered.

_Source: `packages/core/src/schemas/contacts.ts` (`door`), `packages/core/src/node/node.ts` (Doors). Tests: `packages/core/tests/doors.test.ts` ("node.doors")._

## The exchange

```
 Anna                                   relay(s)                                 Leif
  │ doors.open() → std.door, code                                                  │
  │ ── code, out of band (a link, a QR code, a bio) ─────────────────────────────▶ │
  │                                          spaces.create(private), define answers│
  │                                                         invite(role: editor)   │
  │                                     ◀── drop(topic, sealed knock) ── to each   │
  │                                                         std.knock { space, … } │
  │ fetch(topic) ──▶ ◀── mail [knock]                                              │
  │ open + check (spec 07 §6)                                                      │
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
3. seals the knock ([spec 07 §6](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md))
   and drops it at **every** relay the code names, since any one of them may
   lose it (the reference relay keeps its mailbox in memory, so a restart
   loses what it held);
4. if no relay answers `dropped`, leaves the space and fails;
5. otherwise writes `std.knock { space, name, door, sign, invite }` in its
   contacts space.

**Opening.** Besides the checks the protocol requires, the owner's devices
skip knocks from the account itself, from accounts its contact list marks
blocked, and whose space for two it already holds (accepted here or on
another device).

**Accepting.** The owner joins the invite and writes
`std.contact { did: from, name, space, door: <door id> }`, keeping a name it
already had for that account. It purges the knock from the door's relays.
Once its membership in the space for two has landed, it writes the
**answer**:

```
std.knock-answer { sig }      sig = door signing key over UTF-8("weave/knock-answer/v1|" + space + "|" + own account DID)
```

`sig` is ECDSA P-256 / SHA-256, P1363 (64 bytes), base64url, like every
signature of a door signing key. The owner then rewrites the contact without
`door`. Until then the contact carries the door id, so any device of the
account can write the answer.

**Settling.** For each `std.knock`, the knocker's devices look in its space for
a verified `std.knock-answer` whose author is a member other than themselves
and whose `sig` checks out against the `std.knock`'s `sign`. When one does, they
write `std.contact { did: <that author>, name: <their profile name, else the code's>, space }`,
close the invite, and delete the `std.knock`. Anyone else who joined with the
invite (it may have been passed on) is never taken for the person behind the
door, and nobody joins after. Such a person shows up in `contacts.others` for
the knocker to see.

A `std.knock` nobody answered within the knock TTL (14 days) plus a day is let
go: the knocker leaves the space and deletes the record. One whose space is no
longer held is deleted.

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
Doors are the person's: a node whose note is an agent's refuses to open,
close, clear, read, knock, accept or dismiss. A home never gives an agent the
contact key in the first place ([spec 06 §3.1](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).

_Source: `packages/core/src/node/node.ts` (Doors), `packages/core/src/node/types.ts` (`NodeDoors`), `packages/core/src/schemas/contacts.ts` (`knock`, `knockAnswer`, `contact`), `packages/core/src/doors/doors.ts` (`signAnswer`, `checkAnswer`), `packages/core/src/session/auth.ts` (`grant`). Tests: `packages/core/tests/doors.test.ts` ("node.doors"), `packages/core/tests/agents.test.ts`._

## `node.doors`

The calls are listed with the rest of the node, in [node.md](node.md#doors).
`node.doors.knocks()` fetches; it doesn't watch, though the mailbox supports
`watch`. The default mailbox client opens a fresh WebSocket to a relay for
each call.

_Source: `packages/core/src/network/mailbox.ts` (`createMailboxClient`)._

## Not yet built

- **Live knocks.** Watching a door's topic, so a knock shows as it arrives.
- **Retrying a knock** that reached no relay, or whose relays lost it
  (restart), until it is answered or expires. A retry is a fresh knock, signed
  and dropped at once.

## Planned: names

The protocol side of names (a handle resolving to a door code, and a checked
handle on a knock) is planned in
[spec 07 §9](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md).
On this side:

- `node.doors.knock` accepts a handle wherever it takes a code.
- A knock whose handle checks out shows as "@leif.bsky.social ✓", and as the
  plain name otherwise.
- **Who may knock.** A door gains a policy in its `std.door` record (never
  published): `anyone` (default), `follows` or `mutuals` on the handle's
  network. Follows are `app.bsky.graph.follow` records in the owner's own
  repository, read from their PDS, with no AppView. Knocks that don't match
  are kept but shown apart.
