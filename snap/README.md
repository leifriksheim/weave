# @p2p-web/identity-snap

A MetaMask Snap that holds a p2p-web identity.

## What it is for

Every other way into an account is scoped to something. A passkey belongs to one
domain. A password unlocks a vault that has to be present. A folder needs the
File System Access API and a picker. Open an app on a domain that has never seen
you and none of them help — you paste a code.

A Snap runs inside the extension, not inside an origin, so it answers everywhere.
That makes it the only way in that needs nothing stored and no handoff.

## What it will not do

**Hand over the key.** An app generates a session keypair and asks the Snap to
sign a note saying that key may write for the next hour. The app gets the note.
It never gets the seed, so connecting an app is not the same as giving it your
account, and disconnecting one means something.

## The derivation, which is part of the spec

```
m / 44' / 7343' / 0' / 0 / 0        (secp256k1)
  → SHA-256 with "p2p-web-identity-v1"
  → first 16 bytes = the account seed
```

It uses `snap_getBip32Entropy` and not the friendlier `snap_getEntropy` on
purpose. `snap_getEntropy` folds in the Snap's own id, so nothing outside this
Snap could ever reproduce it — which would make the Snap load-bearing for the
identity, the exact thing this design is trying to avoid. A BIP-32 path is
reproducible by anyone holding the recovery phrase with any standard library.

Changing the path changes everyone's identity. Treat it as a migration, not an
edit.

## Several accounts, two kinds

A wallet holds several keys, and so does this. Which one it is acting as is
remembered, so a site that asks gets the account the person chose rather than
whichever was used last.

- **Derived** — from the path above. Always present, nothing stored, same on
  every device where the recovery phrase is restored.
- **Imported** — existing accounts, added one at a time and kept in Snap state.
  This is how an account that already exists becomes portable.

A site with accounts of its own should call `listAccounts` and then
`selectAccount` before acting, rather than assuming there is only one.

## Methods

| Method | Asks the user? | Returns |
|---|---|---|
| `getAccount` | no | `{ did, kind }` |
| `signDelegation` | first time per site | a UCAN, capped at one hour |
| `getVaultKey` | no | the key that decrypts this account's data at rest |
| `exportCode` | yes | the account password |
| `listAccounts` | no | every account it holds, and which is active |
| `selectAccount` | no | `{ did, kind }` for the one chosen |
| `importAccount` | yes | `{ did, kind }` — added alongside, not replacing |
| `forgetAccount` | yes | `{ ok }` — the derived one cannot be dropped |

`getVaultKey` hands out a derived key rather than the seed. It is useless
without the data it belongs to, and a site already trusted to act as this
identity cannot read its own folder without it.

## Publishing

The package is publish-ready but deliberately not published — a name on npm is
effectively permanent, and the scope has to be one you own.

One thing to decide first: **the scope.** `@p2p-web` is unclaimed. A different
one has to change in three places that must agree, or the install fails in a way
that does not name the cause — `package.json` `name`,
`snap.manifest.json` `source.location.npm.packageName`, and the default
`SNAP_ID` in `example/src/snap.ts`.

There is deliberately no `repository` field. It is optional in both files, and a
placeholder URL is worse than none because it ships as a broken link. Add it
whenever the repo exists — that is just another publish. If you ever want the
Snap allowlisted or in the Snaps Directory, expect a real one to be asked for.

Then:

```bash
npm login
cd snap && npm publish        # rebuilds, re-stamps and verifies the checksum first
```

npm will not let you overwrite a published version, so every republish needs a
bump in **both** `package.json` and `snap.manifest.json` — they have to agree.

`publishConfig.access` is set to public, because a scoped package is private by
default and that needs a paid plan.

Once it is up, nothing needs configuring in the app — `npm:@p2p-web/identity-snap`
is already the default, so release MetaMask will find it and your app can stay on
localhost.

### Release MetaMask will refuse it — this is expected

> Cannot install version "0.1.1" of snap "npm:@p2p-web/identity-snap": The snap
> is not on the allowlist.

Being on npm is not enough. **Release MetaMask only installs Snaps on MetaMask's
allowlist**, which means submitting this one for review. There is no setting or
flag that turns that off.

[MetaMask Flask](https://metamask.io/flask/) installs any Snap, from npm or from
a local URL. It is a separate extension — run it in its own browser profile, or
both will fight over the injected provider. (The app handles that case: it picks
between wallets with EIP-6963 and prefers Flask, because for anything not
allowlisted Flask is the only build that can install it at all.)

Flask can install the published package directly — nothing local needed:

```
npm:@p2p-web/identity-snap
```

**Worth weighing before committing to Snaps:** the allowlist means you do not
control distribution. Every user needs Flask, or you need MetaMask's approval
and to keep it. That is the strongest argument for your own extension, which has
no gatekeeper — and the Snap is still the cheap way to prove the design first,
since the interface an app talks to is the same either way.

## Building

```bash
cd snap && npm run build
```

```bash
npm run build     # bundle, stamp the checksum, check it loads
npm run verify    # recompute the checksum the way MetaMask does
npm run smoke     # run the handler against a stubbed MetaMask
```

`npm publish` runs all three first, because every failure so far has only shown
up after publishing, installing, and reading an error in a browser — a loop that
costs a version bump each time. `smoke.mjs` stubs `snap.request` and exercises
every method, which is the ten-second version of it.

Two things it cannot tell you: whether the real sandbox provides WebCrypto (Node
always does), and whether MetaMask will accept the manifest's permissions.

**The checksum is not a hash of the bundle.** It covers the manifest itself
(minus the checksum field), the source, and the icon, hashed in a defined order
— so it changes when the icon or any manifest field does, not just the code.
That is why this uses `getSnapChecksum` from `@metamask/snaps-utils` rather than
computing it by hand: getting it wrong produces "manifest shasum does not match
computed shasum" at install time, which cannot be debugged from the browser.

`snaps-utils` is a dev dependency, used at build time only. The published bundle
still has no dependencies, and the runtime types are declared in
`src/snap-globals.d.ts`.

`npm run verify` also takes a path, so an unpacked tarball can be checked
exactly as MetaMask would see it:

```bash
npm pack && tar -xzf *.tgz && npm run verify -- package
```

## Two different "locals"

These get confused, and they are unrelated:

| | What it means | Release MetaMask |
|---|---|---|
| **Where the Snap comes from** | `npm:@scope/name` or `local:http://…` | npm only |
| **Where your app is served** | `localhost:5173`, or anywhere | doesn't care |

"Fetching local snaps is disabled" is about the first row only. **Your app being
on localhost is fine either way** — MetaMask has no opinion about the origin of
the page asking.

So publishing to npm and running your app on localhost works, with no Flask
involved. Serving the Snap from a local URL is only for iterating on the Snap
itself without republishing.

One thing to check before relying on it: release MetaMask has at times required
Snaps to be allowlisted before it will install them, separately from being on
npm. Flask installs anything. If a published Snap still refuses to install in
release MetaMask, that is the reason to look into — not your packaging.

## Running it locally

**You do not need to publish it.** Ordinary MetaMask only installs Snaps from
npm, but [MetaMask Flask](https://metamask.io/flask/) also installs them from a
local URL, which is what development is for.

```bash
cd snap && npm run dev          # builds, then serves on :8080
```

Then, in another terminal:

```bash
cd example
VITE_SNAP_ID=local:http://localhost:8080 npm run dev
```

Three things that will each produce the same unhelpful "connection failed" in
MetaMask if you miss them:

- **Flask, not MetaMask.** A `local:` snap id is refused by the release build.
  Flask is a separate extension, so run it in its own browser profile — two
  MetaMasks in one profile fight over the `window.ethereum` injection.
- **The server must send CORS headers.** MetaMask fetches from the extension's
  own context, so `python3 -m http.server` will not do. That is what
  `npm run serve` is for.
- **Rebuild after editing.** The manifest carries the bundle's checksum, and
  MetaMask refuses a mismatch. `npm run dev` does both; `npm run build` alone
  updates the checksum without serving.

## Unverified

None of this has run inside MetaMask. Three things to check first, in order:

1. **Does the sandbox have `crypto.subtle`?** The Snap signs with P-256 through
   it. Snaps run under SES with a restricted set of globals, and if WebCrypto is
   not among them this needs a pure-JS ECDSA — the curve maths is already in
   `src/identity/p256-curve.ts`, but signing is not.
2. **Is this BIP-32 path permitted?** Some are allowlisted or reserved.
3. **The dialog content format.** `snap_dialog` has changed shape across
   versions; the panel/heading/text form here may need updating.
