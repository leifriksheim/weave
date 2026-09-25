# BLOCK-19 — Compatible definitions: apps trust what a collection promises, not its name

## What this delivers

Today an app decides it can open a space by checking that a collection with
the right **name** exists. Chat opens any `std.message`, whatever its fields
are and whoever its rules let edit it. And a space whose definition is a
little older than the app's (a Message without the `shares` link) stays that
way for good, so `/poll` quietly doesn't show up in Chat.

After this block:

1. **An app checks what it relies on.** Chat opens a space's `std.message`
   only if its messages have a `text` it can read, the links Chat uses, and
   rules no looser than Chat assumes. If not, it says why, in plain words:
   *"Anyone can edit anyone's messages here; Chat assumes only their author."*
2. **Harmless updates happen by themselves.** Adding the `shares` link to an
   older Message is compatible in both directions, so Chat brings the space
   up to date without asking, and `/poll` appears.
3. **Anything else asks a person.** An update that loosens rules or drops a
   field is shown as exactly that, and stays a proposal until someone adds it,
   as BLOCK-18 does for apps.
4. **`std.*` means the standard thing.** A `std.message` that isn't compatible
   with the library's own can't be defined by this node, and apps treat one
   that arrives from elsewhere as not a message.

One function answers all four: `compare(held, wanted)`.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'const KEYWORDS = new Set' src/schema/collection-def.ts && \
grep -q 'export type Who' src/records/rules.ts && \
grep -q 'export async function useSchemas' src/schemas/index.ts && \
grep -q 'function differences' src/schemas/apps.ts && \
grep -q 'export function readiness' example/src/components/apps/index.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — the stored-schema keywords, rules, useSchemas, BLOCK-18's app review or the Apps tab is missing, or the project does not typecheck"
```

**Depends on** BLOCK-18 (`src/schemas/apps.ts`, where adding an app reviews
the definitions it needs). Nothing else.

---

## Borrowed, not invented

Every part of this has a well-known precedent. Weave's contribution is using
one check for all four jobs above.

| Part | Precedent | What we take |
|---|---|---|
| The question itself | Confluent Schema Registry's **compatibility modes** | *Backward*: the reader can read everything the writer writes. *Forward*: the writer only writes what the reader accepts. *Full*: both |
| The output | **oasdiff** (breaking changes between two OpenAPI versions) | A list of breaking changes, each a plain sentence. Empty means compatible |
| Fields | **JSON Schema subschema checking** (IBM's *jsonsubschema*, Atlassian's `json-schema-diff`) | "Does schema A accept only what B accepts?" Hard for full JSON Schema, small and exact for Weave's keyword set |
| Rules | **UCAN attenuation** | You may narrow what's allowed, never widen it |
| Later: translating instead of refusing | Ink & Switch's **Cambria** (lenses between schema versions) | Out of scope; see the end |

Standard Schema doesn't help here: it's a way to *run* a validator, and it
can't be looked inside to compare two of them. Stored definitions are JSON
Schema, so the comparison works on JSON Schema.

---

## The design

### `compare(held, wanted)`

A new `src/schema/compatible.ts`. `held` is the definition the space has;
`wanted` is the one the app was built with (for Chat, `message` from
`weave-protocol/schemas`).

```ts
interface Compatibility {
  /** Why the app might meet a record it can't read. Empty: it can read them all. */
  readonly read: ReadonlyArray<Break>;
  /** Why a record the app writes might not fit, or might be refused. Empty: it can write. */
  readonly write: ReadonlyArray<Break>;
}
interface Break {
  readonly path: string;     // 'schema.text', 'links.shares', 'rules.edit'
  readonly message: string;  // 'Anyone can edit anyone's messages here; this app assumes only their author'
}
```

An app that only shows records needs `read` to be empty. One that writes,
like Chat, needs both. Anything the checker can't decide is a break: saying
no when unsure is the safe default.

### Fields: the schema

*Reading* needs every body the space accepts to be one the app accepts
(held ⊆ wanted). *Writing* needs the reverse (wanted ⊆ held). With the
keywords stored schemas may use (`src/schema/collection-def.ts:114`), each
check is a walk over both schemas:

- `type`: the accepted types must be contained. `integer` is inside `number`.
- `required`: a field the reader relies on must be required on the other side.
- `minimum`/`maximum`, `minLength`/`maxLength`, `minItems`/`maxItems`: the
  ranges must be contained.
- `enum`, `const`, `oneOf: [{ const }]`: the sets of values must be contained.
- `properties` and `items`: recurse.
- `title`, `description` and `x-choicesFrom` don't change what's accepted, so
  they're ignored.

**Open question: extra fields.** Stored schemas allow unknown fields unless
they say `additionalProperties: false`. Taken literally, a space that has no
`mood` field accepts `{ mood: 5 }`, so an app that adds an optional
`mood: string` would count as unable to read it. Confluent's JSON Schema
support runs into the same thing and splits "open" and "closed" schemas.
Proposed rule: a field only one side mentions is ignored unless that side
requires it or closes the schema. Decide this before building.

### Links

- A link the app uses must be declared in the space.
- Where it may point must be contained: `['app.poll']` is inside `'*'`
  for reading, not for writing.
- `cardinality: 'one'` is inside `'many'`.
- Links the app doesn't know about are ignored when reading.

### Rules: never looser

Stricter rules are never a safety problem. At worst the app can't write, and
`useCan` already handles that when the app runs. So rules are only checked
one way: the space's rule must be an **attenuation** of what the app assumes.

- `create`, `edit`, `delete`: every "who" in the space's list must be covered
  by one in the app's. `member` covers everyone. `creator` and `can:<x>`
  cover themselves. Defaults count (`edit` defaults to `member`, `delete` to
  `edit`).
- `onePer`: the space must promise at least the uniqueness the app relies on.
  Fewer parts is a stronger promise: "one per person" implies "one per person
  per poll".
- `fixed`: the space must keep at least the fields the app expects to be fixed.
- `permissions`: a permission the app's rules name must be declared.

**Open question: rules only apply from now on** (`NodeCollection.rules`: "for
records created from now on"). A space that was loose last month and strict
today holds records written under the loose rules. Either the check looks at
every rule the definition has had, or apps accept that "compatible" describes
records written from now on. Probably the second, stated plainly.

### Using it

1. **Apps open by compatibility.** `readiness()` in
   `example/src/components/apps/index.ts` compares each of an app's `needs`
   against the space's definition instead of looking for the name. A
   collection that exists but isn't compatible shows its breaks in the Apps
   tab instead of opening.
2. **Harmless updates happen by themselves.** `useSchemas` (and BLOCK-18's
   `addApp`) currently skip any collection the space already has. Instead: if
   the library's definition is newer and `compare(held, library)` finds nothing
   in either direction *and* the rules are no looser, define it at the next
   version without asking. The `shares` link is exactly this case.
3. **Other updates ask a person.** BLOCK-18's `differences()` in
   `src/schemas/apps.ts` says "changes who may do what" without saying which
   way. Replace it with `compare`'s breaks, so the review reads *"lets anyone
   edit messages (now only their author)"*, not just "changes".
4. **`std.*` is guarded where it's cheap.** `define` refuses a `std.*`
   definition that isn't compatible with the library's own. Definitions also
   arrive by sync, and refusing things on arrival leaves peers disagreeing
   forever (the reason shape isn't checked on arrival either). So the real
   protection is point 1: an app that won't open an incompatible `std.message`.

---

## Later: `pattern` and `format`

Stored schemas leave out `pattern`, `format` and `$ref` on purpose. Every
device checks every record against the space's schema, possibly in apps
written in different languages. Regex dialects differ between languages,
`format` is optional in the JSON Schema spec, and a slow regex like
`^(a+)+$` in a schema could freeze every member's app.

Adding `pattern` later is straightforward:

- Accept only **I-Regexp (RFC 9485)**: the IETF's regex subset made to mean
  the same in every language, as JSONPath (RFC 9535) uses. No backreferences,
  no lookaround.
- Refuse nested repeats like `(a+)+` when a definition is published. Browsers'
  regex engines can still get stuck on them even in I-Regexp. The other
  option is a linear-time matcher, which would be a dependency.
- Allow only the `format`s with exact definitions: `date-time` (RFC 3339),
  `date`, `uri`. Not `email`.
- `compare` treats two patterns as compatible only if they're identical, until
  there's a reason to do better. Real containment between I-Regexps is
  possible because they're true regular expressions, but it isn't needed yet.

Older apps ignore keywords they don't know when validating, and records that
don't fit are still kept and synced, marked `conforms: false`. So a space
using `pattern` stays readable by an app that predates it. That app just
won't flag records that break the pattern.

## Not in this block

- **Translating between versions** (Cambria-style lenses), so an app can read
  a definition it isn't compatible with instead of refusing it.
- **Checking compatibility with `node.use(space, Poll)`** once typed handles
  exist (see "Typed collections" in the README). It's the same `compare`.
