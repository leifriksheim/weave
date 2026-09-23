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
| [BLOCK-03](BLOCK-03-packed-storage.md) | `BlobStore` + `PackedAdapter` + garbage collection — also what files and avatars need | ~2 weeks |
| [BLOCK-04](BLOCK-04-remote-blob-drivers.md) | S3-compatible and Google Drive blob drivers (after 03) | ~1 week |
| [BLOCK-07](BLOCK-07-hosting-tier.md) | Multi-tenant hosting of always-on nodes, bring-your-own storage. Its readiness check predates the `weave` CLI — the "daemon" it needs is `weave run` | ~2 weeks |
| [BLOCK-11](BLOCK-11-constraints-and-convergence.md) | "One reaction per person", done so peers agree | ~4 days |
| [BLOCK-12](BLOCK-12-typed-queries.md) | Autocomplete for collections, fields and includes | ~4 days |

## Next, not written as blocks yet

- **Agent sessions.** An agent is not its own identity: it signs for you with a
  session key, like any device, given a narrower, labelled delegation (which
  spaces, which collections, read or write).
- **Profiles, round two.** A per-space name ("in this space, call me…"), avatars
  once there is blob storage (BLOCK-03), and private nicknames for others.
- **An account home.** One address that holds your passkey and hands apps a
  delegation to their session key — later, a wallet via the Digital Credentials
  API doing the same job.
- **Meaning-level UI hints** on collection definitions (a title field, a field's
  role, tallies), and web components for the protocol's own `sys.*` collections.

## Written down

- **Revoking access to a private space.** A space has one AES key and no
  rotation, so somebody invited is invited permanently. Re-keying means
  re-encrypting and distributing to the remaining members.
- **Full-text search.** `$contains` is a substring scan — honest at browser
  scale, not search. Ranking and prefix matching need an inverted index.
- **Proof chains that travel.** Delegations deeper than root → session →
  one more need their intermediate proofs carried with the record.
- **Orphaned tree nodes** still accumulate, a few per insert, with nothing
  collecting them → BLOCK-03.
