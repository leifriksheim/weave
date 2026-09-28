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
  works wherever that vault is: this browser, or a pod on any origin. Setting
  one replaces the last (but not the CLI's passphrase, which also opens it here). At least
  `MIN_PASSWORD_LENGTH` (10) characters, since a copied pod can be attacked
  offline. `signInWithPassword` also accepts a recovery code, which password
  managers may hold as this site's login from before passwords existed.
- **A passkey** is a gate, not a key: the WebAuthn ceremony proves presence,
  and the seed is unwrapped with a non-extractable device key kept in this
  site's storage, named by the vault's `device` wrap for this `rpId`. Only a
  wrap whose device key is present in this browser is offered.

A new account's seed is random. Creating one writes its vault with no wraps,
asks the browser to persist its storage (when kept in the browser), starts its
session, writes its name to `sys.profile` in the account registry, and shows
the recovery code (`freshCode`). Setting up a passkey or a password is
required before `ready`: an account with no everyday way in would be opened
with its recovery code every time, which is the habit this avoids. A page that
waits for `ready` does not see the session during `recovery`, `unlock` or
`pod`.

_Source: `packages/core/src/session/auth.ts`, `packages/core/src/session/credentials.ts`. Tests: `packages/core/tests/auth.test.ts`, `packages/core/tests/account-vault.test.ts`._

## The session a sign-in starts

A sign-in starts a node with the local root signer from the seed, the account
key (`deriveVaultKeyBytes(seed)`), the contact key (`deriveContactKeyBytes(seed)`),
the place's stores for that account ([stores](node.md#stores)) and the configured network. The
session (`WeaveSession`) is `{ account, did, sessionDid, node }`. The seed stays
inside the auth object; `accountPassword()` returns it as a recovery code.

The account's name follows the account: on every `account` event the node's
`account.profile()` is read, and a different name is adopted locally (the vault
label and passkey labels). The name is written to the registry only at creation
and on `rename`, never on a plain start.

## Staying signed in

After an unlock, the seed may be kept on the device so a reload does not ask
again. It is wrapped with a fresh non-extractable device key and stored with an
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
and at an account home `<prefix>.connections:<accountId>` ([spec 06 §2.10](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)). `prefix`
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
