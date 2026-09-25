# BLOCK-04 — Remote blob drivers: S3-compatible and Google Drive

## What this delivers

Two `BlobStore` implementations so a node can keep its durable data in storage
the user already pays for. S3 covers Cloudflare R2, Backblaze B2, Minio, Wasabi
and AWS itself for free. Google Drive is the consumer-facing one.

**Build S3 first, on its own.** It's what hosting needs (BLOCK-07 mirrors into
its own R2 bucket), and it's plain keys and PUT/GET/LIST, with no OAuth and no
app review. Drive is "your own storage", a later feature with harder token
rules; it fits best in the extension (BLOCK-17), where `chrome.identity` can
renew Google tokens in the background.

---

## Before you start

Paste this. It must print either `READY` or `READY — but create blob-store.ts first`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
npx tsc --noEmit >/dev/null 2>&1 && {
  test -f src/storage/blob-store.ts \
    && echo "READY" \
    || echo "READY — but create blob-store.ts first (full contents are in this document, Step 0)"
} || echo "NOT READY — the project does not typecheck"
```

**This block does not require BLOCK-03 to be finished.** It needs exactly one
small file from it, and that file is reproduced in full below. If you do both
blocks, the file is identical either way — no conflict.

What you *won't* have without BLOCK-03 is the mirror, so these drivers won't
be wired into anything yet. That's fine: they're independently testable against
the contract suite described below, and they're genuinely useful on their own.

---

## Step 0 — `src/storage/blob-store.ts`

If the file doesn't exist, create it with exactly this:

```ts
/**
 * @module blob-store
 * A dumb blob archive: anything that stores and retrieves opaque bytes by name.
 *
 * Deliberately narrower than StorageAdapter. Implementations are assumed to be
 * high-latency, eventually consistent, non-atomic and without batch support —
 * the packing layer above is what turns one into usable storage.
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

Four methods, and an optional fifth. Implement `changes` where the service
has a change feed (Drive `changes.list`); S3 lists.

---

## Files

| File | Change |
|---|---|
| `src/storage/blob-store.ts` | Create if absent (Step 0) |
| `src/storage/blob/s3.ts` | **New** |
| `src/storage/blob/gdrive.ts` | **New** |
| `src/storage/blob/retry.ts` | **New.** Shared backoff wrapper |
| `tests/helpers/blob-store-contract.ts` | **New.** One suite every driver must pass |
| `tests/blob-drivers.test.ts` | **New** |
| `src/index.ts` | Export the drivers |

---

## The S3 driver

The easy one. `list(prefix)` maps directly onto `ListObjectsV2` with a prefix,
which is exactly the semantics `BlobStore` was designed around.

```ts
export interface S3Config {
  readonly endpoint: string;       // https://<account>.r2.cloudflarestorage.com, etc.
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly prefix?: string;        // namespace within the bucket
}

export function createS3BlobStore(config: S3Config): BlobStore;
```

**Use [`aws4fetch`](https://github.com/mhart/aws4fetch) rather than the AWS SDK
or hand-written SigV4.** The SDK is enormous. Hand-writing SigV4 is the kind of
fiddly, easy-to-get-subtly-wrong code `docs/DEPENDENCIES.md` says not to write:
canonical request ordering, URI encoding rules and header normalisation all
differ in small ways between providers. `aws4fetch` is tiny, has no
dependencies, runs on `fetch` + `crypto.subtle` in browsers, Node and Bun, and
is widely used against R2 and B2. Add it to `docs/DEPENDENCIES.md` when it lands.

Notes:

- `list` paginates — honour `ContinuationToken`, don't stop at 1,000 keys
- A missing object is `404` → return `null`, not a throw
- R2 and B2 ignore `region` but require it in the signature; use `auto` for R2

---

## The Google Drive driver

The awkward one, for two reasons: Drive has no prefixes, only file names inside
folders, and it needs OAuth rather than static keys.

```ts
export interface DriveConfig {
  readonly folderId: string;           // app-created folder; everything lives here
  readonly getAccessToken: () => Promise<string>;   // caller owns refresh
}

export function createDriveBlobStore(config: DriveConfig): BlobStore;
```

### Name → fileId cache

Drive addresses files by opaque `fileId`, not by name. Every `get(key)` would
otherwise cost a lookup *and* a download — two round trips at 300 ms each.

Keep a `Map<string, string>` from blob key to fileId, populated by one
`files.list` over the folder on first use and updated on every `put`. Invalidate
on 404. This roughly halves request count, which matters directly against the
quota.

### Use the `drive.file` scope

`https://www.googleapis.com/auth/drive.file` grants access **only to files the
app itself created**. Two reasons this is the right choice:

1. Google's OAuth verification for it is far lighter than for full `drive` scope
2. The consent screen says "see and manage its own files" rather than "see all of
   your Google Drive files" — enormously less alarming, and honest

### Getting a token onto a headless node

Drive needs user OAuth; there's no static key. The flow:

1. The browser does the consent dance and receives a refresh token
2. The refresh token is handed to the node
3. The node exchanges it for access tokens as needed

`getAccessToken` is a callback precisely so this block doesn't have to own that.
BLOCK-07 builds the broker; until then, paste a refresh token into config by hand.

**Service accounts do not work.** A Drive service account has no storage quota of
its own — files it creates belong to nobody and count against nothing. It has to
be the user's own Drive, via their own OAuth grant.

---

## Shared retry behaviour

Both drivers need the same thing, so write it once in `blob/retry.ts`:

- Exponential backoff with jitter on `429` and `5xx`
- Honour `Retry-After` when present
- Cap total attempts; surface a typed error afterwards rather than retrying forever
- **Never retry a `delete` that returned 404** — it already succeeded

Drive's quota is roughly 1,000 requests per 100 seconds per user. Treat that as a
budget, not a limit to discover empirically.

---

## Testing

### The contract suite

`tests/helpers/blob-store-contract.ts` exports one function that takes a factory
and runs the same tests against any driver:

```ts
export function testBlobStoreContract(
  name: string,
  makeStore: () => Promise<{ store: BlobStore; cleanup: () => Promise<void> }>,
): void;
```

Cases:

- `put` then `get` round-trips bytes exactly, including empty and binary-heavy
- `get` of an absent key returns `null` (never throws)
- `delete` removes; a second `delete` of the same key is a no-op
- `list(prefix)` returns only matching keys, and returns `[]` rather than throwing
- `list` handles more than one page (write 1,200 blobs for S3)
- Keys with slashes, spaces and unicode survive a round trip
- A 1 MB blob round-trips unchanged

Run it against the memory driver (from BLOCK-03, or a five-line local one),
against `fs`, and against both remote drivers when credentials are present.

### Gating on credentials

Remote driver tests must **skip, not fail**, without credentials, so CI stays
green for contributors:

```ts
const hasS3 = !!process.env.WEAVE_TEST_S3_BUCKET;
describe('s3 blob store', { skip: !hasS3 ? 'no S3 credentials in env' : false }, () => { ... });
```

Document the env vars in the test file header.

---

## Acceptance criteria

- [ ] Both drivers pass the full contract suite
- [ ] S3 driver works against at least two providers (R2 and one other)
- [ ] Drive driver works with `drive.file` scope only
- [ ] Drive driver's name→fileId cache measurably reduces request count — assert it
- [ ] A 429 storm is survived via backoff without data loss
- [ ] Tests skip cleanly with no credentials configured
- [ ] The only new runtime dependency is `aws4fetch`, recorded in `docs/DEPENDENCIES.md`
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

- **The mirror** — BLOCK-03. These drivers are dumb byte stores.
- **OAuth token brokering and refresh-token storage** — BLOCK-07. `getAccessToken`
  is a callback so this block doesn't need to care.
- **Dropbox and OneDrive.** Both have an app-folder permission, the narrowest
  grant there is, and Dropbox hands browser apps long-lived refresh tokens.
  Once the contract suite exists each is an afternoon: do Dropbox next, with
  `list_folder/continue` and long polling as its `changes`. It's the first
  your-own-storage provider hosting supports, after R2.
- **iCloud, WebDAV.** iCloud has no usable web API for this; iCloud users keep
  a data folder on their Mac instead.

---

## Gotchas

- **Drive silently permits duplicate file names.** Two files can share a name in
  one folder, and `files.list` will return both. Always `files.update` an
  existing fileId rather than creating, or you'll accumulate shadow copies that
  make reads non-deterministic.
- **Drive's `files.list` is eventually consistent.** A file written moments ago
  may not appear. This is exactly why the fileId cache exists — trust your own
  writes over the listing.
- **S3 `list` is lexicographic and paginated; Drive's is neither.** The contract
  suite must not assume ordering. If the packing layer ever needs sorted keys, it
  sorts them itself.
- **Don't log the access token or the signed URL.** Both are credentials. The
  retry wrapper is the easiest place to leak them by accident.
- **Bun and Node differ on `fetch` body types for binary uploads.** Pass a
  `Uint8Array` directly and test on both — a `Blob` works in one and not always
  the other.
