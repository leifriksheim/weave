# The Weave protocol

This is the specification of Weave: what goes over the wire, what is stored,
what is signed, and what every peer must check. It is written so that someone
can build a client that interoperates with this implementation without
reading its code, and so that an agent can understand the architecture from
the spec and the tests alone.

The code in `src/` is the reference implementation. Where this document and
the code disagree, that is a bug in one of them: open an issue, and say which.

## Parts

| Part | Covers |
|---|---|
| [01 — Identity](01-identity.md) | Seeds and recovery codes, key derivation, DIDs, the account vault, root and session signers, UCAN delegations, agent notes, device keys, contact keys, pairing |
| [02 — Records](02-records.md) | Expressions, canonical encoding and hashing, signatures, versions and which one wins, links, collection definitions, rules, topics, queries, the validation pipeline |
| [03 — Spaces](03-spaces.md) | Spaces, roles and the access log, invites, encryption and key distribution, the account registry, profiles, contacts |
| [04 — Network](04-network.md) | Relays and the signaling protocol, several relays at once, peer authentication, WebRTC and WebSocket transports, the mesh, introductions, live messages, ICE and TURN |
| [05 — Sync and storage](05-sync-and-storage.md) | Negentropy set reconciliation and its messages, what is stored and how, storage adapters, data folders, segments, mirrors, blobs |
| [06 — Nodes, sessions and apps](06-nodes-and-sessions.md) | The node and its actions, sign-in, the account home and app grants, agents, carriers and hosts, calls |
| [07 — Doors](07-doors.md) | Names and doors: how someone you share no space with can ask to become your contact, and the relay mailbox that holds their knock |

## Conventions

- **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are used as
  in RFC 2119, and only where they mean it. Everything else is description.
- **Wire and storage formats** are given exactly: field names, types, byte
  layouts, encodings, and an example. A format a peer must produce or accept
  is normative; a format only this implementation uses internally is marked
  *implementation detail*.
- **Encodings.** Unless a part says otherwise: JSON is UTF-8; `base64url` is
  RFC 4648 §5 without padding; `base58btc` is the Bitcoin alphabet; hashes are
  SHA-256; keys are P-256 (secp256r1); signatures are ECDSA P-256 over SHA-256
  in the 64-byte IEEE P1363 form (r ‖ s).
- **Canonical JSON** is defined once, in [02 — Records](02-records.md), and
  every "hash of" or "signature over" a JSON value means over its canonical form.
- **Labels.** Keys derived from the seed, and signed or sealed messages, are
  bound to string labels. The full list is in [01 — Identity](01-identity.md),
  including the few places one label serves two uses today.
- **Source.** Each section ends with the files that implement it and the
  tests that pin it down, e.g. *Source: `src/sync/negentropy.ts`. Tests:
  `tests/sync.test.ts`.* Tests are the executable half of this spec.
- **Rationale** is kept short and set apart, so the rules can be read without it.
- **Not yet specified.** Where behaviour is left to the implementation, or is
  still moving, the spec says so rather than guessing.

## The shape of it, in one page

```
 account (seed) ──derives──▶ root key ──signs UCAN──▶ session key ──signs──▶ records
                                                                           │
                                                          stored per space │ synced by Negentropy
                                                                           ▼
 space = { id, visibility, roles & access log, collections, records } ◀── peers in the space
                                                                           ▲
             relays (WebSocket) introduce peers ─▶ WebRTC data channels ───┘
```

- An **account** is a 16-byte seed. Everything else about it is derived.
- The **root key** almost never signs data. It signs short-lived delegations
  (UCANs) to **session keys**, which sign **records**.
- A **record** is a signed, versioned JSON document in a **collection** of a
  **space**. Private spaces encrypt record bodies with the space key.
- A **space** carries its own rules: roles, who holds them, what each
  collection accepts. Every peer replays the same history and reaches the
  same answer about who may write what. There is no server to ask.
- **Relays** only introduce peers. **Carriers** and **hosts** keep spaces
  online without being able to read them. Neither has authority.
- **Doors** let someone you share no space with ask to become your contact,
  through a relay mailbox that holds only sealed knocks.
