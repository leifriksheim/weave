# The node

`createNode` and what it returns: configuration, stores, holding spaces,
events, live messages, the rest of its surface, acting as an agent, the
app-side client, doors, and the React and element conveniences.

> Not protocol. This page describes the reference library, and another
> implementation may do it differently and still interoperate. What peers must
> agree on is in the [spec](https://github.com/leifriksheim/weave/blob/main/spec/README.md).

## Configuration

`createNode(config)` takes (`NodeConfig`):

| Field               | Type                        | Meaning                                                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signer`            | `RootSigner`                | Who the node acts for. Asked only for session notes ([spec 06 §1.2](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).                                                                                                                                                                  |
| `accountKey`        | bytes, optional             | The account's vault key bytes. Enables the account registry and the contacts space ([spec 06 §1.3](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).                                                                                                                                   |
| `contactKey`        | bytes, optional             | The contact key's secret. Opens contact requests; published on profiles.                                                                                                                                                                                                                                              |
| `contactsSpace`     | string, optional            | The contacts space's id, for a node given it without the account key (an app granted `contacts`, [spec 06 §2.5](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).                                                                                                                      |
| `stores`            | `StoreFactory`              | Where the registry and each space's store live ([stores](#stores)).                                                                                                                                                                                                                                                   |
| `provider`          | `CryptoProvider`, optional  | Default: P-256 over WebCrypto.                                                                                                                                                                                                                                                                                        |
| `collections`       | `CollectionDef[]`, optional | Schemas the node knows, used when a space does not describe a collection itself. Writes are checked against them; reads are flagged `conforms`. Nothing is refused on arrival for its shape ([02](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)).                                               |
| `network`           | optional                    | `relays` (WebRTC signaling, browsers), `nodes` (always-on nodes to dial, `ws(s)://host/peer`), `iceServers`, `transports` (extra transports per space). Omitted: offline.                                                                                                                                             |
| `sessionTtlSeconds` | number, optional            | Lifetime of each session note. Default `3600`.                                                                                                                                                                                                                                                                        |
| `sessionKey`        | `CryptoKeyPair`, optional   | Sign with this key instead of a fresh one. Used when the signer's note names a specific key (an app's key, an agent's key, [spec 06 §2](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md), [spec 06 §3](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)). |
| `watchIntervalMs`   | number, optional            | How often to look for writes another process made to a folder store. `0` disables. Default `2000`. _Implementation detail._                                                                                                                                                                                           |
| `cache`             | `CacheConfig`, optional     | Hold only the collections used, in spaces that name a keeper ([holding part of a space](#holding-part-of-a-space)).                                                                                                                                                                                                   |
| `mailbox`           | `MailboxClient`, optional   | How doors reach relays' mailboxes ([07](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md)). Default: a WebSocket to each relay.                                                                                                                                                                       |

_Source: `packages/core/src/node/types.ts` (`NodeConfig`, `NodeNetworkConfig`, `CacheConfig`). Tests: `packages/core/tests/node.test.ts`, `packages/core/tests/caches.test.ts`._

## Lifecycle

Starting a node does the following, in order:

1. Uses `config.sessionKey`, or generates a fresh P-256 key pair. Its DID
   (`did:key`, P-256 multicodec) is `sessionDid`.
2. Asks `config.signer.delegate` for a session note ([spec 06 §1.2](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)) and waits for it.
   If the signer refuses, `createNode` fails.
3. Schedules renewal of the note ([spec 06 §1.2](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).
4. Opens the `registry` store, sealed ([stores](#stores)).
5. With an account key: derives the account registry space and the contacts
   space ([03](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)). The contacts space is added to the node's own
   registry like a joined space (so it can be granted to an app like any other
   space), and both are _hidden_ from `spaces.list` ([spec 06 §1.3](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).
6. With an account key: opens the account registry space and reconciles
   ([spec 06 §1.3](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)) before `createNode` returns.

`close()` stops renewal, closes every open space (flushing what each keeps,
stopping sync and disconnecting its transports), closes the registry store,
and drops all event listeners. After `close()`, any call that needs a space
fails with `Node is closed`. Closing twice does nothing.

_Source: `packages/core/src/node/node.ts` (`createNode`, `close`). Tests: `packages/core/tests/node.test.ts`._

## Stores

A node asks for stores by path through its `StoreFactory`:

| Path               | Holds                                                | Sealed                                  |
| ------------------ | ---------------------------------------------------- | --------------------------------------- |
| `registry`         | the node's list of spaces and their keys             | yes: the node asks for `{ seal: true }` |
| `spaces/<spaceId>` | one space's records and what the node keeps about it | no                                      |

What a path means is the factory's choice:

- `indexedDBStores(prefix)` — one IndexedDB database per path, named
  `<prefix>:<path with / replaced by :>`. Never sealed: the browser profile
  already guards it.
- `folderStores(directory, { basePath?, vaultKey? })` — a directory tree under
  `basePath`; the `registry` is sealed under `vaultKey` when one is given.

Sign-in ([sign-in](sign-in.md)) uses `storesFor(account)`: IndexedDB with prefix
`weave:<dataPath with : for />` in the browser, or `folderStores(pod,
{ basePath: account.dataPath, vaultKey })` in a pod, where `dataPath` is
`accounts/<id>/stores`. A connected app uses `indexedDBStores('weave-app:<account DID>')`
by default. These names are _implementation details_; a pod's layout is in
[05](https://github.com/leifriksheim/weave/blob/main/spec/05-sync-and-storage.md).

`copyAccountData({ from, to, did, accountKey? })` copies every space an
account holds, with its key and records, from one set of stores to another —
the account registry too, when `accountKey` is given. It is a union: every
version goes through the same ordering rule as sync, so copying into a store
that holds some of it already is safe, and copying twice changes nothing.

Copied versions are meant to pass the same checks as versions arriving by
sync ([02 — Records](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md), validation) before they are stored.

> **Known defect:** `copyAccountData` stores each version with
> `addExpression` directly, without running it through the validation
> pipeline (`packages/core/src/node/copy.ts`). A pod or data folder that another origin
> wrote to can bring versions this node would have refused from a peer. A fix
> will validate on copy, as sync does.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20).

_Source: `packages/core/src/node/stores.ts`, `packages/core/src/node/copy.ts`, `packages/core/src/session/places.ts` (`storesFor`). Tests: `packages/core/tests/account.test.ts`, `packages/core/tests/folder-adapter.test.ts`._

## Opening and holding spaces

A space is opened (its store read, its peers joined, sync started) the first
time anything asks for it — a read, a write, a status — and stays open until
it is released or the node closes. Opening a space also: publishes the
account's profile in it ([spec 06 §1.3](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)), checks whether the session note was revoked
there ([events](#events), `revoked`), and names the account's carriers as keepers if the
account manages it ([spec 06 §4.2](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).

`spaces.hold(id)` keeps a space open until released. It returns a function
that lets go of that one hold:

- Holds are counted per space. When the count reaches zero, the space closes.
- Releasing twice does nothing.
- A hold made before the space was closed for another reason (leaving it) is
  tied to that stretch of being held: releasing it later does nothing to a hold
  made after rejoining.
- Reading or writing needs no hold.

> Rationale: anything that needs a space live holds it — a screen showing it, a
> call in it — so a screen going away never cuts off a call in the same space.

_Source: `packages/core/src/node/node.ts` (`runtime`, `hold`, `closeRuntime`). Tests: `packages/core/tests/live.test.ts` ("holding a space")._

## Holding part of a space

With `config.cache`, and once a space names at least one keeper
([03](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md), `sys.keepers`), the node holds only the collections it
uses, besides the space's own `sys.*` collections. Everything about this is the
node's own choice; how it tells peers what it holds is in
[05](https://github.com/leifriksheim/weave/blob/main/spec/05-sync-and-storage.md). As implemented:

- Collections listed in `cache.collections` are held from the start and never
  dropped.
- A query marks the collections it reads (its own and every `include … from`)
  as used; sync then fetches them. A query's result has `complete: false`
  until the node has once been level with a node holding the whole space for
  every collection it reads.
- Until the node has once caught up fully with a node holding the whole space,
  it cannot know whether the space names keepers, so it holds only what it uses.
- The node's own writes are _pending_ until `min(keepers named, max(copies ?? 2,
cache.copies ?? 0))` of the space's named keepers have them. A collection
  holding a pending write is never dropped.
- A collection unused for `cache.unusedAfterDays` (default 30) days is dropped
  when the space opens and every 6 hours while it stays open.
- A space that names no keeper is held whole.

The account registry, the contacts space and carry spaces are always held
whole. Apps connected to an account home use `cache: {}` by default ([spec 06 §2.8](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).

_Source: `packages/core/src/node/space-runtime.ts` ("Holding part of the space"). Tests: `packages/core/tests/caches.test.ts`._

## Events

`node.subscribe(listener)` delivers `NodeEvent`s and returns an unsubscribe
function. A listener that throws does not stop the others.

| `type`     | Fields                                      | When                                                                                                                                                                                |
| ---------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `records`  | `space`                                     | Records were added, changed or deleted in a space, locally or by sync.                                                                                                              |
| `status`   | `space`                                     | Connection state or peers changed. A status change in the account registry is re-emitted for every open space (which peers are the account's own is read off the registry's peers). |
| `spaces`   | —                                           | The node's list of spaces changed: created, joined, left, a role or waiting invite changed.                                                                                         |
| `account`  | —                                           | The account's profile may have changed (records changed in the account registry, or `setName`).                                                                                     |
| `rejected` | `space`, `peer`, `reason`                   | A peer sent a version that failed validation.                                                                                                                                       |
| `message`  | `space`, `from`, `peer`, `agent`, `message` | A live message arrived ([live messages and status](#live-messages-and-status)).                                                                                                     |
| `revoked`  | `space`                                     | The note this node writes under was revoked in that space. Emitted at most once per space per node.                                                                                 |

_Source: `packages/core/src/node/types.ts` (`NodeEvent`), `packages/core/src/node/node.ts` (`fromRuntime`, `checkRevoked`). Tests: `packages/core/tests/node.test.ts` ("events announce local writes"), `packages/core/tests/connect.test.ts` ("disconnecting revokes the note")._

## Live messages and status

`spaces.send(id, message, to?)` sends a JSON value to the peers connected in
the space right now, kept nowhere and signed as nothing. `to` is either an
account DID (every connected device that showed a note from that account) or a
session DID (one device). The encoded message must be at most 64 KiB; larger
is refused locally. The wire format, the per-peer allowance (a burst of 60,
then 20 per second) and how the sender's account is established are in
[04](https://github.com/leifriksheim/weave/blob/main/spec/04-network.md).

A received live message is emitted as a `message` event:

| Field     | Meaning                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `from`    | The account behind the sending device, proven by the note it showed, made out to the key the connection proved. `null` for a peer that showed no note (a carrier, a node serving sockets). |
| `peer`    | The sending device's session DID — also where a reply to that device goes.                                                                                                                 |
| `agent`   | `true` when the sender's note is an agent's ([spec 06 §3.1](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).                                               |
| `message` | The value sent.                                                                                                                                                                            |

`spaces.status(id)` returns `SpaceStatus`:

| Field         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection`  | `offline` (no network), `connecting`, `connected` (while any one transport is connected: a relay socket open, or a peer), `error` (the first connect failed and nothing has connected since), `refused` (nothing connected, and every relay refused this node's DID with `4009` because another node with the same key holds it, [spec 04 §1.2](https://github.com/leifriksheim/weave/blob/main/spec/04-network.md)). A space whose relays all drop and whose peers leave is `connecting` again, not `connected`. |
| `peers`       | Session DIDs connected in the space.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `own`         | Of `peers`, the account's own other devices and apps: those also connected in the account registry, minus carriers. Empty without an account key.                                                                                                                                                                                                                                                                                                                                                                 |
| `carriers`    | Of `peers`, the account's carriers, by the keys `sys.carrier` records name.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `accounts`    | Session DID → account, for each peer that showed a valid note.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `fingerprint` | A fingerprint of every version held; equal on two nodes means identical data ([05](https://github.com/leifriksheim/weave/blob/main/spec/05-sync-and-storage.md)).                                                                                                                                                                                                                                                                                                                                                 |
| `rejected`    | How many versions peers sent failed validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `holds`       | `"all"`, or the sorted list of collections held ([holding part of a space](#holding-part-of-a-space)).                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pending`     | This node's writes still waiting for keepers ([holding part of a space](#holding-part-of-a-space)).                                                                                                                                                                                                                                                                                                                                                                                                               |

> Rationale: a peer's key does not say whose it is, but only the account's own
> devices and apps can read its registry, so a peer there is one of ours.

_Source: `packages/core/src/node/node.ts` (`spaces.send`, `spaces.status`), `packages/core/src/node/space-runtime.ts` ("Live messages", `status`, `send`). Tests: `packages/core/tests/live.test.ts`._

## The rest of the node's surface

The node's other parts are specified where their data lives; the node only
exposes them:

- `node.spaces` — create, invite, preview, join, leave, access, `setMember`,
  `putRole`, `removeRole`, `closeInvite`, `changeKey`, `setRelays`,
  `setKeepers`, `revoke`, `profiles`, `authenticator` ([03](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md),
  [04](https://github.com/leifriksheim/weave/blob/main/spec/04-network.md)). Default invite role: the lowest role ranked below the
  inviter's own; with none below, a view-only invite.
- `node.records`, `node.collections` — [02](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md). `records.watch`
  re-runs a query after every `records` event for its space, one run at a time,
  with at most one more queued.
- `node.account` — `profile()`, `setName(name)` (writes `sys.profile`, key
  `profile`, in the account registry, then republishes the profile in every
  open space), `revoke(token)` (in the account registry). All need the account
  key.
- `node.contacts` — [03](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md). `ask` and `accept` make or join a space
  for two, so they need a session note with `with: "*"` (whole-account access).
- `node.direct` — [direct-messages.md](direct-messages.md): `reachable`, `send`
  and `list`. Needs the account's member key for the space.
- `node.doors` — [07](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md). Needs the contact key; knocking and
  accepting also need whole-account access.
- `node.carriers`, `node.hosting`, `node.notifications` — [spec 06 §4](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md).
- `node.iceServers()` — the configured ICE servers plus TURN servers a relay
  offers ([04](https://github.com/leifriksheim/weave/blob/main/spec/04-network.md)); what [calls](calls.md#connections) use.
- `node.network` — `status()`: each relay's state (open, or waiting to redial,
  when and why), the connections open and those still being made, and whether
  a relay offered TURN; `reconnect()` redials a waiting relay now
  ([spec 04 §2](https://github.com/leifriksheim/weave/blob/main/spec/04-network.md), [spec 06 §5.3](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)). A `network` event follows every change.
  Local only: nothing here goes over the wire.
- `node.asAgent({ keys, note })` — [acting as an agent](#a-node-acting-as-an-agent).

_Source: `packages/core/src/node/types.ts`, `packages/core/src/node/node.ts`. Tests: `packages/core/tests/node.test.ts`, `packages/core/tests/contacts.test.ts`, `packages/core/tests/direct.test.ts`, `packages/core/tests/profiles.test.ts`._

## A node acting as an agent

`node.asAgent({ keys, note })` returns the same node acting as an agent. It
throws unless the note verifies, carries the agent fact, is made out to `keys`,
and was issued by `node.did`. The agent:

- signs with its own key, under its note, so what it writes shows "via agent";
- reaches only spaces its note names (`space:<id>`), or every space for `*`;
  events for other spaces are filtered out;
- refuses, locally, everything that needs a person: making, inviting, joining
  or leaving spaces; changing members, roles, invites or revocations; changing
  a space's key, relays or keepers; defining
  or deleting collections; live messages (`send` — a live message carries no
  note to say "via agent"); renaming or revoking at the account level; adding or
  removing carriers; notifications; hosting; changing, blocking, asking or
  accepting contacts; everything about doors (its list of doors is empty);
  `delegate`; `asAgent`;
- sees the contact list only if the contacts space is within its note.

Closing the agent leaves the underlying node running.

An agent granted `scope: account` gets a `*` note and the account key in its
grant ([spec 06 §2.5](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)), so the contact list is within its note to read. A home must not
give an agent the contact key: with it, an agent could open contact requests
and knocks on the account's doors ([07](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md)).

_Source: `packages/core/src/node/node.ts` (`asAgent`). Tests: `packages/core/tests/agents.test.ts` ("an agent acting for a person")._

## The app-side client

`createWeaveConnection({ home, request, network?, storage?, stores? })` is the
app's twin of [sign-in](sign-in.md): statuses `starting`, `disconnected`, `connecting`, `ready`,
`expired`. It keeps the grant in `localStorage` under `weave.grant` and the
person's chosen home under `weave.home` (`home` in the config is only a
default). `propose(notify)` sends a proposal to the grant's home ([spec 06 §2.11](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).
`watchNotifications(node, { origin?, onNotify })` hands the app each record
that arrives matching one of its subscriptions ([spec 06 §2.11](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)). Client conveniences,
not protocol.

_Source: `packages/core/src/session/connection.ts`, `packages/core/src/node/watch-notifications.ts`. Tests: `packages/core/tests/connect.test.ts` ("an app showing its own notifications")._

## Doors

`node.doors` ([06 — Nodes, sessions and apps](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)):

| Call                               | Does                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list()`                           | Your open doors: `{ id, label?, name?, key, sign, relays, code, createdAt }`                                                                                                                                                                                                                                       |
| `open({ relays?, name?, label? })` | Opens a door. Relays default to this node's relays (up to 3); name to the account's name                                                                                                                                                                                                                           |
| `close(id)`                        | Deletes the `std.door`                                                                                                                                                                                                                                                                                             |
| `clear(id)`                        | Purges every knock at the door, from every relay it names                                                                                                                                                                                                                                                          |
| `knock(code, { note? })`           | [spec 07 §7](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md), returns `{ space }`                                                                                                                                                                                                                |
| `knocks()`                         | Fetches every open door's topic from every relay it names, opens and checks ([spec 07 §6](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md); opened results are cached by id), settles sent knocks and writes owed answers; returns `{ id, door, from, name, note?, pairSpace, at }`, newest first |
| `sent()`                           | Your unanswered knocks: `{ space, name, at }`                                                                                                                                                                                                                                                                      |
| `accept(id)`                       | [spec 07 §7](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md), returns the new `ContactView`                                                                                                                                                                                                      |
| `dismiss(id)`                      | Purges one knock                                                                                                                                                                                                                                                                                                   |

## Client conveniences

These are not protocol; another client may draw sign-in and [calls](calls.md) however it
likes.

- **`<weave-auth>`** draws the flow of [sign-in](sign-in.md) into its own light DOM (so password
  managers find its forms). Attributes: `app-name`, `relays` and `nodes`
  (comma-separated). It fires `weave-session` (`detail: { session }`, `null` when
  signed out), bubbling and composed. A page can hand it its own flow with
  `element.auth = createWeaveAuth(…)`.
- **React** (`@weaveprotocol/core/react`): `WeaveProvider`, `useWeave`,
  `useAuth`, `useSession`, `useConnection`, `useAccount`, `useNode`,
  `useWeaveAuth`, `<WeaveAuth>`, `useQuery`, `useLive`, `useSpaces`,
  `useHoldSpace` (holds a space while mounted, releasing it a few seconds late),
  `useRecord`, `useLinked`, `useCollections`, `useProfiles`, `useAccess`,
  `useSpaceStatus`, `useCan`, `CallsProvider`, `useCalls`.

_Source: `packages/core/src/elements/weave-auth.ts`, `packages/core/src/react/`. Tests: none._
