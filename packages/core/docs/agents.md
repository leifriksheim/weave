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

`weave agent` runs the same agent without a chat client: it chats in the
terminal and thinks with the person's own Anthropic API key, offering the model
the same tools. See `packages/cli/README.md`.

## Connecting with a code

The code, the room and link key derived from it, and the messages the two
sides trade are protocol ([spec 06 §3.2](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)). What the reference sides add:

- The app (`apps/example/src/components/ConnectAgent.tsx`) shows the code, then
  the agent's name once `heard` is sent, and asks the person to allow it.
- Allowing opens the account home with `access: write`, `scope: account`,
  `chooseSpaces: false` and the lifetime the person chose.
- The app shows the agent connected when `done` arrives.
- The terminal (`weave connect`, `checkAgentGrant`) waits 60 s to hear `heard`,
  then 10 minutes for the answer.

_Source: `packages/core/src/session/agent-link.ts`, `apps/example/src/components/ConnectAgent.tsx`. Tests: `packages/core/tests/agents.test.ts` ("connecting an agent with a code")._

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

## Watches

An agent that runs by itself (`weave agent`) also does what the person's
`std.watch` records say: when some records appear or change, or at set times.
Any collection, any filter the query format allows. An agent may write a watch
when asked, but it runs only once the person has saved it themselves; see
[standard-library.md](standard-library.md) (Watches).

`weave agent` can think with Anthropic's models, or with any server that
speaks OpenAI's Chat Completions, including a model on your own machine
(`--provider openai`; see `packages/cli/README.md`).

## Bots

A bot is the same program running as an account of its own
(`weave agent --bot`), which people invite to their spaces as a member. It
writes as itself, is checked against its role like any member, and can be
mentioned by its own DID. It runs the watches of members holding
`std.watch/instruct` in a space, in that space only. Where a space keeps
`std.profile`, it says it is a bot there with `bot: true`. See
[standard-library.md](standard-library.md) (Watches, Bots).

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
