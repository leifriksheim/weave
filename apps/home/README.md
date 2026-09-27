# Weave home

Your own account home: the one place your Weave account is ever unlocked.

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/leifriksheim/weave&base=apps/home)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/leifriksheim/weave&root-directory=apps/home)

Apps never sign you in. They open your home in a small window, you sign in
there — with a passkey, or the password your password manager keeps —
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
npm ci                          # at the repository root: one install for the whole workspace
npm run build -w apps/home      # → apps/home/dist, a static site
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
on (the default): the build reads the protocol from `packages/core/src`.

## Developing

`npm run dev` at the repository root starts this on port 5174, with the
example app on 5173 pointed at it.

## How signing in works

Three things, each with one job:

| | What it is | For |
|---|---|---|
| **Recovery code** | The account itself: its seed, written out as 26 characters | Restoring — a new device with nothing to pair from, a new home, or when everything else is gone |
| **Passkey or password** | A copy of the seed, locked, kept with the account | Signing in every day, wherever the account is kept |
| **Pairing** | A QR code from a device that is signed in | Adding a phone or a laptop |

**Create an account.** Pick a name. The home shows the recovery code once —
copy it, or download it as a small text file — and asks you to tick that it is
somewhere safe: a secure note in your password manager, or on paper. Not as a
saved login for this site, where the password you set next could replace it.

Then choose how you sign in: a **passkey**, or a **password** your password
manager saves under the account's name. One of them is required. Without
either, every visit asks for the recovery code, and it ends up being used as a
password after all.

Last, in a browser that can open folders, you are offered a **pod** — a folder
on your computer that holds your data, which any Weave app you point at it can
open. Or keep it in this browser; you can move it any time from your account
page.

**I already have an account.** Where your data lives is asked here, and only
here: someone with a pod has something to point at. Open your pod and its
accounts are listed, ready for your passkey or password. Or add this device
from one that is signed in, or type your recovery code. A restored account goes
on to set up a passkey or password here, so it is needed only once.

It works this way because apps never sign in themselves — they open this home.
So there is one address to unlock, and a password or passkey kept at it is
enough. The recovery code is what makes the account yours with no server: it
needs nothing stored to work, which is also why nobody can reissue it.

### Several accounts in one place

A folder is a disk, not a person. It can hold work and personal, or two people
sharing a laptop. The picker lists them with an avatar derived from each DID, so
the wrong one is obvious before you have read the name, and the one you used
last is expanded already.

The list of names and DIDs is readable without unlocking anything — you cannot
offer a choice without knowing what to call it. The keys are not.

### The ways in

| | Works where | For |
|---|---|---|
| Recovery code | Anywhere, including a device or home that has never seen you | Restoring |
| A password | Wherever the account is kept: this browser, or its pod in any app | Every day |
| A passkey | This browser only | Every day, nothing to type |

The password and the passkey are the same seed encrypted two other ways. A
password in a pod is a locked copy anyone who copies the folder can try to guess
offline, which is why it has to be at least 10 characters — let your password
manager make one. A passkey has no such weakness.

Accounts made before passwords existed used the recovery code as their login,
and password managers still fill it in. It still works in the password field,
and the home then asks you to set a real password or passkey.

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
(cd apps/home && npx vite --port 5174)      # http://localhost:5174
(cd apps/home && npx vite --port 5175)      # a second "domain"
```

`localhost:5174` and `localhost:5175` are separate origins with separate
IndexedDB. Choose the *same pod* in both and the second one arrives at the
same DID and the same spaces. A change in one — a rename, a space an app made —
shows up in the other within a couple of seconds: the folder is polled, because
the web has no filesystem change notification.

## Still to do

- **A passkey that works on a new device.** Today a passkey synced by iCloud or Bitwarden gates a key that stays in one browser, so a new device still needs pairing or the recovery code. With the PRF extension the passkey could wrap the seed itself, its user handle could name the DID, and an always-on node could keep the wrapped copy — at the cost of working only with managers that implement PRF, and of those copies becoming a target.

- **Members and roles.** Screens to see who is in a space and what they hold, edit roles, make an invite link per role, hand over, and leave. So far only `example/` has these (`RolesView`). The copy should be honest: someone removed keeps what they already downloaded, and view-only links made before a removal stop working.
- **Pairing.** Warn on the arrival screen when a `#pair=` link would sign in to a different account than the one here ([01](../../spec/01-identity.md), pairing).
- **Notifications per device.** A list of this device's notification subscriptions.
- **Hosting.**
  - Say plainly, before a lapsed host deletes data, that it will.
  - Remind people before time runs out. The protocol side is planned in [06](../../spec/06-nodes-and-sessions.md).
