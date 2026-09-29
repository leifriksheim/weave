# weave — the protocol from a terminal

One program, three jobs:

- **Manage your spaces** — every command the Node API has, as `weave spaces …` and `weave records …`
- **Run an always-on node** — `weave run` keeps every space syncing, serves sockets browsers dial into, and is a relay too
- **Connect an agent** — `weave connect <code>`, then Claude Code, Claude Desktop or Cursor starts `weave mcp` by itself, or `weave agent` runs it on its own

It uses the same data folder layout a browser does. Point `--home` at the folder
you picked in Chrome and the CLI, the daemon and the browser all share one
account.

## Quick start

In this repo, `npm run dev` (at the root) already runs a node with a throwaway
identity, and `npm run weave -- <command>` talks to it — no setup.

To make the dev node _your_ account's node — so it serves every list you make
in the browser, with nothing to hand it — give it your account password once:

```bash
rm -rf .weave-dev                                  # drop the throwaway identity
WEAVE_RECOVERY_CODE='XXXX-…' npm run weave -- init --existing --passphrase --name Me
npm run dev
```

To have `weave` everywhere:

```bash
npm install -g @weaveprotocol/cli            # or run it without installing: npx @weaveprotocol/cli <command>
```

From this repo: `npm install` at the repo root (the CLI is a workspace), then `cd packages/cli && npm run bundle && npm link`, or a
binary with no Node at all: `bun build.ts --native`.

```bash
weave init --name Leif --passphrase          # prints your recovery code once
export WEAVE_PASSPHRASE='…'                  # so later commands don't ask

weave spaces create --name Groceries --visibility private --roles team
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

|                                                |                                             |
| ---------------------------------------------- | ------------------------------------------- |
| `WEAVE_RECOVERY_CODE` or `--code-file FILE`    | the account's recovery code                 |
| `WEAVE_PASSPHRASE` or `--passphrase-file FILE` | a passphrase added with `init --passphrase` |
| neither                                        | you are asked, without echo                 |

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
- `GET /health` — `{"ok":true}`, nothing more

It listens on this machine only (`127.0.0.1`). On a server, put it behind
whatever terminates TLS — browsers need `wss://` anyway — or pass
`--host 0.0.0.0` to listen on every interface.

It opens every space the account holds and notices new ones within five
seconds, whoever added them: `weave spaces join` in another terminal, a browser
pointed at the same folder, a pairing. It validates everything with the same
gates as any peer. It is an **anchor, not a host** — uptime, no authority.

For a server, `bun build.ts` makes single-file binaries for this machine,
`linux-x64` and `linux-arm64`; `weave-node.service` is a systemd unit.

## Hosting other people's spaces

`weave host` is a hosting service in one process. It carries every paying
account's spaces — sealed, as they travel — and serves them over sockets and a
relay, like `weave run`. It holds no account and no space key.

```bash
# Try it on this machine: every subscription counts as paid
weave host --free --port 8787

# Host only yourself and your family, on a server: the accounts named, and nobody else
weave host --free --host 0.0.0.0 --allow did:key:zDnae… --allow did:key:zDnae…

# As a service: Stripe for payments, R2 (or any S3) for storage
STRIPE_SECRET_KEY=sk_live_… STRIPE_WEBHOOK_SECRET=whsec_… \
STRIPE_PRICE_MONTHLY=price_… STRIPE_PRICE_YEARLY=price_… \
WEAVE_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com WEAVE_S3_BUCKET=weave-host \
WEAVE_S3_ACCESS_KEY_ID=… WEAVE_S3_SECRET_ACCESS_KEY=… \
weave host --host 0.0.0.0 --port 8787 --data /var/lib/weave-host
```

- `--free` on an address others can reach needs `--allow` (or
  `WEAVE_HOST_ALLOW`, comma separated): otherwise anyone who found it could
  fill its disk. An account's DID is under its name in the account home's
  Settings, with a Copy button. `--allow` works on a paying host too.
- The host's key is made once, in `--data` (`host-key`, readable by you alone).
  A new key is a new host: every account would hand its spaces over again.
- Point Stripe's webhook at `https://<host>/host/billing/webhook`, sending
  `checkout.session.completed` and `invoice.paid`.
- Every host serves its own **pay page** at `/pay`. Homes know nothing about
  payment: they open that page in a new tab with a link signed for the
  subscription, and read the status the host signs. Say who you are with
  `WEAVE_HOST_NAME`, `WEAVE_HOST_PRICE` (text, like "$4 a month"),
  `WEAVE_HOST_TERMS` and `WEAVE_HOST_URL` (your public https:// address,
  where Stripe sends people back to). It's all at
  `/.well-known/weave-host`.
- Crypto wallets pay with no company in between: USDC on Base, sent straight
  to your address. Next to Stripe, or instead of it:

  ```bash
  WEAVE_WALLET_ADDRESS=0x… WEAVE_WALLET_MONTHLY=4 WEAVE_WALLET_YEARLY=36 \
  weave host --host 0.0.0.0 --port 8787 --data /var/lib/weave-host
  ```

  The pay page asks the person's browser wallet (MetaMask, Coinbase Wallet,
  Rabby…) to send the plan's price plus a fraction of a cent that marks it as
  theirs; the host reads the network to see it arrive, then adds a month or a
  year. Time is paid up front. `WEAVE_WALLET_NETWORK=base-sepolia` tries it
  with test USDC; `WEAVE_WALLET_RPC` points at a network node of your own or a
  provider's (default: the network's public one). Keep the address's private
  key off the host — it only needs to receive.

- Phone wallets and every other wallet, by QR code: set
  `WEAVE_WALLETCONNECT_PROJECT_ID` (free at dashboard.reown.com) and build the
  WalletConnect bundle once with `npm run bundle:pay` in `cli/` (the published
  package has it built).
- With a bucket, the disk is only a cache: lose it, start on the same key and
  bucket, and every subscription and space comes back.
- Put it behind something that terminates TLS (Caddy does it in two lines).
  The account home offers it under **Keep my spaces online** when built with
  `VITE_WEAVE_HOST=https://<host>`.

## Agents

In an app, choose **Connect an agent** in the account menu. It shows one
command:

```bash
npx @weaveprotocol/cli connect wv_…      # in this repo: npm run weave -- connect wv_…
```

It makes a key for this computer's agent (it never leaves `~/.weave/agent/`),
finds the app through the relay, and waits while you allow it at your account
home, which signs an agent's note for your whole account, for as long as you
chose. Then it adds `weave` to Claude Code (`claude mcp add`), Claude Desktop
and Cursor, where it finds them. `--no-configure` prints the config instead,
`--name` changes what you see ("Agent on leifs-macbook"), and `--relay` adds
one the app uses (`$WEAVE_RELAYS` sets the defaults).

From then on the agent starts `weave mcp` itself. It's a node of its own: it
follows your account's list of spaces, meets your other devices over WebRTC,
and keeps working with every tab closed. What it writes shows "via agent". It
isn't offered what needs a person (making, joining or leaving spaces, invites,
roles, defining collections): it proposes apps with `apps_propose`, and you add
them. `weave disconnect` forgets it on this computer; disconnecting it in your
account home stops its note working everywhere.

`weave mcp --account` serves the unlocked account instead, as you:

```json
{
  "mcpServers": {
    "weave": { "command": "weave", "args": ["mcp", "--account"], "env": { "WEAVE_PASSPHRASE": "…" } }
  }
}
```

It works offline against the folder; with `weave run` on the same folder,
whatever the agent writes is synced within seconds.

### The agent on its own

`weave agent` runs the connected agent without a chat client: its own node,
and a chat with it in this terminal. It thinks with your own Anthropic API key,
from `ANTHROPIC_API_KEY`, or asked for once and kept in
`~/.weave/agent/anthropic-key`, readable only by you.

```bash
npx @weaveprotocol/cli connect wv_…      # once
npx @weaveprotocol/cli agent             # in this repo: npm run weave -- agent
```

It has the tools `weave mcp` serves an agent, and the same limits. Anything
that deletes or overwrites asks you first (and is refused when input is piped).
Every model call is priced; after each answer it shows what it cost, and once
today's spend reaches `--daily-cap` (dollars, default 2) it starts no more calls
until tomorrow. `--model` picks the model (default `claude-opus-5-5`, or
`$WEAVE_AGENT_MODEL`); it must be one whose price it knows.

Only one of `weave agent` and `weave mcp` can use an agent at a time: they sign
with the same key, and the relay lets one in.

It also runs your **watches**: `std.watch` records saying what to do when
some records appear or change, or at set times, in any space ("when a task is
given to me, add it to my weekly plan note"; "weekdays at 8, plan my day").
Each run starts a fresh conversation, with nobody there to allow deleting or
overwriting, so those are refused. Runs share the daily cap. Ask the agent to
keep an eye on something and it writes a watch as a suggestion; it starts once
you turn it on in an app that shows watches (the example app's **Watches**).
What the agent writes never sets a watch off.

`--no-chat` runs only the watches, until stopped: on a server, or in the
background.

### A bot for a space

`weave agent --bot` runs an account of its own as a **bot**: something a
community adds to its spaces to help everyone, rather than one person's
agent. Where a space keeps `std.profile`, it sets `bot: true` on its own
there, so apps can show it as one; elsewhere its name has to say so. It writes
as itself, and every member's device checks what it writes against its role.
People mention it by its own name.

```bash
weave --home ~/club-bot init --name "Club Bot" --passphrase
weave --home ~/club-bot spaces join --invite 'https://…#invite=…'   # an invite with the role it should hold
weave --home ~/club-bot agent --bot --no-chat
```

It runs the watches in a space written by members holding
`std.watch/instruct` there (admins and moderators in the community preset),
in that space only. A watch's `from` narrows what sets it off to records by
some roles, so `"from": ["member"]` is "a mention from anyone with a role".
`--daily-cap-each` limits what each person who sets it off may spend in a
day, a quarter of `--daily-cap` unless given, so nobody can spend the day for
everyone.

Give it a role that can do what it is for and no more: a misled bot can do
only what its role allows.

## Who gets served

Every peer first proves the DID it gives is its own: the node sends a random
challenge, and the client signs it with the key that DID names. So nobody can
connect under someone else's name and knock them off the node.

For a **private** space, the client also proves it may read before anything
moves: it signs the same challenge with the space's read key, which comes from
the space key. The node checks that against the
public read key the space names, so it needs no secret of the space's to do it.
The node then signs the client's challenge with its own key, so the client
knows the welcome comes from the node that sent the challenge. A stranger who
knows the space id gets a challenge and a closed socket, never the ciphertext —
the same answer as for a space the node does not hold, so a web page cannot ask
your node which spaces you have.
A **public** space is served to anyone, as its data is public anyway.

Writing is checked separately, record by record: its author must hold a role in
the space, as of the access history the record says it saw, and the node
refuses any that doesn't, as every peer does. Roles and members are kept in the
clear, so a node holding no key of a private space still judges its writes.

## Your node follows your account

Run the node as _your_ account (`weave init --existing` with your recovery code)
and it follows the account registry: every space you create or join, on any
device, is served by the node within moments — no invites to hand it. Leaving a
space anywhere leaves it everywhere.

## Not yet

- **WebRTC on the node.** Browsers reach it over WebSocket. `node-datachannel`
  plugs into the same transport seam if measurement says it is needed.
- **Publishing.** `weave-protocol-cli` on npm (or a built JS package), and
  trying the Bun binary with `node-datachannel`.
- **Hosting, before it's offered to anyone.**
  - A load test with 1,000 spaces, with metrics. Check the pricing against those numbers, and decide on TURN from them.
  - A real Stripe test-mode run end to end, and a decision on Stripe Tax or a merchant of record.
  - A breach plan.
- **The pay page.**
  - A real Base Sepolia wallet payment.
  - A Lightning route (BTCPay), and gasless USDC (EIP-3009).
  - An optional email for reminders: SMTP, with double opt-in.
- **TURN.** Run coturn with `use-auth-secret` and quotas, and set
  `TURN_SECRET` and `TURN_URLS` on the relay and the node. Then test calls
  across real networks, behind a strict NAT, in Safari, and on a phone
  switching apps.

What the protocol still has planned is in [the spec](../../spec/README.md),
under **Planned** in each part.
