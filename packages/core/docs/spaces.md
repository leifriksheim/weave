# Spaces in the library

What the library chooses when it creates, invites to, reads and keeps
spaces: role presets, invite defaults, profiles, the space manager, and how
an app shows a subscription.

> Not protocol. None of this is checked by a peer, and another implementation
> may do it differently and still interoperate. What peers must agree on about
> spaces is in [spec 03 — Spaces](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md).

## Presets

A preset is a list of starting roles and the one the creator holds. The
protocol reads whatever roles a space's genesis names and never looks at a
preset's name; these are a sensible start for an app. Pass one when creating a
space, change it, or write your own.

| Preset      | Roles (name, title, rank, permissions)                                                   | Creator |
| ----------- | ---------------------------------------------------------------------------------------- | ------- |
| `solo`      | owner Owner 100 `["*"]`                                                                  | owner   |
| `team`      | owner Owner 100 `["*"]`; editor Editor 10 `["invite","define"]`                          | owner   |
| `community` | admin Admin 100 `["*"]`; moderator Moderator 50 `["invite","*/*"]`; member Member 0 `[]` | admin   |

When a space is created with no roles, it gets `solo`. With roles but no
`creatorRole`, the creator holds the highest-ranked one.

The account's derived spaces (the registry, the contacts space) use `solo`'s
roles, byte for byte: their ids depend on it
([spec 03 §13.1](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)).
Changing `solo` would change those ids, so it must not change.

_Source: `packages/core/src/space/presets.ts`, `packages/core/src/space/space-manager.ts` (`create`). Tests: `packages/core/tests/space.test.ts`, `packages/core/tests/roles.test.ts`._

## Invites

`node.spaces.invite(id, options?)`:

- With no role given, it opens an invite for the lowest-ranked role strictly
  below the inviter's own. With none below (as in `solo`), it makes a
  view-only invite.
- `write: false` always makes a view-only invite.
- Each role invite gets its own fresh secret and its own `sys.invite` record,
  so one can be closed without the others.
- The invite names the space's relays, or the inviter's own when the space
  names none.

`node.spaces.preview(invite)` decodes an invite without storing anything:

```
{ space: { id, name, visibility, creator, createdAt }, invitedBy,
  carriesKey, carriesWrite, role }      // role is null for a view-only invite
```

On `join`, relays carried by the invite are a hint: the node uses them only
when they pass `checkRelays` and it holds no relay list for the space yet.
While the invite's record has not reached this device, the space is held with
`joining: true` and the node tries again as records arrive
([spec 06 §1.3](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).

_Source: `packages/core/src/node/node.ts` (`spaces.invite`, `preview`, `join`), `packages/core/src/space/space-manager.ts` (`previewInvite`, `join`). Tests: `packages/core/tests/space.test.ts` ("invites"), `packages/core/tests/roles.test.ts` ("invites")._

## Keeping a space's keys and relays

The node does the protocol's key upkeep by itself, in each space it opens:

- On every upkeep it publishes this account's member key when it differs from
  the one published.
- When a key change is due and it holds `manage` and the current key, it
  changes the key. `node.spaces.changeKey` does the same by hand.
- In a space with no relays named yet, a node holding `manage` names its own.

_Source: `packages/core/src/node/space-runtime.ts` (`upkeep`, `rotateKey`, `nameRelays`). Tests: `packages/core/tests/key-change.test.ts`, `packages/core/tests/space-relays.test.ts`._

## Profiles

The record format, and whose versions count, is protocol
([spec 03 §11](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)).
The rest is the library's.

**Reading.** For each `profile:` key, the node looks at versions newest first,
skipping any that is not `sys.profile`, does not verify, does not stand, or
whose root's `hex40` is not the record key:

- a deleted version ends the search: no profile;
- the first remaining version gives `name` (trimmed, cut to 64 characters;
  empty means no profile), `did` (its root) and `updatedAt` (its `createdAt`);
- `contactKey` comes from the newest remaining version that carries a valid
  P-256 point, so a newer version written without one does not hide it.

**Writing.** Profiles are written with `retain`, so older versions stay. A
writer that does not hold the contact key must carry forward the
`contactKey` of its current profile.

**The account's name.** The account keeps its name in the account registry,
as `sys.profile` at key `profile` with body `{ name }`; the newest version
wins. `node.account.setName` writes it. The node publishes that name into
every space it opens, and again on a rename, except the registry, the
contacts space and agent sessions; a non-member publishes nothing
([spec 06 §1.3](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).

> **Planned:** profiles, round two.
>
> - **A name per space** ("in this space, call me…"). The record is already
>   per space; what is missing is a way to say the name was chosen for this
>   space, so publishing the account name on the next rename does not
>   overwrite it.
> - **An avatar**, as a reference to an image on the profile. Depends on a
>   way for a record to carry a file, which is not specified yet (the blob
>   stores of [spec 05](https://github.com/leifriksheim/weave/blob/main/spec/05-sync-and-storage.md) hold mirrors, not files records
>   point to).
> - **Private nicknames for others**: a name you give someone, seen only by
>   you. It belongs in the account's own spaces, not in the shared one;
>   `std.contact`'s `name` already does this for contacts.
>
> Open questions: the field names; the avatar's size limit and format; and
> whether nicknames for people who are not contacts get a collection of their
> own. `profile:` keys may also change (spec 03 §8.6).

_Source: `packages/core/src/node/space-runtime.ts` (`loadProfiles`, `publishProfile`), `packages/core/src/node/node.ts` (`publishProfile`, `ownName`, `account.setName`), `packages/core/src/space/account-registry.ts` (`PROFILE_COLLECTION`, `PROFILE_KEY`). Tests: `packages/core/tests/profiles.test.ts`, `packages/core/tests/contacts.test.ts` ("the contact key"), `packages/core/tests/account.test.ts` ("the account name")._

## The space manager

The space manager keeps, per space, in a storage adapter (the node's
`registry` store, sealed at rest; see [node](node.md#stores)):

| Storage key           | Value                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `space:<id>`          | JSON space object                                                                            |
| `spacekey:<id>`       | JSON `{ keys: [{ id, raw, createdAt, version }], current }`: every key held, `raw` base64url |
| `spaceinvite:<id>`    | base64url invite secret, until used                                                          |
| `spacerole:<id>`      | the role last held: a hint for listing, never a gate                                         |
| `spacememberkey:<id>` | base64url member key scalar, for a node given it without the vault key                       |
| `spacerelays:<id>`    | JSON relay list last heard                                                                   |

`remove` deletes all six. Joining again with a secret while one is waiting
keeps the newer one.

_Source: `packages/core/src/space/space-manager.ts`. Tests: `packages/core/tests/space.test.ts` ("space manager")._

## Subscriptions

A subscription's `app` names the app that proposed it
([spec 03 §15](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)),
and that app shows what it matches. A home adds no subscription of its own.
One without `app` was made by an earlier home, or proposed by an earlier
extension (which is why an extension's origin stays valid), and nothing shows
it now.

**Narrowing with `where`.** A subscription, a proposal and an app's `notify`
entry may carry `where`: a condition over the record in the language of
[checks](collections.md#checks), reading `body`, `links`, `key`,
`collection`, `author` and `createdAt`. Since a collection's schema says what
each field holds, an app can build these from what a person picks — "a task
whose priority is at least 3", "a poll that isn't closed" — rather than
offering a fixed list. `checkRecordCondition` says whether one can be kept,
and `recordHolds(condition, record)` whether it holds, which an app can use
to show what a subscription would have matched before proposing it.

```typescript
await connection.propose([
  {
    label: 'Urgent task for me',
    collection: 'std.task',
    topic: { field: 'assignees', me: true },
    where: { '>=': [{ var: 'body.priority' }, 3] },
  },
]);
```

Put what a carrier can match in `topic` when there is one: `where` is judged
only by the app, so a carrier matching on `collection` alone wakes the app for
records it then turns down.

_Source: `packages/core/src/space/notify.ts` (`checkNotify`, `whereHolds`), `packages/core/src/records/checks.ts` (`checkRecordCondition`, `recordHolds`), `packages/core/src/node/node.ts` (`notifications`), `apps/example/src/notifications.ts`. Tests: `packages/core/tests/carrier.test.ts` ("notifications through a carrier"), `packages/core/tests/topics.test.ts` ("a subscription’s where")._
