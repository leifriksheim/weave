# Weave home

Your own account home: the one place your Weave account is ever unlocked.

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/leifriksheim/weave&base=home)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/leifriksheim/weave&root-directory=home)

Apps never sign you in. They open your home in a small window, you sign in
there — with a passkey, or the account password your password manager keeps —
and you say what the app may use. The home signs a note from your account to
the app's own key: which spaces, read or change, for seven days. The app never
sees your password, and every peer holds it to what the note says.

## What it does

| Page | For |
|---|---|
| `/` | Your account: its name, connected apps, passkeys, staying signed in, where your data lives (this browser or a pod), adding a phone, signing out |
| `/connect` | What apps open to ask for access: sign in if needed, then allow or don't |

It is a static site. Nothing about your account is sent to whoever hosts it;
the account lives in your browser (or a folder you choose) at this address.
What you trust the host with is the page's code — which is exactly why you may
want to run your own.

## Running your own

Either button above deploys this folder of the repository. Or by hand:

```bash
npm ci                         # at the repository root: the home compiles the protocol from ../src
cd home && npm ci && npm run build   # → home/dist, a static site
```

Serve `dist` from anywhere that falls back to `index.html` for unknown paths
(`public/_redirects` does it on Netlify; `vercel.json` on Vercel).

Settings, as build-time environment variables:

| Variable | Default | |
|---|---|---|
| `VITE_SIGNALING_URL` | `wss://p2p-web-relay.fly.dev` | Relays, comma separated. Must include one your apps use, or they cannot sync with the home. |
| `VITE_WEAVE_NODES` | — | Always-on nodes (`weave run`) to keep a socket to |

Then use it from any Weave app: choose **Use your own home** when connecting
and type its address. The app remembers it, and joins the relays your home
uses, so the two sync even if they were set up with different ones.

On Vercel, keep "Include files outside the root directory in the Build Step"
on (the default): the build reads `../src`.

## Developing

`npm run dev` at the repository root starts this on port 5174, with the
example app on 5173 pointed at it.

## How signing in works

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

**On another device**: sign in with the same password — your password manager
fills it in, since this is the same address. Then set up a passkey on your
account page and this device never asks again. Apps never ask at all: they
open this home.

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
to tell apart from the first. One set earlier still unlocks; nothing sets a new
one.

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

## Adding your phone

Sign in, and on your account page open **Add your phone**. It hands over the
whole account, not one space.

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

On connectivity: WebRTC uses Google's public **STUN** servers by default
(`rtc-transport.ts`), which is enough for two devices on the same Wi-Fi and
usually enough across networks. There is no free public **TURN** — it relays your
actual traffic — so if you need to cross a hostile NAT, bring your own
(Cloudflare has a free tier) and pass it as `iceServers`.

## One account on two addresses, through a pod

Two origins on one machine are enough, and they have to share a relay — peers
pointed at different ones never meet, however identical everything else is:

```bash
npm run signal                              # in the project root, port 8787
(cd home && npx vite --port 5174)           # http://localhost:5174
(cd home && npx vite --port 5175)           # a second "domain"
```

`localhost:5174` and `localhost:5175` are separate origins with separate
IndexedDB. Choose the *same pod* in both and the second one arrives at the
same DID and the same spaces. A change in one — a rename, a space an app made —
shows up in the other within a couple of seconds: the folder is polled, because
the web has no filesystem change notification.
