# BLOCK-20 — Connect an agent with one command

> **Status (2026-09-25):** built on branch `agent-made-apps`. Checked end to
> end in a real browser: app → command → terminal → account home → a message
> the terminal's agent wrote shows in the tab as "Ada via agent". What's left
> is under "Still open" at the end.

## What this delivers

Before this there were two switches in the account menu, "Let an agent help"
and "Desktop agents", and it wasn't clear how they differed. One was about
permission (a note for an agent's key), the other about reaching the tab (a
relay program on localhost). Now there's one idea per kind of agent:

| | Agent in this browser | Agent on this computer |
|---|---|---|
| Examples | Claude in Chrome, an extension | Claude Code, Claude Desktop, Cursor |
| Setup | Nothing | "Connect an agent" → one command |
| Acts as | You | Its own key, "via agent" |
| Needs the tab open | Yes, it lives there | No, it runs a node of its own |
| Relay sees the traffic | — | No, only the introduction |

The flow for a computer agent:

1. Avatar menu → **Connect an agent**. A dialog shows
   `npx weave-protocol-cli connect wv_…` and a copy button, and a choice of
   how long it may work (1 day, 1 week, 30 days, 1 year).
2. The person pastes it in a terminal. The terminal makes a key, finds the
   tab through the relay, and says who it is ("Agent on leifs-macbook").
3. The dialog shows "“Agent on leifs-macbook” wants to connect". **Allow**
   opens the account home, which says what an agent can and can't do, and
   signs an agent's note for the whole account.
4. The terminal keeps the note, adds `weave` to Claude Code, Claude Desktop
   and Cursor where it finds them, and says so. The dialog says
   "✓ Connected".
5. From then on, the agent's client starts `weave mcp` by itself: a node that
   follows the account, meets the person's devices over WebRTC, and keeps
   working with every tab closed.

## Why it's shaped like this

**The browser agent needs no note.** Anything that can call a page's WebMCP
tools can already click through that page, read it, and run code in it. A
separate key doesn't stop it doing anything; it only added a step. So WebMCP is
always on and acts as the person. Two things stay, because the agent reads
other people's writing and any of it may try to steer it: removing,
overwriting, joining or handing out a key asks first, and `collections_define`
isn't offered, so the agent proposes apps and the person adds them. The
localhost relay (`@mcp-b/webmcp-local-relay`) is gone. It was the one way
something outside the tab could reach these tools.

**The computer agent does need its own key.** It's a separate program on a
separate "device", running when no tab is open. Its own key is what makes "via
agent" true everywhere, and what lets every device refuse it changing
collections, roles, or the account.

**Precedent.** This copies Sanity's and Supabase's MCP setup: one command,
then approve in a browser, with access that runs out (Sanity: 7 days). It
differs where those servers can read your data: here the MCP server is a node
on your own computer, and nothing in between can read what it says.

**The code, not a token.** The code is a random 128-bit secret, made for one
connection. Both sides derive a meeting room and an AES key from it
(`src/session/agent-link.ts`, the phone pairing's arrangement with a fresh
secret instead of the seed). Everything said over the link is sealed with that
key, so the relay, which introduces the two sides and could sit between them,
learns nothing and can change nothing. The code is pasted, not typed, so it
can be long enough that recording the traffic and guessing it later gets
nowhere. It works once, only while the dialog is open, and the terminal's key
is made on the terminal and never sent anywhere. The note is the only thing
that travels, and it's only useful with that key.

**WebRTC in the CLI.** Browsers can't accept connections, so two devices behind
home routers only meet over WebRTC. The CLI uses `node-datachannel` (libdatachannel,
widely used, the same browser API), loaded only by `connect` and `mcp`. The
network layer takes several transports, so sockets to an always-on node
(`WEAVE_NODES`) work alongside.

## What was built

- **`src/session/agent-link.ts`**: `offerAgentLink` (the app's side, with
  stages waiting → asking → connected/failed), `acceptAgentLink` (the
  terminal's side), `checkAgentGrant`, and the code (`newAgentCode`,
  `readAgentCode`, which finds a code in anything pasted, the whole command
  included). Messages: ask → heard → answer (grant or no) → done.
- **Home** (`auth.ts`, `connect.ts`): an agent may now be given the whole
  account (`scope: 'account'`, never spaces made for it). A request carries
  `days` (1–365). Agents are connections of their own, named by their key, so
  one app can connect several and each disconnects alone
  (`disconnect(origin, { audience })`). `connectToHome` takes an `audience`,
  for a key that lives elsewhere.
- **The account's own spaces refuse agents** (`peopleOnly` in
  `space-runtime.ts`, for the account's list of spaces and carry spaces). A
  whole-account note says `*`, which would otherwise let an agent write the
  account's list of spaces, and so make every device join or leave one. A node
  running under an agent's note never tries: no list of spaces, no passes, no
  name (`agentSession` in `node.ts`).
- **CLI** (`cli/src/agent.ts`, `cli/src/clients.ts`): `weave connect <code>
  [--name] [--relay] [--no-configure]`, `weave disconnect`, and `weave mcp`,
  which now serves the connected agent (`--account` serves the unlocked
  account, as before). The agent's tools leave out what needs a person, and
  its instructions say to propose apps. Kept in `<home>/agent/`: `key.json`,
  `grant.json`, `data/`, readable only by the user.
- **Example**: `ConnectAgent.tsx`, the menu item, `webmcp.ts` acting as the
  person. `VITE_WEAVE_CONNECT` sets the command (`npm run weave -- connect` in
  development).
- **Tests**: the link (right code, wrong code, saying no), a whole-account
  agent node finding spaces made before and after it connected, and refusing
  to write the account; the home's agent connections; the MCP tool list for an
  agent.

## Still open

- **Publishing the CLI.** The dialog says `npx weave-protocol-cli connect`,
  which needs the package on npm. `bin/weave.mjs` runs the TypeScript through
  tsx; a built JS package would start faster. The compiled Bun binary has not
  been tried with `node-datachannel`.
- **Renewing.** When the note runs out, the agent says to connect again. It
  could ask the tab for a new note instead, while one is open.
- **Agents in the cloud** (claude.ai connectors, the mobile app) can't start a
  local program. They'd need an HTTPS endpoint on a relay, which would then see
  the traffic. Not built; to be offered as a clearly labelled option if at all.
- **Spaces granted by name** still work (`scope: 'spaces'`), but nothing asks
  for them now. The dialog always asks for the whole account.
- **Two tabs, one code.** Each open dialog makes its own code, so this is
  fine, but a dialog left open keeps a relay connection until it's closed.
