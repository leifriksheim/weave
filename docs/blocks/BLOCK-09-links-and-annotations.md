# BLOCK-09 — Links, and an annotation library agents can compose with

## What this delivers

One record can point at another, in a named role — a comment is *about* a
todo, a vote is *about* a poll, a reply *replies to* a comment — and anyone can
ask what points at a thing. Collections declare which links they have, so an
agent reading a space's catalogue sees not just what things look like but how
they connect. And five collections ship with the protocol — reactions,
comments, tags, attachments, references — so **every app gets them on every
other app's data without anyone agreeing on anything**.

This is the substrate the agent work builds on: an agent can find what is in a
space (`collections_list`), see how it connects (declared links), attach to
anything (`sys.*`), and follow links (`records_linked`).

---

## Before you start

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'supersedes' src/records/version.ts && \
grep -q 'CATALOG_COLLECTION' src/schema/collection-def.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — needs BLOCK-14 (record keys) and BLOCK-08 (the catalogue)"
```

**Needs BLOCK-14** — links point at record *keys*, which survive edits — and
**BLOCK-08**, for declaring links in a collection's definition. Both done.

---

## The design, and why it is not a graph

The thing every one of these apps needs is *"this record is about that one, in
a named role"*. The subject is always the record doing the pointing. That is a
link with a role, not a general graph — no triples, nobody has to think in RDF.

> **Strict nouns, polymorphic annotations.** A Kanban card is a Kanban card,
> not a generic Task — nouns declare exactly what they point at. A reaction
> attaches to anything — annotations declare `"*"`. That escape hatch is
> deliberate, visible and rare.

### The link

```ts
export interface Link {
  /** The role: 'about', 'in', 'replyTo' — lower camel case */
  readonly rel: string;
  /** The key of the record it points at, in the same space */
  readonly to: string;
}
```

- **Links point at keys, not versions** (BLOCK-14). A comment stays on a todo
  however many times the todo is ticked.
- **Links are part of the signed record.** An unsigned link is a link anyone
  could add to someone else's record.
- **At most 32 per record.** A record that points at more is a list, and should
  be one.
- **Changing a record's links is an edit** — a new version, like any other.
  `update` keeps the previous version's links unless given new ones.

### Where links live, and who can see them

| Space | Links are | So a relay or an always-on node without the key sees |
|---|---|---|
| **Public** | a signed field on the record, in the clear | everything, as it does the bodies |
| **Private** | sealed inside the encrypted body, with it | that records exist and how often they change — not what points at what |

The original version of this block kept links outside the body everywhere,
which would have let a relay count the comments on every item of a private
list and see who reacted to what. Private spaces seal them. The cost: an
always-on node without the key cannot answer "what points at this" — and it
never needs to; members can.

### The index is derived, and local

"What points at X" is answered from an index each node builds from the
records it holds — rebuilt when records change, never synced. The original
block synced it as a second tree; that would be derived data travelling
between peers, one more thing to disagree about, with nothing gained: any node
holding the records can build it. A link to a record not held here is kept
and indexed — you will routinely hold a reaction before its post.

### Declaring links

A collection definition (BLOCK-08) gains `links`:

```ts
export interface StoredCollection {
  // …name, schema, version, history…
  readonly links?: Readonly<Record<string, {
    /** Collections the target may be in, or '*' for any */
    readonly to: '*' | ReadonlyArray<string>;
    /** How many links of this role a record may have. Default 'many'. */
    readonly cardinality?: 'one' | 'many';
    readonly description?: string;
  }>>;
}
```

Checked the way schemas are (BLOCK-08): **refused on write, flagged on read,
never rejected during sync.** Whether a link's target is in an allowed
collection depends on whether a node holds the target yet — a check at sync
time would make nodes disagree forever. A link to a record not held here
passes; a link of an undeclared role, or to a record in a disallowed
collection, is reported in `issues`.

### The `sys.*` library

Built into every node, not published into spaces — so every node agrees on
them without anyone defining them, and apps and agents find them in
`collections_list` marked `builtIn`.

| Collection | Body | Links |
|---|---|---|
| `sys.reaction` | `{ emoji }` | `about → *` (one) |
| `sys.comment` | `{ text }` | `about → *` (one), `replyTo → sys.comment` (one) |
| `sys.tag` | `{ label }` | `about → *` (many) |
| `sys.attachment` | `{ name, mime, size?, url? }` | `about → *` (one) |
| `sys.reference` | `{ note? }` | `about → *` (one), `to → *` (one) |

**Do not let `sys.*` grow.** Five cover the annotation layer of nearly every
app. The sixth will be somebody's noun wearing a disguise.

---

## API

```ts
node.records.put(space, collection, body, { key?, links? })
node.records.update(space, key, body, { links? })     // links kept unless given
node.records.linked(space, key, { rel?, collection? }) → NodeRecord[]   // what points here
// NodeRecord gains: links: ReadonlyArray<Link>
```

Actions: `records_put` and `records_update` take `links`; `records_linked` is
new; `collections_define` takes `links`; `collections_list` includes the
`sys.*` library with its declared links, so an agent sees the space's map.

---

## Files

| File | Change |
|---|---|
| `src/types.ts` | `Link`; `links` on `Expression` / `UnsignedExpression` |
| `src/schema/expression.ts` | `createExpression` takes `links` |
| `src/records/links.ts` | **New.** `checkLinks` (shape), the `sys.*` library definitions |
| `src/records/version.ts` | The shape check covers links in the clear |
| `src/schema/collection-def.ts` | `links` in definitions, validated |
| `src/node/space-runtime.ts` | Links on write and read; sealing them in private spaces; the index; `linked`; link issues |
| `src/node/node.ts`, `types.ts`, `actions.ts` | API above |
| `example/` | Reactions on todos — a count, and your own to toggle |
| `tests/links.test.ts` | **New** |

---

## Testing

- A link is part of the signature: changing it invalidates the record
- `linked(todo, { rel: 'about' })` returns the reactions on it; editing the todo
  keeps them attached (same key)
- A reaction arriving before its target is kept, and appears once the target does
- An undeclared role, or a target in a disallowed collection, is refused on
  write and flagged on read — and never rejected during sync
- In a private space, links are not visible in the stored record without the key
- An app that knows nothing about todos lists and renders reactions on them
- The index follows deletes: a deleted reaction stops being returned
- `collections_list` shows the `sys.*` library with its links

## Acceptance criteria

- [ ] React to a todo; the reaction is an ordinary signed record in `sys.reaction`
- [ ] `linked(todoKey, { rel: 'about' })` returns it, before and after the todo is ticked
- [ ] A second app that knows nothing of todos can list and render reactions on them
- [ ] A reaction arriving before its target is kept, not rejected
- [ ] Private spaces keep links sealed
- [ ] Example verified in two browsers: react, see the count on the other side
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

- **"One reaction per person."** Cardinality across *records* — one per author
  per target — is a fold at read time, BLOCK-11. `cardinality` here is per
  record: how many links of one role a single record carries.
- **Multi-hop traversal and `include`.** One hop from a node you hold covers
  these apps. Nested includes are BLOCK-10.
- **Cross-space links.** A key names a record in *this* space. Resolving one
  into another space needs a fetching story; left undefined rather than
  half-working.
- **Attachments' bytes.** `sys.attachment` describes a file; storing blobs is
  BLOCK-03/04's.

## Gotchas

- **Referential integrity has to be soft.** A link to a record not held here is
  normal. A check that rejects it drops half the annotations on a slow sync.
- **The index is a cache.** Throw it away and rebuild it from the records; never
  treat it as the source of truth.
- **`rel` names are forever.** Changing `about` to `on` orphans every existing
  link. Choose them like field names in a public API.
