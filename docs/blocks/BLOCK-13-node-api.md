# BLOCK-13 — The Node API

> **Done (2026-09-23).** `src/node/`. Tests: `tests/node.test.ts`. The example
> app runs on it, checked end to end in two browser profiles (create a private
> shared list, invite, sync both ways, toggle, delete).

## What this delivers

`createNode()`: one identity, its spaces, and everything needed to read, write
and sync them, behind an API that is plain JSON in and out. A browser tab, a
CLI, a daemon and an agent are all thin layers over it.

Before this, the wiring lived in the example app (`example/src/space-session.ts`,
~400 lines) and every new front end would have had to copy it.

## Shape

```
createNode({ signer, stores, collections?, network?, sessionTtlSeconds?, watchIntervalMs? })

node.spaces   list · get · create · invite · preview · join · leave · open · close · status
node.records  list · get · put · update · delete
node.delegation() · node.delegate({ audience, capabilities, expiration? })
node.subscribe(listener) · node.close()

NODE_ACTIONS  the same operations as { name, description, input: JSON Schema, readOnly, sensitive?, run }
```

`stores` is a `StoreFactory` — `(path, { seal? }) => StorageAdapter`. The node
asks for `registry` (sealed) and `spaces/<id>`. `indexedDBStores(prefix)` and
`folderStores(directory, { basePath, vaultKey })` ship with it.

`network` takes `relays` (WebRTC rooms, browsers), `nodes` (WebSocket to
always-on nodes, space id appended as `?space=`), and `transports` (anything
else — how the daemon's inbound sockets and the tests plug in).

## Decisions made while building it

- **Deletes are tombstones.** Removing an expression locally never deleted it:
  the next sync pulled it back from any peer that still had it. A delete is now
  a signed record in `sys.tombstone` naming its target. It is honoured only
  when signed by the target's root identity or the space owner. The target stays
  stored — dropping it would invite it back.
- **Update = new record + tombstone.** Ids are content hashes, so an update has
  a new id. A stable logical identity across edits is BLOCK-11's territory.
- **Delegations are judged at signing time.** Found here: `verifyUCAN`
  compared expiry against *now*, so every record stopped verifying an hour after
  it was written and later peers rejected it. The capability gate now checks
  against the record's `createdAt` and refuses records dated more than five
  minutes ahead. Trade-off, written into the gate: a leaked session key could
  backdate records within its own window.
- **Unknown collections pass the structural gate** (`allowUnknownCollections`).
  Signature and capability are still checked. Until BLOCK-08 stores schemas in
  the space, a node cannot know every app's shapes, and refusing them would make
  an always-on node drop other apps' data.
- **The node renews its own delegation** at 75% of its lifetime; if the signer
  refuses, it keeps the old one and retries.
- **Cross-tab nudge.** A `BroadcastChannel` per space tells other tabs sharing
  the same IndexedDB to re-read.

## Known gaps

- `records.list` without a collection walks every key; fine at browser scale,
  replaced by BLOCK-10's query engine.
- Deeper delegations (root → session → agent) do not verify on other peers yet:
  proofs above the leaf are not carried with the record. `node.delegate` returns
  them for local checking. Needed before agents write on their own keys.
- The example no longer re-checks a folder on window focus, only on the 2 s poll.
