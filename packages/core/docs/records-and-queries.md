# Records and queries

A record is a JSON body in a collection of a space, signed by whoever wrote
it. Its `key` stays the same across edits, and links point at the key. Every
edit is a new version.

## Writing

```typescript
const todo = await node.records.put(space.id, todos, { text: 'milk', done: false });

await node.records.update(space.id, todo.key, { text: 'milk', done: true }); // the whole body, not a patch
await node.records.delete(space.id, todo.key);
```

- `put` makes a new record with a random key, unless you give one
  (`{ key }`). A chosen key suits a record there is one of by nature, like a
  settings record.
- `update` takes the whole next body. Links carry over unless you pass new
  ones.
- `delete` writes a version marked deleted, which syncs like any other.
- Pass a definition made with `collection(…)` instead of a name, and the body
  is type-checked as you write it.
- A write this account isn't allowed to make throws, with the reason in plain
  words. Nothing is signed. `node.records.can(space, 'edit', key)` asks first.

Which version wins is decided by `seq` (one higher each edit), then by version
id, never by a clock. Two devices that edited apart agree on the same winner.
Merging edits inside one record is not built yet, so design records so that
people edit different ones: one record per vote, per card, per reaction.

## Links

```typescript
await node.records.put(
  space.id,
  votes,
  { choice: 0 },
  {
    links: [{ rel: 'about', to: poll.key }],
  },
);

const all = await node.records.linked(space.id, poll.key, { rel: 'about' });
```

The roles a record may carry are declared on its collection
([collections.md](collections.md)).

## What a record looks like

```typescript
{
  key, version, seq, space, collection,
  body,          // null when encrypted and this node has no key
  links,         // [{ rel, to }]
  root,          // the account that wrote this version
  createdBy,     // the account that created the record
  createdAt, updatedAt,   // the writer's clock: for display only
  verified,      // signature, delegation and shape check out
  conforms,      // fits the collection's schema (null when there is none)
  viaAgent,      // true when an agent wrote it for the account
}
```

Show `root` or `createdBy` as the author, not `author`, which is the session
key that signed. `node.spaces.profiles(space)` maps accounts to names.

## Queries

A query is plain JSON, so an agent can write one, and it can cross a wire.

```typescript
const { records, cursor, complete } = await node.records.query(space.id, {
  collection: polls,
  where: { closed: { $ne: true }, question: { $contains: 'may' } },
  sort: { '@createdAt': 'desc' },
  limit: 20,
  include: {
    votes: { rel: 'about', from: votes }, // records linking to each poll
    reactions: { rel: 'about', from: 'std.reaction', count: true },
  },
});
```

- **Fields.** A bare name is a field of the body (`done`, `address.city`). A
  name starting with `@` is about the record: `@key`, `@author`, `@root`,
  `@createdBy`, `@createdAt`, `@updatedAt`, `@seq`.
- **Operators.** `$eq`, `$ne` (true for a missing field too), `$gt`, `$gte`,
  `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$contains` (a case-insensitive
  substring, or an element of a list). Combine with `$and`, `$or`, `$not`. A
  bare value means `$eq`.
- **Sort** by several fields in order. Ties break on the key.
- **Paging.** Pass the `cursor` back to get the next page. It is null on the
  last one.
- **Include** follows links. `direction: 'in'` (the default) finds records
  linking to this one, `'out'` the ones it links to. Each include takes its own
  `where`, `limit`, nested `include`, or `count: true` for just the number.
  What it finds is on each record's `included`.
- Name collections by their definitions and the results are typed, includes
  too.
- `complete` is false while a node that holds only part of a space is still
  fetching a collection the query needs. Show "Loading…", not "Nothing here".
- A malformed query throws, saying what to fix.

This is not full-text search: `$contains` is a substring match.

## Watching

```typescript
const stop = node.records.watch(space.id, query, (result) => render(result));
stop();
```

It runs now and again whenever the space's records change, here or from a
peer. In React, `useQuery(space, query)` does the same.

For anything else, subscribe to the node's events:

```typescript
const unsubscribe = node.subscribe((event) => {
  if (event.type === 'records') reload(event.space);
});
```

## History

`node.records.history(space, key)` gives the versions this node keeps whole,
newest first: the current one, or every one in a collection defined with
`history: 'all'`. What an earlier version said is otherwise forgotten once
it is superseded; only a stub of it is kept, to check the next one.
