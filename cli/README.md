# p2p — the protocol from a terminal

One program, three jobs:

- **Manage your spaces** — every command the Node API has, as `p2p spaces …` and `p2p records …`
- **Run an always-on node** — `p2p run` keeps every space syncing, serves sockets browsers dial into, and is a relay too
- **Hand your spaces to an agent** — `p2p mcp` exposes the same operations over MCP

It uses the same data folder layout a browser does. Point `--home` at the folder
you picked in Chrome and the CLI, the daemon and the browser all share one
account.

## Quick start

In this repo, `npm run dev` (at the root) already runs a node with a throwaway
identity, and `npm run p2p -- <command>` talks to it — no setup.

To make the dev node *your* account's node — so it serves every list you make
in the browser, with nothing to hand it — give it your account password once:

```bash
rm -rf .p2p-dev                                  # drop the throwaway identity
P2P_RECOVERY_CODE='XXXX-…' npm run p2p -- init --existing --passphrase --name Me
npm run dev
```

To have `p2p` everywhere:

```bash
cd cli && npm install && npm link          # or a binary with no Node at all: bun build.ts --native
```

```bash
p2p init --name Leif --passphrase          # prints your recovery code once
export P2P_PASSPHRASE='…'                  # so later commands don't ask

p2p spaces create --name Groceries --type shared --visibility private
p2p records put --space <id> --collection app.todo.item --body '{"text":"milk","completed":false,"order":1}'
p2p records list --space <id>
p2p spaces invite --space <id>             # a secret: it carries the space key
p2p spaces join --invite 'https://…#invite=…'
p2p run                                    # stay up and serve; --create makes an account on first start
```

Every data command is an action from `NODE_ACTIONS`: `p2p records put` runs
`records_put`, and its flags are that action's input fields. `p2p actions`
prints them all with their schemas. `--json '{…}'` passes an input whole.

## Unlocking

Secrets never go on the command line, where `ps` shows them:

| | |
|---|---|
| `P2P_RECOVERY_CODE` or `--code-file FILE` | the account's recovery code |
| `P2P_PASSPHRASE` or `--passphrase-file FILE` | a passphrase added with `init --passphrase` |
| neither | you are asked, without echo |

Nothing ever writes the seed in the clear: the account file holds only wrapped
copies, exactly as in a browser folder.

## The always-on node

```bash
p2p run --port 8787
```

- `ws://host:8787/peer?space=<id>` — the protocol's WebSocket transport. Browsers
  reach it with `network: { nodes: ['wss://host/peer'] }` (the example app reads
  `VITE_P2P_NODES`). No relay, no TURN.
- `ws://host:8787?room=<id>` — the signaling relay, so one process bootstraps a space.
- `GET /health`

It opens every space the account holds and notices new ones within five
seconds, whoever added them: `p2p spaces join` in another terminal, a browser
pointed at the same folder, a pairing. It validates everything with the same
gates as any peer. It is an **anchor, not a host** — uptime, no authority.

For a server, `bun build.ts` makes single-file binaries for this machine,
`linux-x64` and `linux-arm64`; `p2p-node.service` is a systemd unit.

## Agents

```json
{ "mcpServers": { "p2p": { "command": "p2p", "args": ["mcp"], "env": { "P2P_PASSPHRASE": "…" } } } }
```

The tools are the Node API's actions, with MCP's read-only and destructive
hints set, and a warning on `spaces_invite` since an invite carries a key. What
an agent can do is exactly what the account can do, through the same gates.

`p2p mcp` works offline against the folder; with `p2p run` on the same folder,
whatever the agent writes is synced within seconds.

## Who gets served

For a **private** space, both ends prove they hold the space key before
anything moves: the node sends a random challenge, the client answers with a MAC
over it, and the node answers the client's challenge the same way. A stranger
who knows the space id gets a challenge and a closed socket, never the
ciphertext; a node that cannot prove it is dropped by the client. A **public**
space is served to anyone, as its data is public anyway.

## Your node follows your account

Run the node as *your* account (`p2p init --existing` with your recovery code)
and it follows the account registry: every space you create or join, on any
device, is served by the node within moments — no invites to hand it. Leaving a
space anywhere leaves it everywhere.

## Not yet

- **WebRTC on the node.** Browsers reach it over WebSocket. `node-datachannel`
  plugs into the same transport seam if measurement says it is needed.
