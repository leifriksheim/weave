# Agents

An agent reads and writes as the person, with a note from their account that
every peer checks. What it writes shows as theirs, "via agent", everywhere.
It never gets the seed, and it can't do what needs a person: define
collections, change roles, invite, join or leave spaces.

## Every operation, described once

Every node operation is in `NODE_ACTIONS`: a name, a sentence and a JSON
Schema for its input. The CLI, the MCP server and the browser's WebMCP tools
are all generated from it.

```typescript
import { NODE_ACTIONS, runAction } from '@weaveprotocol/core';

await runAction(node, 'records_put', { space, collection: 'app.todo.item', body: { text: 'milk' } });
```

`records_query` takes the same plain-JSON query as `node.records.query`
([records-and-queries.md](records-and-queries.md)).

## Connecting an agent to someone's account

From `@weaveprotocol/cli`, the `weave` command:

```bash
npx @weaveprotocol/cli connect wv_…   # the code from "Connect an agent" in an app
```

It makes a key for this computer's agent, waits while the person allows it at
their account home, and adds `weave mcp` to Claude Code, Claude Desktop and
Cursor where it finds them. The agent is then a node of its own: it follows
the account's spaces and keeps working with every tab closed.

## Tools an agent gets

`node_info`, `spaces_list`, `spaces_status`, `spaces_preview_invite`, `spaces_access`, `spaces_profiles`,
`collections_list`, `records_query`, `records_list`, `records_get`,
`records_linked`, `records_history`, `records_can`, `records_put`,
`records_update`, `records_delete`, and for new tools: `apps_list`,
`apps_propose`, `apps_screen_guide`.

To make something new, an agent proposes an app (`apps_propose`): the
collections it needs, optionally a screen for each, and optionally what is
worth hearing about (`notify`: `[{ "label": "New ride", "collection":
"carpool.ride" }]`), which people can then turn on with one click. The person
reads what it would do and adds it. See [screens-and-apps.md](screens-and-apps.md).

## In your own code

`node.asAgent({ keys, note })` gives the same node acting as an agent, from an
agent's note issued by the account home. Everything it writes is signed under
that note.

> **Planned (open question): naming the agent.** Records show as "via agent",
> without saying which. The note could carry a name (say
> `{ "weave": "agent", "name": "Claude in Chrome" }`), but that is the
> agent's own word, signed by the account on its say-so, not a proof. Peers
> would judge records the same either way, so it is a matter of display. Not
> decided whether that is worth showing.

## Working on a Weave app with a coding agent

These guides ship inside the package so an agent in your repository can read
them at `node_modules/@weaveprotocol/core/docs/`, matched to the installed
version. A line in your project's `AGENTS.md` or `CLAUDE.md` pointing there is
enough.
