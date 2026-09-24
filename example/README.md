# Weave example

A general-purpose app for your Weave spaces: it shows any kind of data from
what each space says about itself.

It also serves the landing pages for now: `/` for developers, `/why` for
people, and the app itself at `/app` (`example/src/site/`). Links made
before the move — an invite at `/` — still open the app.
`public/_redirects` sends every path to `index.html` on Netlify. A Vite + React app on top of [`weave-protocol`](../README.md). It imports the
protocol straight from `../src`, so edits to the library hot-reload here.

```bash
npm run dev         # at the repository root: this app on :5173, the account home on :5174, a node and relay on :8787
```

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

|  | 👤 Personal | 👥 Shared |
|---|---|---|
| 🔒 **Private** | Encrypted, yours alone. Only your DID's writes are accepted. | Encrypted for whoever holds the invite; the relay never sees content. |
| 🌍 **Public** | Readable by anyone you hand it to, but only you can write. | An open space — anyone with the link reads and writes. |

Each space has its own Merkle Search Tree, its own store and its own gossip
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

`server/` has a Dockerfile and a `fly.toml`:

```bash
cd server
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
  needs to be behind TLS — `server/signaling-server.mjs` speaks plain `ws`, so
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

| Protocol piece | Where it shows up |
|----------------|-------------------|
| Account home | Connecting: the home signs a note from the account to this app's own key, and the app never sees the seed |
| UCAN delegation | Every record is signed by this app's key, under that note; peers check the chain back to the account |
| Spaces | Four kinds of space, each with its own MST, database and gossip room |
| E2EE | Private spaces encrypt bodies before signing; a record says *encrypted* when it had to be opened |
| Validation engine | Signature, schema and capability gates run on everything, including what peers send |
| Authorization | A personal space rejects writes not rooted in its owner — the *rejected* counter shows what was dropped |
| Derived UI | Forms, tables, "+ Add …" buttons and tallies worked out from each space's own definitions |
| Profiles | Everyone in a space shown by the name they gave, which only they can change |
| Anti-entropy sync | Peers reconcile MST roots over WebRTC data channels |
| WebMCP | Every node operation as a tool an agent in the page can call |
| Invites | Space and key encoded into a fragment-only link |

## Layout

```
src/
  main.tsx                 # routes: / and /why (site/), /app (the app), /connect (the account home)
  weave.ts                 # this app's Weave setup: one sign-in flow, and where peers meet
  App.tsx                  # sign in (<WeaveAuth />), then your spaces
  spaces.ts                # invite links
  webmcp.ts                # node operations as WebMCP tools
  derive/                  # pure helpers: UI from schemas and links, names from profiles
  components/              # spaces, collections, records, security (sign-in is <weave-auth>)
  site/                    # the landing pages
```

## Not production

Peer discovery depends on a relay being reachable by both sides, and there is
no TURN configuration for peers behind strict NATs beyond the defaults. Access
to a private space cannot be revoked yet: its key never rotates.
