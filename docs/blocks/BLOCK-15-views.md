# BLOCK-15 — Views: how to show records, as data

> **Done (2026-09-23).** `src/records/views.ts` — `sys.view` in the built-in
> library, checked on write. Tests: `tests/views.test.ts`. The example draws
> every view in a list with one generic renderer (`example/src/components/ViewsPanel.tsx`);
> verified in two browsers: a view one person saves appears for the other,
> and updates live as reactions arrive and todos are ticked.

## What this delivers

An agent asked for "a table of what's left, with the likes" writes a record —
not code:

```json
{
  "title": "Still to do",
  "query": {
    "collection": "app.p2p-todo.item",
    "where": { "completed": false },
    "sort": { "order": "asc" },
    "include": { "likes": { "rel": "about", "from": "sys.reaction", "count": true } }
  },
  "layout": "table",
  "fields": [{ "field": "text", "label": "What" }, { "field": "@createdAt", "label": "Added" }]
}
```

It syncs like any record. Every app that draws views shows it — including
apps that have never heard of todos.

## Is this part of the protocol?

**The format is; the drawing is not.**

- If the format were app code, a view saved in one app would mean nothing in
  another, and an agent would have to learn each app's format. Putting it in
  the built-in library means every node agrees on what a view *is*.
- How a `table` or a `board` looks is each app's own business, the way HTML
  says "this is a list" and the browser decides how it looks. An app that
  does not know a layout shows it as a list.
- The query inside is exactly what `records_query` takes (BLOCK-10), so an
  agent learns one format, not two.

## The format

| Field | |
|---|---|
| `title` | Required |
| `description` | Optional |
| `query` | Required. A BLOCK-10 query; checked with the same checker, so a view that cannot run is refused on write and flagged on read |
| `layout` | `list`, `table`, `cards` or `board` |
| `fields` | `[{ field, label? }]` — the same names a query uses (`text`, `address.city`, `@createdAt`). Included things show as counts or lists after them |
| `groupBy` | The field whose values are a board's columns. Required for `board` |

Optional link: `about → *` — a view that belongs to one record, like "the
comments on this document".

## Out of scope

- **Views across spaces.** A view queries the space it is in.
- **Editing through a view.** A view shows; changing records stays with the
  app that knows them, or an agent using the actions.
- **More layouts.** Calendars and charts can come as new layout names;
  renderers that do not know them fall back to a list, so adding one never
  breaks an older app.
