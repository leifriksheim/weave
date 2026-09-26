# BLOCK-24 — Names: a handle that leads to a door

> **Status (2026-09-26):** doors are built (`src/doors/`, `node.doors`, the
> relay mailbox; spec in `docs/spec/07-doors.md`). This block is what comes
> next: pasting `@anna.example` instead of a door code.

## What this delivers

Someone sends you their handle on WhatsApp, `@anna.bsky.social`, and you paste
it into any Weave app. The app finds Anna's door from the handle, you knock,
and Anna sees:

> **@leif.bsky.social** wants to connect · you follow him · 4 mutuals

When this is done:

- a person can **link a handle** to a door once, at their account home;
- any app can **resolve a handle** to a door code, and knock;
- a knock can carry the knocker's handle, **checked** by the door's owner;
- a door can ask for knocks only from **people it follows** (on the handle's
  network), as a filter against spam.

## The idea: a name is a pointer to a door, never the identity

Three things stay apart ([07 — Doors](../spec/07-doors.md)):

- **Identity**: the seed and its DID. Never public by default.
- **Name**: a handle, borrowed from a naming system that already works: ATProto
  handles (domains, checked both ways against a DID).
- **Door**: a key and relays that accept knocks, which can be closed and replaced.

A handle resolves to a door. It never resolves to the account DID: that would
link everything the account ever signed to the handle.

ATProto is used **only to publish one record**, never to sign in to Weave. Its
signing keys usually live with the PDS, which is the opposite of "the seed is
the account".

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'export function parseDoorCode' src/doors/doors.ts && \
grep -q 'export async function openKnock' src/doors/doors.ts && \
grep -q "handleMail" server/relay.mjs && \
grep -q 'readonly doors: NodeDoors' src/node/types.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — doors are not where this block expects, or the project does not typecheck"
```

**Depends on:** doors (built). Part 1 needs nothing else. Part 3 needs the account home.

## Part 1 — Resolving a handle to a door (read only, no sign-in)

1. **Handle → DID.** Standard ATProto resolution: DNS TXT `_atproto.<handle>`
   (`did=did:plc:…`), else `https://<handle>/.well-known/atproto-did`. Browsers
   can't read TXT records: use the HTTPS path, then a DNS-over-HTTPS resolver as
   a fallback, configurable. Check the DID document's `alsoKnownAs` names the
   handle back (both ways, as ATProto requires).
2. **DID → PDS.** From the DID document's `AtprotoPersonalDataServer` service.
   `did:plc` resolves through the PLC directory; `did:web` through the domain.
3. **PDS → door record.** `com.atproto.repo.getRecord` for collection
   `org.weaveprotocol.door`, record key `self`:

   ```json
   { "$type": "org.weaveprotocol.door", "code": "<door code>", "createdAt": "…" }
   ```

   The record sits in a signed repository, so it is the handle owner's word.
   Nothing more is needed: the code already carries the key and relays.
4. `node.doors.resolve('@anna.bsky.social') → { code, handle, did }`, and
   `node.doors.knock('@anna.bsky.social')` accepting a handle wherever it takes a code.

Tests: a fake PDS and DoH server in-process; resolution both ways; a handle
whose DID document doesn't name it back is refused; a missing record says
"This handle has no Weave door".

## Part 2 — A checked handle on a knock

A knock (07 §6) gains an optional `handle` field. The owner checks it: resolve
the handle (Part 1), read the knocker's **own** door record, and compare the
door key there with a `handleProof`: the knocker's signature, with the key of
**their** door, over `weave/knock-handle/v1|<door knocked on>|<knock at>`.

That proves the knocker controls both the handle's repository (the record is
there) and the door key (the signature), without putting their account DID in
public. Needs door keys that can sign: derive a separate **door signing key**
next to the door key (`weave/p256-door-sign-key/v1|<id>`), and publish its
public half in the code as `sign`. A door key MUST NOT both sign and decrypt.

Shown as "@leif.bsky.social ✓" when it checks out, and as the plain name
otherwise.

## Part 3 — Linking a handle (the account home)

1. ATProto OAuth (PAR, PKCE, DPoP), asking only for write access to
   `org.weaveprotocol.door`. Lives in the account home only, since it is the
   heavy part, and the home holds the contact key the door comes from.
2. The home opens a door (or picks one) and writes the record. Unlinking
   deletes the record; rotating writes a new door's code into it.
3. The account registry remembers which door a handle points at, so every
   device shows "Your handle @anna.bsky.social leads to this door".

## Part 4 — Who may knock

A door gains a policy, kept in its `std.door` record (never published):
`anyone` (default), `follows` (accounts the owner follows on the handle's
network), `mutuals`. Follows are `app.bsky.graph.follow` records in the
owner's own repository, read from their PDS: no AppView needed. Knocks that
don't match the policy are kept but shown under "Others".

## Where it comes from

| Part | Borrowed from |
|---|---|
| Handles as domains, checked both ways | ATProto handle resolution |
| A signed record pointing elsewhere | Keybase proofs; ATProto's own `alsoKnownAs` |
| Names that are optional aliases over keys | Signal usernames, SimpleX contact addresses |
| The social graph as a spam filter | Email allowlists; Bluesky's "follows only" DMs |

## Risks and trade-offs

- **Dependencies, for discovery only.** The PLC directory, a DoH resolver, and
  `bsky.social` owning its subdomains. Contacts already made are Weave spaces
  and survive all of them going away. A custom-domain handle removes the
  subdomain one.
- **Public fact.** A door record says "this handle uses Weave". Opt-in.
- **Pluggable.** A second name provider should follow: plain DNS,
  `_weave.<domain>` TXT holding a door code, for people with a domain and no
  ATProto account.
