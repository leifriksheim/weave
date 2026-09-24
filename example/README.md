# Weave example

A general-purpose app for your Weave spaces: it shows any kind of data from
what each space says about itself.

It also serves the landing pages for now: `/` for people, `/developers` for
developers, and the app itself at `/app` (`example/src/site/`). Links made
before the move — an invite or a phone-pairing code at `/` — still open the app.
`public/_redirects` sends every path to `index.html` on Netlify. A Vite + React app on top of [`weave-protocol`](../README.md). It imports the
protocol straight from `../src`, so edits to the library hot-reload here.

```bash
npm install
npm run dev:full    # app on :5173 and the signaling relay on :8787
```

`npm run dev` runs the app alone — everything works except finding other peers.

## Signing in

**First: where your data lives.** A *pod* — a folder on your computer that any
Weave app you point at it can open — or just this browser, which no other app
can reach. Asked first because a pod may already hold your account; once
answered it is remembered, and a pod is reopened without asking.

**Then: do you have a Weave account?** Sign in with your account password, or
create one.

**Create an account.** Pick a name; the app generates a strong password and
shows it once. Save it to your password manager — that is the whole credential,
and it is the only thing that works on an app which has never seen you.

It is not a backup of your key. It *is* your key, written out, which is why it
needs nothing stored to work. A password that unlocks something needs that
something to be present, and on a new domain it is not.

**On another app, on another domain**: paste the same password. Your password
manager scopes entries by address, so it will not offer it unprompted — search
the vault, or add the second address to the same entry. Once is enough: after
that, add Touch ID or a short password from the avatar menu and this app never
asks again.

### Several accounts in one place

A folder is a disk, not a person. It can hold work and personal, or two people
sharing a laptop. The picker lists them with an avatar derived from each DID, so
the wrong one is obvious before you have read the name, and the one you used
last is expanded already.

The list of names and DIDs is readable without unlocking anything — you cannot
offer a choice without knowing what to call it. The keys are not.

### The two ways in

| | Works where | For |
|---|---|---|
| Account password | Anywhere, including a domain that has never seen you | The real credential |
| A passkey | This browser only | Not reaching for the password every time |

The second is a shortcut holding the same seed encrypted another way. Adding one
is how a second app becomes a second door into one account rather than a second
account — no delegation, just another entry in a file.

There was a third — a short password for one device — and it is gone. Once the
account password is saved in a password manager it fills itself in, so a second
password for the same account bought nothing and cost a vault entry people had
to tell apart from the first. The machinery is still in `accounts.ts` for an app
that wants it; nothing offers it here.

**Every passkey provider works** — Bitwarden, 1Password, iCloud, Touch ID —
because the passkey is not asked for key material. Only the PRF extension can
give a passkey's secret to a site, and several popular managers store passkeys
without it. So the passkey confirms it is you, and the key that actually opens
the account is a random one kept in this browser, non-extractable.

Be clear about what that means: **the gate is enforced by this app's code, not
by cryptography.** Anything that can read this origin's storage can use the key
without ever meeting the passkey. What it does protect is the case the vault
exists for — someone holding a copy of your folder, who has the wrapped seed and
none of this. Against a compromised browser profile it buys only that the key
cannot be copied out and used elsewhere.

The stronger option was to derive the key from PRF, binding it to the
authenticator. That was traded for working everywhere. If you want it back it
belongs as a second tier, labelled differently, not as a silent upgrade.

## The four kinds of space

Two independent choices — who may write, and who may read:

|  | 👤 Personal | 👥 Shared |
|---|---|---|
| 🔒 **Private** | Encrypted, yours alone. Only your DID's writes are accepted. | Encrypted for whoever holds the invite; the relay never sees content. |
| 🌍 **Public** | Readable by anyone you hand it to, but only you can write. | An open space — anyone with the link reads and writes. |

Each space has its own Merkle Search Tree, its own store and its own gossip
room. Sharing one tells a peer nothing about the others.

## Adding your phone

Sign in, and on the screen showing your spaces open **Add your phone** — the
collapsed section below them, next to "How it works". It is there rather than
inside a space because it hands over the whole account, not one space.

Click **Show pairing code**, point your phone's camera at the QR, and open the
link it offers. There is no scanner in the app —
iPhone and Android both read a URL out of a QR natively, which is also why this
works in Safari.

The code holds a link whose fragment carries your recovery code and the relay
address. A fragment never reaches a server, so the secret goes straight from
your screen to your phone. Treat the code on screen like the recovery code it
contains: anyone who photographs it gets the account.

The list of spaces is deliberately *not* in the QR — it would not fit, and a
denser code is a code your camera struggles with. Instead both devices work out
the same private room from the seed, meet there over WebRTC, and your computer
sends the spaces across encrypted. Once that is done the phone is a full peer: it
holds its own copy, syncs with anyone in the space, and never needs your
computer again.

Two things to know before it works:

- **Your phone cannot reach `localhost`.** Start with `npm run dev -- --host` and
  open the network address Vite prints. The app says so if you forget.
- **`crypto.subtle` needs a secure context**, which a plain `http://192.168.x.x`
  is not — the app will not run there. Use HTTPS on the LAN (`@vitejs/plugin-basic-ssl`,
  then accept the certificate warning on the phone) or a tunnel like `cloudflared`.

This needs a session that *has* a seed — a data folder or a recovery code. A
passkey sign-in has nothing to hand over: its secret never leaves the
authenticator as something you could photograph. The panel says so rather than
offering a button that cannot work.

On connectivity: WebRTC uses Google's public **STUN** servers by default
(`rtc-transport.ts`), which is enough for two devices on the same Wi-Fi and
usually enough across networks. There is no free public **TURN** — it relays your
actual traffic — so if you need to cross a hostile NAT, bring your own
(Cloudflare has a free tier) and pass it as `iceServers`.

## Seeing the cross-origin part work

Two origins on one machine are enough, and they have to share a relay — peers
pointed at different ones never meet, however identical everything else is:

```bash
npm run signal                              # in the project root, port 8787
npm run dev                                 # http://localhost:5173/app
npm run dev -- --port 5174                  # a second "domain"
```

`localhost:5173` and `localhost:5174` are separate origins with separate
IndexedDB. Choose the *same pod* in both and the second one arrives at the
same DID and the same spaces. Add a record in one and it shows up in the other
within a couple of seconds — the folder is polled, because the web has no
filesystem change notification.

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
| Account | A 16-byte seed → a P-256 `did:key`; its written form is the password you save |
| UCAN delegation | The root issues a 1-hour UCAN to a per-tab, memory-only session key |
| Stay signed in | The seed kept under a non-extractable device key, for as long as the Security page says |
| Pods | A folder any origin can open: the same account and spaces in every app pointed at it |
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
  main.tsx                 # routes: / and /developers (site/), /app (the app)
  protocol.ts              # the session: node, signer, stores, network
  accounts.ts              # homes (browser or pod), accounts, ways in, moving pods
  remember.ts              # staying signed in on this device
  spaces.ts                # invite links
  webmcp.ts                # node operations as WebMCP tools
  derive/                  # pure helpers: UI from schemas and links, names from profiles
  hooks/                   # React bindings
  components/              # onboarding, spaces, collections, records, security
  site/                    # the landing pages
```

## Not production

Peer discovery depends on a relay being reachable by both sides, and there is
no TURN configuration for peers behind strict NATs beyond the defaults. Access
to a private space cannot be revoked yet: its key never rotates.
