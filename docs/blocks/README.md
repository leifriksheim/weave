# Work blocks

Each block is a self-contained piece of work still ahead. Finished blocks are
removed once what they built is described in the main README — their full text
stays in git history.

Every block opens with a **Before you start** check you can paste into a
terminal. Libraries are allowed where a problem is hard and already solved; see
[../DEPENDENCIES.md](../DEPENDENCIES.md) before adding one.

## The blocks

| Block | Delivers | Rough size |
|---|---|---|
| [BLOCK-03](BLOCK-03-mirrors.md) | Mirrors: a space kept in any dumb file store, synced like a peer; tree garbage collection | ~2 weeks |
| [BLOCK-04](BLOCK-04-remote-blob-drivers.md) | S3-compatible and Google Drive blob drivers; S3 first, since hosting needs it (after 03) | ~1 week |
| [BLOCK-07](BLOCK-07-hosting-tier.md) | Hosting: one blind always-on node on one server carrying many people's spaces, backed up to R2; paid-until plans by card, Apple Pay or crypto, and pricing (after 03 and S3 from 04) | ~3 weeks |
| [BLOCK-12](BLOCK-12-typed-queries.md) | Autocomplete for collections, fields and includes | ~4 days |
| [BLOCK-14](BLOCK-14-security-hardening.md) | Security, round two: checkable version history, safe pairing, private votes, sync limits (removing members is done) | ~2½ weeks |
| [BLOCK-15](BLOCK-15-spaces-and-roles.md) | Spaces and roles: one kind of space, custom roles per space, hand over and leave, access you can take back. Built except the home's role screens | ~3 days left |
| [BLOCK-17](BLOCK-17-browser-extension.md) | A Chrome extension that keeps your node in the gossip and your pod up to date while the browser is open, without being able to read your spaces | ~2 weeks |
| [BLOCK-18](BLOCK-18-agent-made-apps.md) | Apps an agent makes: its own labelled key, proposals a person adds, a summary worked out from the rules, apps as records in the Apps tab | ~1 week |
| [BLOCK-19](BLOCK-19-compatible-definitions.md) | Compatible definitions: apps check what a collection promises (fields, links, rules) instead of its name; harmless updates apply themselves (after 18) | ~1 week |
| [BLOCK-20](BLOCK-20-connect-an-agent.md) | Connect an agent with one command: the browser's agent works as you, one on your computer pairs through a code and runs a node of its own | ~3 days |
| [BLOCK-21](BLOCK-21-calls.md) | Calls: voice and video in any space, ringing one person or a call the space can join, and the call stays up while you move between spaces. Built; running TURN and testing on real networks and phones is left | ~2 days left |

## Next, not written as blocks yet

- **Roles in rules (`can:<role>`).** "Anyone the owner made a moderator" as a
  rule: a UCAN from the owner, carried in the record's own proof chain, so any
  peer can check it. Needs proof chains that travel (below).
- **Uniqueness that cannot be a key.** `onePer` covers "one per author per
  thing" by deriving the key. Anything that cannot be derived would need a
  deterministic fold on read instead — every peer keeping the same one.
- **Typed collections.** A TypeScript builder that emits the JSON Schema, the
  rules and the types in one, and typed handles (`node.use(space, Poll)`) —
  replaces BLOCK-12.

- **Contacts in the example app.** A contacts screen over `node.contacts`:
  requests waiting in a space, "Add as a contact" on someone's name, and, when
  someone new turns up in a conversation, the choice between starting a group
  and inviting them anyway. The library side is built (see Contacts in the
  main README).
- **One relay socket per room.** Each space is its own room, and so its own
  WebSocket per relay; with hundreds of contacts, staying connected to all of
  them isn't practical. For now, hold a contact's space only while the
  conversation is open. Later, the relay carries many rooms over one socket.
- **Profiles, round two.** A per-space name ("in this space, call me…"), avatars
  once there is blob storage (BLOCK-03), and private nicknames for others.
- **An account home.** One address that holds your passkey and hands apps a
  delegation to their session key — later, a wallet via the Digital Credentials
  API doing the same job.
- **Meaning-level UI hints** on collection definitions (a title field, a field's
  role, tallies), and web components for the standard schemas (`weave-protocol/schemas`).

## Written down

- **Full-text search.** `$contains` is a substring scan — honest at browser
  scale, not search. Ranking and prefix matching need an inverted index.
- **Proof chains that travel.** Delegations deeper than root → session →
  one more need their intermediate proofs carried with the record.
- **Merging inside one record.** Two devices editing different fields of one
  record while apart produce two versions, and one wins whole. Field-level
  merging, or a text CRDT for long text, would keep both edits. A question
  about record bodies; storage and sync don't change.
- **Collection names travel in the clear.** A private space encrypts record
  bodies, but envelopes stay readable, so a host, a mirror's provider or a
  relay can see `app.todo.item`. Encrypting the name, or replacing it with a
  keyed hash, would close that.
- **Orphaned tree nodes** still accumulate, a few per insert, with nothing
  collecting them → BLOCK-03.
