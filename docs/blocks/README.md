# Work blocks

Each block in this folder is a self-contained unit of work. You can open any one
of them and start, in any order, without reading the others.

Every block opens with a **Before you start** section containing a command you
can paste into a terminal. It tells you whether the block is ready to go. Where a
block needs something small from another block, that thing is written out in full
inside the block itself — you never have to go hunting.

> Run the check from anywhere inside the project — the `cd` in each command
> finds the repo root. Libraries are allowed where a problem is hard and already
> solved; see [../DEPENDENCIES.md](../DEPENDENCIES.md) before adding one.

## The blocks

| Block | Delivers | Rough size |
|---|---|---|
| [BLOCK-01](BLOCK-01-sync-protocol.md) | Sync that ships subtree CIDs instead of every key — **done** | — |
| [BLOCK-02](BLOCK-02-wallet-login.md) | ~~MetaMask as a login option~~ — parked, the Snap in `snap/` does this | — |
| [BLOCK-03](BLOCK-03-packed-storage.md) | `BlobStore` + `PackedAdapter` + garbage collection | ~2 weeks |
| [BLOCK-04](BLOCK-04-remote-blob-drivers.md) | S3-compatible and Google Drive blob drivers | ~1 week |
| [BLOCK-05](BLOCK-05-transport-abstraction.md) | Pluggable network transport + WebSocket transport | ~3 days |
| [BLOCK-06](BLOCK-06-bun-daemon.md) | `p2p` CLI: spaces from a terminal, `run` as the always-on node, `mcp` for agents — **done** | — |
| [BLOCK-07](BLOCK-07-hosting-tier.md) | Multi-tenant hosting, BYO-storage credentials | ~2 weeks |
| [BLOCK-08](BLOCK-08-self-describing-spaces.md) | Collection definitions stored in the space — **done** | — |
| [BLOCK-09](BLOCK-09-links-and-annotations.md) | Links between records, and a `sys.*` library agents compose with — **done** | — |
| [BLOCK-10](BLOCK-10-query-layer.md) | Filtering, sorting and following links | ~1 week |
| [BLOCK-11](BLOCK-11-constraints-and-convergence.md) | "One reaction per person", done so peers agree | ~4 days |
| [BLOCK-12](BLOCK-12-typed-queries.md) | Autocomplete for collections, fields and includes | ~4 days |
| [BLOCK-13](BLOCK-13-node-api.md) | `createNode`: one API for tabs, CLIs, daemons and agents — **done** | — |
| [BLOCK-14](BLOCK-14-versioned-records.md) | Records with a stable key, ordered versions, history on request — **done** | — |

## What depends on what

```
  MST rewrite ── done ──┬──> BLOCK-01  sync protocol        (free to start)
                        └──> BLOCK-03  packed storage       (free to start)
                                         │
                                         └──> BLOCK-04  remote drivers
                                              (needs one small interface file;
                                               BLOCK-04 contains a full copy)

  BLOCK-02  wallet login        (parked — superseded by snap/)

  BLOCK-05  transport           (free to start, depends on nothing)
     │
     └──> BLOCK-06  bun daemon
          (needs the transport refactor; BLOCK-06 contains it inline)
              │
              └──> BLOCK-07  hosting tier
                   (genuinely needs a working daemon — the only hard ordering here)

  BLOCK-08  self-describing spaces    (free to start)
     │
     └──> BLOCK-09  links + sys.* library
          (works without it, but nothing checks the links until 08 lands)
              │
              └──> BLOCK-10  query layer
                   (the filtering half works alone; `include` needs the link index)
                       │
                       ├──> BLOCK-11  constraints
                       │    (the fold lives in the query engine)
                       └──> BLOCK-12  typed queries
                            (a typed surface over the engine; no runtime change)
```

**Free to start right now, in any order:** 01, 03, 05, 08.

**Two soft orderings:** BLOCK-07 genuinely needs BLOCK-06 finished first — it says
so at the top and won't let you start by mistake. BLOCK-09 runs without BLOCK-08,
but its links go unchecked until that lands.

## Current order

1. ~~**BLOCK-05**~~ — done.
2. ~~**BLOCK-13**, the Node API~~ — done.
3. ~~**BLOCK-06**, the CLI and always-on node~~ — done.
4. ~~**BLOCK-01**~~ — done: 508 KB → 25 KB for one change in 10,000.
5. ~~**An account registry space** and a signed hello on `/peer`~~ — done.
6. ~~**BLOCK-08**~~ — done; agents can define collections over MCP.
7. ~~**BLOCK-14**~~ — done: records keep their key; edits are ordered versions.
8. ~~**BLOCK-09**~~ — done: links by key, declared in definitions, `sys.*` annotations.
9. ~~**BLOCK-10**~~ — done: `records.query` / `watch` / `records_query`; plain-data filters, includes over links.
10. **Views** — `sys.view`: a query plus a layout, as data an agent can write
    and any app can render. The format is protocol; renderers are app code. (Block to write.)
11. **Agent sessions** — an agent is not its own identity: it signs for you with
    a session key, like any device, given a narrower, labelled delegation
    (which spaces, which collections, read or write). (Block to write.)
12. WebMCP in the example.

## Why the always-on node matters most

Everything else assumes somebody is online, and today nobody is:
close the last tab with a browser-only account and the data is not slow to reach,
it is gone. A data folder covers desktop Chrome and nothing else. Until the daemon
exists, "no server" reads as a feature in the README and as data loss in practice.

After that: **BLOCK-03** is what the product thesis rests on — bring-your-own-storage
is what makes the hosted node cheap and what lets you say you never hold anyone's
data. **BLOCK-08 and 09** are what make "apps are views on your data" literally
true rather than nearly true: without them a second app can read your files but
not your meaning.

## Written down but not blocked yet

Things that came up while building and have no block of their own:

- ~~**An account-wide registry space**~~ — done (2026-09-23):
  `src/space/account-registry.ts`, wired into `createNode({ accountKey })`.
  Verified in browsers: a list made on one device appears on another of the
  same account with no invite. Alongside it, the node's `/peer` endpoint now
  requires both ends to prove they hold a private space's key
  (`src/network/peer-auth.ts`).
- **Revoking access to a private space.** A space has one AES key and no
  rotation, so somebody invited is invited permanently. Re-keying means
  re-encrypting and distributing to the remaining members.
- **Full-text search.** BLOCK-10's `$contains` is a substring scan, which is
  honest at browser scale and is not search. Ranking and prefix matching need an
  inverted index — a third MST keyed by token.
- **Proof chains that travel.** `resolveDelegationRoot` takes a resolver that
  the example passes as `() => null`, so any delegation deeper than
  root → session fails to verify. Nothing depends on it yet; anything
  multi-device will.

## Background: what already happened

Two spikes ran before these blocks were written.

**Spike C (passed).** The protocol core compiles to a standalone Bun binary. All
crypto works: P-256, HKDF, PBKDF2, AES-GCM, UCAN, SHA-256 — 11/11 checks inside a
compiled binary. Cross-compiles to `linux-x64` and `linux-arm64`. `bun:sqlite`
works compiled. This is why BLOCK-06 is a safe bet.

**Spike B (found a blocker, now fixed).** The MST in `src/storage/mst.ts` was not
a tree — every key was spliced into a single root node and the computed key
heights were discarded. Writes were O(N) each and O(N²) in total: at 10,000
expressions, one insert rewrote an 810 KB node and the store held 3.96 GB.

That has been rewritten around the height invariant and is covered by
`tests/mst.test.ts` (13 tests, including order-independence and
delete-is-the-inverse-of-insert). Measured at N=10,000:

| | Before | After |
|---|---:|---:|
| Bytes per insert | 405 KB | 4.4 KB |
| Root node | 810 KB | 235 B (constant at every N) |
| Total stored | 3.96 GB | 44 MB |
| 10k inserts | 16.1 s | 0.97 s |

Two things that rewrite deliberately left open, each now owned by a block:

- Sync still ships the full key list every round (2.87 MB at N=10k) → **BLOCK-01**
- Orphaned nodes still accumulate, ~4 per insert, with no collection → **BLOCK-03**

### One breaking change to know about

MST nodes gained a `height` field, so v1 data cannot be read. The IndexedDB
adapter is at `DB_VERSION = 2` and **drops both object stores on upgrade**.
Anyone with existing browser data starts clean and re-syncs from peers. Mention
it in release notes when you cut one.
