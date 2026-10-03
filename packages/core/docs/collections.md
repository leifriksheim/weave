# Collections

A collection is a named kind of record in a space. Its definition is stored in
the space as a signed record, so another app, or an agent, can open the space
and know what its data means without your code.

```typescript
import * as z from 'zod'; // or Valibot, ArkType, or plain JSON Schema
import { collection } from '@weaveprotocol/core';

const Poll = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1)).min(2).max(10),
});

export const polls = collection({
  name: 'app.poll',
  title: 'Poll',
  schema: Poll,
  permissions: ['moderate'],
  rules: {
    edit: 'creator',
    delete: ['creator', 'can:moderate'],
    fixed: ['options'],
  },
});

await node.collections.define(space.id, polls);
```

`collection(…)` only keeps the definition's types, so queries and writes that
name `polls` are typed from the schema. Pass it where a collection name goes.

## Names

Reverse-DNS, lower case, at least two parts: `app.poll`, `com.example.recipe`.
Letters, digits and `-` in each part. `sys.*` is the protocol's own and
`std.*` is the standard library.

Names are local to a space: nothing registers or owns one across spaces. Two
apps sharing a space settle a clash over a name before anything is defined,
when a person reads what each would define
([the app review](apps-as-records.md#the-app-review)).

## Schemas

What gets stored is JSON Schema, in a small subset every app agrees on:

`type`, `properties`, `required`, `items`, `enum`, `const`, `minimum`,
`maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`,
`additionalProperties` (true or false), `title`, `description`

and two that say what a value means, so any app can show it well:

- `oneOf: [{ const, title }]`: fixed choices with labels.
- `x-choicesFrom: { rel, field }`: the value picks from a list in the record
  this one links to as `rel`, in its field `field`. A number is a position in
  that list; anything else is the option itself. A vote's `choice` picks from
  its poll's `options`. It is a display hint, never checked when validating.

Anything else, like `pattern` or `format`, is refused when you define the
collection, with the reason. A Zod `.regex()` or `.email()` fails for that
reason. Validators that can describe themselves as JSON Schema work directly:
Zod 4.2+, ArkType 2.1.28+, Valibot with `toStandardJsonSchema`. They are
converted with target `draft-2020-12` before storing, a `$schema` member is
dropped, and the result is checked like any other.

### Validating

A body is checked against a stored schema as draft 2020-12 JSON Schema, with
unknown keywords ignored, so a space written by a newer app that allows more
stays readable by an older one. Every failing leaf is reported, not only the
first, with a JSON Pointer to the value. The validator is
`@cfworker/json-schema`, which interprets rather than compiles, so it runs
under a strict CSP.

A record that doesn't fit the schema is still kept and synced, and comes back
with `conforms: false` and the issues. Shape is checked when you write, not
enforced on arrival, because two peers may have seen different versions of a
definition ([spec 02 §9.6](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)).
Rules, below, are enforced everywhere.

_Source: `packages/core/src/schema/collection-def.ts` (`validateJsonSchema`, `toJsonSchema`, `asStandardSchema`), `packages/core/src/node/space-runtime.ts` (`contentIssues`). Tests: `packages/core/tests/space-catalog.test.ts` ("validate and reject within the supported subset", "an unknown keyword is ignored when validating, so newer spaces stay readable", "choices can carry labels, or come from a linked record", "a record that does not fit is kept and flagged when it arrives, never rejected"), `packages/core/tests/schemas.test.ts` ("schemas from a validator you already use")._

## Links

Records point at each other with links: `{ rel: 'about', to: <record key> }`.
A definition declares the roles its records may carry:

```typescript
links: {
  about: { to: ['app.poll'], cardinality: 'one' },   // only at polls, at most one
  mentions: { to: '*' },                              // at anything, many
},
```

A link role is lower camel case. Queries follow links with `include`, and
filter on them with `link:<rel>` ([records-and-queries.md](records-and-queries.md)).

**A record that points at another record says so with a link**, never with
the other record's key in a body field. Everything that follows relations
works on links and only on links: declarations and conformance, `onePer`,
checks, `include` and counts, rules ([rules.md](rules.md)), and the "what
points here" a record's page shows. A key in a body field is a string to all
of them. Fields are for values and for people (DIDs); links are for records.
If a keeper must match on a link without reading, make it a topic:
`topics: ['link:channel']`.

Like a schema, link declarations are checked when you write: the node refuses
to sign links that don't conform. A record that arrives with links that
don't conform is kept and comes back with `conforms: false`.

_Source: `packages/core/src/records/links.ts` (`checkLinks`), `packages/core/src/node/space-runtime.ts` (`linkIssues`, `write`). Tests: `packages/core/tests/links.test.ts` ("refused on write when they break the declaration; flagged, never rejected, when they arrive")._

## Rules

| Rule     | Means                                                     | Default        |
| -------- | --------------------------------------------------------- | -------------- |
| `create` | Who may create a record                                   | `member`       |
| `edit`   | Who may write later versions                              | `member`       |
| `delete` | Who may delete                                            | same as `edit` |
| `onePer` | At most one record per combination of these               | none           |
| `fixed`  | Fields that keep the value the record was created with    | none           |
| `check`  | Conditions every new version must meet ([below](#checks)) | none           |
| `final`  | `true`: written once, then never edited or deleted        | none           |

Who is one of these, or a list meaning any of them:

- `member`: anyone holding a role in the space.
- `creator`: whoever wrote the record's first version. Not allowed for `create`.
- `can:<permission>`: someone whose role holds a permission the collection
  declares in `permissions`. `can:moderate` in `app.poll` is the permission
  `app.poll/moderate`.

`onePer` names `@author` (the writer), `link:<rel>` (the record a link points
at) or a body field. It works by construction: the record's key is derived
from those values, so a second vote from the same person on the same poll is
the first vote's next version, not a new record.

```typescript
rules: { edit: 'creator', delete: 'creator', onePer: ['@author', 'link:about'] }  // one vote per person per poll
```

## Checks

The rules above say who may write. `check` says what a version must be:
conditions every device checks, over the body, the version before it, and
other versions it **cites** as evidence. With them a space can hold things
that normally need a server or a smart contract: a proposal that passes only
with enough votes, a game whose moves must be legal, points that can't be
spent twice, a reward that unlocks when its condition is met.

```typescript
export const passed = collection({
  name: 'app.proposal.passed',
  schema: z.object({ votes: z.array(z.string()) }),
  links: { about: { to: ['app.proposal'], cardinality: 'one' } },
  rules: {
    onePer: ['link:about'], // one "passed" per proposal
    check: [
      {
        // At least three members' yes votes on this proposal, among those cited
        that: {
          '>=': [
            {
              size: {
                distinct: {
                  map: [
                    {
                      filter: [
                        { versions: { var: 'body.votes' } },
                        {
                          and: [
                            { '==': [{ var: 'it.collection' }, 'app.proposal.vote'] },
                            { '==': [{ link: ['about', { var: 'it' }] }, { link: ['about'] }] },
                            { '==': [{ var: 'it.body.choice' }, 'yes'] },
                          ],
                        },
                      ],
                    },
                    { var: 'it.author' },
                  ],
                },
              },
            },
            3,
          ],
        },
        else: 'A proposal passes with yes votes from at least three members',
      },
    ],
  },
});

// The app finds the votes and cites them by version id
const votes = await node.records.linked(space.id, proposal.key, { collection: 'app.proposal.vote' });
await node.records.put(
  space.id,
  passed,
  { votes: votes.map((v) => v.version) },
  { links: [{ rel: 'about', to: proposal.key }] },
);
```

A check never searches, because no device holds everything. The writer does
the work (finds the votes, adds up the balances, picks the move) and cites
what proves it. Every device then checks that exactly what was cited proves
it. A version that fails is refused everywhere, with the check's `else` as
the reason, and your own node refuses it before signing. A version citing
one that hasn't arrived yet waits until it does.

A condition is JSON: literals, lists, and `{ "<operator>": [arguments] }`.
It reads `body`, `links`, `key`, `seq`, `author` (the account),
`creator`, `createdAt`, `prev` (the version before, or `null`) and, inside
list operators, `it`. The operators are `==` `!=` `<` `<=` `>` `>=` `in`,
`and` `or` `not` `if`, `+` `-` `*` `/` `%` `min` `max`, `size` `map`
`filter` `all` `some` `count` `sum` `distinct`, `get` `link` `hash`, and
three that ask the space: `versions` (read cited versions by id), `can`
(does someone hold a permission) and `member`. There are no loops except over
lists already in hand, a check always ends, and a value is never "truthy": a
condition is `true` or the version is refused. The exact rules are in the
spec, `spec/02-records.md` §7.6.

**What can be cited.** Only versions kept whole, so every device reads the
same thing however late it joins: any version in a collection with
`history: 'all'` or with checks of its own, and a first version under
`onePer` or `fixed`. Give a collection you mean to cite `history: 'all'`,
or an edited vote's latest version can't be cited. A cited version proves
what was signed, not that it is still current, so make evidence final where
it matters: `final: true` on a vote, so nobody can change or delete it once
it is counted, or `fixed: ['choice']` to allow other edits.

**A proof stays a proof.** A cited version is judged as of what the citing
version saw: removing a voter later, or revoking the device that voted,
doesn't undo a decision that already counted the vote. A decision written
after seeing the removal can't count it. Peers keep such withdrawn versions
for this, without showing them.

The standard library has two ready-made: `std.decision`, a proposal decided
by a quorum of ballots, and `std.goal-reached`, a goal reached by pledges
([standard-library.md](standard-library.md)).

**Patterns.**

- **Quorums and multisig.** "Three admins approved": cite the approvals, and
  check `distinct` authors with `{ can: ['approve', { var: 'it.author' }] }`.
- **State machines.** Check each version against `prev`: a task moves from
  `open` to `done` only, a counter goes up by one, a chess move is legal from
  the board before. Each step is small, and there is no limit on steps.
- **Ledgers.** A transfer cites the balance records it spends, and checks
  that they are the sender's and add up. Two spends of one balance are two
  versions of it, which everyone sees.
- **Commit, then reveal.** A player first writes `hash` of a secret, then
  reveals it: `{ '==': [{ hash: { var: 'body.secret' } }, <the commitment>] }`.
  Shared dice, lotteries and sealed bids need nothing else.
- **Closing a set.** A check can prove that something exists, not that nothing
  else does. For "a majority" or "nobody objected", someone with a permission
  signs a record that closes the vote and lists what counts, and the result
  cites that.
- **Time.** There is no clock. "Before Friday" is a record from someone
  trusted to say it (a host, a witness) that the result cites.

## Roles

Roles live in the space, not in your code. Each has a name, a rank and a list
of permissions:

```typescript
await node.spaces.putRole(space.id, {
  name: 'host',
  title: 'Host',
  rank: 50,
  permissions: ['invite', 'app.poll/moderate'],
});
await node.spaces.setMember(space.id, did, 'host');
```

- `*` alone is every permission. `*/*` is every permission any collection
  declares, so a moderator can moderate every app in the space.
- Space permissions include `invite`, `define` (add or change collections)
  and `manage`.
- You can only change people and roles ranked below your own.

## Other options

- `history: 'all'` keeps every version of every record whole, hash-linked
  (`node.records.history`). The default, `latest`, keeps the current one
  whole and forgets what earlier ones said, and what a deleted record said.
  With `onePer` or `fixed` in the rules, a record's first version is kept
  whole too: those rules are checked against it. With `check`, every version
  is.
- `topics: ['mentions', 'link:channel']` lets a node that can't read the
  space still match records by a field's value, or by where a link of that
  role points, for notifications. At most 8.
- `screen`: a small UI for the collection's records. See
  [screens-and-apps.md](screens-and-apps.md).
- `version`: see [below](#versions-of-a-definition).

## Versions of a definition

Defining a collection again writes the next version of its definition, one
higher unless you give a `version`. The node refuses a `version` that is not
higher than the one in force; peers don't check it. Records don't name the
version they were written under: each is judged by the definition in force
as of the access changes it saw.

`node.collections.delete` removes a definition only once its collection has
no records left, since records left behind would lose their shape and their
rules.

_Source: `packages/core/src/node/space-runtime.ts` (`define`, `undefine`), `packages/core/src/node/types.ts` (`NodeCollections`). Tests: `packages/core/tests/space-catalog.test.ts` ("redefining bumps the version, and only the definer or someone who can manage the space may", "a definition can be removed once its collection is empty, by whoever may change it")._

## The standard library

```typescript
import { reaction, comment, poll, vote, useSchemas } from '@weaveprotocol/core/schemas';

await useSchemas(node, space.id, [poll, vote, reaction, comment]); // defines only what the space is missing
```

About eighty definitions, by area (`standardGroups`): annotations that attach
to any record (`reaction`, `comment`, `rating`, `bookmark`, `claim`…), people
(`profile`, `follow`…), messaging and publishing (`message`, `post`,
`article`, `doc` and `docBlock`, `note`…), lists (`list`, `listItem`), files
and media, time and planning (`event`, `rsvp`, `task`, `booking`…), places,
home and life (`recipe`, `meal`…), money (`expense`, `settlement`…) and
community (`poll`, `vote`, `proposal`, `decision`, `goal`…). The full list is in
[standard-library.md](standard-library.md).

They are ordinary collections. Using the same one is how two apps agree: a
poll asked in one can be voted on in another. For shapes of your own, the
`fragments` export builds times, money, places and files the same way the
library does.

Hand-made order (cards on a board) uses a `position` string.
`positionBetween(before, after)` makes one that sorts between two others, so
moving a card rewrites only that card.
