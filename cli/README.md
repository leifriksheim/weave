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

## Not yet

- **Access control on `/peer`.** Anyone who knows a space id can connect and
  sync, as with a relay room. Private spaces stay encrypted and every write is
  checked, but the ciphertext is served. A signed hello (prove you hold a key
  the space trusts) belongs here next.
- **The node's hello is a claim.** A client trusts the DID a node announces;
  that is fine for data, which is signed, and not fine for anything that treats
  the node as a party.
- **WebRTC on the node.** Browsers reach it over WebSocket. `node-datachannel`
  plugs into the same transport seam if measurement says it is needed.
