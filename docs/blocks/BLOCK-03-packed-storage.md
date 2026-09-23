# BLOCK-03 — BlobStore, PackedAdapter and garbage collection

## What this delivers

A `StorageAdapter` that keeps a fast local tier and writes durable, encrypted,
append-only **pack segments** to any high-latency blob store. Plus the garbage
collection the MST needs to stop growing forever.

This is the block that makes "store your data in a service you already pay for"
real, and the one the cheap-VPS story depends on — if durable data lives in the
user's own storage, the hosted node holds nothing and can be thrown away and
redeployed at will.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'readonly height: number' src/storage/mst.ts && \
node --import tsx --test tests/mst.test.ts >/dev/null 2>&1 && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — the MST rewrite is missing, its tests fail, or the project does not typecheck"
```

**If it prints NOT READY:** this block is built on the MST rewrite. Before it, a
single insert at N = 10,000 rewrote an 810 KB node — you would be uploading that
to Google Drive on every keystroke, and no caching layer fixes an O(N) write.
Check `MSTNode` in `src/storage/mst.ts` has a `height` field.

**Depends on no other block.** Free to start.

---

## Background

### Why Drive can't be a `StorageAdapter` directly

`src/storage/mst.ts` calls `adapter.get(cid)` once per node on every tree walk.
Google Drive is ~200–500 ms per API call with roughly a 1,000-requests-per-100s
quota. A naive adapter would make a single sync take minutes and exhaust the
quota before lunch.

So Drive isn't a key-value store — it's a **blob archive**. Treat it as one.

### The numbers you're designing against

After the MST rewrite, measured at N = 10,000:

- **4.4 KB written per insert**, spread across ~4 small immutable nodes
- Root node is **235 B**, constant at every N
- **~4 orphaned nodes per insert** — 41,949 stored nodes for 10,000 inserts

That first number is why packing works: small immutable content-addressed nodes
batch into segments beautifully. The third is why this block also owns GC.

---

## Design

### Tier it

```
   writes ──> hot: StorageAdapter (SQLite / memory / IndexedDB)   ← every read hits here first
          └─> open segment (in memory)
                   │ flush on size or age
                   ▼
              encrypt ──> cold: BlobStore (Drive / S3 / fs)
                   │
                   └─> new signed manifest
```

**Write:** straight to `hot`, and append to an open in-memory segment. Flush when
the segment exceeds `flushBytes` or `flushMs`, whichever comes first.

**Read:** `hot` → miss → consult manifest index → fetch **the whole segment**
(segments are the cache unit, never individual keys) → decrypt → populate `hot`.

**Manifest:** the tree's entry point.

```ts
interface PackManifest {
  readonly generation: number;      // strictly monotonic
  readonly root: string | null;     // current MST root CID
  readonly segments: ReadonlyArray<{
    readonly id: string;
    readonly keyIndex: ReadonlyArray<string>;   // which CIDs live in this segment
  }>;
  readonly createdAt: string;
  readonly signature: string;       // signed by the node's key
}
```

Written to `manifest.json`, and also to `manifest-<generation>.json` so history
is inspectable and rollback is detectable.

### Why an untrusted store is safe

Expressions and MST nodes are content-addressed and signed, so the remote store
**cannot forge anything** — `src/validation/crypto-gate.ts` catches it. With
`spaceKey` set, segments are encrypted with AES-GCM before upload (reuse
`src/privacy/space-encryption.ts`), so the store can't read them either.

The one genuine attack is **withholding or rollback**: serving a stale manifest.
Defend by persisting the last-seen `generation` locally and refusing anything
lower. A lower generation is an error, not a silent accept.

Encrypt the manifest body too, or hash the CIDs in `keyIndex` — otherwise the
store learns your tree's shape and size even though it can't read the contents.

### Garbage collection

Every insert orphans ~4 nodes. Without collection, storage grows without bound
even though the tree itself doesn't.

Mark and sweep from the current root:

1. Walk the live set from `manifest.root`, collecting reachable CIDs.
2. Anything in a segment and not reachable is garbage.
3. When a segment falls below `compactThreshold` live bytes, rewrite its live
   nodes into a fresh segment, bump `generation`, drop the old segment.

**`src/storage/mst.ts` has a private `collectCids` function that does step 1
exactly.** Export it as `collectReachableCids` rather than writing a second
traversal that can drift out of sync with the tree format.

Never delete a segment still referenced by a manifest generation you might roll
back to. Keep the last few generations.

---

## Files

| File | Change |
|---|---|
| `src/storage/blob-store.ts` | **New.** The interface (below) |
| `src/storage/packed-adapter.ts` | **New.** The tiering, manifest, GC |
| `src/storage/blob/memory.ts` | **New.** In-memory driver, for tests |
| `src/storage/blob/fs.ts` | **New.** Local-filesystem driver |
| `src/storage/mst.ts` | Export `collectCids` as `collectReachableCids` |
| `src/index.ts` | Export the new surface |
| `tests/helpers/latency-blob-store.ts` | **New.** The fixture that matters most |
| `tests/packed-adapter.test.ts` | **New** |

### `src/storage/blob-store.ts`

Deliberately narrower than `StorageAdapter`. Assume high latency, eventual
consistency, no atomicity, no batch.

```ts
/**
 * A dumb blob archive. Anything that can store and retrieve opaque bytes by
 * name can be one: S3, R2, Backblaze, Google Drive, Dropbox, WebDAV, a folder.
 */
export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
```

Four methods. That's the whole point — **the real artifact of this block is the
packing layer, not any one integration.** Once `PackedAdapter` exists, a new
backend is ~40 lines (see BLOCK-04).

### `createPackedAdapter`

```ts
export interface PackedAdapterConfig {
  readonly hot: StorageAdapter;
  readonly cold: BlobStore;
  readonly spaceKey?: SpaceKey;          // from src/privacy/space-encryption.js
  readonly signingKey?: CryptoKey;       // signs the manifest
  readonly flushBytes?: number;          // default 256 * 1024
  readonly flushMs?: number;             // default 5000
  readonly compactThreshold?: number;    // live-byte ratio below which a segment is rewritten, default 0.5
}

export function createPackedAdapter(config: PackedAdapterConfig): Promise<StorageAdapter & {
  flush(): Promise<void>;
  compact(): Promise<void>;
  generation(): number;
}>;
```

---

## Steps

1. Write `blob-store.ts` and `blob/memory.ts`. Ten minutes, and everything else
   can be tested against them.
2. Write `tests/helpers/latency-blob-store.ts` **before** the adapter — see
   below. Building the adapter without it means discovering the latency bugs in
   production against someone's real Drive.
3. Export `collectReachableCids` from `mst.ts`.
4. Implement the write path: hot write, segment append, flush on threshold.
5. Implement the manifest: write, sign, read back, verify, monotonic generation
   check.
6. Implement the read path: hot → manifest lookup → whole-segment fetch →
   decrypt → populate hot.
7. Implement `compact()` — mark from root, sweep, rewrite sparse segments.
8. Implement `blob/fs.ts`. It's a real durable backend and the easiest way to
   run the daemon before any cloud driver exists.
9. Run the **acceptance test** below: the full existing sync suite against a
   packed adapter behind 300 ms of simulated latency.

---

## Testing

### The fixture that matters

`tests/helpers/latency-blob-store.ts` wraps any `BlobStore` and injects:

- configurable per-call delay (default 300 ms, Drive-like)
- random 429s at a configurable rate
- stale reads — occasionally return a previous value, to model eventual
  consistency
- a **call counter**, so tests can assert on request budget

Every `PackedAdapter` test runs behind it. This is how you validate Drive
behaviour without touching Drive, and it's what will catch the quota bugs.

### Tests

- Write N expressions, read them all back — with `hot` cleared between, forcing
  cold reads
- Segments flush on byte threshold, and on time threshold
- A read that misses `hot` fetches exactly **one** segment, not one blob per key
- Manifest round-trips, signature verifies, a tampered manifest is rejected
- **A manifest with a lower `generation` than last seen is rejected** (rollback)
- Encrypted segments are unreadable without the key, readable with it
- `compact()` reclaims orphaned nodes: assert stored bytes drop after inserting
  and deleting a few thousand entries
- `compact()` never drops a reachable node — walk the tree afterwards and confirm
  every key still resolves
- Under a 429 storm the adapter retries with backoff and still converges

### Acceptance test

Run the existing `tests/sync.test.ts` suite with both peers on
`createPackedAdapter({ hot: memory, cold: latency(memory, 300) })`. It must pass
in reasonable wall-clock, and the logged request count must stay inside Drive's
1,000-per-100s budget.

---

## Acceptance criteria

- [ ] Full existing test suite passes with a `PackedAdapter` substituted in
- [ ] A cold read of one key fetches one segment, not one blob per node
- [ ] Request count for a 1,000-expression sync stays under Drive's quota
- [ ] `compact()` measurably reduces stored bytes after churn
- [ ] Every key still resolves after compaction
- [ ] A rolled-back manifest is detected and refused
- [ ] Encrypted segments are opaque without the space key
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

- **Google Drive and S3 drivers** — BLOCK-04. Build the packing layer first and
  those become small.
- **Multi-tenant credential storage** — BLOCK-07.
- **Changing the MST or the sync protocol.** If you find yourself editing
  `src/sync/`, stop: that's BLOCK-01.

---

## Gotchas

- **Don't cache individual keys from cold storage.** The segment is the unit. A
  per-key cache re-creates exactly the request-amplification problem this block
  exists to solve.
- **The manifest is a single point of contention.** Two writers against one blob
  store will clobber each other's manifests — there's no compare-and-swap in the
  `BlobStore` interface. For now, document that one node owns one store. If you
  need multi-writer later, that's a lease or a CAS primitive, and it's a design
  decision, not an implementation detail.
- **`keyIndex` grows.** Full CID lists in the manifest are fine up to roughly
  100k keys. Past that, move to per-segment index blobs plus a bloom filter in
  the manifest. Don't build that now, but don't design it out either.
- **Flush on shutdown.** An open segment lives in memory. The daemon must call
  `flush()` on SIGTERM or the last few seconds of writes vanish. They're still in
  `hot`, so it's recoverable, but only if `hot` is durable.
- **`Uint8Array` vs `Buffer` in the fs driver.** Node's `readFile` gives a
  `Buffer`, which is a `Uint8Array` subclass and mostly works — until something
  checks `constructor.name` or serializes it. Normalize on the way out.
- **Clock skew has no role here.** Order by `generation`, never by `createdAt`.
  The timestamp is for humans reading the manifest.
