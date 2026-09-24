# BLOCK-15 — Spaces and roles

## What this delivers

One permission system, made of a few plain parts, in place of today's mix of
space types, a fixed owner, a write secret and a per-collection "definer".
When this block is done:

- there is **one kind of space**. "Personal" is a space where nobody else was
  invited;
- the creator starts at the top and can **hand over and leave**. The people
  they handed over to keep running the space;
- each space has its **own roles**, with permissions an admin chooses;
- apps write under the account's note and **never hold a write secret**, and
  pressing Disconnect in the account home stops their writes;
- **removing someone stops their writes**, even if they put old dates on new
  records. Stopping their reads is still BLOCK-14 §2;
- invite links are **one per role, and each can be closed** on its own.

The protocol takes no position on what roles a space should have. The
defaults are presets: plain data an app may use or ignore.

This replaces the earlier BLOCK-15 draft (member cards and cancel records)
and does the write half of BLOCK-14 §2.

## Status (2026-09-24, branch `spaces-and-roles`)

**Built:** parts 1–7, except the home's screens for members and roles. One
kind of space (genesis v2), rules naming facts or `can:<permission>`, the four
access collections with the rank rule, the access history (`space/roles.ts`)
and its replay, keep lists, `sys.revoke`, invites per role, read-only grants
and a Disconnect that revokes, presets, and the node API (`access`,
`setMember`, `putRole`, `removeRole`, `closeInvite`, `revoke`) with actions for
agents. `tests/roles.test.ts` pins the replay; `tests/space-access.test.ts`
covers it through real nodes.

**Left:** the home's screens — members and their roles, editing roles, invite
links per role, hand over and leave. And BLOCK-14 §1: a version that stops
counting falls back to the one before it only where the store kept one.

**Decided while building:**

- Roles, members, invites and revokes are stored **in the clear**, even in a
  private space, so a peer without the key — a relay, a host — still judges
  writes. Definitions stay sealed.
- **Joining waits for the first sync.** A joiner's member record counts once
  the invite's own record reaches them. Carrying that record in the link
  would let a joiner name a point in history before every definition, and
  dodge every rule.
- **Access changes are always stored** once what they saw is here and their
  author is someone the history has heard of, whatever the replay decides.
  Whether a change counts can flip as others arrive; whether it is stored
  must not.
- **Order among changes follows the strongest take-away each leads to**, not
  only the change itself: a removal that also saw something not yet placed
  must still beat a change it had not seen. Found by a flaky test; pinned in
  `tests/roles.test.ts`.
- `closeInvite` takes the link itself.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'export function grantCapabilities' src/session/connect.ts && \
grep -q 'createSpaceGate' src/node/space-runtime.ts && \
grep -q 'isTrustedRoot' src/validation/capability-gate.ts && \
grep -q "CATALOG_COLLECTION = 'sys.collection'" src/schema/collection-def.ts && \
node --experimental-vm-modules --import tsx --test tests/connect.test.ts tests/attacks.test.ts >/dev/null 2>&1 && \
echo READY || echo "NOT READY — the account home connect flow or the collection catalogue is missing"
```

**Depends on** BLOCK-14 §1 (versions whose history can be checked). Taking
access back can make a stored version stop counting, and the version before it
has to still be there to take its place.

Each part says which attack it closes. Add those to `tests/attacks.test.ts`,
failing before and passing after.

---

## The whole model on one page

Three questions decide every write, each with its own mechanism:

1. **Who is really writing?** A **note** (UCAN): "this key speaks for this
   account." That's all notes are for.
2. **What standing does that account have in this space?** Its **role**.
3. **Does this action on this record allow that?** The collection's **rules**.

And one chain connects them:

**records → collection rules → a fact about the record, or a permission →
roles → members**

- A **rule** is written by the app, in the collection definition. It names
  either a *fact* anyone can check from the records ("the creator"), or a
  *permission* ("`can:moderate`").
- A **role** is written by the space's admins: a name, a rank, and the
  permissions it holds.
- A **member** record says which role an account holds.

The test for which side something belongs on: *did a person have to decide it?*
"The creator of a poll may edit it" follows from the data, so it's a rule.
"Bob is a moderator" was decided by someone, so it's a role.

| Today | After |
|---|---|
| Personal and shared spaces | One kind of space |
| An owner, fixed forever | The top role, which can be handed over |
| A write secret; every record countersigned | Member records; the secret is gone |
| One write secret per space, forever | Invite links, one per role, each deletable |
| Rules name `member`, `owner`, `creator` | Rules name `member`, `creator`, `can:<permission>` |
| A collection's "definer" (`definedBy`) | The creator of its definition record, and the `define` permission |
| No way to take access back | Deleting an access record, with a keep list |

---

## 1. One kind of space

The genesis, whose hash is the space id, becomes:

```ts
interface SpaceGenesis {
  readonly v: 2;
  readonly creator: string;            // an account DID
  readonly visibility: 'private' | 'public';
  readonly readKey?: string;           // private spaces: public half, as today
  readonly roles: ReadonlyArray<Role>; // the starting roles (part 3)
  readonly creatorRole: string;        // which of them the creator holds
  readonly createdAt: string;
  readonly nonce: string;
}
```

Gone: `owner`, `type` and `writeKey`. The starting roles are the first version
of each role record, and the creator's role is the first version of their
member record. From then on, they are ordinary records.

The account registry and the BLOCK-16 contacts space are ordinary spaces whose
creator never invites anyone.

**What goes.** `Space['type']` and every `'personal'`/`'shared'` branch (14
places in `src/`, plus a few screens in the example). `writeSecret`,
`generateWriteSecret`, `deriveWriteKey`, countersigning, `spaceSignature` and
`createSpaceGate`. A space is writable by you if your account holds a role
there.

## 2. Rules name facts or permissions

`records/rules.ts` changes one type:

```ts
type Who = 'member' | 'creator' | `can:${string}`;
```

- `member`: anyone holding any role in the space.
- `creator`: whoever wrote the record's first version. A fact, never assigned.
- `can:<permission>`: anyone whose role holds that permission.

`owner` goes. Where a rule said `owner`, a preset now gives the top role a
permission, and the rule names that permission.

**Permissions belong to a collection.** A definition declares the ones its
rules use:

```ts
{
  name: 'app.poll',
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
}
```

Inside `app.poll`'s rules, `can:moderate` means `app.poll/moderate`. That's
the name a role holds. A rule may only name permissions its own definition
declares. Two apps in one space never clash, and a space can let someone
moderate polls but not comments.

**Where the code splits.** `records/rules.ts` knows records and facts. It asks
one question elsewhere: *does this account hold this permission here?*
`space/roles.ts` answers it, and knows nothing about polls.

## 3. Roles, members and invites

Four reserved collections. Each is an ordinary collection with ordinary
rules. The only difference is that the protocol fixes those rules, and each
one just names a permission. Who holds the permission is still up to the space.

| Collection | Key | Body | Needs |
|---|---|---|---|
| `sys.role` | `role:<name>` | `{ name, rank, permissions }` | `can:manage` |
| `sys.member` | `member:<did>` | `{ did, role }` | `can:manage`, or an invite (below) |
| `sys.invite` | `invite:<public key>` | `{ key, role, label? }` | `can:invite` |
| `sys.collection` | `collection:<name>` | the definition, as today | `can:define` |

So the protocol knows exactly **three permissions of its own**: `manage`,
`invite` and `define`. Everything else is an app's word.

A role's permissions are strings, matched exactly or with a `*` for one
segment: `app.forum.*/moderate` covers every forum collection's `moderate`.
Plain string matching, nothing more.

### The one built-in check: rank

Rules can't compare two people, so rank is checked separately. It's the only
check the rules language doesn't express.

- You may add, change or remove people and roles **ranked below you**.
- You may give out roles **up to your own rank**, directly or as an invite.
- You may not give a role a permission you don't hold.
- You may always **remove yourself**.

As a result, two people at the same rank can never remove each other, so
the worst conflict can't happen. **Handing over:** give someone your role,
then remove yourself. The home only offers "leave" to the last person at the
top after they've handed over. If two last admins leave at the same moment,
the space has no admin, and we accept that.

### Invites

An invite link carries a random secret (and, for a private space, the read
key, as today). Its record holds only the secret's public half and a role.
Joining means writing your own member record, signed under your own note, with
a second signature by the invite's secret over `space id | your DID`. That
second signature is the one remaining use of a countersignature, and it's
checked only on member records.

Links are shown once, like a new password, and stored nowhere: not in the
registry, and not by the home. The person who joins doesn't need the secret
again, because they have a member record. Deleting the invite record closes
the link (part 5).

A **view-only** link carries the read key and no invite secret at all. That's
reading without a role.

## 4. The access history

This is the hard part, and the only genuinely new mechanism.

**The problem.** Nobody decides the order things happen in. Alice removes Bob
while Bob, not yet knowing, bans Carol. Every peer has to reach the same answer
on its own.

**The shape.** Versions of `sys.role`, `sys.member`, `sys.invite` and
`sys.revoke` (part 5) together form the space's **access history**. Each one
carries `seen`: the ids of the latest access changes its author knew about,
usually one. That makes the history a small graph that anyone can replay.

**Replaying it.** It comes down to one function in `space/roles.ts`, the same
on every peer:

1. A change comes after everything it saw.
2. Changes that didn't see each other are ordered by **removals and demotions
   first**, then **higher author rank first**, then lower id.
3. Replay in that order. A change whose author doesn't have the power at its
   turn is dropped.

This is the idea behind Matrix's "state resolution", simplified to what we
need. Matrix rooms face the same problem: no referee, and servers that
disagree for a while.

**Ordinary records carry `seen` too.** A poll is judged by its author's role
*as of what it saw*. So a moderator's deletions stay valid after they stop
being a moderator. Part 5 covers the one thing this opens up: pointing
`seen` at the past on purpose.

A record whose `seen` names changes a peer doesn't have yet waits, like a
record waiting for its first version (the sync engine's waiting list). The
limits on that list in BLOCK-14 §6 matter more now.

**Verdicts are no longer permanent.** Today a verdict on a version is cached
forever (`space-runtime.ts`, `verdicts`). With this block, a later removal can
turn a valid record invalid. Key the cache by the access history's current
heads as well, or clear it when the history changes.

**Tests.** Build the three classic conflicts as two offline nodes that sync
afterwards: mutual removal at the same rank (impossible), removal against a
concurrent ban (the removal wins and the ban is dropped), and two admins
leaving at once (no admin, same on both). Every peer, in any arrival order,
reaches the same state.

## 5. Taking access back

**Deleting** an access record takes access back: a member, an invite, a role.
The deletion carries a **keep list**: the ids of records that relied on the
thing being taken away and that the remover had seen.

```ts
{ deleted: true, keep: ['<version id>', …] }
```

From then on, a record that relied on it **and doesn't have the deletion in
its `seen`** is refused unless it's in `keep`. That closes the old-dates
problem in every form:

- a removed member writing records that claim an old `seen`;
- a demoted moderator doing the same with moderator powers;
- someone joining through a closed invite, claiming they joined earlier.

Dates play no part. The cost: an honest offline write that hadn't synced when
access was taken away is lost. When access is being taken away, that's the
right trade.

Applied where a record is **read**, too, next to `consistent()`. A version
that stops counting stops being current, and the one before it counts again.
This is why BLOCK-14 §1 comes first.

### App notes

An app's note isn't a record in the space, so it can't be deleted. It gets
one more reserved collection instead, part of the access history:

| `sys.revoke` | `revoke:<note cid>` | `{ note, keep }` | the account the note is from |

The home writes one into each space the app could write in when the person
presses Disconnect.

`keep` is a plain list with a cap. A member removed after years of writing
might need thousands of ids. If the cap is ever reached, it can become a hash
of a sorted list with the list carried separately.

**Tests.** A removed member's record claiming an old `seen` is refused on a
peer that never saw it. The same record listed in `keep` still reads. A
demoted moderator's old deletions stay, and new ones claiming an old `seen`
are refused. A joiner through a deleted invite who isn't in `keep` is
refused. An app, after Disconnect, can't write, whatever date or `seen` it
claims.

## 6. Apps and the account home

- `auth.grant()` hands out **read-only invites** (the read key, for private
  spaces, and no invite secret). Write access comes from the note alone, as
  `grantCapabilities` already shapes it. An app writes under the account's
  member record.
- `auth.disconnect(origin)` writes a `sys.revoke`, with `keep` set to that
  app key's records the home can see, into each space the note covered. For a
  whole-account app, that's every space the account can write in.
- The registry stores no invite secrets. Nothing a whole-account app can open
  lets it add members.
- The Settings text says what's true: writes stop as soon as peers hear of it,
  and anything the app could already read stays readable to it.
- The home gets the screens: members and their roles, editing roles,
  invite links per role, hand over and leave.

## 7. Presets, outside the protocol

Plain data in their own module, like `weave-protocol/schemas`:

```ts
roles.presets.solo       // Owner (100: manage, invite, define, every app permission)
roles.presets.team       // Owner (100) · Editor (10: invite, define) · Viewer (use a view-only link)
roles.presets.community  // Admin (100) · Moderator (50: every app permission) · Member (0)
```

"Every app permission" is filled in when the space is created from the
collections it starts with. A preset is only the starting `roles` in the
genesis. The protocol never looks at a preset's name.

---

## What changes where

| File | Change |
|---|---|
| `space/space-access.ts` | Genesis v2; the write secret, write key and countersigning go; the invite signature on member records comes in |
| `space/roles.ts` (new) | Role, member, invite and revoke records; the rank check; replaying the access history; "does this account hold this permission here?" |
| `records/rules.ts` | `Who` becomes `member \| creator \| can:<permission>`; permissions are declared per collection |
| `schema/collection-def.ts` | `permissions` on a definition |
| `validation/space-gate.ts` | Removed |
| `validation/capability-gate.ts` | A root must hold a role here; `sys.revoke` checked; the keep lists applied |
| `node/space-runtime.ts` | `seen` on every write; `definedBy` becomes the definition's creator plus `can:define`; the verdict cache keyed by the access history; `consistent()` hides records that no longer count |
| `sync/sync-engine.ts` | Records wait for the access changes their `seen` names |
| `space/space-manager.ts`, `space/account-registry.ts`, `node/node.ts`, `types.ts` | No space types; no stored write or invite secrets; joining writes a member record |
| `session/auth.ts`, `home/` | Read-only invites in grants; revoke on Disconnect; the member and role screens |
| `example/` | The space list and invite screens lose "personal" and "shared" |

It's pre-release, so there's nothing to migrate: genesis v1 spaces don't need
to keep working.

## Decisions

1. **One role per member.** Rank stays a single comparison, and "what can Bob
   do" is one lookup. Custom roles cover the combinations. `role` can become a
   list later without touching the rest.
2. **Definitions are part of the access history, and records lose `def`.** A
   record is judged by the definition in force at its `seen`, not one it
   picks, which settles BLOCK-14 §5. Definition changes carry no keep list for
   now: dodging a just-tightened rule needs a member who had the right to
   write, and they can be removed.
3. **Ranks are numbers in the data, an order in the UI.** Inserting a role
   between two others changes one record, not every role below it. Equal
   numbers are equals.

## What is left out, on purpose

- **Taking away reading.** A role governs writing. Anyone who had the read key
  keeps it until the key changes for everyone, which is BLOCK-14 §2.
- **Roles that follow a person across spaces.** Each space has its own. An app
  can copy roles when it makes a new space.
- **Facts through links** ("the creator of the poll this vote is about may
  remove it"). A natural next rule, but not needed for the model.

## Done when

- A space is created from a preset. Its genesis holds the roles, and its
  creator holds the top one.
- A member at rank 50 can't change anyone at 50 or above. The creator can hand
  over and leave, and the new admin keeps managing.
- A poll collection with `delete: ['creator', 'can:moderate']` lets a
  Moderator delete others' polls and a Member only their own. Renaming the
  role in the space changes nothing in the app.
- An app granted write access holds no secret. After Disconnect, nothing it
  writes is accepted, whatever it claims.
- The three offline conflicts in part 4 end the same on every peer.
- The README describes spaces, roles, rules and the access history, and this
  block is removed.

## Size

About 4 weeks. The access history and its tests (part 4) come first and are
the risky part. Settle the replay order in writing, pin it with the offline
conflict tests, and only then build parts 5–6 and the home screens.
