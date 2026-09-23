# weave — the protocol from a terminal

One program, three jobs:

- **Manage your spaces** — every command the Node API has, as `weave spaces …` and `weave records …`
- **Run an always-on node** — `weave run` keeps every space syncing, serves sockets browsers dial into, and is a relay too
- **Hand your spaces to an agent** — `weave mcp` exposes the same operations over MCP

It uses the same data folder layout a browser does. Point `--home` at the folder
you picked in Chrome and the CLI, the daemon and the browser all share one
account.

## Quick start

In this repo, `npm run dev` (at the root) already runs a node with a throwaway
identity, and `npm run weave -- <command>` talks to it — no setup.

To make the dev node *your* account's node — so it serves every list you make
in the browser, with nothing to hand it — give it your account password once:

```bash
rm -rf .weave-dev                                  # drop the throwaway identity
WEAVE_RECOVERY_CODE='XXXX-…' npm run weave -- init --existing --passphrase --name Me
npm run dev
```

To have `weave` everywhere:

```bash
cd cli && npm install && npm link          # or a binary with no Node at all: bun build.ts --native
```

```bash
weave init --name Leif --passphrase          # prints your recovery code once
export WEAVE_PASSPHRASE='…'                  # so later commands don't ask

weave spaces create --name Groceries --type shared --visibility private
weave records put --space <id> --collection app.todo.item --body '{"text":"milk","completed":false,"order":1}'
weave records list --space <id>
weave spaces invite --space <id>             # a secret: it carries the space key and the write key
weave spaces invite --space <id> --view-only # they can read it, not change it
weave spaces join --invite 'https://…#invite=…'
weave run                                    # stay up and serve; --create makes an account on first start
```

Every data command is an action from `NODE_ACTIONS`: `weave records put` runs
`records_put`, and its flags are that action's input fields. `weave actions`
prints them all with their schemas. `--json '{…}'` passes an input whole.

## Unlocking

Secrets never go on the command line, where `ps` shows them:

| | |
|---|---|
| `WEAVE_RECOVERY_CODE` or `--code-file FILE` | the account's recovery code |
| `WEAVE_PASSPHRASE` or `--passphrase-file FILE` | a passphrase added with `init --passphrase` |
| neither | you are asked, without echo |

Nothing ever writes the seed in the clear: the account file holds only wrapped
copies, exactly as in a browser folder.

## The always-on node

```bash
weave run --port 8787
```

- `ws://host:8787/peer?space=<id>` — the protocol's WebSocket transport. Browsers
  reach it with `network: { nodes: ['wss://host/peer'] }` (the example app reads
  `VITE_WEAVE_NODES`). No relay, no TURN.
- `ws://host:8787?room=<id>` — the signaling relay, so one process bootstraps a space.
- `GET /health`

It opens every space the account holds and notices new ones within five
seconds, whoever added them: `weave spaces join` in another terminal, a browser
pointed at the same folder, a pairing. It validates everything with the same
gates as any peer. It is an **anchor, not a host** — uptime, no authority.

For a server, `bun build.ts` makes single-file binaries for this machine,
`linux-x64` and `linux-arm64`; `weave-node.service` is a systemd unit.

## Agents

```json
{ "mcpServers": { "weave": { "command": "weave", "args": ["mcp"], "env": { "WEAVE_PASSPHRASE": "…" } } } }
```

An agent can also shape a space: `collections_list` shows what a space holds,
and `collections_define` publishes a new collection — a poll, an expense, a
reading list — with a JSON Schema, which then syncs to everyone in the space.

The tools are the Node API's actions, with MCP's read-only and destructive
hints set, and a warning on `spaces_invite` since an invite carries a key. What
an agent can do is exactly what the account can do, through the same gates.

`weave mcp` works offline against the folder; with `weave run` on the same folder,
whatever the agent writes is synced within seconds.

## Who gets served

For a **private** space, the client proves it may read before anything moves:
the node sends a random challenge, and the client signs it with the space's
read key, which comes from the space key. The node checks that against the
public read key the space names, so it needs no secret of the space's to do it.
The node then signs the client's challenge with its own key, so the client
knows the welcome comes from the node that sent the challenge. A stranger who
knows the space id gets a challenge and a closed socket, never the ciphertext.
A **public** space is served to anyone, as its data is public anyway.

Writing is checked separately, record by record: in a shared space every record
must carry a signature by the space's write key, and the node refuses any that
doesn't, as every peer does.

## Your node follows your account

Run the node as *your* account (`weave init --existing` with your recovery code)
and it follows the account registry: every space you create or join, on any
device, is served by the node within moments — no invites to hand it. Leaving a
space anywhere leaves it everywhere.

## Not yet

- **WebRTC on the node.** Browsers reach it over WebSocket. `node-datachannel`
  plugs into the same transport seam if measurement says it is needed.
