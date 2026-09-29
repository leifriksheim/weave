# Signing in

> Not protocol. This page describes the reference library, and another
> implementation may do it differently and still interoperate. What peers must
> agree on is in the [spec](https://github.com/leifriksheim/weave/blob/main/spec/README.md).

`createWeaveAuth(config)` is the whole sign-in flow of a page that holds the
seed — an account home, or an app that signs people in itself — as a state to
read and actions to call. It is a client convenience: nothing in it goes over
the wire except what the node it starts does. An account home is a page built on it; the exchange it has with apps is
[spec 06 §2](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md).

## Places

A **place** is where accounts and their data are kept (`Place`):

| `kind`             | Accounts are kept                     | Data is kept                                                 |
| ------------------ | ------------------------------------- | ------------------------------------------------------------ |
| `browser`          | the browser account store (IndexedDB) | IndexedDB, per account ([stores](node.md#stores))            |
| `folder` (a _pod_) | the folder's account store            | the folder, per account, registry sealed under the vault key |

A pod is a directory picked through the File System Access API. The last one
picked is remembered and re-opened without a prompt when permission is still
granted. A place holds any number of accounts; `listAccounts` returns them most
recently used first. Account files and vault formats are in [01](https://github.com/leifriksheim/weave/blob/main/spec/01-identity.md).

_Source: `packages/core/src/session/places.ts`. Tests: `packages/core/tests/account-store.test.ts`._

## Account stores

A folder's `accounts.json` and vault files are
[spec 01 §13.1](https://github.com/leifriksheim/weave/blob/main/spec/01-identity.md).
The library lists them most recently used first (`lastUsedAt`, else
`createdAt`), and writes each file as JSON with a 2-space indent and a trailing
newline.

**In the browser**, with no folder, the same shape lives in IndexedDB database
`weave-accounts`, object store `accounts`: key `__list` holds the array of
summaries, and key `<id>` that account's vault. No other origin can edit it.

**A folder from before `accounts.json`** held one account at its root:

```
<folder>/
  weave-account.json     the vault (spec 01 §10.2), or the version-1 form below
  README.txt             explanation for humans, rewritten on each save
  stores/…               the spaces
```

- If `weave-account.json` has `version: 2` and a `wraps` array, it is a vault.
  Opening the folder adopts it when `accounts.json` does not list its DID: a
  new id, name = its `label` (default `My data`), `dataPath: "stores"`. The
  data is not moved.
- **Version 1** stored the seed in the clear as
  `{ "recoveryCode": "…", "label"?: …, "did"?: … }`. It is read only to
  migrate, never written, and never adopted silently: the person is asked to
  lock it.
- Anything else fails with `FOLDER_ACCOUNT_UNREADABLE`.

_Source: `packages/core/src/identity/account-store.ts`, `packages/core/src/identity/folder-account.ts`. Tests: `packages/core/tests/account-store.test.ts`, `packages/core/tests/account-vault.test.ts` ("the account file")._

## Stages

`AuthState.stage` is one of:

| Stage      | Meaning                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starting` | Looking for accounts and a kept sign-in.                                                                                                                   |
| `welcome`  | The place holds no accounts: create one, or "I already have one".                                                                                          |
| `existing` | Ways to an account this place does not list: open a pod, add this device from another, or the recovery code. Where data lives is asked here, not up front. |
| `signIn`   | Choose an account and unlock it.                                                                                                                           |
| `restore`  | Type the recovery code.                                                                                                                                    |
| `create`   | Name a new account.                                                                                                                                        |
| `recovery` | Signed in; `freshCode` is the recovery code to keep safe.                                                                                                  |
| `unlock`   | Signed in; choose a passkey or a password. Required.                                                                                                       |
| `pod`      | Signed in; a new account is offered a pod. Optional.                                                                                                       |
| `pair`     | Opened from a phone-pairing link ([01](https://github.com/leifriksheim/weave/blob/main/spec/01-identity.md)).                                              |
| `ready`    | Signed in; `session` is set.                                                                                                                               |

Transitions:

| From                            | Action                                                                                                                | To                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `starting`                      | `start()`, a kept sign-in for an account in the place ([the session a sign-in starts](#the-session-a-sign-in-starts)) | `ready`                                                                                                         |
| `starting`                      | `start()`, a pairing ticket in the URL                                                                                | `pair`                                                                                                          |
| `starting`                      | `start()`, otherwise                                                                                                  | `signIn` if the place has accounts, else `welcome`                                                              |
| `starting`                      | `start()` fails                                                                                                       | `welcome` (with `error`)                                                                                        |
| any                             | `showWelcome()` / `showExisting()` / `showRestore()` / `showSignIn()`                                                 | `welcome` / `existing` / `restore` / `signIn`                                                                   |
| `existing`, `signIn`            | `choosePod()` / `useBrowser()` while signed out                                                                       | `signIn` or `welcome`                                                                                           |
| `ready`                         | `choosePod()` while signed in                                                                                         | `ready`, with `podChoice` set; `confirmPod('combine' \| 'switch')` restarts the session in the pod              |
| `pod`                           | `choosePod()`                                                                                                         | `ready`: the new account moves into the pod without asking, and its browser copy is removed                     |
| `pod`                           | `finishSetup()`                                                                                                       | `ready`                                                                                                         |
| `welcome`, `existing`, `signIn` | `startCreating()`                                                                                                     | `create`                                                                                                        |
| `signIn`                        | `signInWithPassword` / `signInWithPasskey` succeeds                                                                   | `ready`                                                                                                         |
| `signIn`, `restore`             | `signInWithCode` (or a recovery code given to `signInWithPassword`) succeeds                                          | `ready` if the account has a usable passkey or a password here; else `recovery` with `setup: 'restored'`        |
| `create`                        | `createAccount(name)`                                                                                                 | `recovery`, with `session`, `freshCode` and `setup: 'new'` set                                                  |
| `recovery`                      | `codeSaved()`                                                                                                         | `unlock`                                                                                                        |
| `unlock`                        | `addPasskey()` / `setPassword(p)` succeeds                                                                            | `pod` for a new account in a browser that can open folders, else `ready`                                        |
| `pair`                          | `acceptPairing()`                                                                                                     | `unlock` with `setup: 'paired'` if the account has no way in here, else `ready`; then collects from the desktop |
| `pair`                          | `dismissPairing()`                                                                                                    | `ready` if signed in, else `signIn` / `welcome`                                                                 |
| `ready`                         | `signOut()`                                                                                                           | `starting`, then `signIn` / `welcome`                                                                           |

A failed action sets `error` (`{ message, hint?, code? }`) and leaves the stage
as it was. A dismissed passkey or folder prompt sets no error.

_Source: `packages/core/src/session/auth.ts`. Tests: `packages/core/tests/auth.test.ts`._

## Ways in

- **The recovery code** is the seed written out, 26 characters
  ([01](https://github.com/leifriksheim/weave/blob/main/spec/01-identity.md)). It works on any site without anything stored there,
  and is for restoring, not for every day. If an account is selected and the
  code opens a different one, sign-in fails with a reason. If the code's
  account is new to this place, it is filed there with an empty vault (no
  wraps) under the selected account's name or `My account`.
- **A password** unwraps the seed from the vault's `passphrase` wrap. It
  works wherever that vault is: this browser, or a pod on any origin. The flow
  keeps one passphrase wrap as the account's password: setting one replaces
  any other, except the CLI's (label `CLI passphrase`, `CLI_PASSPHRASE_LABEL`),
  which is for unattended unlocking and is kept; the CLI account home
  (`packages/cli/src/home.ts`) makes those. Signing in by password tries every
  passphrase wrap. At least `MIN_PASSWORD_LENGTH` (10) characters, since a
  copied pod can be attacked offline. `signInWithPassword` also accepts a
  recovery code, which password managers may hold as this site's login from
  before passwords existed.
- **A passkey** is a gate, not a key: the WebAuthn ceremony proves presence,
  and the seed is unwrapped with a non-extractable device key kept in this
  site's storage, named by the vault's `device` wrap for this `rpId`
  ([device keys and passkeys](#device-keys-and-passkeys)). Only device wraps
  whose `rpId` is this site's are offered, since another origin's device key
  is unreachable from here, and only one whose device key is present in this
  browser.

A new account's seed is random. Creating one writes its vault with no wraps,
asks the browser to persist its storage (when kept in the browser), starts its
session, writes its name to `sys.profile` in the account registry, and shows
the recovery code (`freshCode`). Setting up a passkey or a password is
required before `ready`: an account with no everyday way in would be opened
with its recovery code every time, which is the habit this avoids. A page that
waits for `ready` does not see the session during `recovery`, `unlock` or
`pod`.

_Source: `packages/core/src/session/auth.ts`, `packages/core/src/session/credentials.ts`, `packages/core/src/identity/account-vault.ts` (`CLI_PASSPHRASE_LABEL`). Tests: `packages/core/tests/auth.test.ts`, `packages/core/tests/account-vault.test.ts`._

## Device keys and passkeys

A device key ([spec 01 §11](https://github.com/leifriksheim/weave/blob/main/spec/01-identity.md))
is generated non-extractable, with usages `encrypt` and `decrypt`, and kept in
IndexedDB database `weave-device-keys`, object store `keys`, key = its id,
value = the `CryptoKey`.

What that protects: someone holding a copy of the folder or the vault gets
ciphertext and no key, and because the key is non-extractable it cannot be
carried off and used elsewhere. What it does not: anything that can run script
in the origin can use the key in place without the passkey. The passkey in
front of it is enforced by this code, not by cryptography.

**Passkeys are a gate.** A passkey yields no key material here. A WebAuthn
ceremony is required before the flow reaches for a device key, and the seed
comes from the device wrap. A passkey can return a secret only through the PRF
extension, which several major credential providers do not implement or report
inconsistently, and a passkey is bound to one relying party, so an identity
derived from it would differ per origin. There is no server, so nobody verifies
the assertion's challenge or signature; the gate is that the browser completed
a user-verified ceremony for the recorded credential.

Registration (`navigator.credentials.create`):

| Option                          | Value                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rp`                            | `{ id: rpId, name: appName }` (default name `Weave`)                                                                                                              |
| `user.id`                       | 32 random bytes (kept, base64url, as the wrap's `userHandle`)                                                                                                     |
| `user.name`, `user.displayName` | The account's name                                                                                                                                                |
| `challenge`                     | 32 random bytes                                                                                                                                                   |
| `pubKeyCredParams`              | ES256 (−7), RS256 (−257)                                                                                                                                          |
| `authenticatorSelection`        | `residentKey: "required"`, `requireResidentKey: true`, `userVerification: "required"`; `authenticatorAttachment: "platform"` when a platform authenticator exists |
| `hints`                         | `["client-device"]` when preferring the platform authenticator                                                                                                    |
| `extensions.prf.eval.first`     | UTF-8 `weave-protocol-key-v1`                                                                                                                                     |

Assertion (`navigator.credentials.get`): random 32-byte challenge,
`userVerification: "required"`, `allowCredentials` = the wrap's `credentialId`
when known, and the same PRF request. Nothing reads the PRF output.

Renaming an account asks the provider to relabel the passkey through the
WebAuthn Signal API (`PublicKeyCredential.signalCurrentUserDetails` with the
`userHandle`); best effort.

_Source: `packages/core/src/identity/device-key.ts`, `packages/core/src/identity/webauthn.ts`, `packages/core/src/session/auth.ts` (`passkeyGate`). Tests: `packages/core/tests/account-vault.test.ts` ("wrapping a seed"); WebAuthn itself is not exercised by tests._

## The session a sign-in starts

A sign-in starts a node with the local root signer from the seed, the account
key (`deriveVaultKeyBytes(seed)`), the contact key (`deriveContactKeyBytes(seed)`),
the place's stores for that account ([stores](node.md#stores)) and the configured network. A
page holds the vault key as a non-extractable `CryptoKey`; only a node that
must derive from it gets its bytes. The
session (`WeaveSession`) is `{ account, did, sessionDid, node }`. The seed stays
inside the auth object; `accountPassword()` returns it as a recovery code.

The account's name follows the account: on every `account` event the node's
`account.profile()` is read, and a different name is adopted locally (the vault
label and passkey labels). The name is written to the registry only at creation
and on `rename`, never on a plain start.

## Staying signed in

After an unlock, the seed may be kept on the device so a reload does not ask
again. It is wrapped with a fresh non-extractable device key, as a device wrap
labelled `stay signed in` that is kept outside any vault, and stored with an
expiry that is pushed forward each time it is used. Choices: `never`, `1d`,
`7d` (default), `30d`. A kept sign-in resumes only for the same kind of place
it was made in (`browser` or `folder`). Signing out, choosing `never`, or
finding it expired deletes the device key.

_Implementation detail:_ kept in `localStorage` as `<prefix>.stay-signed-in`
(the choice) and `<prefix>.remembered-session`:

```json
{
  "accountId": "k3j2h4g5f6d7",
  "place": "browser",
  "wrap": { "kind": "device", "...": "…" },
  "expiresAt": 1791027701000
}
```

Other keys the flow keeps: `<prefix>.last-account`, `<prefix>.storage-choice`,
and at an account home `<prefix>.connections:<accountId>` ([the account home's side](#the-account-homes-side)). `prefix`
defaults to `weave`.

_Source: `packages/core/src/session/stay-signed-in.ts`, `packages/core/src/session/auth.ts`. Tests: none._

## Moving into a pod

Picking a pod while signed in sets `podChoice` with what the pod holds
(`inspectPod`: this account's copy, other accounts, whether it is the pod in use).
`confirmPod('switch')` uses the pod's own copy and brings nothing.
`confirmPod('combine')` writes the account and a union of both vaults' wraps
into the pod, copies every space into it (`copyAccountData`, [stores](node.md#stores)), and
restarts the session there. `forgetBrowserCopy()` then deletes the browser's
copy. Other accounts in the pod are never touched.

_Source: `packages/core/src/session/auth.ts` (`confirmPod`), `packages/core/src/session/places.ts`. Tests: `packages/core/tests/account.test.ts`._

## Pairing a phone

The ticket, the room and the exchange are
[spec 01 §14](https://github.com/leifriksheim/weave/blob/main/spec/01-identity.md).
`offerToPhone(onStage)` starts an offer on the first configured relay and
returns `{ url, stop }`: the link for the QR code, and a way to stop. The
offer keeps listening, and hands over to every peer that joins, until `stop()`
disconnects it. Each space goes in the handover as `node.spaces.invite(id)`
with default options.

On the phone, the `pair` stage signs in with the ticket's code and then
collects from the desktop (`collectFromDesktop`). It waits 30 seconds by
default; if nothing arrives by then it finishes with zero spaces, since the
identity is already correct and only the spaces are missing.

_Source: `packages/core/src/session/pairing.ts` (`offerToPhone`, `collectFromDesktop`), `packages/core/src/session/auth.ts` (`offerToPhone`, `acceptPairing`). Tests: `packages/core/tests/pairing.test.ts`._

## The account home's side

What a home receives from an app, what it must check and what it answers are
protocol ([spec 06 §2](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)). An account home built on `createWeaveAuth` does
its side with these:

**Receiving a request.** `receiveConnectRequest(timeoutMs = 10 000)` does
nothing without `window.opener`, says hello, and resolves with the first
request from the opener and the origin the browser reports for it, or `null`
after the timeout. Answering closes the window 100 ms later.

**Granting.** `auth.grant({ origin, request, spaceIds, days? })` makes the
grant: `spaceIds` are the spaces the person picked, `days` their choice of
lifetime, clamped to [1/24, 365].

**Connections.** The home remembers each connection per account in
`localStorage` under `<prefix>.connections:<accountId>` (`Connection`:
`origin`, `name`, `audience`, `access`, `scope`, `carrySpace?`, `spaces`,
`grantedAt`, `expiresAt`, `token?`, `agent?`). Connecting the same origin again
replaces its connection; an agent's connection is keyed by its audience
instead, so each agent is its own. `auth.connections()` lists them.

**Disconnecting.** `auth.disconnect(origin, { agent?, audience? })` removes the
app's connections (by default the app and every agent connected through it;
`agent: true` only those agents; `audience` only that key), revokes the notes
of those with `access: write`, and, unless only agents go, removes the
subscriptions the app proposed.

**Proposals.** `auth.propose({ origin, request, notify? })` adds the
subscriptions the person kept: `notify` is the indices kept, default all. The
home lists the account's subscriptions by app, and the person pauses or removes
them there.

**Carriers.** `auth.grantCarry({ origin, request })` replaces any earlier
carrier from the same origin, adds the carrier with `node.carriers.add`
([carriers and hosting](node.md#carriers-hosting-and-notifications)) and
returns the `CarryGrant`. Its connection is kept with `expiresAt: 0`, since a
carry connection never expires.

_Source: `packages/core/src/session/auth.ts` (`grant`, `grantCarry`, `propose`, `connections`, `disconnect`), `packages/core/src/session/connect.ts` (`receiveConnectRequest`). Tests: `packages/core/tests/connect.test.ts` ("the home receiving a request", "connecting an app to an account home", "disconnecting …", "connecting a carrier to an account home")._
