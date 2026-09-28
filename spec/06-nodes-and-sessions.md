# 06 — Nodes, sessions and apps

This part covers what a **node** must do to act for an account: the session
note it writes under, and following the account's list of spaces. Then the
exchanges that let a program act without the seed: **connecting an app** to
an account home, **connecting an agent**, and **carriers and hosts** that keep
spaces online without reading them. It ends with **calls**, which are built
only from live messages.

The node's programming interface is not protocol, and another implementation
may shape its own however it likes. The reference one is described in the
package docs: [the node](../packages/core/docs/node.md) (creating one, stores,
holding spaces, events, the app-side client), [sign-in](../packages/core/docs/sign-in.md),
and [actions](../packages/core/docs/actions.md) (the CLI, MCP and WebMCP tools).

Material specified elsewhere is linked, not repeated:

| Topic                                                                                                                                                                                                                                                      | Where                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Seeds, recovery codes, DIDs, the account vault and its wraps, UCANs, `AGENT_FACT`, device keys, contact and member keys, phone pairing                                                                                                                     | [01 — Identity](01-identity.md)                 |
| Records, versions, `seq`, rules, topics and tags                                                                                                                                                                                                           | [02 — Records](02-records.md)                   |
| Spaces, roles, the access log (`sys.role`, `sys.member`, `sys.invite`, `sys.revoke`, `sys.collection`, `sys.key`, `sys.relays`, `sys.keepers`), invites, encryption, the account registry (`sys.joined`, `sys.profile`, `sys.carrier`), profiles, contacts | [03 — Spaces](03-spaces.md)                     |
| Relays, rooms, peer authentication, the network message envelope, the `who` note exchange, live messages and their limits, TURN                                                                                                                            | [04 — Network](04-network.md)                   |
| Negentropy, stores, storage adapters, data folders, mirrors, what a node that holds part of a space says it holds                                                                                                                                          | [05 — Sync and storage](05-sync-and-storage.md) |
| Names, doors, the relay mailbox                                                                                                                                                                                                                            | [07 — Doors](07-doors.md)                       |

Terms used here:

- **Account** — an identity derived from a seed; its DID is the _root_ of every
  record it writes ([01](01-identity.md)).
- **Note** — a UCAN delegation from an account (or a key holding one) to
  another key. A **session note** is the note a node's session key writes under.
- **Session key** — the P-256 key a node signs records with and proves on the
  wire. Its DID is the node's `sessionDid`.
- **Account home** — a page that holds an account's seed and grants notes to
  apps. It is a sign-in page (the reference one: [sign-in](../packages/core/docs/sign-in.md)) plus
  the home side of §2.
- **Carrier** — a node that keeps spaces online without being able to read or
  write them. A **host** is a carrier for many accounts, which they pay for.

---

## 1. The node

### 1.1 What a node is

A node acts for exactly one account (`node.did`) and signs with exactly one
session key (`node.sessionDid`) for its lifetime. It holds a set of spaces,
each with its own store and its own peers, and exposes them as plain data: every
value a node method returns is JSON-serialisable, so the same calls can be
exposed over a command line, MCP and WebMCP ([actions](../packages/core/docs/actions.md)).

A node MAY hold the **account key** (the vault key bytes, [01](01-identity.md)).
With it the node follows the account registry — the account's list of spaces,
its name, its carriers, hosts and subscriptions — and joins and leaves spaces as
the account does on any device. Without it, the node holds only the spaces it
was given or joined itself.

A node MAY hold the **contact key** (`deriveContactKeyBytes(seed)`). With it the
node opens contact requests sent to the account and publishes the contact key's
public half on the account's profile in every space it writes in.

_Source: `packages/core/src/node/node.ts`, `packages/core/src/node/types.ts`. Tests: `packages/core/tests/node.test.ts`._

### 1.2 The session note, and renewing it

The root key never signs records. The node asks its signer for one note that
lets the session key write everywhere the account can:

```json
{ "aud": "<sessionDid>", "att": [{ "with": "*", "can": "expression/*" }], "exp": <now + ttl> }
```

(`SESSION_CAPABILITY = { with: '*', can: 'expression/*' }`; the UCAN envelope
and how peers verify it are in [01](01-identity.md).) Every record this node
signs carries the current note as its `proof`, and every live connection opens
with it (the `who` message, [04](04-network.md)).

Renewal timing:

- The first renewal is asked for at `0.75 × ttl` seconds after start (2700 s
  with the default TTL), and each successful renewal schedules the next
  `0.75 × ttl` later.
- If the signer refuses or cannot be reached, the node keeps the note it has
  and asks again after `min(60, ttl / 4)` seconds, repeating until it succeeds
  or the node closes. Once the held note expires, peers (and the node's own
  gates) refuse what it writes.
- Records written under an earlier note stay valid after that note expires:
  expiry limits when a note may be _used to write_, not how long its records
  count ([01](01-identity.md), [02](02-records.md)).

A signer need not be able to sign. `grantSigner(grant)` (§2.7) answers every
`delegate` call with the one note an account home granted, unchanged, and
refuses once `grant.expiresAt` has passed. A node started from a grant
therefore never gets a fresh note: its "renewal" returns the same note, and when
it runs out the app must connect again (§2.9).

> Rationale: one root signature an hour, never one per write. The root — a seed
> in a page, an account home, anything — can stay out of reach of the code that
> writes.

`node.delegate({ audience, capabilities, expiration? })` passes a narrower note
from the session key on to another key. The capabilities MUST be no broader
than the session note's, and `expiration` is capped at the session note's. It
returns `{ token, proofs: [<session note>] }`.

`node.delegation()` returns the note the session key writes under now.

_Source: `packages/core/src/node/node.ts` (`delegate`, `scheduleRenewal`, `SESSION_CAPABILITY`), `packages/core/src/session/connect.ts` (`grantSigner`). Tests: `packages/core/tests/node.test.ts` ("the delegation is renewed before it expires", "records outlive the session that wrote them")._

### 1.3 The spaces a node keeps

The node's **registry** store lists every space it holds, with its key(s), its
invite secret while one is waiting to be used, its role as last seen, the
relays the space names and, for an app without the account key, its member
key. Its storage format is an _implementation detail_ of `packages/core/src/space/space-manager.ts`
([03](03-spaces.md)).

Three kinds of space are the account's own machinery and are **hidden** from
`spaces.list`:

| Space                | Derived from                               | Notes                                                          |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| The account registry | the account key                            | Never in the node's registry; opened directly. Cannot be left. |
| The contacts space   | the account key, or `config.contactsSpace` | Held in the registry, hidden. Cannot be left.                  |
| Carry spaces         | one per carrier the account uses (§4)      | Held in the registry, hidden.                                  |

In these three kinds of space, a record signed under an agent's note never
counts (§3.1), and they are always held whole ([05](05-sync-and-storage.md) §5).

**Following the account.** With an account key, the node makes its spaces
match the account's list — the `sys.joined` records in the account registry,
one per space, keyed `space:<id>`, whose format is in [03](03-spaces.md). This
_reconciliation_ runs at start and whenever records change in the account
registry. It:

1. joins every carry space a live `sys.carrier` record names, and closes and
   forgets one whose carrier was removed more than 30 days ago (kept open until
   then, so an offline carrier still hears it was removed);
2. joins every space a live `sys.joined` record names that the node does not
   hold, using the view-only invite in the record;
3. leaves every space whose `sys.joined` record is deleted;
4. writes a `sys.joined` record for any space held here that the account
   registry has never heard of (joined before the registry existed, or on a
   node without the account key);
5. brings every carrier's passes and subscriptions up to date (§4.2);
6. names the account's carriers as keepers of the open spaces it manages (§4.2);
7. asks every host the account uses how it stands, handing it the spaces if it
   has been paid since (§4.5) — without waiting for the answer.

Only `sys.joined` records that verify and whose root is the account itself
count. Creating or joining a space writes its `sys.joined` record; leaving
deletes it. A record whose space key changed is rewritten with an invite
carrying the key in use now, so a new device joins with it.

A node writing under an agent's note never writes the account registry: no
`sys.joined`, no passes, no name, no hosting receipts (every peer would ignore
them; §3.1).

**Profiles.** When a space opens, when the node's role in it becomes non-null,
and when the account's name changes on any device, the node publishes the
account's profile in that space: `{ name, contactKey? }`, with the name taken
from the account registry's `sys.profile` record and `contactKey` only when
the node holds the contact key. It does this only in spaces other than the
account registry and the contacts space, only with an account name to publish,
and never under an agent's note. The profile record format is in
[03](03-spaces.md).

**Joining.** `spaces.join(invite)` accepts a bare invite or any link carrying
`#invite=…`, `?invite=…` or `&invite=…`. It stores the space (and its key, for
a private space), stores `memberKey` when given, writes the `sys.joined`
record, then tries to use the invite's role secret at once. If the space's
invite record has not reached this device yet, the space is held with
`joining: true` and the node tries again each time records arrive in it.

**Leaving.** `spaces.leave(id)` deletes the `sys.joined` record, closes the
space and forgets it with its key. It does not give up the account's role in
the space; to do that, `setMember(id, self, null)` first.

_Source: `packages/core/src/node/node.ts` (`reconcileOnce`, `remember`, `forget`, `finishJoining`, `publishProfile`, `spaces`). Tests: `packages/core/tests/node.test.ts` ("the account registry"), `packages/core/tests/profiles.test.ts`, `packages/core/tests/space-access.test.ts`._

## 2. The account home protocol

An **app** acts for an account without ever holding its seed. It gets a note
from the account to a key of its own, signed at the person's **account home**.

```
 app page                                   account home (popup)
    │  window.open(home, 'weave-home')            │
    │ ◀──────────── { type: 'weave:hello' } ──────│  posted to '*'
    │── { type: 'weave:request', request } ─────▶ │  to the home's origin
    │                                             │  person unlocks, approves
    │ ◀──── { type: 'weave:grant', grant } ───────│  to the app's origin only
    │    or { type: 'weave:denied', reason }      │  window closes 100 ms later
```

### 2.1 The app's key

An app MUST make its own P-256 key and keep the private half non-extractable.
The reference `appKey(name = 'default')` keeps it in the IndexedDB database
`weave-app-key`, object store `keys`, under `name`. `forgetAppKey` deletes it;
the next connection makes a new one. The key's DID is the grant's audience, and
the app's node signs with this key (`sessionKey`), not a fresh one.

> **Known defect:** so every tab or window of one app is the same DID on the
> relays, and only the first gets into a space's room; the others report
> `refused` in its status until it closes. See [04](04-network.md) §1.2 and
> [#55](https://github.com/leifriksheim/weave/issues/55).

### 2.2 The home's address

`homeAddress(input)` turns what a person typed into the home's connect page:

- no scheme → `https://`, or `http://` for `localhost`, `127.0.0.1`, `[::1]`;
- the host MUST be a loopback name or a domain name with a TLD of two or more
  letters;
- the scheme MUST be `https:`, or `http:` on loopback;
- a path of `/` or empty becomes `/connect`; query and fragment are dropped.

Example: `weave.example.com` → `https://weave.example.com/connect`.

### 2.3 The exchange

The app:

1. MUST open the home in a popup from a user gesture, before awaiting anything
   (reference: name `weave-home`, features `popup,width=460,height=720`).
2. Listens for `message` events and MUST ignore any whose `source` is not the
   popup it opened or whose `origin` is not the home's origin.
3. On `{ type: "weave:hello" }`, posts `{ type: "weave:request", request }` to
   the popup with `targetOrigin` = the home's origin.
4. On `{ type: "weave:grant", grant }`, checks the grant (§2.6) and resolves
   (for a proposal, §2.11, `grant` is the `Proposed` answer instead). On
   `{ type: "weave:denied", reason? }`, fails with `reason`.
5. Fails if the popup is closed first (polled every 500 ms) or after a timeout
   (default 10 minutes).

The home (`receiveConnectRequest(timeoutMs = 10 000)`):

1. Does nothing unless `window.opener` is set.
2. Posts `{ type: "weave:hello" }` to the opener with `targetOrigin` `*`. The
   hello carries nothing secret.
3. Takes the first `message` whose `source` is the opener and whose `type` is
   `weave:request`. The **origin of that event**, as the browser reports it, is
   the app's identity; the home MUST NOT trust any name the request gives
   instead, and MUST show the origin to the person.
4. If the request is malformed (§2.4), answers `weave:denied` with a reason
   saying it did not understand, to that origin, and closes.
5. Otherwise waits for the person, then posts exactly one of `weave:grant` or
   `weave:denied` to that origin only, and closes itself 100 ms later.
6. Gives up silently if no request arrives within the timeout.

_Source: `packages/core/src/session/connect.ts` (`connectToHome`, `askHome`, `receiveConnectRequest`, `homeAddress`). Tests: `packages/core/tests/connect.test.ts` ("the home receiving a request", "an account home typed by a person")._

### 2.4 The request

`ConnectRequest`:

| Field          | Type                            | Meaning                                                                                                                                                 |
| -------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`            | `1`                             |                                                                                                                                                         |
| `audience`     | string                          | The app's key, `did:key:…`. The note is made out to it.                                                                                                 |
| `name`         | string, ≤ 80, optional          | What the app calls itself. Shown, never trusted.                                                                                                        |
| `access`       | `read` \| `write` \| `carry`    | `write` to change the spaces given, `read` only to look, `carry` for a carrier (§4.3).                                                                  |
| `scope`        | `spaces` \| `account`, optional | `spaces` (default): the spaces the person picks and any made for the app. `account`: every space, the account's list, making and joining spaces.        |
| `create`       | `NewSpace[]`, optional          | Spaces the home should make for the app: at most 8, each with a non-empty `name` ≤ 80, `visibility`, and valid starting `roles`/`creatorRole` if given. |
| `contacts`     | boolean, optional               | The contacts space and the contact key.                                                                                                                 |
| `chooseSpaces` | boolean, optional               | Whether to offer the person's existing spaces. Default true. UI only.                                                                                   |
| `agent`        | boolean, optional               | The audience is an agent's key (§3).                                                                                                                    |
| `days`         | integer 1–365, optional         | How long the note should last. The home decides; default 7.                                                                                             |

A home MUST refuse a request (as in §2.3 step 4) unless: `v` is `1`; `audience`
starts with `did:key:`; `access` is one of the three; `scope`, `name`,
`contacts`, `create`, `days` are absent or valid as above; when
`agent: true`, `access` is not `carry`, `create` is absent and `contacts` is
not true.

Connecting offers no subscriptions: a person signing in has asked to be told
about nothing yet. An app asks later, when they do (§2.11). A home MUST NOT
add a subscription while connecting; a `notify` field an older app still
sends is ignored.

Example:

```json
{
  "type": "weave:request",
  "request": {
    "v": 1,
    "audience": "did:key:zDnaeyrPwbZxpDVLsnvAvAEGYazWB2ZrM7QL4Qb1JPzfiYpKy",
    "name": "Todo",
    "access": "write",
    "scope": "spaces",
    "create": [{ "name": "Todos", "visibility": "private" }],
    "days": 30
  }
}
```

### 2.5 The grant

When the person approves, the home (`auth.grant({ origin, request, spaceIds, days? })`):

1. Makes the spaces in `create`, in the account (so they land in its list on
   every device).
2. With `contacts` and `scope: spaces`, adds the contacts space to the spaces
   granted. (With `scope: account` the app derives it itself.)
3. For each granted space — the ones the person picked, the ones made, and the
   contacts space — makes a **view-only invite** (for a private space it
   carries the key; it never carries a role secret) and, for a private space
   under `scope: spaces`, the account's **member key** for that space
   (`deriveMemberKeyBytes(accountKey, spaceId)`, [01](01-identity.md)), which
   opens that space's next key and nothing else.
4. Computes the lifetime: `days` = the person's choice, else the request's,
   else 7, clamped to [1/24, 365]; `expiresAt = now + round(days × 86400)`
   (unix seconds).
5. Signs a note with the account's root key:
   `aud` = `request.audience`, `exp` = `expiresAt`, `att` =
   `grantCapabilities(access, scope)`:
   - `scope: account` → `[{ with: "*", can }]`
   - `scope: spaces` → one `{ with: "space:<id>", can }` per granted space

   where `can` is `expression/*` for `write`, `expression/read` for `read`; and
   `fct: [{ "weave": "agent" }]` when `agent: true`.

6. Remembers the connection (§2.10).
7. Answers with the grant.

`Grant` (the home sends it without `home`; the app adds `home` = the connect
page it opened):

| Field           | Type                                 | Meaning                                                                                                                                                                    |
| --------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`             | `1`                                  |                                                                                                                                                                            |
| `did`           | string                               | The account.                                                                                                                                                               |
| `name`          | string                               | The account's name, for showing who is connected.                                                                                                                          |
| `token`         | string                               | The encoded note.                                                                                                                                                          |
| `access`        | `read` \| `write`                    |                                                                                                                                                                            |
| `scope`         | `spaces` \| `account`                |                                                                                                                                                                            |
| `spaces`        | `{ id, name, invite, memberKey? }[]` | Granted spaces; `memberKey` is base64url.                                                                                                                                  |
| `accountKey`    | base64url, optional                  | With `scope: account`: the vault key bytes. It opens every private space and the account registry, but cannot sign as the account.                                         |
| `contactKey`    | base64url, optional                  | With `contacts` or `scope: account`: the contact key's secret. Never in an agent's grant: it opens contact requests and knocks on the account's doors ([07](07-doors.md)). |
| `contactsSpace` | string, optional                     | With `contacts` and `scope: spaces`: which of `spaces` is the contacts space.                                                                                              |
| `relays`        | string[], optional                   | Relays the home uses; the app joins them too, so the two always share one.                                                                                                 |
| `expiresAt`     | number                               | Unix seconds.                                                                                                                                                              |
| `agent`         | `true`, optional                     | The note is an agent's.                                                                                                                                                    |
| `home`          | string                               | Added by the app.                                                                                                                                                          |

Example (token shortened):

```json
{
  "type": "weave:grant",
  "grant": {
    "v": 1,
    "did": "did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ",
    "name": "Leif",
    "token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsInVjdiI6IjAuMTAuMCJ9.eyJhdHQiOlt7ImNhbiI6…",
    "access": "write",
    "scope": "spaces",
    "spaces": [{ "id": "bafk…", "name": "Todos", "invite": "…", "memberKey": "q0v…" }],
    "relays": ["wss://p2p-web-relay.fly.dev"],
    "expiresAt": 1792614901
  }
}
```

whose note's payload is

```json
{
  "iss": "did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ",
  "aud": "did:key:zDnaeyrPwbZxpDVLsnvAvAEGYazWB2ZrM7QL4Qb1JPzfiYpKy",
  "att": [{ "can": "expression/*", "with": "space:bafk…" }],
  "exp": 1792614901,
  "nbf": 1790022901,
  "nnc": "a6b6617b6ed4fba0",
  "prf": []
}
```

> Rationale: the note limits **writing**, per space, and every peer checks it.
> It cannot limit **reading** a private space it was given: reading is holding
> the space's key. Invites are view-only because what lets the app write is the
> note, under the account's own role — never a secret of the space's.

_Source: `packages/core/src/session/auth.ts` (`grant`), `packages/core/src/session/connect.ts` (`ConnectRequest`, `Grant`, `grantCapabilities`, `isRequest`). Tests: `packages/core/tests/connect.test.ts` ("connecting an app to an account home", "connecting asks for no subscriptions")._

### 2.6 What the app checks

Before using a grant the app MUST check that the note verifies
([01](01-identity.md)), that its `aud` is the app's own key, and that its `iss`
is `grant.did`. An app that asked for `agent: true` MUST refuse a note without
the agent fact.

### 2.7 Starting a connected node

`startConnectedNode({ grant, key?, network?, stores?, cache? })` starts a node
with:

- `signer = grantSigner(grant)`: `did` = `grant.did`, `custody: "remote"`,
  `delegate()` returns the granted note (whatever was asked) and throws once
  `expiresAt` has passed;
- `sessionKey` = the app's key;
- stores `indexedDBStores('weave-app:<grant.did>')` unless given;
- `cache: {}` unless `cache: false` ([holding part of a space](../packages/core/docs/node.md#holding-part-of-a-space));
- `accountKey`, `contactKey`, `contactsSpace` from the grant when present;
- relays = the app's relays ∪ `grant.relays`.

It then joins each granted space it does not hold yet, passing its `memberKey`.
Without an account key it sees only the spaces it was given; with one it
follows the whole account (§1.3).

_Source: `packages/core/src/session/connect.ts` (`startConnectedNode`, `grantSigner`, `grantStore`). Tests: `packages/core/tests/connect.test.ts`._

### 2.8 Scope

|                       | `scope: spaces`                                                    | `scope: account`                        |
| --------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| Note                  | `space:<id>` per granted space                                     | `*`                                     |
| Account key           | no                                                                 | yes                                     |
| Sees                  | the granted spaces                                                 | every space; the account registry       |
| Makes or joins spaces | the home makes them at grant time                                  | itself; they land in the account's list |
| Contacts              | only with `contacts: true` (list and requests; not `ask`/`accept`) | yes, including `ask`/`accept`           |
| Member keys           | one per granted private space                                      | derived from the account key            |

Either way the app never gets the seed: it cannot sign in as the account, change
its password or passkeys, or keep access past `expiresAt`.

> **Planned: grants narrower than a space.** A note is per space, and reading
> a private space is holding its key, so an app or agent granted a private
> space reads all of it until the space's key changes ([03](03-spaces.md),
> `changeKey`). Grants per collection would need both a note capability per
> collection (`with` narrower than `space:<id>`) and collection keys the home
> can hand out alone. Not designed yet. Under UCAN 1.0 the note half is a
> policy on `.collection` rather than new resource syntax ([01 §7.1](01-identity.md),
> [#19](https://github.com/leifriksheim/weave/issues/19)).

### 2.9 Expiry and renewal

A note is never renewed in place. When `expiresAt` passes, the app's writes stop
counting everywhere. To continue, the app connects again, which produces a new
note (and, at the home, replaces the old connection record). The reference
client (`createWeaveConnection`, [node](../packages/core/docs/node.md#the-app-side-client)) switches to `expired` at `expiresAt`
and does not load an expired grant from storage.

### 2.10 Connections and revocation

_Implementation detail:_ the home remembers each connection per account in its
local storage (`Connection`: `origin`, `name`, `audience`, `access`, `scope`,
`carrySpace?`, `spaces`, `grantedAt`, `expiresAt`, `token?`, `agent?`).
Connecting the same origin again replaces its connection; an agent's connection
is keyed by its audience instead, so each agent is its own.

**Disconnecting** (`auth.disconnect(origin, { agent?, audience? })`) removes the
app's connections (by default the app and every agent connected through it;
`agent: true` only those agents; `audience` only that key) and, for each with
`access: write`, revokes its note:

- `scope: spaces`: in every space it was granted;
- `scope: account`: in every space the account can write in, the contacts
  space, and the account registry.

Disconnecting an app (not only its agents) also removes every subscription
whose `app.origin` is its origin (§2.11, §4.4).

Revoking writes a `sys.revoke` record naming the note ([03](03-spaces.md)).
From then on nothing written under the note counts, except versions the revoker
had already seen. What the app could already read, it keeps. A node that sees
its own note revoked in a space emits `revoked` ([events](../packages/core/docs/node.md#events)); the reference client
then forgets the grant and the app key.

_Source: `packages/core/src/session/auth.ts` (`disconnect`, `connections`), `packages/core/src/node/node.ts` (`checkRevoked`). Tests: `packages/core/tests/connect.test.ts` ("disconnecting …")._

### 2.11 Proposing subscriptions

Only an app offers subscriptions, and only when the person asks it to, from
something like a "Notify me" button: never while connecting (§2.4), never a
carrier or an agent, and never the home on its own. The home lets the person
pause and remove what they kept, not add to it. The app uses the exchange of
§2.3 (`proposeToHome`) with a `ProposeRequest` in place of the
`ConnectRequest`:

| Field    | Type                   | Meaning                                                      |
| -------- | ---------------------- | ------------------------------------------------------------ |
| `v`      | `1`                    |                                                              |
| `kind`   | `"propose"`            | Tells it apart from a `ConnectRequest`, which has no `kind`. |
| `name`   | string, ≤ 80, optional | What it calls itself. Shown, never trusted.                  |
| `notify` | `NotifyProposal[]`     | 1 to 8 subscriptions to offer the person.                    |

`NotifyProposal` is `{ label, collection, topic?, others?, spaces?, open? }`,
where `topic` is `{ field, value }` or `{ field, me: true }` (`me` stands for
the account's DID, which an app given only some spaces does not know). It looks
at the spaces the app may reach (step 2 below), or with `spaces` only those of
them; it cannot widen them.

A home MUST refuse a request with a `kind` as malformed (§2.3 step 4) unless
`v` is `1`, `kind` is `propose`, `name` is absent or valid, and `notify` has 1
to 8 entries, each of which would be a valid `NotifyWhen` ([03](03-spaces.md)
§15) with `app.origin` the request's origin and `spaces` its `spaces` when
given (else `"all"`), and whose `open`, when given, is on the request's
origin: a click on a notification leads only back to the app that proposed it.

When the person approves (`auth.propose({ origin, request, notify? })`, where
`notify` is the indices they kept, default all), the home:

1. Finds the connection it keeps for the request's origin (§2.10), other than
   an agent's or a carrier's. With none it MUST refuse.
2. Works out what the app may reach: every space (`"all"`) under
   `scope: account`, else the spaces granted without the contacts space
   (none: it refuses).
3. Checks every kept proposal before writing any. It MUST refuse the whole
   proposal when one names in `spaces` a space outside that reach.
4. Adds each kept proposal to the account's subscriptions ([03](03-spaces.md)
   §15): `spaces` is the proposal's own, else the reach; `me` becomes the
   account's DID; `others` defaults to true; `open` defaults to `<origin>/`;
   `since` is now; `app` is `{ origin, name? }` with `name` the connection's,
   else the request's, cut to 80. A proposal equal to a subscription the same
   origin already has (same collection, spaces, topic and `others`) is not
   added again.
5. Answers `weave:grant` with `Proposed`:
   `{ v: 1, kind: "proposed", notify: { id, label }[], versions? }`, the
   subscriptions added or found; empty when the person kept none. For an app
   with `scope: account` that kept at least one, `versions` MUST hold every
   version the home keeps of each of them, as stored in the registry: signed,
   its body sealed. For any other app it MUST be absent.

An app given `versions` SHOULD store them at once, each only once it passes
every check a version arriving from a peer would ([05](05-sync-and-storage.md)), and only
versions of `sys.notify` in its own registry. The home's window closes when it
answers, often before the two have met on the network; without them, the
subscriptions would reach the app only when it next meets another device of
the account.

Nothing else changes: the app gets no access it did not have, no note, and
learns only which of its suggestions were kept, and a whole-account app only
what it could already read.

Example:

```json
{
  "type": "weave:request",
  "request": {
    "v": 1,
    "kind": "propose",
    "name": "Chat",
    "notify": [
      {
        "label": "New message in Club",
        "collection": "std.message",
        "others": true,
        "spaces": ["bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"]
      }
    ]
  }
}
```

answered with

```json
{
  "type": "weave:grant",
  "grant": {
    "v": 1,
    "kind": "proposed",
    "notify": [{ "id": "notify:k3v6mzq4ha2tmbyx", "label": "New message in Club" }]
  }
}
```

The app shows the notifications itself. An app with `scope: account` holds
the account key, so it reads the subscriptions naming its origin from the
registry, and matches each record that arrives against them with the body in
hand (`matchesRecord`): not paused, the collection, one of the spaces, created
at or after `since` and within the last 24 hours, by another account when
`others`, and holding the topic value when there is one. What it held before
it started is never news. How it shows a match is the app's to decide.

> Rationale: the home writes the subscriptions, not the app. A subscription is
> the person's intent: the app knows good collections and labels, the person
> says yes, and says no later in one place for every app.

> Rationale: a carrier cannot read what it would notify about, and a label it
> chose from the kinds of record it sees go by would be a guess at the
> person's words. An app they are looking at knows what its records mean.

_Source: `packages/core/src/session/connect.ts` (`ProposeRequest`, `Proposed`, `proposeToHome`, `isRequest`), `packages/core/src/session/auth.ts` (`propose`, `subscriptionsFrom`), `packages/core/src/session/connection.ts` (`propose`), `packages/core/src/node/node.ts` (`notifications.versions`, `notifications.take`), `packages/core/src/node/space-runtime.ts` (`versionsOf`, `take`), `packages/core/src/space/notify.ts` (`checkProposal`, `proposalSpaces`, `fromProposal`, `sameSubscription`, `matchesRecord`), `packages/core/src/node/watch-notifications.ts` (`watchNotifications`), `apps/home/src/components/ConnectPage.tsx` (`ApproveProposal`). Tests: `packages/core/tests/connect.test.ts` ("an app proposing subscriptions", "an app showing its own notifications", "the home receiving a request")._

> **Planned: a wallet as the account home.** The same job — hold the root and
> hand an app's key a note — done by a credential wallet through the Digital
> Credentials API instead of a popup page. Nothing is designed beyond that: open
> are what the wallet would hold (the seed, or a key the account's note
> delegates to) and how the request and grant of §2.4–2.5 would map onto a
> credential request.

---

## 3. Agents

### 3.1 Agent notes, and what peers refuse from them

An agent is not an identity. It writes for a person under a note from their
account, like an app; the note carries the fact `{ "weave": "agent" }`
(`AGENT_FACT`, [01](01-identity.md)). A note is an agent's when any entry of its
`fct` has `weave === "agent"`.

Every record written under an agent's note shows as `viaAgent: true`. Every
peer MUST refuse, from a version whose proof is an agent's note:

| What                                                                                                                                                      | How it is refused                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Any record in the access log collections (`sys.role`, `sys.member`, `sys.invite`, `sys.revoke`, `sys.collection`, `sys.key`, `sys.relays`, `sys.keepers`) | It is never an access event: it changes nothing about who may do what, or which collections exist. |
| Any record in the account registry, the contacts space or a carry space                                                                                   | It does not stand ("Only the account itself writes here, not an agent").                           |

Recipients additionally ignore:

- a contact request (`std.contact-request`) written `viaAgent`: it is never
  opened ([03](03-spaces.md));
- call messages from an agent (§5).

A node writing under an agent's note never names relays, seals member keys or
rotates a space key; in a private space it only learns keys.

An agent granted `scope: account` gets a `*` note and the account key in its
grant (§2.5), so the contact list is within its note to read. A home MUST NOT
give an agent the contact key: with it, an agent could open contact requests
and knocks on the account's doors ([07](07-doors.md)).

_Source: `packages/core/src/identity/agent-note.ts`, `packages/core/src/node/space-runtime.ts` (`buildEvent`, `judgeStanding`, `write`, `upkeep`). Tests: `packages/core/tests/agents.test.ts` ("a definition an agent signs by hand is ignored by every peer", "taking someone out of the space, signed by an agent, is ignored too", "it never writes the account itself")._

### 3.2 Connecting an agent with a code

An app offers a one-time code; a terminal on the person's computer pastes it
(`weave connect wv_…`), and the two trade the agent's key for an agent's note
over a relay that learns nothing.

**The code.** `wv_` followed by 16 random bytes in base64url (22 characters),
e.g. `wv_eYV4XGMvhkky6OWpPfqfRQ`. A reader MUST accept it anywhere in pasted
text: the first match of `wv_([A-Za-z0-9_-]{22})` not followed by another
base64url character.

**Derived from the secret** (the 16 bytes):

- the room: `encodeURIComponent('b' + base32(SHA-256(utf8("weave-agent-link-room-v1") ‖ secret)))`
  — for the code above, `buasdssu2j24ugkfiukw3qorcixxl4mxj67uiyeyc3dsdoqbprocq`;
- the link key: HKDF-SHA-256 with `ikm = secret`, empty salt,
  `info = utf8("weave-agent-link-key-v1")`, giving an AES-GCM-256 key.

Both sides join that room on a shared relay ([04](04-network.md); introductions
off) and talk over the resulting peer connection. The app side uses a throwaway
key for its DID on the link.

**Messages.** Network messages `{ type, from, payload }` where `payload` is
`seal(JSON)`: a 12-byte random IV followed by the AES-GCM ciphertext and tag,
sent as a JSON array of byte values. A message that does not open with the link
key is ignored.

| `type`              | From                              | Sealed body                                                              |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `agent-link:ask`    | terminal, on connecting to a peer | `{ "did": "<agent key>", "name": "Agent on leifs-macbook" }` (name ≤ 80) |
| `agent-link:heard`  | app                               | `{ "heard": true }`                                                      |
| `agent-link:answer` | app                               | `{ "grant": <Grant> }` or `{ "denied": "<reason>" }`                     |
| `agent-link:done`   | terminal                          | `{ "ok": true }`                                                         |

**Flow.**

1. The app starts offering: makes a code, joins the room, shows the code.
2. The terminal joins the room and, to each peer that connects, sends `ask`.
3. The app takes the **first** valid `ask` only (a `did` starting `did:key:`),
   answers `heard`, and shows the person the agent's name. Later asks are
   ignored; the code is good for one agent.
4. The person allows it, which opens the account home (§2) with
   `audience` = the agent's DID and `agent: true` (the reference app asks
   `access: write`, `scope: account`, `chooseSpaces: false`, and the person's
   chosen `days`). The app checks the note is for the agent's key and sends
   `answer { grant }`. Or the person declines: `answer { denied }`.
5. The terminal checks the grant (`checkAgentGrant`: `v` is 1; the note
   verifies; `aud` is the agent's key; `iss` is `grant.did`; the note is an
   agent's), sends `done`, and keeps the grant. The app shows it connected when
   `done` arrives.

Timeouts on the terminal: 60 s to hear `heard`, then 10 minutes for the answer.

> Rationale: the relay introduces the two sides and could sit between them,
> so everything is sealed with a key from the code. The code is pasted, not
> typed, so it can be long enough that recording the traffic and guessing it
> later gets nowhere.

_Source: `packages/core/src/session/agent-link.ts`, `apps/example/src/components/ConnectAgent.tsx`. Tests: `packages/core/tests/agents.test.ts` ("connecting an agent with a code")._

### 3.3 Planned

> **Planned.** Not normative.
>
> - **Renewing an agent's note.** Today, when the note runs out, the agent
>   says to connect again (§3.2). It could instead ask an open tab of the
>   person's for a new note, while one is open. Open: how the agent reaches the
>   tab (an agent sends no live messages: one carries no note to say "via agent"), and whether the person must
>   approve each renewal.
> - **Naming the agent.** Records show only "via agent". The note could carry
>   which agent it is (say "Claude in Chrome") as a second fact. That is the
>   agent's own word, not a proof; open whether it is worth showing.
> - **Agents that cannot run a program** (a hosted chat's connectors, a phone
>   app) would need an HTTPS MCP endpoint somewhere else, such as on a relay,
>   which would then see the traffic. If offered at all, it is a separate,
>   clearly labelled option. Not designed.

---

## 4. Carriers and hosts

### 4.1 What a carrier holds, and sees

A carrier keeps an account's spaces online and backed up without being able to
read them. It holds:

- its own P-256 key (its DID is what peers and keepers lists name);
- the key of its **carry space**, which holds nothing but passes and
  subscriptions;
- for each carried space, a **pass**: the space's genesis and, for a private
  space, its read key seed;
- the records of each carried space exactly as they travel.

It holds no seed, no space key, no invite secret and no note: it signs nothing,
writes nothing, and every record it takes in passes the same gates as at any
member's node. On the wire it shows no note, so peers see it as `from: null`.

It can see: which spaces exist, their size and when they change, every record's
outer details (author, collection, times, topic tags; [02](02-records.md)), and
which account asked it to carry which space. It cannot read a private space's
bodies or links, and cannot tell a topic tag's value.

The **read key** in a pass only proves to peers that the carrier may take part
in a private space ([04](04-network.md)); it is derived one way from the space
key and decrypts nothing ([03](03-spaces.md)).

_Source: `packages/core/src/space/pass.ts`, `packages/core/src/node/carrier.ts`. Tests: `packages/core/tests/carrier.test.ts` ("passes", "a carrier")._

### 4.2 Carry spaces and passes

Using a carrier (`node.carriers.add({ did, name })`, needs the account key):

1. The node makes a private space named `Carried by <name>` (name trimmed to 80,
   default `Carrier`), with the account as its only writer.
2. It writes a `sys.carrier` record in the account registry, key
   `carrier:<hex of the first 20 bytes of SHA-256(utf8(carry space id))>`, body
   `{ space, invite, did, name, since }`, where `invite` is a view-only invite
   to the carry space ([03](03-spaces.md)).
3. It fills the carry space (below) and returns `{ space, invite }`; the
   carrier joins with the invite.

Every device holding the account key keeps each live carrier's carry space in
step with the account, on every reconciliation (§1.3): one `sys.pass` record per
space, and one `sys.subscription` per notification subscription.

**Pass records.** Collection `sys.pass`, key
`pass:<hex of the first 20 bytes of SHA-256(utf8(space id))>`, body `SpacePass`:

| Field     | Meaning                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `v`       | `1`                                                                                                                                   |
| `space`   | The space's genesis (`Space`, [03](03-spaces.md)).                                                                                    |
| `read`    | Private spaces: the read key seed (`deriveReadSeed(spaceKey)`), base64url.                                                            |
| `readKey` | Present once the space's key has changed since it began: the read key's DID, which the space's history (not its genesis) vouches for. |

Passes are written for the account registry, the contacts space, and every
space in `sys.joined` that this device holds with its key (a private space held
without its key gets none until the key arrives). Passes for other spaces are
deleted.

A carrier MUST accept a pass only if the space hashes to its id and, for a
private space, the read seed's DID equals `space.readKey` or the pass's
`readKey`. Only pass records verified as written by the carried account count.
When two accounts name one space, a pass for a later key wins over one for the
first key.

**Removing a carrier** (`carriers.remove(carrySpace)`): delete every pass, write
`sys.pass` key `carry:closed` with body `{ "v": 1, "closed": true }`, then
delete the `sys.carrier` record. A carrier that reads `carry:closed` from the
account MUST stop carrying for it and forget what it held. The node keeps the
carry space open for 30 days so the carrier hears it.

A pass cannot be taken back. A removed carrier that does not forget keeps the
read key seeds it was given, so it can still prove itself to peers and fetch
ciphertext until each space's key changes ([03](03-spaces.md), `changeKey`).
Removing a carrier does not change any key by itself.

**Keepers.** When a space opens, and on every reconciliation, a node holding
the account key that may `manage` a space names the account's live carriers as
its keepers (`{ did, name }`, at most 16, [03](03-spaces.md)) and stops naming
carriers the account removed. Other keepers stay. So apps holding part of a
space ([05](05-sync-and-storage.md) §5) can rely on the carriers.

_Source: `packages/core/src/node/node.ts` (`carriers`, `syncPasses`, `nameKeepers`), `packages/core/src/space/pass.ts`, `packages/core/src/space/account-registry.ts`. Tests: `packages/core/tests/carrier.test.ts`._

### 4.3 Connecting a carrier through the account home

A carrier (a browser extension) asks the home with `access: "carry"` (§2.4),
from a page that stays open until the answer comes. The home calls
`auth.grantCarry`, which replaces any earlier carrier from the same origin,
calls `carriers.add({ did: audience, name })`, and answers with a `CarryGrant`:

```json
{
  "v": 1,
  "kind": "carry",
  "did": "<account>",
  "name": "Leif",
  "carry": { "space": "<carry space id>", "invite": "<view-only invite>" },
  "pod": { "dataPath": "accounts/k3j2h4g5f6d7/stores", "folder": "Weave" },
  "relays": ["wss://…"]
}
```

`pod` is `null` when the account lives in the home's browser storage. The
carrier MUST check that `kind` is `carry`, that the invite is to the named
space, that the space is private, created by `did`, and that the invite carries
its key; and that `pod.dataPath` has no empty or `..` segments. A carry
connection has no expiry (`expiresAt: 0` in the home's record) and no note to
revoke; disconnecting it removes the carrier (§4.2).

_Source: `packages/core/src/session/connect.ts` (`connectCarrier`, `checkCarryGrant`, `CarryGrant`), `packages/core/src/session/auth.ts` (`grantCarry`). Tests: `packages/core/tests/connect.test.ts` ("connecting a carrier to an account home")._

### 4.4 Subscriptions, and carriers

"Let me know when…" subscriptions (`node.notifications`, needs the account
key) are kept in the account registry as `sys.notify` records, key
`notify:<base32 of 10 random bytes>`, body `NotifyWhen`:
`{ label (≤ 120), collection (not sys.*), spaces ("all" or 1–256 ids), topic?: { field, value }, others? (default true), open? (https URL), paused?, since (ISO date), app?: { origin, name? } }`.

An app proposes them when the person asks it to, and the home adds the ones
the person keeps, naming the app (§2.11). The home lists them by app; the
person pauses or removes them there. Disconnecting an app removes its
subscriptions (§2.10). The app shows what they match itself, while it runs
(§2.11). A subscription without `app` was made by an earlier home and is kept.

Each device copies every subscription into every carry space as
`sys.subscription` (same key), with the topic value replaced by the tag it has
in each space ([02](02-records.md)):
`{ v: 1, label, collection, spaces, tags?: { <spaceId>: [<tag>] }, others, open?, paused, since }`.
A private space whose key the device lacks gets no tag.

A carrier node reports a record that arrives (`notify` on `CarrierNode`) when
all hold: not paused; same collection; `seq` 0 and not deleted; the space is in
`spaces`; `createdAt` is not before `since` and within the last 24 hours; with
`others`, the record's root is not the account; with `tags`, the record
carries one of that space's tags. What it reports is only the subscription, the
space and the record's key, collection and `createdAt`. No carrier shows these
today, the browser extension included: the copies are there for waking an app
that is closed (below).

_Source: `packages/core/src/space/notify.ts`, `packages/core/src/node/node.ts` (`notifications`, `syncPasses`), `packages/core/src/node/carrier.ts` (`arrived`). Tests: `packages/core/tests/carrier.test.ts` ("notifications through a carrier")._

> **Planned: Web Push, to a closed app or a phone.** Today only an app that
> is running shows a match (§2.11), so nothing reaches a device where it is
> closed, and an app with `scope: spaces`, which cannot read the registry,
> shows nothing. The plan:
>
> - A device registers its Web Push subscription as a **receiver** (the plan
>   below): `push: { endpoint, p256dh, auth }` (the browser's
>   `PushSubscription`) and `device` (a name for people). Subscription
>   records hold none of it.
> - A carrier that stores a new version matching a subscription (the rules
>   above) sends a Web Push to its endpoint: one HTTPS POST, VAPID-signed
>   (RFC 8292), payload encrypted to the device (RFC 8291). The payload is the
>   version as the carrier holds it (private body still encrypted) when it fits
>   in about 3 KB, otherwise its id and space.
> - The push carries RFC 8030's `Topic` header, derived from the version id,
>   so when several carriers send the same record the push service replaces
>   undelivered copies. The notification's `tag` is the record key, so
>   duplicates that get through replace each other.
> - The app's service worker (installed as a PWA on a phone: Android, and
>   iOS 16.4 or later from the home screen) opens the space key from its own storage,
>   decrypts, checks the rest of the filter, and shows the notification.
>   Browsers require every push to show one (`userVisibleOnly`), so a device
>   cannot quietly drop most of a stream: a subscription whose carrier-side
>   part is only a busy collection with no topic tag SHOULD be refused when
>   made, naming the fields to mark as topics.
>
> The push service (chosen by the browser) sees timing and size, never
> content. A carrier learns a device's endpoint and how often a tag matches.
> Depends on nothing else in this part.
>
> Open: a push subscription is bound to one sender's VAPID key
> (`applicationServerKey`). Several carriers pushing to one device need either
> one subscription per carrier (the device subscribes with each carrier's key;
> a host's description would list it as `vapid`) or carriers sharing a key.

> **Planned: devices deliver subscriptions.** Issue:
> [#30](https://github.com/leifriksheim/weave/issues/30). Subscriptions are
> the account's and apps propose them (above); which device shows a match is
> not modeled yet. Every device copies every subscription into every carry
> space, and every copy of the app that is open shows what it matches. The
> plan:
>
> - Each device registers as a **receiver** in its own record, apart from
>   subscriptions: a browser through Web Push, for the app that proposed the
>   subscription. Subscription records hold no device or endpoint data.
> - By default every receiver gets every subscription; a device can opt out
>   on its own.
> - A removed device's receiver record goes with it.
>
> _Open:_ which device copies subscriptions into carry spaces; where receiver
> records live and which carrier sends to which endpoint (with the VAPID
> question above); whether "not on this device" syncs.

### 4.5 Hosts

A **host** is a carrier for many accounts, run as a service. Each account that
uses it has a **subscription**: a key pair the account made, a date it is paid
until, and, once a device hands it over, the account's carry space. Spaces
several subscriptions name are held once.

**The subscription key.** When an account first uses a host
(`node.hosting.use(url)`), the node makes a 32-byte random seed, derives a
P-256 key pair from it, and keeps a `sys.hosting` record in the account
registry, key `hosting:<hex of the first 20 bytes of SHA-256(utf8(url))>`, body:

| Field     | Meaning                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `url`     | The host's origin: `https://`, or `http://` on `localhost`/`127.0.0.1`. |
| `host`    | The host's DID, from its description when first used.                   |
| `seed`    | The subscription key's seed, base64url.                                 |
| `since`   | ISO date.                                                               |
| `name`    | The host's name, as it described itself.                                |
| `receipt` | The latest `SignedStatus` the host gave (below).                        |

Every device of the account signs as the same subscription. It is not the
account's key: the host learns a subscription, not who pays.

**Description.** `GET <url>/.well-known/weave-host`, public:

| Field   | Meaning                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------- |
| `weave` | `"host/1"`                                                                                        |
| `did`   | The host's key: its identity to peers, and what signs its statuses.                               |
| `name`  | For people.                                                                                       |
| `free`  | Every subscription counts as paid.                                                                |
| `price` | Optional, free text.                                                                              |
| `pay`   | Optional: the pay page, relative to the host's address or absolute. Absent: it takes no payments. |
| `terms` | Optional, for people.                                                                             |

A device MUST refuse a description whose `weave` is not `host/1` or whose `did`
is not a `did:key`, and MUST treat a host whose `did` changed since it was first
used as a different host.

**Signed requests.** Every call about a subscription carries

```
Authorization: Weave did=<subscription DID>, at=<unix seconds>, sig=<base64url>
```

where `sig` is the subscription key's signature over the UTF-8 bytes of

```
weave-host/v1\n<METHOD>\n<path and query>\n<at>\n<base64url(SHA-256(body))>
```

(`body` is the exact request body, empty string when none). A host MUST refuse a
request whose header does not match
`^Weave did=(did:key:z[1-9A-HJ-NP-Za-km-z]{1,120}), at=(\d{1,12}), sig=([A-Za-z0-9_-]{1,200})$`,
whose `at` is more than 300 s from its clock, whose signature fails, or whose
signer is not the subscription in the path. Example:

```
Authorization: Weave did=did:key:zDnaet57TmtMH7vQJT8HzNLSZV5sc5JGJub2ZzpX3oHshR2k2, at=1790422901, sig=UD0ynCDYHqxRQ2N08X3On5ljQhEZwyczof1_Zuiv0jhN4rYpoh0pEZ88mPx7hit20d9A5T2oSgvK-UPTetIO_Q
```

**Calls.** `<id>` is the subscription DID, URL-encoded or not.

| Call                                    | Body                                                                         | Answer                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /host/subscriptions/<id>`          | —                                                                            | `SignedStatus`                                                                                                                          |
| `PUT /host/subscriptions/<id>/carry`    | `{ "account": "<account DID>", "invite": "<carry invite, ≤ 16 000 chars>" }` | `SignedStatus`. 402 when not paid (or lapsed); 403 when the host carries only named accounts and this is not one; 400 for a bad invite. |
| `DELETE /host/subscriptions/<id>/carry` | —                                                                            | `SignedStatus`. Stops carrying; the subscription stays.                                                                                 |

Errors are `{ "error": "<message>" }` with 400, 401 (not signed by the
subscription), 402, 403, 404, 405. The reference host sends
`Access-Control-Allow-Origin: *` on these paths and answers `OPTIONS`.

**Signed status.** `SignedStatus = { payload, sig }`, where `payload` is the JSON
text of a `HostStatus` and `sig` is the host key's signature (base64url) over
`utf8("weave-host-status/v1\n" + payload)`. `HostStatus`:

| Field          | Meaning                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `subscription` | The subscription DID.                                                                                                          |
| `host`         | The host's DID.                                                                                                                |
| `state`        | `active` (paid, or a free host), `grace` (past `paidUntil`, within the grace period), `lapsed`, `none` (no such subscription). |
| `paidUntil`    | Unix seconds; 0 before any payment.                                                                                            |
| `renews`       | Paid through something that renews by itself (a card).                                                                         |
| `carrying`     | Whether it carries the account's spaces now.                                                                                   |
| `spaces`       | How many spaces the carry space's passes name.                                                                                 |
| `at`           | When the host said it, unix seconds.                                                                                           |

A device MUST accept a status only if it verifies under the host's recorded DID,
its `host` equals that DID, and its `subscription` is the device's own. Example:

```json
{
  "payload": "{\"subscription\":\"did:key:zDnaet57…\",\"host\":\"did:key:zDnaeXL64…\",\"state\":\"active\",\"paidUntil\":1821536000,\"renews\":true,\"carrying\":true,\"spaces\":4,\"at\":1790422901}",
  "sig": "cC4uQLCnF0tkMzhAuxHp58tjc2XWhdRpj9RpWgb-wYIhzKvhXhi97DoBn_hvcz9NLyv0ch2bqFMJfTIXgYxQhw"
}
```

**Pay link.** A device never handles payment. `node.hosting.payPage(url)`
returns the host's pay page with, in the fragment,
`s=<subscription DID>&at=<unix seconds>&sig=<base64url>`, where `sig` is the
subscription key's signature over `utf8("weave-pay/v1\n" + hostDid + "\n" + subscriptionDid + "\n" + at)`.
The fragment is never sent to a server; the pay page reads it and calls the
host's pay API with

```
Authorization: WeavePay s=<subscription DID>, at=<at>, sig=<sig>
```

A host MUST accept it only for its own DID, when `at` is at most 3600 s old and
at most 300 s in the future. The pay page's own API, plans and payment methods
are the host's business and are _Not yet specified_. Example link:

```
https://host.example/pay#s=did%3Akey%3AzDnaet57TmtMH7vQJT8HzNLSZV5sc5JGJub2ZzpX3oHshR2k2&at=1790422901&sig=-EIgo2A2JYBWDwiJdfQR4v6rBL2WFqw07YgOJqAQB9_FdmTuq0f9uR1f2DSCOM3xw4sqytIJQ4hfz29T-uAbPA
```

**What a device does.** `hosting.list()` asks each host the account uses for its
status. When the status says it is not carrying and it is paid (`active`,
`grace`, or a free host not `lapsed`), the device hands over the carry space
with `PUT …/carry`, making the carrier (§4.2) for the host's DID first if the
account has none (named after the host's address). It asks at most once a
minute per host, and a second look waits for a handover already in flight. It
writes the returned receipt into the `sys.hosting` record when the state,
`paidUntil`, `renews` or name changed. Every device does this after each
reconciliation. `hosting.stop(url)` sends `DELETE …/carry` (ignoring failure),
removes the carrier and deletes the `sys.hosting` record.

**What a host does.** Subscriptions are `active` while `paidUntil ≥ now` (or
always, when free), `grace` for `graceDays` (default 30) after, then `lapsed`;
a lapsed subscription is dropped by a periodic sweep (reference: hourly), and
its carry space with it unless another subscription carries it. Paying again
in time carries again what the grace period kept. A host MAY carry only a
configured list of accounts, and then MUST refuse any other before keeping
anything. It runs the carrier of §4.1–6.2 for every carry space.

How a device reaches a host's sockets is outside this protocol: the reference
host takes peers at `wss://<host>/peer` ([04](04-network.md)), which a device
must be configured with as a node (`network.nodes`). _Not yet specified_: the
host description does not advertise it, and `hosting.use` does not add it (see
Planned, below).

_Source: `packages/core/src/session/hosting.ts`, `packages/core/src/node/host.ts`, `packages/core/src/node/node.ts` (`hosting`), `packages/cli/src/host.ts`, `packages/cli/src/pay-page.ts`. Tests: `packages/cli/tests/host.test.ts`._

### 4.6 Planned: hosts

> **Planned.** Not normative.
>
> **Reaching a host, and restoring through it.** The host description names
> where it takes peers, and `hosting.use` adds that to the node's always-on
> nodes, on every device of the account. A new device that has only the
> recovery code then tries a host by default (one its home was built with), so
> it finds the account registry there — the registry has a pass like every
> space (§4.2) — and from it every space. Open: the description field's name,
> and whether a device should try a default host before it knows the account
> uses one.
>
> **Storage the person already has.** When the account has connected its own
> storage (a Dropbox or Drive folder, [05](05-sync-and-storage.md) mirrors),
> the device seals the storage grant (for Dropbox, a refresh token) to the
> host's key and hands it over with a new signed call on the subscription. The
> host keeps it encrypted at rest under a key outside its database, never logs
> it, and mirrors the carried spaces into that folder as well as its own
> bucket, so moving to another host means handing it the same folder. A leaked
> grant exposes only ciphertext, since mirrors hold records as they travel.
> Depends on the mirror drivers for those services. Open: Google and OneDrive
> give browser apps no lasting refresh token, so for them consent has to finish
> on the host (or in the extension); and a grant shared by device and host
> disconnects both when revoked at the provider, unless the host gets its own
> consent.
>
> **Quotas.** A subscription has a storage quota (the reference plan: 10 GB),
> and the host meters bytes stored, requests and bandwidth per subscription.
> Open: how a device learns usage and the quota (a field of `HostStatus` is
> the obvious place) and what a host answers when a subscription is over it.
>
> **A reminder before time runs out.** Time paid up front does not renew
> itself (`renews: false`), so the host reminds the person 14 and 3 days before
> `paidUntil` and once when the grace period starts, each once per date; a
> payment moves the date and cancels reminders not yet sent. Email, opted into
> on the pay page with double opt-in, is the host's own business. The other
> route is Web Push through the carry space (§4.4, Planned): the home writes a
> `sys.subscription` with no filter and `purpose: "hosting"` when the person
> allows it, and the host pushes `{ kind: "hosting", host, paidUntil }`,
> signed like a status. No new call between home and host. Depends on Web Push.
>
> **Paying without being linked to the account.** Today the host can tie a
> payment to the carry space it is then handed. Privacy Pass tokens (RFC 9576)
> — pay once, receive anonymous tokens, spend them for time — would cut that
> link. Not designed.

---

## 5. Calls

Calls add nothing to the protocol below them. A call is live messages
(`spaces.send`, [04](04-network.md) §9.2) in the space it belongs to, plus one WebRTC connection of
its own between each pair of devices in it (a full mesh). The setup travels
over the space's peer connection, whose handshake proved who is at the other
end; a relay only introduces devices and never sees a call.

### 5.1 Messages

Every call message is a JSON object with a `type` and a `call` id (a string of
1–64 characters; the reference makes 12 random bytes in lowercase hex). A
receiver MUST ignore a call message that is not one of these types, lacks a
valid `call`, comes from a peer with no account (`from: null`), or comes from an
agent (`agent: true`).

| `type`          | Sent to                                              | Fields                                                                                    | Meaning                                      |
| --------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| `call.here`     | the space, every `heartbeat` (5 s); or one device    | `since` (ms, when the sender joined), `camera` (bool), `muted` (bool)                     | "I am in this call."                         |
| `call.ring`     | one account                                          | —                                                                                         | Ring that account's devices.                 |
| `call.answered` | the caller's account, and the answerer's own account | —                                                                                         | Answered; stop ringing.                      |
| `call.declined` | the caller's account, and the decliner's own account | —                                                                                         | Declined; stop ringing.                      |
| `call.cancel`   | the rung account                                     | —                                                                                         | The caller stopped ringing.                  |
| `call.signal`   | one device                                           | `description` (`{ type: "offer"\|"answer", sdp }`) or `candidate` (`RTCIceCandidateInit`) | Connection setup.                            |
| `call.leave`    | the space                                            | —                                                                                         | "I left", now rather than after the timeout. |

Examples:

```json
{ "type": "call.here", "call": "3f9a1c0b7e2d4a6f8b1c2d3e", "since": 1790422901000, "camera": false, "muted": false }
{ "type": "call.signal", "call": "3f9a1c0b7e2d4a6f8b1c2d3e", "description": { "type": "offer", "sdp": "v=0\r\n…" } }
```

### 5.2 Who takes part

Only **members** — accounts holding a role in the space ([03](03-spaces.md)) —
take part. A receiver MUST ignore `call.here`, `call.ring` and `call.signal`
from an account that holds no role there (a view-only reader). The reference
caches the member list for 10 s and asks once more for someone not in it.

A device MUST NOT ring for more than 3 `call.ring`s from one account in any 60 s;
later ones are ignored. `call.cancel` is honoured only from the account that
rang.

> **Planned: blocked people do not ring.** A device will ignore `call.ring`
> from an account the person has blocked (`contacts.block`,
> [03](03-spaces.md)). Today a ring is checked only for membership and rate.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20).

### 5.3 Presence

A device is in at most one call per space at a time: a `call.here` for another
call moves it. A device not heard from for 15 s (`gone`) is dropped, and the
connection to it closed. On hearing a new device's first `call.here` in the call
it is in, a device sends its own `call.here` straight to that device.

### 5.4 Joining, and which call

`start(space)` joins the call already going on in the space — the one with the
lowest id, if several — or starts one with a new id. Joining holds the space
([holding a space](../packages/core/docs/node.md#opening-and-holding-spaces)) for as long as the call lasts, so moving between screens never interrupts
it. When a device alone in its call (no connections yet) hears a `call.here`
for a call with a lower id in the same space, it moves into that call: two calls
started at once merge into the lower id.

### 5.5 Connections

- Between two devices, the one with the **lower session DID** (by string
  comparison) makes the offer. A device MUST ignore an offer from a device whose
  session DID is higher than its own, and an answer on a connection it did not
  offer or that already has one.
- Each connection is made with one audio and one video transceiver
  (`sendrecv`) from the start. Muting, turning the camera on or off and sharing
  the screen replace the sender's track and are announced with `call.here`;
  they never renegotiate.
- Candidates arriving before the remote description are queued (at most 64).
- The offering side keeps at most one connection to each device, and offers
  only to a device it has none with.
- When a connection fails, or its offer or answer cannot be applied, the
  offering side offers again after 2 s if the other device is still in the
  call. A connection not connected within `gone` (15 s) of its offer counts as
  failed too: an offer or answer lost on the way leaves a connection that never
  fails, only never connects.
- ICE servers come from `node.iceServers()`.

### 5.6 Ringing

1. The caller starts (or joins) the call, sends `call.ring` to the callee's
   account and shows `outgoing: ringing`.
2. The callee's devices ring for 45 s unless answered, declined or cancelled.
3. Answering: stop ringing, join the call (with that id), send `call.answered`
   to the caller's account and to one's own account (so other devices stop).
   Declining: `call.declined` the same way.
4. The caller on `call.answered` clears `outgoing`; on `call.declined` shows
   `declined` and, if nobody else is in the call 2.5 s later, leaves.
5. After 45 s unanswered, the caller sends `call.cancel`, writes a missed-call
   record ([`std.call`](../packages/core/docs/standard-library.md#stdcall)), shows `missed`, and leaves 2.5 s later if alone.

Group calls do not ring: a call going on shows to everyone with the space open.

### 5.7 Leaving

Leaving closes every connection, stops the local tracks, sends `call.leave` to
the space, and — if still ringing someone — sends `call.cancel` and writes a
missed-call record. If nobody else is left in the call and anyone else was ever
in it, the leaver writes an ended-call record. The space's hold is released 1 s
later, so the goodbye gets out first.

### 5.8 Planned

> **Planned.** Not normative.
>
> - **Ringing with the app closed.** A ring reaches only devices with the
>   space open. Reaching a closed browser or a phone needs Web Push from a
>   carrier (§4.4, Planned); the extension, always running while the browser
>   is, could ring too. Not designed: a live message is not a record, so a
>   carrier has nothing to match a ring against today.
> - **Big calls.** Past about 6 video streams a full mesh runs out of upload
>   bandwidth. The known answer is a forwarding server (an SFU) with end-to-end
>   encryption on top (SFrame), so it forwards media it cannot watch. A host
>   could run one. Not designed.
> - **Listening without talking.** View-only readers are kept out of calls
>   (§5.2). A space where readers may listen could come as a role permission,
>   e.g. `call: "listen" | "talk"` ([03](03-spaces.md)). Open.
> - **Calls across apps.** A call lives in the app that started it; another
>   app on another origin does not see it. Moving a call between apps would
>   need the account home to hold it. No plan yet.
