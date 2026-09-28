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

## Schemas

What gets stored is JSON Schema, in a small subset every app agrees on:

`type`, `properties`, `required`, `items`, `enum`, `const`, `minimum`,
`maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`,
`additionalProperties` (true or false), `title`, `description`

and two that say what a value means, so any app can show it well:

- `oneOf: [{ const, title }]`: fixed choices with labels.
- `x-choicesFrom: { rel, field }`: the value picks from a list in the record
  this one links to. A vote's `choice` picks from its poll's `options`.

Anything else, like `pattern` or `format`, is refused when you define the
collection, with the reason. A Zod `.regex()` or `.email()` fails for that
reason. Validators that can describe themselves as JSON Schema work directly:
Zod 4.2+, ArkType 2.1.28+, Valibot with `toStandardJsonSchema`.

A record that doesn't fit the schema is still kept and synced, and comes back
with `conforms: false`. Shape is checked when you write, not enforced on
arrival, because two peers may have seen different versions of a definition.
Rules, below, are enforced everywhere.

## Links

Records point at each other with links: `{ rel: 'about', to: <record key> }`.
A definition declares the roles its records may carry:

```typescript
links: {
  about: { to: ['app.poll'], cardinality: 'one' },   // only at polls, at most one
  mentions: { to: '*' },                              // at anything, many
},
```

A link role is lower camel case. Queries follow links with `include`
([records-and-queries.md](records-and-queries.md)).

## Rules

| Rule     | Means                                                  | Default        |
| -------- | ------------------------------------------------------ | -------------- |
| `create` | Who may create a record                                | `member`       |
| `edit`   | Who may write later versions                           | `member`       |
| `delete` | Who may delete                                         | same as `edit` |
| `onePer` | At most one record per combination of these            | none           |
| `fixed`  | Fields that keep the value the record was created with | none           |

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

- `history: 'all'` keeps every version of every record, hash-linked
  (`node.records.history`). The default, `latest`, keeps the current one.
- `topics: ['channel']` lets a node that can't read the space still match
  records by that field's value, for notifications. At most 8.
- `screen`: a small UI for the collection's records. See
  [screens-and-apps.md](screens-and-apps.md).
- `version`: defining again bumps it. Records keep the version they were
  written under.

## The standard library

```typescript
import { reaction, comment, poll, vote, useSchemas } from '@weaveprotocol/core/schemas';

await useSchemas(node, space.id, [poll, vote, reaction, comment]); // defines only what the space is missing
```

About seventy definitions, by area (`standardGroups`): annotations that attach
to any record (`reaction`, `comment`, `rating`, `bookmark`, `claim`…), people
(`profile`, `follow`…), messaging and publishing (`message`, `post`,
`article`, `doc` and `docBlock`, `note`…), lists (`list`, `listItem`), files
and media, time and planning (`event`, `rsvp`, `task`, `booking`…), places,
home and life (`recipe`, `meal`…), money (`expense`, `settlement`…) and
community (`poll`, `vote`, `proposal`…). The full list is in
[standard-library.md](standard-library.md).

They are ordinary collections. Using the same one is how two apps agree: a
poll asked in one can be voted on in another. For shapes of your own, the
`fragments` export builds times, money, places and files the same way the
library does.

Hand-made order (cards on a board) uses a `position` string.
`positionBetween(before, after)` makes one that sorts between two others, so
moving a card rewrites only that card.
