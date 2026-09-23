# BLOCK-03 — Mirrors: your spaces in storage you already have

## What this delivers

A way to keep a space in any dumb file store: a Dropbox or OneDrive app
folder, a Google Drive folder, an S3 bucket, or a plain directory. The store is
treated as a **peer that never runs code**. Any device that has access syncs
with it the same way it syncs with another device: it reads what others left
there, and leaves what they're missing.

This gives three things at once:

- **Backup** in storage the user already pays for.
- **Sync between your own devices with no server.** A phone and a laptop that
  are never online at the same time still meet through the folder.
- **Storage kept separate from hosting.** An always-on node (BLOCK-07) is just
  one more device writing into the same folder. Changing host means handing a
  new one the same folder, and the data never moves.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'readonly height: number' src/storage/mst.ts && \
grep -q 'export async function reconcileFolder' src/storage/folder-reconcile.ts && \
grep -q 'export function supersedes' src/records/version.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — the MST rewrite, folder reconcile or the version rule is missing, or the project does not typecheck"
```

**Depends on no other block.** Free to start.

---

## Background

### This is already how data folders work

`src/storage/folder-reconcile.ts` makes a shared folder converge with no locks:
record files are named by their own hash, so two writers either write
different files or identical ones, and **the set of record files wins**. The
tree is derived state that anyone can rebuild. A mirror is the same idea,
applied to a store that is slow, charges per request and can't be trusted.

### Why the store can't be a `StorageAdapter`

`src/storage/mst.ts` reads one tree node per step of every walk. Google Drive
takes roughly 200–500 ms per call and allows about 1,000 calls per 100 seconds.
A store that answered tree lookups one at a time would make one sync take
minutes and use up the quota. So the remote store never holds the tree. It
holds **records**, packed into batches.

### Is this a CRDT?

Yes, and it already was. A space is a set of signed record versions: merging
two copies means taking both sets together, and the ordering rule in
`src/records/version.ts` (higher `seq`, then lower id) picks the same current
version everywhere. That's a set that only grows, plus a last-writer-wins
register per record. Both are standard CRDTs.

The mirror doesn't change how records merge. It only decides **how those
versions sit in a folder that nobody can lock.** A CRDT library such as
Automerge or Yjs would have the same storage problem, and Automerge solves it
the same way: immutable chunks, one set per writer, compacted now and then.

What a library *would* change is merging inside one record. Today two devices
editing different fields of one record while apart produce two versions, and
one wins whole. That's a question about record bodies, not storage, and it's
listed in the blocks README.

---

## Design

### Layout

```
<root>/
  <space-id>/
    <writer-id>/
      000001-<hash>.seg        immutable; written once, never changed
      000002-<hash>.seg
    <writer-id>/
      …
```

- **One subfolder per writer.** A writer is one store on one device, in one
  origin: a browser's IndexedDB, a data folder, a hosted node. Its id is 128
  random bits, made once and kept beside the local store. Not a DID: an id that
  appears in the folder shouldn't identify the account anywhere else.
- **A writer only ever creates files in its own subfolder.** No file is written
  twice, so there's nothing to overwrite and nothing to lock. The only other
  write is deletion, and the rules for that are strict (see *Compaction*).
- **A segment is a batch of signed record versions exactly as they travel on
  the wire**: bodies encrypted in a private space, envelopes readable. No tree
  nodes, no manifest, no root pointer. Each reader rebuilds its own tree from
  the records, the way `reconcileFolder` does.
- **Names sort, and carry a hash.** The counter keeps a writer's segments in
  order for humans, and the hash of the segment's bytes makes a retried upload
  land on the same name.

The account registry (`src/space/account-registry.ts`) is a space like any
other, so it mirrors the same way. Its records are already encrypted with a key
that comes from the account's seed. That's what makes a full restore possible:
recovery code, then connect storage, then every space comes back.

### What leaves the device, and what the store sees

Exactly what a peer sees: record envelopes (author, collection, record key,
`seq`, signature, time) and encrypted bodies. A blind host sees the same
(BLOCK-07). **Don't seal segments with the space key.** A host that has to read
the folder to restart would then need the key, and would no longer be blind.
If collection names are too revealing, fix that at the protocol level, for
peers and stores alike; see the blocks README.

Public spaces are stored readable. They're public anyway.

The account file, with its seed wraps, **never** goes in a mirror. A
passphrase wrap can be attacked offline by anyone holding the file, at full
speed, with nothing to slow them down. A mirror carries spaces and nothing else.

### Push

1. Keep a local set of version ids **known to be in the store**: everything this
   writer uploaded, plus everything it has read from any segment.
2. When the space changes, collect current versions (and first and retained
   ones, the same set `StorageProvider.entries()` indexes) that aren't in
   that set.
3. Pack them into one segment when the batch reaches `flushBytes`, or
   `flushMs` after the first change, whichever comes first.

Step 1 is what stops everyone re-uploading everyone else's records. It's also
what makes a hosted node useful as a bridge: records it got by sync from a
friend aren't in the user's folder yet, so it adds them.

### Pull

1. List the space folder: every writer, every segment.
2. Fetch each segment this device hasn't read yet. Segments are immutable, so
   "read" is simply remembering the name.
3. Pass every record through **the same gates as a record from a peer**:
   crypto (the signature), then capability (was the author allowed to write
   here). The store is untrusted. It can't forge anything, because the gates
   catch it, but it can serve junk, and junk is dropped exactly as it would be
   from a bad peer.
4. `storage.addExpression` each one. The ordering rule makes the order
   irrelevant.

A store that hides segments only makes this device know less; the mesh and
other mirrors fill the gap. Nothing is lost by accepting less, so there's no
rollback check to build, because there is no manifest to roll back.

Where the service offers a change feed, use it instead of listing: Dropbox
`list_folder/continue` plus long polling, Drive `changes.list`. S3 and plain
directories list. This is an optional method on `BlobStore`.

### Compaction

Segments pile up: many small ones, holding versions that have since been
superseded. Two rules, and nothing else deletes.

**A writer may rewrite its own segments.** It writes a new segment holding the
still-wanted versions from several old ones, then deletes the old ones. New
first, delete after, so a reader in between sees duplicates, and duplicates are
harmless.

**Anyone may absorb a writer that has gone quiet.** A lost phone leaves a
subfolder behind forever. A writer whose newest segment is older than
`absorbAfterDays` (default 30) may copy the still-wanted versions from one of
its segments into its own, then delete that segment. It's safe because the
segment can't change underneath it. If two devices absorb the same segment,
both copies are the same records, and records are idempotent.

"Still wanted" means what the local tree keeps: current versions, first
versions and retained history. A superseded version that the tree already
dropped isn't copied forward.

### Local tree garbage

Separate from the above, and local only. Every insert into the tree leaves
about four unreachable nodes behind. `collectReachableCids` in
`src/storage/mst.ts` already walks the live set. Add `collectGarbage(adapter)`,
which deletes every tree node it doesn't reach, and run it when the node is
idle.

---

## Files

| File | Change |
|---|---|
| `src/storage/blob-store.ts` | **New.** The interface, below |
| `src/storage/blob/memory.ts` | **New.** For tests |
| `src/storage/blob/directory.ts` | **New.** A directory handle or a directory on disk |
| `src/storage/segment.ts` | **New.** Pack and unpack a batch of versions; name a segment |
| `src/storage/mirror.ts` | **New.** Push, pull, compact, absorb |
| `src/storage/mst.ts` | `collectGarbage` |
| `src/node/types.ts`, `src/node/node.ts` | `mirrors` in `NodeConfig`; each open space gets one |
| `src/index.ts` | Export the new surface |
| `tests/helpers/latency-blob-store.ts` | **New.** The fixture that matters most |
| `tests/mirror.test.ts` | **New** |

### `src/storage/blob-store.ts`

```ts
/**
 * A dumb file store. Anything that can keep bytes by name can be one: S3, R2,
 * Backblaze, a Dropbox or OneDrive app folder, a Drive folder, a directory.
 * Assume it is slow, eventually consistent, and without atomic operations.
 */
export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /**
   * Keys that appeared or went away under `prefix` since `cursor`, where the
   * service can say so cheaply. Without it the mirror lists.
   */
  changes?(prefix: string, cursor: string | null): Promise<{ added: string[]; removed: string[]; cursor: string }>;
}
```

### `src/storage/mirror.ts`

```ts
export interface MirrorConfig {
  readonly store: BlobStore;
  readonly space: string;
  readonly storage: StorageProvider;
  /** The same gates sync uses. Nothing from the store is trusted more than a peer. */
  readonly accept: (expression: Expression) => Promise<boolean>;
  /** Where this writer keeps its id, its read segments and its known-uploaded set */
  readonly state: StorageAdapter;
  readonly flushBytes?: number;       // default 256 * 1024
  readonly flushMs?: number;          // default 5000
  readonly absorbAfterDays?: number;  // default 30
}

export interface Mirror {
  pull(): Promise<{ added: number }>;
  /** Upload what the store is missing, now. Also called on a timer and on shutdown. */
  flush(): Promise<void>;
  compact(): Promise<void>;
  close(): Promise<void>;
}

export function createMirror(config: MirrorConfig): Promise<Mirror>;
```

In `NodeConfig`, `mirrors?: ReadonlyArray<(space: string) => BlobStore>`. It's
a list because a user may have two (their Dropbox, plus the host's own bucket
when they pay without connecting anything). The node pulls when a space opens
and on each change notice, and flushes after local writes and on shutdown.

---

## Steps

1. `blob-store.ts`, `blob/memory.ts` and `tests/helpers/latency-blob-store.ts`,
   **before** the mirror. Building the mirror without the slow fixture means
   finding the request-count bugs later, against someone's real Drive.
2. `segment.ts`: pack, unpack, name. Pure functions, easy to test.
3. Pull, through the gates.
4. Push, with the known-uploaded set.
5. Wire it into the node. Two nodes, one memory store, never online together:
   they converge.
6. Compaction and absorbing.
7. `blob/directory.ts`: a real backend, and the way to try the whole thing
   before any cloud driver exists (BLOCK-04).
8. `collectGarbage`.

---

## Testing

### The fixture that matters

`tests/helpers/latency-blob-store.ts` wraps any `BlobStore` and adds:

- a delay per call (default 300 ms, like Drive)
- random 429 errors at a set rate
- listings that lag: a new key shows up only after a few calls
- a **call counter**, so tests can check the request budget

Every mirror test runs behind it.

### Tests

- Two nodes that are never online together converge through one store
- Three writers pushing at once: no file is written twice, and all three
  converge
- A pull reads each segment once; a second pull with nothing new fetches
  nothing
- A pushed segment doesn't come back as new work to the writer that pushed it
- A node never re-uploads a version it read from someone else's segment
- A forged record, and a record by someone not allowed to write, are dropped on
  pull, and the rest of the segment is kept
- A private space's segment has no readable body without the key
- Compaction lowers the stored bytes after a few thousand edits, and every
  record still resolves afterwards on a fresh node
- A quiet writer is absorbed; two nodes absorbing at once still converge
- A segment deleted between listing and fetching is skipped, not an error
- Under a burst of 429s the mirror backs off and still converges
- `collectGarbage` frees unreachable nodes and never a reachable one

### Acceptance test

Run `tests/sync.test.ts`'s scenarios with the peers never connected to each
other, only to `latency(memory, 300)`. It must pass in reasonable time, and the
logged calls for syncing 1,000 records must stay inside Drive's
1,000-per-100-seconds budget.

---

## Acceptance criteria

- [ ] Two devices that are never online together converge through a store
- [ ] No file in the store is ever written twice
- [ ] Nothing from the store skips the gates
- [ ] 1,000 records sync inside Drive's request budget
- [ ] Compaction and absorbing reduce stored bytes and lose nothing
- [ ] The account file never reaches a store
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

- **S3, Drive, Dropbox and OneDrive drivers**: BLOCK-04. Each is small once
  the contract exists.
- **Hosting**: BLOCK-07.
- **Files and avatars.** They fit the same layout later, as
  `<space-id>/files/<hash>`: content-addressed, immutable, anyone may write the
  same one. Don't build it now; don't design it out.
- **Merging inside one record.** Different question, see *Is this a CRDT?*

---

## Gotchas

- **Never cache single records from the store.** The segment is the unit you
  fetch. Fetching per record brings back the request flood this block exists
  to avoid.
- **Flush on shutdown.** An open batch lives in memory. It's also in the local
  store, so nothing is lost, but it reaches the store only on the next start.
- **Order by the version rule, never by a file's time.** The counter in a
  segment name is for humans. Services report modified times differently, and
  clocks disagree.
- **Listing is eventually consistent everywhere.** Trust your own writes over
  the listing. A segment you just wrote may not appear yet, and that must not
  look like a delete.
- **`Uint8Array` vs `Buffer`** in the directory driver on Node: normalise on
  the way out.
