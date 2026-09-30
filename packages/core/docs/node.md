# The node

`createNode` and what it returns: configuration, root signers and notes, renewing
the session note, stores, holding spaces, following the account, events, live
messages, the rest of its surface, the network, acting as an agent, the
app-side client, carriers and hosting, doors, and the React and element
conveniences.

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
3. Schedules renewal of the note ([renewing the session note](#renewing-the-session-note)).
4. Opens the `registry` store, sealed ([stores](#stores)).
5. With an account key: derives the account registry space and the contacts
   space ([03](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)). The contacts space is added to the node's own
   registry like a joined space (so it can be granted to an app like any other
   space), and both are _hidden_ from `spaces.list` ([following the account](#following-the-account)).
6. With an account key: opens the account registry space and reconciles
   ([following the account](#following-the-account)) before `createNode` returns.

A node acts for one account (`node.did`) and signs with one session key
(`node.sessionDid`) for its whole lifetime. To act for another account, start
another node.

`close()` stops renewal, closes every open space (flushing what each keeps,
stopping sync and disconnecting its transports), closes the registry store,
and drops all event listeners. After `close()`, any call that needs a space
fails with `Node is closed`. Closing twice does nothing.

_Source: `packages/core/src/node/node.ts` (`createNode`, `close`). Tests: `packages/core/tests/node.test.ts`._

## Root signers and notes

A node never holds the root key. It is given a **root signer** (`RootSigner`),
which hides where the key lives and is asked only for notes. This is an
in-process interface, not a wire format; what a note must be is
[spec 01 §7](https://github.com/leifriksheim/weave/blob/main/spec/01-identity.md).

| Member                                                   | Type                    | Meaning                                                                                          |
| -------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `did`                                                    | string                  | The account DID                                                                                  |
| `custody`                                                | `'local'` \| `'remote'` | `local`: the seed is unlocked in this page. `remote`: another context (an account home) holds it |
| `delegate({audience, capabilities, expiration, facts?})` | → UCAN                  | Issue a note from the account to `audience`                                                      |

- The **local** signer (`createLocalRootSigner`) calls `issueUCAN` with the
  root key. It includes `fct` only when `facts` is non-empty.
- The **grant** signer an app uses returns the one note the account home
  already issued to the app's key, unchanged, and refuses once the grant's
  `expiresAt` has passed. It cannot mint new notes
  ([spec 06 §2](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).

The **session note** a node asks for when it starts:

```
aud = session DID
att = [{ "with": "*", "can": "expression/*" }]   (SESSION_CAPABILITY)
exp = now + sessionTtlSeconds                     (default 3600)
nbf = now − 300                                   (issueUCAN's default)
fct = absent                                      (or [{"weave":"agent"}] for an agent's own node)
prf = []
```

Peers check only that the note covers what each record needs, so `att` is
this node's choice, not a rule. The note is renewed before it runs out
([spec 06 §1.2](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).

**Issuing.** `issueUCAN` defaults `exp` to now + 3600, `nbf` to now − 300
(`UCAN_CLOCK_SKEW_SECONDS`, so a peer whose clock is a little behind still
accepts it), `nnc` to 16 random hex characters, and `prf` to `[]`.
`delegateCapabilities` issues a child of an existing note, with
`prf = [CID(parent)]` and no facts, and refuses when:

- the issuer is not the parent's `aud`;
- a child capability is not covered by some parent capability
  ([spec 01 §7.6](https://github.com/leifriksheim/weave/blob/main/spec/01-identity.md));
- the requested `exp` is later than the parent's (default: the parent's `exp`).

These refusals only save issuing a note that would not verify: a verifier
checks the chain itself ([spec 01 §7.5](https://github.com/leifriksheim/weave/blob/main/spec/01-identity.md)).

_Source: `packages/core/src/identity/root-signer.ts`, `packages/core/src/identity/ucan.ts` (`issueUCAN`, `delegateCapabilities`), `packages/core/src/node/node.ts` (`SESSION_CAPABILITY`, `delegate`), `packages/core/src/session/connect.ts` (`grantSigner`, `grantCapabilities`). Tests: `packages/core/tests/ucan.test.ts`, `packages/core/tests/node.test.ts`, `packages/core/tests/connect.test.ts`._

## Renewing the session note

The note format, and that every record carries it, are protocol
([spec 06 §1.2](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)). When to renew it is the node's own:

- The first renewal is asked for at `0.75 × ttl` seconds after start (2700 s
  with the default TTL), and each successful renewal schedules the next
  `0.75 × ttl` later.
- If the signer refuses or cannot be reached, the node keeps the note it has
  and asks again after `min(60, ttl / 4)` seconds, repeating until it succeeds
  or the node closes. Once the held note expires, peers (and the node's own
  gates) refuse what it writes.

A signer need not be able to sign. `grantSigner(grant)` answers every
`delegate` call with the one note an account home granted, unchanged, and
refuses once `grant.expiresAt` has passed. A node started from a grant
therefore never gets a fresh note: its "renewal" returns the same note, and when
it runs out the app must connect again ([spec 06 §2.9](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).

`node.delegate({ audience, capabilities, expiration? })` passes a narrower note
from the session key on to another key. The capabilities must be no broader
than the session note's, and `expiration` is capped at the session note's. It
returns `{ token, proofs: [<session note>] }`.

`node.delegation()` returns the note the session key writes under now.

_Source: `packages/core/src/node/node.ts` (`delegate`, `scheduleRenewal`, `SESSION_CAPABILITY`), `packages/core/src/session/connect.ts` (`grantSigner`). Tests: `packages/core/tests/node.test.ts` ("the delegation is renewed before it expires")._

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
by default. These names are _implementation details_ ([sync and storage](storage.md#indexeddb));
a pod's layout is in
[05](https://github.com/leifriksheim/weave/blob/main/spec/05-sync-and-storage.md).
A node also opens `mirrors/<spaceId>/<n>` for a mirror's writer state
([mirrors](storage.md#mirrors)), and a host `host` for its subscriptions.

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
account's profile in it ([following the account](#following-the-account)), checks whether the session note was revoked
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

## Leaving a space

`spaces.leave(id)` deletes the space's `sys.joined` record in the account
registry, closes the space and forgets it with its keys. It is local: it
writes no `sys.member` self-removal, so the space's history still lists the
account, keeps it a reader, and no key change becomes due. To give up the
role too, call `setMember(id, self, null)` first. The account registry and
the contacts space cannot be left.

> **Known defect:** a leave should also give up the account's place in the
> space ([spec 03 §6.2](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md),
> planned there). The fix makes `spaces.leave` write the account's own
> `sys.member` with `role: null` first, then forget the space as today.
> Tracked in [#15](https://github.com/leifriksheim/weave/issues/15).

_Source: `packages/core/src/node/node.ts` (`spaces.leave`, `forget`). Tests: `packages/core/tests/node.test.ts` ("the account registry")._

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
  when the space opens and every 6 hours while it stays open. It stops being
  held _before_ its versions are removed, so nothing syncs it back meanwhile.
- A space that names no keeper is held whole, and the node may itself be one
  of its copies.
- When what it holds changes (whole or part, or a newly used collection), the
  node says hello to every peer.

A keeper confirms a write the way the spec says: by `stored`, or by being
level with the writer on its collection. Only a peer named in `sys.keepers`
counts ([spec 05 §9](https://github.com/leifriksheim/weave/blob/main/spec/05-sync-and-storage.md)).

This state is kept in the space's own store (`spaces/<spaceId>`):

| Key                    | Value (UTF-8 JSON)                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache`                | `{ "settled": boolean, "used": { [collection]: ms }, "level": { [collection]: ms } }`. `settled`: has synced with a whole-space peer; `used`: when a query last used it; `level`: when it was first level with a whole-space peer |
| `pending/<version id>` | `{ "collection": string, "by": [keeper DID…] }`, deleted once `by` reaches the target                                                                                                                                             |

Completeness rests on trust: a keeper that withholds versions, or a peer
holding `"all"` that lost some, still counts as level, and a reader cannot
tell. Signed writer logs will replace this definition of complete
([spec 05 §9.1](https://github.com/leifriksheim/weave/blob/main/spec/05-sync-and-storage.md)).

The account registry, the contacts space and carry spaces are always held
whole. Apps connected to an account home use `cache: {}` by default ([the app-side client](#the-app-side-client)).

_Source: `packages/core/src/node/space-runtime.ts` ("Holding part of the space"), `packages/core/src/node/types.ts` (`CacheConfig`). Tests: `packages/core/tests/caches.test.ts`, `packages/core/tests/reconcile.test.ts` ("holding part of a space")._

### Planned: caches that widen and trim

> **Planned.** None of it changes what other nodes see. Fetching linked
> records by key, and holding less than a collection, need new messages and
> are planned in [spec 05 §9.2](https://github.com/leifriksheim/weave/blob/main/spec/05-sync-and-storage.md).

- **Widening.** A node holding part of a space starts holding all of it when
  too few keepers are online (Holochain's arcs: nodes grow their share when
  others go missing). Opt-in only (`cache.widen: true`), since done on its own
  it could fill a disk at a bad moment. Open: what "too few" is, and for how
  long. Today a cache only widens as queries use collections.
- **Trimming by size.** `cache.maxBytes`: above it, drop least recently used
  collections first, undeclared ones before declared. Also trim when
  `navigator.storage.estimate()` says room is low, before the browser clears
  the site. Pending writes are never dropped.

## Following the account

What counts in the account's list of spaces, and what a device with the
account key must keep current for carriers, is protocol
([spec 06 §1.3](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)). How the reference node does it:

The node's `registry` store ([stores](#stores)) lists every space it holds,
with its key(s), its invite secret while one is waiting to be used, its role
as last seen, the relays the space names and, for an app without the account
key, its member key. Its format is the node's own
(`packages/core/src/space/space-manager.ts`).

Three kinds of space are the account's own machinery and are hidden from
`spaces.list`:

| Space                | Derived from                               | Notes                                                          |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| The account registry | the account key                            | Never in the node's registry; opened directly. Cannot be left. |
| The contacts space   | the account key, or `config.contactsSpace` | Held in the registry, hidden. Cannot be left.                  |
| Carry spaces         | one per carrier the account uses           | Held in the registry, hidden.                                  |

**Reconciling.** With an account key, the node makes its spaces match the
account's list of `sys.joined` records. This runs at start and whenever
records change in the account registry, one run at a time. It:

1. joins every carry space a live `sys.carrier` record names, and closes and
   forgets one whose carrier was removed more than 30 days ago (kept open until
   then, so an offline carrier still hears it was removed);
2. joins every space a live `sys.joined` record names that the node does not
   hold, using the view-only invite in the record;
3. leaves every space whose `sys.joined` record is deleted;
4. writes a `sys.joined` record for any space held here that the account
   registry has never heard of (joined before the registry existed, or on a
   node without the account key);
5. brings every carrier's passes and subscriptions up to date
   ([spec 06 §4.2](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md));
6. names the account's carriers as keepers of the open spaces it manages
   (also whenever a space opens);
7. asks every host the account uses how it stands, handing it the spaces if it
   has been paid since ([carriers and hosting](#carriers-hosting-and-notifications)),
   without waiting for the answer.

Creating or joining a space writes its `sys.joined` record; leaving deletes it.

**Profiles.** When a space opens, when the node's role in it becomes non-null,
and when the account's name changes on any device, the node publishes the
account's profile in that space: `{ name, contactKey? }`, with the name taken
from the account registry's `sys.profile` record and `contactKey` only when
the node holds the contact key. It does this only in spaces other than the
account registry and the contacts space, only with an account name to publish,
and never under an agent's note. The profile record format is in
[03](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md).

**Joining.** `spaces.join(invite)` accepts a bare invite or any link carrying
`#invite=…`, `?invite=…` or `&invite=…`. It stores the space (and its key, for
a private space), stores `memberKey` when given, writes the `sys.joined`
record, then tries to use the invite's role secret at once. If the space's
invite record has not reached this device yet, the space is held with
`joining: true` and the node tries again each time records arrive in it.

**Leaving.** `spaces.leave(id)` deletes the `sys.joined` record, closes the
space and forgets it with its key. It does not give up the account's role in
the space; to do that, `setMember(id, self, null)` first.

_Source: `packages/core/src/node/node.ts` (`reconcileOnce`, `remember`, `forget`, `finishJoining`, `publishProfile`, `spaces`), `packages/core/src/space/space-manager.ts`. Tests: `packages/core/tests/node.test.ts` ("the account registry"), `packages/core/tests/profiles.test.ts`, `packages/core/tests/space-access.test.ts`._

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

### Versions that wait or are refused

A version from a peer stands, waits or is refused
([spec 02 §9.5](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)).
What the node does with each is its own:

- A batch from a peer is admitted `sys.collection` versions first, then by
  ascending `seq`, so definitions and first versions are in before what
  depends on them and little has to wait.
- A version that waits is held in memory, at most 1,000, the oldest dropped
  when full, and judged again whenever something new is stored. A version
  waiting for its first version, or the one before it, asks the peer for
  them at once.
- A refused version emits a `rejected` event with the peer and the reason,
  and is remembered as (peer, id), at most 10,000, so it is not asked of that
  peer again. Never by id alone: a copy with a mangled signature has the
  genuine version's id.

_Source: `packages/core/src/sync/sync-engine.ts` (`admit`, `admitAll`, `rank`, `MAX_WAITING`, `MAX_REFUSED`). Tests: `packages/core/tests/reconcile.test.ts` ("a refused version is not asked for again", "a version that waits for its first version asks for it at once, and is acknowledged once in")._

## Live messages and status

`spaces.send(id, message, to?)` sends a JSON value to the peers connected in
the space right now, kept nowhere and signed as nothing. The message is
`JSON.stringify(message ?? null)`; if that is longer than 65 536 characters
the call throws "A live message can be at most 64 KB". It goes as a `live`
message to every connected peer of the space, once per peer, over whichever
network that peer was last connected on. With `to`, it goes only to peers
whose session DID equals `to` (one device), or whose account DID, as learned
from their `who`, equals `to` (every device of that account); a peer whose
`who` has not been checked yet is matched by session DID only. An agent's node
refuses `send` ([acting as an agent](#a-node-acting-as-an-agent)). The wire
format, the per-peer allowance (a burst of 60, then 20 per second) and how the
sender's account is established are in
[spec 04 §9](https://github.com/leifriksheim/weave/blob/main/spec/04-network.md).

A received live message is emitted as a `message` event,
`{ type: "message", space, from, peer, agent, message }`:

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
| `fingerprint` | A fingerprint of every version held; equal on two nodes means identical data ([the store in memory](storage.md#the-store-in-memory)).                                                                                                                                                                                                                                                                                                                                                                             |
| `rejected`    | How many versions peers sent failed validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `holds`       | `"all"`, or the sorted list of collections held ([holding part of a space](#holding-part-of-a-space)).                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pending`     | This node's writes still waiting for keepers ([holding part of a space](#holding-part-of-a-space)).                                                                                                                                                                                                                                                                                                                                                                                                               |

> Rationale: a peer's key does not say whose it is, but only the account's own
> devices and apps can read its registry, so a peer there is one of ours.

_Source: `packages/core/src/node/node.ts` (`spaces.send`, `spaces.status`), `packages/core/src/node/space-runtime.ts` ("Live messages", `status`, `send`). Tests: `packages/core/tests/live.test.ts`._

## The rest of the node's surface

The node's other parts are specified where their data lives; the node only
exposes them. Every value a node method returns is JSON-serialisable, so the
same calls can be exposed over a command line, MCP and WebMCP
([actions](actions.md)).

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
- `node.contacts` — [contacts.md](contacts.md). `ask` and `accept` make or join a space
  for two, so they need a session note with `with: "*"` (whole-account access).
- `node.direct` — [direct-messages.md](direct-messages.md): `reachable`, `send`
  and `list`. Needs the account's member key for the space.
- `node.doors` — [doors.md](doors.md), [07](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md). Needs the contact key; knocking and
  accepting also need whole-account access.
- `node.carriers`, `node.hosting`, `node.notifications` — [carriers and hosting](#carriers-hosting-and-notifications), [spec 06 §4](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md).
- `node.iceServers()` — the configured ICE servers plus TURN servers a relay
  offers ([the network](#the-network)); what [calls](calls.md#connections) use.
- `node.network` — `status()`: each relay's state (open, or waiting to redial,
  when and why), the connections open and those still being made, and whether
  a relay offered TURN; `reconnect()` redials a waiting relay now
  ([the network](#the-network), [spec 04 §2](https://github.com/leifriksheim/weave/blob/main/spec/04-network.md)). A `network` event follows every change.
  Local only: nothing here goes over the wire.
- `node.asAgent({ keys, note })` — [acting as an agent](#a-node-acting-as-an-agent).

_Source: `packages/core/src/node/types.ts`, `packages/core/src/node/node.ts`. Tests: `packages/core/tests/node.test.ts`, `packages/core/tests/contacts.test.ts`, `packages/core/tests/direct.test.ts`, `packages/core/tests/profiles.test.ts`._

## The network

How the node uses relays, always-on nodes and WebRTC, where
[spec 04](https://github.com/leifriksheim/weave/blob/main/spec/04-network.md)
leaves it the choice. Another implementation may pick other values and still
meet this one.

**Redialling a relay** (spec 04 §2). The client waits 1, 2, 4, 8, 16 s and
then 30 s between attempts, each ±20% so peers that dropped together do not
return together, and never stops until `disconnect`. After a `4009` it emits
`refused` and waits 10 s, doubling with each refusal in a row up to 60 s. It
tries at once when the browser reports `online` or the page becomes visible
again, since both follow a network change or a sleep, and when asked
(`reconnect`). A successful open resets the count. Each relay's state
(`connecting`, `open`, `waiting` with the time of the next attempt and why the
last one failed, `stopped`) is readable as `RelayStatus`, and through a node
as `network.status()`.

**Several relays** (spec 04 §3). The signaling layer raises `peer-joined`
when a peer's set of relays in a room becomes non-empty, and `peer-left` when
it empties. `requestIce` asks every connected relay for TURN.

**A space's relays** (spec 04 §4). A relay socket opened only for spaces'
own relays is closed once no room needs it. A node that holds `manage` in a
space that names no relays names its own configured relays (the valid ones,
at most 8) by itself.

**Always-on nodes** (spec 04 §5.2). `network.nodes` lists the node URLs to
dial, one socket per node per space. After an unexpected close the client
redials without limit, waiting `base/2 + random·base/2` where
`base = min(1 s · 2ⁿ, 30 s)`; a deliberate close is never redialled. The
`/peer` endpoint waits 10 s for the hello (configurable).

**In-process links** (spec 04 §5.4). `createLocalHub()` links every
transport made from it that has connected, delivering on a later task with
the bytes copied, as on a real wire. It performs no handshake. A carrier uses
it to link its own copy of a space with the copy in the person's pod folder,
so the usual sync keeps the two level.

**The mesh** (spec 04 §7). Admission raises `peer-connected` for the room. A
newly opened connection that no room takes up within 10 s is closed. A
connection attempt is given 20 s, doubling with each failed attempt at the
same peer up to 5 min. The node remembers the last 512 relayed-signal ids.
When a node that must prove read access holds no read key, the handshake
throws and the room times out.

**ICE servers** (spec 04 §10). The defaults are STUN only:
`stun:stun.l.google.com:19302` and `stun:stun1.l.google.com:19302`.
`network.iceServers` replaces them. Each new WebRTC connection uses the
configured servers plus the TURN servers relays offered, the latter only while
`expiresAt` is in the future. `node.iceServers()` returns the same list for
the application's own connections (a call's). Before answering it refreshes:
if any relay is connected and the TURN passwords held are missing or expire
within 10 minutes, and it has not asked in the last 10 minutes, it sends `ice`
to every connected relay and waits up to 1.5 s for an answer (relays without
TURN never answer), then returns what it has. A node with no relays returns
the configured servers.

_Source: `packages/core/src/network/signaling.ts` (`createSignalingClient`, `RelayStatus`), `packages/core/src/network/multi-signaling.ts` (`release`), `packages/core/src/network/ws-transport.ts`, `packages/core/src/network/local-transport.ts` (`createLocalHub`), `packages/core/src/node/carrier.ts` (`carry`), `packages/core/src/network/mesh.ts` (`CONNECT_TIMEOUT_MS`, `closeIfIdle`, `iceServers`, `ICE_REFRESH_MS`, `ICE_WAIT_MS`), `packages/core/src/network/introductions.ts` (`createSeenSignals`), `packages/core/src/network/rtc-transport.ts` (`DEFAULT_ICE_SERVERS`), `packages/core/src/node/space-runtime.ts` (`nameRelays`), `packages/core/src/node/node.ts` (`iceServers`), `packages/cli/src/serve.ts` (`onPeer`). Tests: `packages/core/tests/signaling.test.ts` ("signaling reconnects"), `packages/core/tests/relay-refusal.test.ts`, `packages/core/tests/introductions.test.ts`, `packages/core/tests/space-relays.test.ts`, `packages/core/tests/ws-transport.test.ts`, `packages/core/tests/carrier.test.ts`; the client-side ICE refresh is untested._

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
and knocks on the account's doors ([doors.md](doors.md)).

_Source: `packages/core/src/node/node.ts` (`asAgent`). Tests: `packages/core/tests/agents.test.ts` ("an agent acting for a person")._

## The app-side client

What an app and an account home send each other, and what each checks, is
protocol ([spec 06 §2](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)). The reference app side:

**The app's key.** `appKey(name = 'default')` makes the app's P-256 key once
and keeps it, non-extractable, in the IndexedDB database `weave-app-key`,
object store `keys`, under `name`. `forgetAppKey` deletes it; the next
connection makes a new one.

**The home's address.** `homeAddress(input)` turns what a person typed into the
home's connect page:

- no scheme → `https://`, or `http://` for `localhost`, `127.0.0.1`, `[::1]`;
- the host must be a loopback name or a domain name with a TLD of two or more
  letters;
- the scheme must be `https:`, or `http:` on loopback;
- a path of `/` or empty becomes `/connect`; query and fragment are dropped.

Example: `weave.example.com` → `https://weave.example.com/connect`.

**Asking the home.** `connectToHome` (and `proposeToHome`, for a proposal)
opens the home in a popup named `weave-home` with features
`popup,width=460,height=720`, polls every 500 ms to see whether the person
closed it, and gives up after 10 minutes by default.

**Starting the node.** `startConnectedNode({ grant, key?, network?, stores?, cache? })`
starts a node with:

- `signer = grantSigner(grant)` ([renewing the session note](#renewing-the-session-note)):
  `did` = `grant.did`, `custody: "remote"`;
- `sessionKey` = the app's key;
- stores `indexedDBStores('weave-app:<grant.did>')` unless given;
- `cache: {}` unless `cache: false` ([holding part of a space](#holding-part-of-a-space));
- `accountKey`, `contactKey`, `contactsSpace` from the grant when present;
- relays = the app's relays ∪ `grant.relays`.

It then joins each granted space it does not hold yet, passing its `memberKey`.

**The connection.** `createWeaveConnection({ home, request, network?, storage?, stores? })`
is the app's twin of [sign-in](sign-in.md): statuses `starting`, `disconnected`,
`connecting`, `ready`, `expired`. It keeps the grant in `localStorage` under
`weave.grant` and the person's chosen home under `weave.home` (`home` in the
config is only a default). It switches to `expired` at `expiresAt` and does not
load an expired grant from storage. When the node sees its own note revoked in
a space it emits `revoked` ([events](#events)), and the connection forgets the
grant and the app key. `propose(notify)` sends a proposal to the grant's home
([spec 06 §2.11](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).

**Showing notifications.** The app shows its own notifications.
`watchNotifications(node, { origin?, onNotify })` needs the account key (an
app with `scope: account`): it reads the subscriptions naming the app's origin
from the registry and hands the app each record that arrives matching one,
with the body in hand (`matchesRecord`): not paused, the collection, one of the
spaces, created at or after `since` and within the last 24 hours, by another
account when `others`, holding the topic value when there is one, and for
which its `where` holds when it has one (`whereHolds`). What the node held
before it started is never news. How the app shows a match is its own
to decide; a "Notify me" button is where a proposal usually starts.

_Source: `packages/core/src/session/connect.ts` (`appKey`, `forgetAppKey`, `homeAddress`, `connectToHome`, `proposeToHome`, `startConnectedNode`, `grantSigner`), `packages/core/src/session/connection.ts`, `packages/core/src/node/watch-notifications.ts`, `packages/core/src/space/notify.ts` (`matchesRecord`, `whereHolds`). Tests: `packages/core/tests/connect.test.ts` ("an account home typed by a person", "an app showing its own notifications"), `packages/core/tests/topics.test.ts` ("a subscription’s where")._

## Carriers, hosting and notifications

What goes into a carry space, what a carrier checks and the host's HTTP API
are protocol ([spec 06 §4](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)). The reference node's side:

**Carriers.** `node.carriers.add({ did, name })` (needs the account key) makes
the carry space, named `Carried by <name>` (name trimmed to 80, default
`Carrier`), writes the `sys.carrier` record, fills the carry space, and returns
`{ space, invite }` for the carrier to join with. `node.carriers.remove(carrySpace)`
writes `carry:closed` and deletes the record; the node keeps the carry space
open for 30 days after, so a carrier that is offline still hears it.

**Subscriptions.** `node.notifications` (needs the account key) lists, adds,
updates (`label`, `paused`) and removes the account's `sys.notify` records. The
reference home adds them when a person keeps an app's proposal, and lists them
by app for the person to pause or remove ([sign-in](sign-in.md#the-account-homes-side)).

**A carrier's matches.** `CarrierNode` reports a version matching a carried
subscription through `notify`, with only the subscription, the space and the
record's key, collection and `createdAt`. Nothing shows these yet, the browser
extension included.

**Hosting.** `node.hosting`:

| Call           | Does                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `use(url)`     | Reads the host's description, makes the subscription key and writes the `sys.hosting` record.                                                                                                                                               |
| `list()`       | Asks each host for its status and hands over the carry space when paid and not carrying, making the carrier first if needed (named after the host's address). At most once a minute per host; a second look waits for a handover in flight. |
| `payPage(url)` | The host's pay page, with the signed fragment.                                                                                                                                                                                              |
| `stop(url)`    | Sends `DELETE …/carry` (ignoring failure), removes the carrier and deletes the `sys.hosting` record.                                                                                                                                        |
| `space(id)`    | The hosts a space names in `std.host`, each asked how the space's own subscription stands, with its pay link (below).                                                                                                                       |

Every device runs `list()` after each reconciliation ([following the account](#following-the-account)).
A device reaches a host at the socket its description names (`peer`,
[spec 06 §4.5](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)): every
open space holds one to each host in `sys.hosting`, and to each host the space
names in `std.host`, and follows as those change. `network.hosts` names hosts
to look for the account registry at before the account says which it uses, so
an app built with a default host restores an account from its recovery code
alone. `network.nodes` still adds sockets of its own, to every space.

The reference host (`weave host`, `packages/cli/src/host.ts`) keeps a lapsed
subscription for `graceDays` (default 30) after `paidUntil`, and drops lapsed
ones in a sweep every hour (`sweepMs`). It measures each carried space's
folder at most every ten minutes, and each status gives the sum as `bytes`,
with `quotaBytes` as `quota` (`WEAVE_HOST_QUOTA_GB`: 10 on a paying host, none
on a free one). At its quota, an account's carry space takes no new space
(`full`, in `createCarryCore`): what it carries stays and keeps syncing, and a
space that waited is taken once a later measure finds room. All of this is the
host's own policy.

_Source: `packages/core/src/node/node.ts` (`carriers`, `notifications`, `hosting`), `packages/core/src/node/carrier.ts` (`arrived`), `packages/core/src/session/hosting.ts`, `packages/cli/src/host.ts`. Tests: `packages/core/tests/carrier.test.ts`, `packages/cli/tests/host.test.ts`._

### A space paying for itself

A space names the hosts it pays in `std.host` records ([standard library](standard-library.md)),
which only members holding `std.host/manage` may write. The host keeps the
space for the space itself: its own subscription, `space:<id>`, which anyone
may pay into ([spec 06 §4.6](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).

Every device holding the space's key (not an agent's note alone, nor a
carrier) looks at the hosts its space names when it takes a role there and
on changes after that: at once when the list of hosts changed, else at most
every ten minutes. For each, it reads the description, refuses a host whose
key is not the one the record names, asks for the status, and hands over the
space's pass when the host is paid (or free and not lapsed) and either does
not carry the space or carries it with an older read key. It looks only where
the space defines `std.host`, so a space held in part is not made to hold it.

`node.hosting.space(id)` does the same at once and returns each host's view:
its name, key, status, and `pay`, the pay page with `#space=<id>`, which an
app opens for anyone who wants to chip in. An agent may call it for a space
it was given.

_Source: `packages/core/src/node/node.ts` (`keepSpaceHosts`, `askSpaceHost`, `hosting.space`). Tests: `packages/cli/tests/host.test.ts` ("a space paying for itself")._

## Doors

`node.doors` ([doors.md](doors.md), [spec 07](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md)):

| Call                               | Does                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list()`                           | Your open doors: `{ id, label?, name?, key, sign, relays, code, createdAt }`                                                                                                                                                                                                                                       |
| `open({ relays?, name?, label? })` | Opens a door. Relays default to this node's relays (up to 3); name to the account's name                                                                                                                                                                                                                           |
| `close(id)`                        | Deletes the `std.door`                                                                                                                                                                                                                                                                                             |
| `clear(id)`                        | Purges every knock at the door, from every relay it names                                                                                                                                                                                                                                                          |
| `knock(code, { note? })`           | [the exchange](doors.md#the-exchange), returns `{ space }`                                                                                                                                                                                                                                                         |
| `knocks()`                         | Fetches every open door's topic from every relay it names, opens and checks ([spec 07 §6](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md); opened results are cached by id), settles sent knocks and writes owed answers; returns `{ id, door, from, name, note?, pairSpace, at }`, newest first |
| `sent()`                           | Your unanswered knocks: `{ space, name, at }`                                                                                                                                                                                                                                                                      |
| `accept(id)`                       | [the exchange](doors.md#the-exchange), returns the new `ContactView`                                                                                                                                                                                                                                               |
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
