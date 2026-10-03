# Weave example

A general-purpose app for your Weave spaces: it shows any kind of data from
what each space says about itself.

It also serves the landing pages for now: `/` for communities (`/why` too, for
older links), `/developers` for developers, and the app itself at `/app`
(`src/site/`). Links made before the move — an invite at `/` — still open the app.
`public/_redirects` sends every path to `index.html` on Netlify. A Vite + React app on top of [`@weaveprotocol/core`](../../README.md). It imports the
protocol straight from its source in the workspace (`packages/core/src`), so
edits to the library hot-reload here.

```bash
npm run dev         # at the repository root: this app on :5173, the account home on :5174, a node and relay on :8787
```

`apps/example/.env.development` and `apps/home/.env.development` point the app
and the home at the rest of `npm run dev`. Override any of them in a
`.env.local`, and the dev host in `packages/cli/.env.host.local`.

## Connecting

This app never signs anyone in. **Connect with Weave** opens the account home
(`home/`, on :5174 in development) in a small window: you make an account or
sign in there, and allow this app your whole account. The home hands back a
note signed by your account for this app's own key; the app keeps it for seven
days and asks again when it runs out. The avatar menu's **Account settings**
opens the home, where passkeys, staying signed in, pods, phones and connected
apps live.

How the account itself works — the password, passkeys, pods, pairing a phone —
is in [home/README.md](../home/README.md).

## The four kinds of space

Two independent choices — who may write, and who may read:

|                | 👤 Personal                                                  | 👥 Shared                                                             |
| -------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| 🔒 **Private** | Encrypted, yours alone. Only your DID's writes are accepted. | Encrypted for whoever holds the invite; the relay never sees content. |
| 🌍 **Public**  | Readable by anyone you hand it to, but only you can write.   | An open space — anyone with the link reads and writes.                |

Each space has its own store, its own sync and its own gossip
room. Sharing one tells a peer nothing about the others.

## Deploying it

The default relay is `ws://localhost:8787`, which is a process on your own
machine. A deployed page has to be told where a real one is:

```bash
VITE_SIGNALING_URL=wss://relay.example npm run build
```

Or several, comma separated — they are used all at once, not as failover:

```bash
VITE_SIGNALING_URL=wss://my-relay.fly.dev,wss://a-friends-relay.example npm run build
```

### Running one

`packages/relay/` has a Dockerfile and a `fly.toml`:

```bash
cd packages/relay
fly launch --no-deploy --copy-config --name my-relay
fly deploy
```

It sleeps when nobody is being introduced (`auto_stop_machines`), so a quiet
relay costs close to nothing — but check Fly's current pricing rather than
trusting that, since their free allowance has changed over time. Anything that
runs a Node process and terminates TLS works just as well: Render, Railway,
a small VPS behind Caddy.

The relay holds nothing worth keeping. Rooms exist only while peers are in
them, and are rebuilt as peers reconnect.

Two rules, and the app now says so on screen rather than quietly failing to
sync:

- **`wss://`, not `ws://`.** A page served over HTTPS is not allowed to open a
  plain websocket; the browser blocks it before it is attempted. So the relay
  needs to be behind TLS — `packages/relay/signaling-server.mjs` speaks plain `ws`, so
  put it behind a reverse proxy, or on a host that terminates TLS for you
  (Fly, Render, Railway), or expose it with `cloudflared tunnel`.
- **Views need at least one relay in common.** Peers with no shared relay never
  meet — which is why the list is used all at once rather than in order, so
  overlapping lists is enough.

The relay only introduces peers — it forwards connection offers and never sees
an expression — so running your own is a small thing, and pointing at someone
else's costs you nothing but availability.

**And it is only needed for the first connection.** Once two peers are talking,
their data channel carries connection offers as happily as it carries records, so
each peer introduces the others it knows. Bring a relay down after everyone has
met and nobody notices; someone arriving later needs one again.

## Giving the node a space

To give the dev node a space, create an invite link in the app and:

```bash
npm run weave -- spaces join --invite '<link>'
npm run weave -- records list --space <id>
```

Close every browser holding the space, open the link somewhere else, and the
records come from the node. Or make the node your own account's (see
[packages/cli/README.md](../../packages/cli/README.md)) and it serves every
space you make, unasked.

## Trying hosting and payments

In the home: Settings, **Keep my spaces online**, **Keep online** (the dev host
is filled in), then one of its plans. What you can pay with:

- **A browser wallet, on by default.** Payments go to Base Sepolia, a test
  network: test money only. In MetaMask (or any browser wallet), get test ETH
  for the fee from a Base Sepolia faucet (Coinbase's, or Alchemy's) and test
  USDC from faucet.circle.com (choose Base Sepolia). Choose the wallet plan,
  then **Pay with this browser's wallet** (or scan the QR code with a phone
  wallet); within a minute the home says "Payment received", shows "paid
  until", and the host takes your spaces. To see payments arrive, set your own
  address as `WEAVE_WALLET_ADDRESS` in `packages/cli/.env.host.local`.
- **A card, in Stripe's test mode.** In `packages/cli/.env.host.local`, add
  `STRIPE_SECRET_KEY=sk_test_…` and the price ids of a monthly and a yearly
  recurring test price (`STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`). With
  the Stripe CLI installed, `npm run dev` forwards Stripe's webhooks to the
  host by itself. Pay with card 4242 4242 4242 4242, any future date, any CVC.

`npm test` covers the same paths without any of this: a fake network, fake
Stripe calls, and the home's side against a real host.

## Sharing with a friend

Open a space → **Create invite link** → send it. They open it, sign in, and the
app offers to join. Both sides then meet in that space's room on the relay and
sync over WebRTC.

The invite lives in the URL **fragment**, which browsers never send to a server —
so a private space's key reaches your friend without passing through the relay, the
page host, or anyone's logs. That also makes the link itself the secret.

**Your own other devices** need no invite: sign in with the same account and
your spaces follow, through the account registry, as soon as another of your
devices — or your always-on node — is online.

To share across machines, point both at the same relay:

```bash
VITE_SIGNALING_URL=wss://your-relay.example npm run dev
```

## What it demonstrates

| Protocol piece         | Where it shows up                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Account home           | Connecting: the home signs a note from the account to this app's own key, and the app never sees the seed              |
| UCAN delegation        | Every record is signed by this app's key, under that note; peers check the chain back to the account                   |
| Spaces                 | Four kinds of space, each with its own database, sync and gossip room                                                  |
| E2EE                   | Private spaces encrypt bodies before signing; a record says _encrypted_ when it had to be opened                       |
| Validation             | Shape, signature and capability checks run on everything, including what peers send                                    |
| Authorization          | A personal space rejects writes not rooted in its owner — the _rejected_ counter shows what was dropped                |
| Derived UI             | Forms, tables, "+ Add …" buttons and tallies worked out from each space's own definitions                              |
| Profiles               | Everyone in a space shown by the name they gave, which only they can change                                            |
| Sync by reconciliation | Peers compare a fingerprint per collection, and reconcile the ones that differ (Negentropy), over WebRTC data channels |
| WebMCP                 | Every node operation as a tool an agent in the page can call                                                           |
| Invites                | Space and key encoded into a fragment-only link                                                                        |
| Contacts               | A private space for two per person; asking someone in a space you share, sealed so only they can read it               |
| Doors                  | A link that lets someone you share no space with knock, without your account becoming an address                       |

### Derived UI

A space opens on its **Apps** tab: apps built on the standard schemas (a chat,
a kanban board, polls and decisions) show up once the space holds the
collections they need, and adding one defines what is missing. The
**Collections** tab lists every collection down the side. Each one is a list
you can search and add to in one line, or a table, or (when it has a field with
fixed choices) a board you drag cards across; a yes/no field becomes a checkbox
on each row. A record opens in a panel beside the list: its fields as
properties you edit in place, what it points at and what points at it, and
reactions, tags and comments once the space has added them from the library.
Every collection that declares a link to this one gets a "+ Add …" button:
define `app.poll.vote` with `about → app.poll` and every poll gets "+ Add
vote". Choices show by their label (`oneOf`, `x-choicesFrom`), so a vote
stored as `1` shows as "Lisbon", its form offers the poll's options, and the
poll shows a tally. The helpers are pure functions
(`src/derive/schema-ui.ts`). An empty space offers a small "define a
collection" form; an agent can do the same over WebMCP.

### Calls

Every space you have a role in has "Start a call" at the top, or "Join call ·
3" while one is going on, and People & roles has "Call" beside each member,
which rings them. The call sits in a panel in the corner, over whatever page
you're on, so you keep talking as you move around; the sidebar marks the space
a call is in. The panel grows to fill the screen, or moves into a
picture-in-picture window where the browser has one. Someone ringing you shows
as a card on any page. The **Calls** app keeps a log of a space's calls
(`std.call`). `createCalls` is made once in `App.tsx`, above everything that
changes as you move around.

### Agents

**In the browser (WebMCP).** When `/app` loads, it registers every node
operation as a WebMCP tool on `document.modelContext` (`src/webmcp.ts`, with
`@mcp-b/webmcp-polyfill`: Chrome's own WebMCP when present, a polyfill
otherwise). A browser agent sees the same tools as the CLI and `weave mcp`,
and works as the person, with nothing to switch on: anything that can call a
page's tools can already click through the page. It isn't offered
`collections_define`: it proposes apps (`apps_propose`) and a person adds
them. Anything that changes a space's people, or hands out its key, asks the
person first. An app may bring its own screen, which the example runs in a
sandboxed frame with no network ([screens and apps](../../packages/core/docs/screens-and-apps.md)).

**On your computer (Claude Code, Claude Desktop, Cursor).** "Connect an
agent", in the account menu, shows one command:
`npx @weaveprotocol/cli connect wv_…`. The person allows it at their account
home, and the command adds `weave` to the agents it finds, which start
`weave mcp` themselves: a node of its own that keeps working with every tab
closed. See [agents](../../packages/core/docs/agents.md).

### Mini apps

[Liquid](../liquid/) is a standalone app for one job: an assembly votes on
proposals, and anyone can trust a person or a party with their vote, topic by
topic, and take it back. Its collections are its own
(`apps/liquid/src/schema.ts`), every device counts the votes the same way
(`apps/liquid/src/tally.ts`, tested in `apps/liquid/tests/`), and what it can't
promise is on its own **?** page.

It is written once and runs two ways: as its own site, and as one of this
app's apps, on the same records. The contract is `MiniApp` in
`apps/shared/src/mini-app.ts`: the collections the app needs, its icon, and a
`Space` component that shows one space in whatever frame it gets. Liquid
exports one (`@weave/liquid/app`, from `apps/liquid/src/mini-app.tsx`), its
standalone shell wraps the same `Space` in a header of its own, and this app
lists it with `fromMiniApp` (`src/components/apps/index.tsx`). A new one is a
workspace under `apps/` that exports a `MiniApp`, plus one line in `APPS`.

## Layout

```
src/
  main.tsx                 # routes: /, /why and /developers (site/), /app (the app), /connect (the account home)
  weave.ts                 # this app's Weave setup: one sign-in flow, and where peers meet
  App.tsx                  # sign in (<WeaveAuth />), then your spaces and contacts
  spaces.ts                # invite links
  contacts.ts              # door links, and the contact list kept current
  webmcp.ts                # node operations as WebMCP tools
  derive/                  # pure helpers: UI from schemas and links, names from profiles
  components/              # spaces, collections, records, security (sign-in is <weave-auth>)
  site/                    # the landing pages
```

## Still to do

- **Contacts.** The Contacts screen warns when someone else is in a space for two; it should offer the choice between starting a group and letting them stay. Door codes as QR codes too, not only links.
- **The Apps tab.** A coded app wins over an agent-made one with the same collections.
- **Hosting.** An "Always online" mark on spaces a host keeps.
- **Notifications.** "Notify me when I'm mentioned" in chat; and showing them with the app closed, which needs a service worker and Web Push ([spec 06 §6.4](../../spec/06-nodes-and-sessions.md)).
- **Agents.** A connect dialog left open keeps a relay connection; it should let go.
- **Compatible definitions in the Apps tab.** Open apps by compatibility (`readiness()` in `components/apps/index.ts`) and show what breaks, once definitions can be compared ([02](../../spec/02-records.md), compatible definitions).
- **Typed queries.** Move `src/collections.ts` onto typed collections and drop the hand-written record interfaces.

## Not production

Peer discovery depends on a relay being reachable by both sides, and calls
between peers behind strict NATs need a relay configured with TURN
([packages/relay](../../packages/relay/README.md)).
