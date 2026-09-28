# The Weave protocol

This is the specification of Weave: what goes over the wire, what is stored,
what is signed, and what every peer must check. It is written so that someone
can build a client that interoperates with this implementation without
reading its code, and so that an agent can understand the architecture from
the spec and the tests alone.

The code in `packages/core/src/` is the reference implementation. Where this document and
the code disagree, that is a bug in one of them: open an issue, and say which.

## Parts

| Part                                                      | Covers                                                                                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [01 — Identity](01-identity.md)                           | Seeds and recovery codes, key derivation, DIDs, the account vault, root and session signers, UCAN delegations, agent notes, device keys, contact keys, pairing        |
| [02 — Records](02-records.md)                             | Expressions, canonical encoding and hashing, signatures, versions and which one wins, links, collection definitions, rules, topics, queries, the validation pipeline  |
| [03 — Spaces](03-spaces.md)                               | Spaces, roles and the access log, invites, encryption and key distribution, the account registry, profiles, contacts                                                  |
| [04 — Network](04-network.md)                             | Relays and the signaling protocol, several relays at once, peer authentication, WebRTC and WebSocket transports, the mesh, introductions, live messages, ICE and TURN |
| [05 — Sync and storage](05-sync-and-storage.md)           | Negentropy set reconciliation and its messages, what is stored and how, storage adapters, data folders, segments, mirrors, blobs                                      |
| [06 — Nodes, sessions and apps](06-nodes-and-sessions.md) | The node and its actions, sign-in, the account home and app grants, agents, carriers and hosts, calls                                                                 |
| [07 — Doors](07-doors.md)                                 | Names and doors: how someone you share no space with can ask to become your contact, and the relay mailbox that holds their knock                                     |

## Conventions

- **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are used as
  in RFC 2119, and only where they mean it. Everything else is description.
- **Wire and storage formats** are given exactly: field names, types, byte
  layouts, encodings, and an example. A format a peer must produce or accept
  is normative; a format only this implementation uses internally is marked
  _implementation detail_.
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
  tests that pin it down, e.g. _Source: `packages/core/src/sync/negentropy.ts`. Tests:
  `packages/core/tests/sync.test.ts`._ Tests are the executable half of this spec.
- **Rationale** is kept short and set apart, so the rules can be read without it.
- **Planned.** Work that is designed but not built lives in the part it
  belongs to, in a section or blockquote headed **Planned**, saying what it
  will add, what it depends on, and its issue when one exists. Planned text is
  not normative. This spec is the working document: when planned work is
  built, its section becomes the specification; when plans change, it is
  edited. (Earlier plans lived in `docs/blocks/`, kept in git history.)
- **Not yet specified.** Where behaviour is left to the implementation, or is
  still moving, the spec says so rather than guessing.
- **Known defect.** Where this implementation does something the protocol
  should not require, the spec says so in a blockquote starting
  "> **Known defect:**", describing current behaviour and what a fix will
  change. Other implementations MUST NOT rely on it, and SHOULD NOT copy it.

## Planned work

Designed but not built. Each entry is specified, as **Planned**, where it
belongs. Issues track the larger ones. Known defects link their issue where
they are described; the smaller ones share
[#20](https://github.com/leifriksheim/weave/issues/20).

| Planned                                                                                     | Where                                                                                                                                    |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A check character on recovery codes                                                         | [01 §2](01-identity.md), [#20](https://github.com/leifriksheim/weave/issues/20)                                                          |
| One spelling per key; one valid form per token; strict token shape                          | [01 §4, §7](01-identity.md)                                                                                                              |
| Proof chains that travel (fixes a known defect)                                             | [01 §7.5](01-identity.md), [#17](https://github.com/leifriksheim/weave/issues/17)                                                        |
| Delegations as UCAN 1.0                                                                     | [01 §7](01-identity.md), [#19](https://github.com/leifriksheim/weave/issues/19)                                                          |
| Grants narrower than a space                                                                | [01 §7.1](01-identity.md), [06 §4](06-nodes-and-sessions.md), [#19](https://github.com/leifriksheim/weave/issues/19)                     |
| Revoking a session's note when it ends                                                      | [01 §7.4](01-identity.md), [#26](https://github.com/leifriksheim/weave/issues/26)                                                        |
| Sealing with HPKE (RFC 9180)                                                                | [01 §9.4](01-identity.md), [#24](https://github.com/leifriksheim/weave/issues/24)                                                        |
| Wraps bound to their account                                                                | [01 §10](01-identity.md)                                                                                                                 |
| Pairing without showing the account                                                         | [01 §14.4](01-identity.md), [#31](https://github.com/leifriksheim/weave/issues/31)                                                       |
| Versions whose history can be checked (fixes a known defect)                                | [02 §4.7](02-records.md), [#14](https://github.com/leifriksheim/weave/issues/14)                                                         |
| Merging inside one record                                                                   | [02 §4.8](02-records.md)                                                                                                                 |
| Deletes and edits that forget                                                               | [02 §4.9](02-records.md), [#47](https://github.com/leifriksheim/weave/issues/47)                                                         |
| References to records in other spaces                                                       | [02 §5.3](02-records.md), [#38](https://github.com/leifriksheim/weave/issues/38)                                                         |
| `pattern` and `format` in definitions                                                       | [02 §6](02-records.md)                                                                                                                   |
| Compatible definitions; content-addressed definitions; definition tiers                     | [02 §6.5](02-records.md), [#11](https://github.com/leifriksheim/weave/issues/11), [#12](https://github.com/leifriksheim/weave/issues/12) |
| Meaning-level hints on definitions                                                          | [02 §6.6](02-records.md)                                                                                                                 |
| Private `onePer` keys; uniqueness that cannot be a key                                      | [02 §7.3](02-records.md)                                                                                                                 |
| Queries leave the protocol; queries that leave out non-conforming records; full-text search | [02 §11](02-records.md), [#28](https://github.com/leifriksheim/weave/issues/28)                                                          |
| What the standard library still waits on: file bytes, references to other spaces, `format`  | [02 Appendix A.4](02-records.md), [#36](https://github.com/leifriksheim/weave/issues/36)                                                 |
| Leaving writes the self-removal (fixes a known defect)                                      | [03 §6.2](03-spaces.md), [#15](https://github.com/leifriksheim/weave/issues/15)                                                          |
| Contact requests that can be taken back; leaving a space for two updates the list           | [03 §16.5](03-spaces.md), [#40](https://github.com/leifriksheim/weave/issues/40)                                                         |
| Keep lists past the cap; deleted access records can't leave access standing                 | [03 §6.3, §7.2](03-spaces.md)                                                                                                            |
| What a private space still shows (hashed keys and collection names)                         | [03 §8.6](03-spaces.md)                                                                                                                  |
| Profiles, round two                                                                         | [03 §11](03-spaces.md)                                                                                                                   |
| Access-control convergence                                                                  | [05 §8](05-sync-and-storage.md), [#10](https://github.com/leifriksheim/weave/issues/10)                                                  |
| A node you can pin; no plain `ws://` off this machine                                       | [04 §5.2](04-network.md), [#32](https://github.com/leifriksheim/weave/issues/32)                                                         |
| Limits on what one peer can cost another                                                    | [04 §7.4](04-network.md), [05 §6.4, §8](05-sync-and-storage.md), [#33](https://github.com/leifriksheim/weave/issues/33)                  |
| Binary sync messages                                                                        | [05 §4](05-sync-and-storage.md)                                                                                                          |
| Completeness from signed writer logs; fork proofs                                           | [05 §9.1](05-sync-and-storage.md), [#13](https://github.com/leifriksheim/weave/issues/13)                                                |
| Caches that fetch, widen and trim; subsets smaller than a collection                        | [05 §9.2](05-sync-and-storage.md), [#27](https://github.com/leifriksheim/weave/issues/27)                                                |
| Mirrors in your own storage, and their drivers                                              | [05 §16.5](05-sync-and-storage.md)                                                                                                       |
| Files: blob references, bytes synced by hash                                                | [05 §16.6](05-sync-and-storage.md), [#37](https://github.com/leifriksheim/weave/issues/37)                                               |
| A wallet as the account home                                                                | [06 §4](06-nodes-and-sessions.md)                                                                                                        |
| Agents: renewing notes, naming, agents that can't run a program                             | [06 §5.6](06-nodes-and-sessions.md)                                                                                                      |
| Web Push through carriers, to an app that is closed                                         | [06 §6.4](06-nodes-and-sessions.md)                                                                                                      |
| Subscriptions delivered per device, through receiver records                                | [03 §15](03-spaces.md), [06 §6.4](06-nodes-and-sessions.md), [#30](https://github.com/leifriksheim/weave/issues/30)                      |
| Hosts: reachability, restore, user storage, quotas, reminders, private payments             | [06 §6.6](06-nodes-and-sessions.md)                                                                                                      |
| Calls: blocked people don't ring, ringing a closed app, big calls, listen-only              | [06 §7](06-nodes-and-sessions.md), [#20](https://github.com/leifriksheim/weave/issues/20)                                                |
| Names: handles that lead to a door                                                          | [07 §10](07-doors.md)                                                                                                                    |

Proposed in an issue but not yet designed into the spec, so listed under
**Not yet specified** in their part: key rotation, KERI-style pre-rotation
([01 §15](01-identity.md), [#9](https://github.com/leifriksheim/weave/issues/9)), and access-history checkpoints
([03 §17](03-spaces.md), [#25](https://github.com/leifriksheim/weave/issues/25)).

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
