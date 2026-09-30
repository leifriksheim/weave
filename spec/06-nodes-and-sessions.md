# 06 — Nodes, sessions and apps

This part covers what a **node** must do to act for an account: the session
note it writes under, and what it keeps current for the account. Then the
exchanges that let a program act without the seed: **connecting an app** to
an account home, **connecting an agent**, and **carriers and hosts** that keep
spaces online without reading them. Calls, built only from live messages, are
a layer on it and described with the library
([calls](../packages/core/docs/calls.md)).

The node's programming interface is not protocol, and another implementation
may shape its own however it likes. The reference one is described in the
package docs: [the node](../packages/core/docs/node.md) (creating one, stores,
holding spaces, following the account, events, the app-side client, carriers
and hosting), [sign-in](../packages/core/docs/sign-in.md) (including the
account home's side of §2), [agents](../packages/core/docs/agents.md), and
[actions](../packages/core/docs/actions.md) (the CLI, MCP and WebMCP tools).

Material specified elsewhere is linked, not repeated:

| Topic                                                                                                                                                                                                                                            | Where                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Seeds, recovery codes, DIDs, the account vault and its wraps, UCANs, `AGENT_FACT`, device keys, contact and member keys, phone pairing                                                                                                           | [01 — Identity](01-identity.md)                 |
| Records, versions, `seq`, rules, topics and tags                                                                                                                                                                                                 | [02 — Records](02-records.md)                   |
| Spaces, roles, the access log (`sys.role`, `sys.member`, `sys.invite`, `sys.revoke`, `sys.collection`, `sys.key`, `sys.relays`, `sys.keepers`), invites, encryption, the account registry (`sys.joined`, `sys.profile`, `sys.carrier`), profiles | [03 — Spaces](03-spaces.md)                     |
| Relays, rooms, peer authentication, the network message envelope, the `who` note exchange, live messages and their limits, TURN                                                                                                                  | [04 — Network](04-network.md)                   |
| Negentropy, stores, storage adapters, data folders, mirrors, what a node that holds part of a space says it holds                                                                                                                                | [05 — Sync and storage](05-sync-and-storage.md) |
| Names, doors, the relay mailbox                                                                                                                                                                                                                  | [07 — Doors](07-doors.md)                       |

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

A node acts for one account and signs with one session key at a time. It
holds a set of spaces, each with its own store and its own peers.

A node MAY hold the **account key** (the vault key bytes, [01](01-identity.md)).
With it the node follows the account registry — the account's list of spaces,
its name, its carriers, hosts and subscriptions — and joins and leaves spaces as
the account does on any device (§1.3). Without it, the node holds only the
spaces it was given or joined itself.

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

(The UCAN envelope and how peers verify it are in [01](01-identity.md).)
Every record this node signs carries the current note as its `proof`, and every
live connection opens with it (the `who` message, [04](04-network.md)).

The node asks for a new note before the one it holds runs out. Once the held
note expires, peers refuse what the node writes under it. Records written under
an earlier note stay valid after that note expires: expiry limits when a note
may be _used to write_, not how long its records count ([01](01-identity.md),
[02](02-records.md)). An app's note from an account home is never renewed in
place (§2.9).

> Rationale: one root signature an hour, never one per write. The root — a seed
> in a page, an account home, anything — can stay out of reach of the code that
> writes.

When and how the reference node renews, and how it passes a narrower note on,
are in [the node](../packages/core/docs/node.md#renewing-the-session-note).

_Source: `packages/core/src/node/node.ts` (`SESSION_CAPABILITY`, `scheduleRenewal`). Tests: `packages/core/tests/node.test.ts` ("the delegation is renewed before it expires", "records outlive the session that wrote them")._

### 1.3 The spaces a node keeps

The account's list of spaces is the `sys.joined` records in its account
registry, one per space, keyed `space:<id>` ([03](03-spaces.md)). Only
`sys.joined` records that verify and whose root is the account itself count.
A record whose space key changed is rewritten with an invite carrying the key
in use now, so a new device joins with it.

A node holding the account key follows that list, and keeps what carriers
depend on current: each live carrier's passes and `carry:closed` (§4.2), and
the account's carriers named as keepers of the spaces it manages (§4.2). A
carrier sees only what these devices write, so without them it carries stale
passes or none.

The account registry, the contacts space and carry spaces are the account's
own machinery. In them a record signed under an agent's note never counts
(§3.1), and a node always holds them whole ([05](05-sync-and-storage.md) §5).
A node writing under an agent's note never writes the account registry: no
`sys.joined`, no passes, no name, no hosting receipts (every peer would ignore
them).

When a node joins, leaves and reconciles, which spaces it hides from its own
list, and when it publishes the account's profile are the node's own; the
reference node is in [the node](../packages/core/docs/node.md#following-the-account).

_Source: `packages/core/src/node/node.ts` (`reconcileOnce`, `syncPasses`, `nameKeepers`), `packages/core/src/space/account-registry.ts`. Tests: `packages/core/tests/node.test.ts` ("the account registry"), `packages/core/tests/agents.test.ts` ("it never writes the account itself")._

## 2. The account home protocol

An **app** acts for an account without ever holding its seed. It gets a note
from the account to a key of its own, signed at the person's **account home**.

```
 app page                                   account home (popup)
    │  opens the home in a popup                  │
    │ ◀──────────── { type: 'weave:hello' } ──────│  posted to '*'
    │── { type: 'weave:request', request } ─────▶ │  to the home's origin
    │                                             │  person unlocks, approves
    │ ◀──── { type: 'weave:grant', grant } ───────│  to the app's origin only
    │    or { type: 'weave:denied', reason }      │  then closes
```

### 2.1 The app's key

An app MUST make its own P-256 key and keep the private half non-extractable.
The key's DID is the grant's audience, and the app's node signs with this key,
not a fresh one. Where the reference keeps it:
[the app-side client](../packages/core/docs/node.md#the-app-side-client).

> **Known defect:** so every tab or window of one app is the same DID on the
> relays, and only the first gets into a space's room; the others report
> `refused` in its status until it closes. See [04](04-network.md) §1.2 and
> [#55](https://github.com/leifriksheim/weave/issues/55).

### 2.2 The home's address

A home is found by its bare domain: an app given only an origin opens
`<origin>/connect`, so a home serves its connect page there. Example:
`weave.example.com` → `https://weave.example.com/connect`. How the reference
client reads what a person typed is in
[the app-side client](../packages/core/docs/node.md#the-app-side-client).

### 2.3 The exchange

The app:

1. MUST open the home in a popup from a user gesture, before awaiting anything.
2. Listens for `message` events and MUST ignore any whose `source` is not the
   popup it opened or whose `origin` is not the home's origin.
3. On `{ type: "weave:hello" }`, posts `{ type: "weave:request", request }` to
   the popup with `targetOrigin` = the home's origin.
4. On `{ type: "weave:grant", grant }`, checks the grant (§2.6) and resolves
   (for a proposal, §2.11, `grant` is the `Proposed` answer instead). On
   `{ type: "weave:denied", reason? }`, fails with `reason`.
5. Fails if the popup is closed first, or after a timeout.

The home:

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
   `weave:denied` to that origin only, and closes itself.
6. Gives up silently if no request arrives within the timeout.

The reference timings (popup size, polling, timeouts) are in
[the app-side client](../packages/core/docs/node.md#the-app-side-client) and
[the account home's side](../packages/core/docs/sign-in.md#the-account-homes-side).

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

When the person approves, the home:

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
   else 7, within the home's own bounds; `expiresAt = now + round(days × 86400)`
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

The app's node signs with the app's own key (§2.1) under the granted note,
joins the relays in `grant.relays` besides its own, and joins each granted
space with its view-only invite and, when given, its `memberKey`. Without an
account key it sees only the spaces it was given; with one it follows the
whole account (§1.3). How the reference starts it is in
[the app-side client](../packages/core/docs/node.md#the-app-side-client).

_Source: `packages/core/src/session/connect.ts` (`startConnectedNode`, `grantSigner`). Tests: `packages/core/tests/connect.test.ts`._

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
note (and, at the home, replaces the old connection record).

### 2.10 Connections and revocation

The home remembers each connection it grants: the app's origin, audience,
access, scope and the spaces granted. Connecting the same origin again replaces
its connection; an agent's connection is its own, apart from the app's.

**Disconnecting** an app or agent revokes the note of each connection removed
that has `access: write`:

- `scope: spaces`: in every space it was granted;
- `scope: account`: in every space the account can write in, the contacts
  space, and the account registry.

Disconnecting an app (not only its agents) also removes every subscription
whose `app.origin` is its origin (§2.11, §4.4).

Revoking writes a `sys.revoke` record naming the note ([03](03-spaces.md)).
From then on nothing written under the note counts, except versions the revoker
had already seen. What the app could already read, it keeps. How the reference
home stores connections and what the reference client does when it sees its
note revoked are in [the account home's side](../packages/core/docs/sign-in.md#the-account-homes-side).

_Source: `packages/core/src/session/auth.ts` (`disconnect`, `connections`), `packages/core/src/node/node.ts` (`checkRevoked`). Tests: `packages/core/tests/connect.test.ts` ("disconnecting …")._

### 2.11 Proposing subscriptions

Only an app offers subscriptions, and only when the person asks it to: never
while connecting (§2.4), never a
carrier or an agent, and never the home on its own. The home lets the person
pause and remove what they kept, not add to it. The app uses the exchange of
§2.3 with a `ProposeRequest` in place of the
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

When the person approves some or all of the proposals, the home:

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

The app shows the notifications itself; how the reference matches records
against its subscriptions is in
[the app-side client](../packages/core/docs/node.md#the-app-side-client).

> Rationale: the home writes the subscriptions, not the app. A subscription is
> the person's intent: the app knows good collections and labels, the person
> says yes, and says no later in one place for every app.

> Rationale: a carrier cannot read what it would notify about, and a label it
> chose from the kinds of record it sees go by would be a guess at the
> person's words. An app they are looking at knows what its records mean.

_Source: `packages/core/src/session/connect.ts` (`ProposeRequest`, `Proposed`, `proposeToHome`, `isRequest`), `packages/core/src/session/auth.ts` (`propose`, `subscriptionsFrom`), `packages/core/src/session/connection.ts` (`propose`), `packages/core/src/node/node.ts` (`notifications.versions`, `notifications.take`), `packages/core/src/node/space-runtime.ts` (`versionsOf`, `take`), `packages/core/src/space/notify.ts` (`checkProposal`, `proposalSpaces`, `fromProposal`, `sameSubscription`), `apps/home/src/components/ConnectPage.tsx` (`ApproveProposal`). Tests: `packages/core/tests/connect.test.ts` ("an app proposing subscriptions", "the home receiving a request")._

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
- call messages from an agent ([calls](../packages/core/docs/calls.md#messages)).

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

1. The app makes a code and joins the room.
2. The terminal joins the room and, to each peer that connects, sends `ask`.
3. The app takes the **first** valid `ask` only (a `did` starting `did:key:`)
   and answers `heard`. Later asks are ignored; the code is good for one agent.
4. If the person allows it, the app asks the account home (§2) with
   `audience` = the agent's DID and `agent: true`, checks the note is for the
   agent's key, and sends `answer { grant }`. If not: `answer { denied }`.
5. The terminal checks the grant (`v` is 1; the note verifies; `aud` is the
   agent's key; `iss` is `grant.did`; the note is an agent's), sends `done`,
   and keeps the grant.

What the reference app shows and asks for, and the terminal's timeouts, are in
[agents](../packages/core/docs/agents.md#connecting-with-a-code).

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

Using a carrier needs the account key:

1. The node makes a private space, with the account as its only writer.
2. It writes a `sys.carrier` record in the account registry, key
   `carrier:<hex of the first 20 bytes of SHA-256(utf8(carry space id))>`, body
   `{ space, invite, did, name, since }`, where `invite` is a view-only invite
   to the carry space ([03](03-spaces.md)).
3. It fills the carry space (below) and returns `{ space, invite }`; the
   carrier joins with the invite.

Every device holding the account key keeps each live carrier's carry space in
step with the account (§1.3): one `sys.pass` record per space, and one
`sys.subscription` per notification subscription.

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

**Removing a carrier**: delete every pass, write `sys.pass` key `carry:closed`
with body `{ "v": 1, "closed": true }`, then delete the `sys.carrier` record. A
carrier that reads `carry:closed` from the account MUST stop carrying for it and
forget what it held. The node keeps the carry space open for a while after, so
the carrier hears it ([the node](../packages/core/docs/node.md#carriers-hosting-and-notifications)).

A pass cannot be taken back. A removed carrier that does not forget keeps the
read key seeds it was given, so it can still prove itself to peers and fetch
ciphertext until each space's key changes ([03](03-spaces.md), `changeKey`).
Removing a carrier does not change any key by itself.

**Keepers.** A node holding the account key that may `manage` a space names the account's live carriers as
its keepers (`{ did, name }`, at most 16, [03](03-spaces.md)) and stops naming
carriers the account removed. Other keepers stay. So apps holding part of a
space ([05](05-sync-and-storage.md) §5) can rely on the carriers.

_Source: `packages/core/src/node/node.ts` (`carriers`, `syncPasses`, `nameKeepers`), `packages/core/src/space/pass.ts`, `packages/core/src/space/account-registry.ts`. Tests: `packages/core/tests/carrier.test.ts`._

### 4.3 Connecting a carrier through the account home

A carrier (a browser extension) asks the home with `access: "carry"` (§2.4),
from a page that stays open until the answer comes. The home replaces any
earlier carrier from the same origin, adds the carrier (§4.2) with
`did` = the request's `audience`, and answers with a `CarryGrant`:

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
connection has no expiry and no note to revoke; disconnecting it removes the
carrier (§4.2).

_Source: `packages/core/src/session/connect.ts` (`connectCarrier`, `checkCarryGrant`, `CarryGrant`), `packages/core/src/session/auth.ts` (`grantCarry`). Tests: `packages/core/tests/connect.test.ts` ("connecting a carrier to an account home")._

### 4.4 Subscriptions, and carriers

"Let me know when…" subscriptions are kept in the account registry as `sys.notify` records, key
`notify:<base32 of 10 random bytes>`, body `NotifyWhen`:
`{ label (≤ 120), collection (not sys.*), spaces ("all" or 1–256 ids), topic?: { field, value }, others? (default true), open? (https URL), paused?, since (ISO date), app?: { origin, name? } }`.

An app proposes them when the person asks it to, and the home adds the ones
the person keeps, naming the app (§2.11). Disconnecting an app removes its
subscriptions (§2.10). The app shows what they match itself, while it runs
(§2.11). A subscription without `app` was made by an earlier home and is kept.

Each device copies every subscription into every carry space as
`sys.subscription` (same key), with the topic value replaced by the tag it has
in each space ([02](02-records.md)):
`{ v: 1, label, collection, spaces, tags?: { <spaceId>: [<tag>] }, others, open?, paused, since }`.
A private space whose key the device lacks gets no tag.

A version matches a carried subscription when all hold: not paused; same collection; `seq` 0 and not deleted; the space is in
`spaces`; `createdAt` is not before `since` and within the last 24 hours; with
`others`, the record's root is not the account; with `tags`, the record
carries one of that space's tags. No carrier acts on a match today: the copies
are there for waking an app that is closed (below).

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

**The subscription key.** When an account first uses a host, the node makes a 32-byte random seed, derives a
P-256 key pair from it, and keeps a `sys.hosting` record in the account
registry, key `hosting:<hex of the first 20 bytes of SHA-256(utf8(url))>`, body:

| Field     | Meaning                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| `url`     | The host's origin: `https://`, or `http://` on `localhost`/`127.0.0.1`.      |
| `host`    | The host's DID, from its description when first used.                        |
| `seed`    | The subscription key's seed, base64url.                                      |
| `since`   | ISO date.                                                                    |
| `name`    | The host's name, as it described itself.                                     |
| `peer`    | Optional: where the host takes peers, resolved from its description (below). |
| `receipt` | The latest `SignedStatus` the host gave (below).                             |

Every device of the account signs as the same subscription. It is not the
account's key: the host learns a subscription, not who pays.

**Description.** `GET <url>/.well-known/weave-host`, public:

| Field   | Meaning                                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weave` | `"host/1"`                                                                                                                                                           |
| `did`   | The host's key: its identity to peers, and what signs its statuses.                                                                                                  |
| `name`  | For people.                                                                                                                                                          |
| `free`  | Every subscription counts as paid.                                                                                                                                   |
| `price` | Optional, free text.                                                                                                                                                 |
| `pay`   | Optional: the pay page, relative to the host's address or absolute. Absent: it takes no payments.                                                                    |
| `terms` | Optional, for people.                                                                                                                                                |
| `peer`  | Optional: where it takes peers over WebSocket ([04](04-network.md)), relative to the host's address or absolute. Absent: devices cannot reach it by its description. |

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

**Pay link.** A device never handles payment. It opens the host's pay page
with, in the fragment,
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

**What a device does.** A device asks each host the account uses for its
status. When the status says it is not carrying and it is paid (`active`,
`grace`, or a free host not `lapsed`), the device hands over the carry space
with `PUT …/carry`, making the carrier (§4.2) for the host's DID first if the
account has none. It writes the returned receipt into the `sys.hosting` record
when the state, `paidUntil`, `renews` or name changed. To stop using a host it
sends `DELETE …/carry`, removes the carrier and deletes the `sys.hosting`
record. How often the reference asks is in
[the node](../packages/core/docs/node.md#carriers-hosting-and-notifications).

**What a host does.** Subscriptions are `active` while `paidUntil ≥ now` (or
always, when free), `grace` for a grace period after (the host's policy), then
`lapsed`; a lapsed subscription is dropped, and its carry space with it unless
another subscription carries it. Paying again
in time carries again what the grace period kept. A host MAY carry only a
configured list of accounts, and then MUST refuse any other before keeping
anything. It runs the carrier of §4.1–4.2 for every carry space.

**Reaching a host.** A device resolves `peer` against the host's address
(`new URL(peer, url + "/")`), reading `https:` as `wss:` and `http:` as `ws:`.
It MUST NOT use an address that is not `wss://`, except `ws://` on
`localhost` or `127.0.0.1`. It keeps the resolved address in the
`sys.hosting` record, so the account's other devices have it without asking.
Every device of the account then holds a socket to that address for every
space it holds ([04](04-network.md)), as the host carries all of them through
the carry space. A device also holds one, for that space, to each host a space
it holds pays itself (§4.6). Example: a host at `https://host.example` that
describes `"peer": "/peer"` is reached at `wss://host.example/peer`, and a
space `b3kq7zp2f4mhx6ydwa5rtc9n1e` at
`wss://host.example/peer?space=b3kq7zp2f4mhx6ydwa5rtc9n1e`.

A device MAY be built with hosts to look for its account registry at before it
knows which the account uses: that is how a new device with only the recovery
code finds its registry, and every space from it. The host learns the
registry's id and the device's session key, and serves it only if it carries
it. The reference reaches those hosts for the registry alone.

_Source: `packages/core/src/session/hosting.ts` (`hostPeerAddress`), `packages/core/src/node/host.ts`, `packages/core/src/node/node.ts` (`hosting`, `reachHosts`), `packages/core/src/node/space-runtime.ts` (`useNodes`), `packages/cli/src/host.ts`, `packages/cli/src/pay-page.ts`. Tests: `packages/cli/tests/host.test.ts` ("reaching a host at the address it names": all)._

### 4.6 A space paying for itself

A space can also be a host's subscriber: its **own subscription** there,
which anyone may pay into, so a community keeps its space online together.
The host carries that one space as a carrier would (§4.1), from a pass
(§4.2) any member's device hands over, and can read no more of it than any
carrier.

**The subscription.** It is named `space:<space id>`. It has no key: anyone
may ask how it stands and pay for it, and a pass proves itself, so nothing
about it is signed but the host's answers. A host MUST refuse a space id that
does not match `^[A-Za-z0-9_-]{1,120}$`.

**Calls.** No `Authorization`.

| Call                               | Body                            | Answer                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /host/spaces/<space id>`      | —                               | `SignedStatus` (§4.5), `subscription` `space:<space id>`; `state` `none` before anyone paid or handed a pass                                                                                  |
| `PUT /host/spaces/<space id>/pass` | `{ "pass": <SpacePass, §4.2> }` | `SignedStatus`. 402 when not paid (or lapsed); 403 when the host carries only named accounts; 400 when the pass does not open, or is for another space. A later pass replaces the one before. |

A host MUST check a pass as a carrier checks one from a carry space (§4.2):
its space must verify and hash to the id in the path, and a private space's
read key must be one the space's history names. It carries the space while
the subscription is `active` or `grace`, and drops it when it lapses unless an
account's carry space also names it.

For a space's own subscription, `HostStatus` also has:

| Field     | Meaning                                                                                      |
| --------- | -------------------------------------------------------------------------------------------- |
| `readKey` | For a private space it carries: the read key it carries it with, as a DID. Absent otherwise. |

`carrying` is whether it carries the space now, and `spaces` is 1 when it
does. A device compares `readKey` with the space's current read key to know
whether the host needs a newer pass, after the space's key changed.

**Pay link.** `<pay page>#space=<space id>`, not signed. The pay page calls
the host's pay API with

```
Authorization: WeavePay space=<space id>
```

which a host MUST read as that space's own subscription, and MUST NOT count
as the pay link of any account's. Payments to it add time to what is paid
already, whoever makes them.

```
https://host.example/pay#space=b3kq7zp2f4mhx6ydwa5rtc9n1e
```

**Which host a space uses** is not protocol: the library keeps it in a
`std.host` record that only those who may manage the space write, and every
member's device holding the space key hands that host the pass once the
space is paid for there, and again when its key changes. See
[the node](../packages/core/docs/node.md#a-space-paying-for-itself).

Anyone who knows a space's id can learn whether a host carries it and until
when, as its status is open. A pass lets its holder download the space's
records sealed, as a carrier does; any member could hand one over already.

_Source: `packages/core/src/node/host.ts` (`carrySpace`, `spaceSubscription`), `packages/core/src/node/carrier.ts` (`addPass`, `removePass`), `packages/core/src/session/hosting.ts` (`createSpaceHostClient`, `spacePayLink`, `verifyPayLink`), `packages/cli/src/host.ts` (`answerSpace`), `packages/cli/src/stripe.ts` (`once`). Tests: `packages/cli/tests/host.test.ts` ("a space paying for itself": all)._

### 4.7 Planned: hosts

> **Planned.** Not normative.
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
> `paidUntil` and once when the grace period starts. Email is the host's own
> business. The protocol route is Web Push through the carry space (§4.4,
> Planned): the home writes a
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

Calls are not protocol. A call is live messages (§9.2 of [04](04-network.md))
between copies of an app, plus WebRTC connections of the app's own; no peer
syncs, stores or judges a record differently because of it. The `call.*`
messages two calling apps agree on, and how the reference library rings,
joins and leaves, are in [calls](../packages/core/docs/calls.md).
