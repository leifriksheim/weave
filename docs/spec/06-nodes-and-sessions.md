# 06 — Nodes, sessions and apps

This part covers the **node**, the object every front end (a browser tab, the
`weave` command line, the daemon, an agent) is a thin layer over. It also
covers the ways a person or program comes to run one: **signing in** with the
seed, **connecting an app** to an account home without the seed, **connecting
an agent**, and **carriers and hosts** that keep spaces online without reading
them. It ends with **calls**, which are built only from live messages.

Material specified elsewhere is linked, not repeated:

| Topic | Where |
|---|---|
| Seeds, recovery codes, DIDs, the account vault and its wraps, UCANs, `AGENT_FACT`, device keys, contact and member keys, phone pairing | [01 — Identity](01-identity.md) |
| Records, versions, `seq`, rules, topics and tags, queries | [02 — Records](02-records.md) |
| Spaces, roles, the access log (`sys.role`, `sys.member`, `sys.invite`, `sys.revoke`, `sys.collection`, `sys.key`, `sys.relays`, `sys.keepers`), invites, encryption, the account registry (`sys.joined`, `sys.profile`, `sys.carrier`), profiles, contacts | [03 — Spaces](03-spaces.md) |
| Relays, rooms, peer authentication, the network message envelope, the `who` note exchange, live messages and their limits, TURN | [04 — Network](04-network.md) |
| Negentropy, stores, storage adapters, data folders, mirrors, what a node that holds part of a space says it holds | [05 — Sync and storage](05-sync-and-storage.md) |
| Names, doors, the relay mailbox | [07 — Doors](07-doors.md) |

Terms used here:

- **Account** — an identity derived from a seed; its DID is the *root* of every
  record it writes ([01](01-identity.md)).
- **Note** — a UCAN delegation from an account (or a key holding one) to
  another key. A **session note** is the note a node's session key writes under.
- **Session key** — the P-256 key a node signs records with and proves on the
  wire. Its DID is the node's `sessionDid`.
- **Account home** — a page that holds an account's seed and grants notes to
  apps. It is an ordinary sign-in page (§3) plus the home side of §4.
- **Carrier** — a node that keeps spaces online without being able to read or
  write them. A **host** is a carrier for many accounts, which they pay for.

---

## 1. The node

### 1.1 What a node is

A node acts for exactly one account (`node.did`) and signs with exactly one
session key (`node.sessionDid`) for its lifetime. It holds a set of spaces,
each with its own store and its own peers, and exposes them as plain data: every
value a node method returns is JSON-serialisable, so the same calls can be
exposed over a command line, MCP and WebMCP (§2).

A node MAY hold the **account key** (the vault key bytes, [01](01-identity.md)).
With it the node follows the account registry — the account's list of spaces,
its name, its carriers, hosts and subscriptions — and joins and leaves spaces as
the account does on any device. Without it, the node holds only the spaces it
was given or joined itself.

A node MAY hold the **contact key** (`deriveContactKeyBytes(seed)`). With it the
node opens contact requests sent to the account and publishes the contact key's
public half on the account's profile in every space it writes in.

*Source: `src/node/node.ts`, `src/node/types.ts`. Tests: `tests/node.test.ts`.*

### 1.2 Configuration

`createNode(config)` takes (`NodeConfig`):

| Field | Type | Meaning |
|---|---|---|
| `signer` | `RootSigner` | Who the node acts for. Asked only for session notes (§1.4). |
| `accountKey` | bytes, optional | The account's vault key bytes. Enables the account registry and the contacts space (§1.5). |
| `contactKey` | bytes, optional | The contact key's secret. Opens contact requests; published on profiles. |
| `contactsSpace` | string, optional | The contacts space's id, for a node given it without the account key (an app granted `contacts`, §4.5). |
| `stores` | `StoreFactory` | Where the registry and each space's store live (§1.6). |
| `provider` | `CryptoProvider`, optional | Default: P-256 over WebCrypto. |
| `collections` | `CollectionDef[]`, optional | Schemas the node knows, used when a space does not describe a collection itself. Writes are checked against them; reads are flagged `conforms`. Nothing is refused on arrival for its shape ([02](02-records.md)). |
| `network` | optional | `relays` (WebRTC signaling, browsers), `nodes` (always-on nodes to dial, `ws(s)://host/peer`), `iceServers`, `transports` (extra transports per space). Omitted: offline. |
| `sessionTtlSeconds` | number, optional | Lifetime of each session note. Default `3600`. |
| `sessionKey` | `CryptoKeyPair`, optional | Sign with this key instead of a fresh one. Used when the signer's note names a specific key (an app's key, an agent's key, §4, §5). |
| `watchIntervalMs` | number, optional | How often to look for writes another process made to a folder store. `0` disables. Default `2000`. *Implementation detail.* |
| `cache` | `CacheConfig`, optional | Hold only the collections used, in spaces that name a keeper (§1.8). |
| `mailbox` | `MailboxClient`, optional | How doors reach relays' mailboxes ([07](07-doors.md)). Default: a WebSocket to each relay. |

*Source: `src/node/types.ts` (`NodeConfig`, `NodeNetworkConfig`, `CacheConfig`). Tests: `tests/node.test.ts`, `tests/caches.test.ts`.*

### 1.3 Lifecycle

Starting a node does the following, in order:

1. Uses `config.sessionKey`, or generates a fresh P-256 key pair. Its DID
   (`did:key`, P-256 multicodec) is `sessionDid`.
2. Asks `config.signer.delegate` for a session note (§1.4) and waits for it.
   If the signer refuses, `createNode` fails.
3. Schedules renewal of the note (§1.4).
4. Opens the `registry` store, sealed (§1.6).
5. With an account key: derives the account registry space and the contacts
   space ([03](03-spaces.md)). The contacts space is added to the node's own
   registry like a joined space (so it can be granted to an app like any other
   space), and both are *hidden* from `spaces.list` (§1.5).
6. With an account key: opens the account registry space and reconciles
   (§1.5) before `createNode` returns.

`close()` stops renewal, closes every open space (flushing what each keeps,
stopping sync and disconnecting its transports), closes the registry store,
and drops all event listeners. After `close()`, any call that needs a space
fails with `Node is closed`. Closing twice does nothing.

*Source: `src/node/node.ts` (`createNode`, `close`). Tests: `tests/node.test.ts`.*

### 1.4 The session note, and renewing it

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
  expiry limits when a note may be *used to write*, not how long its records
  count ([01](01-identity.md), [02](02-records.md)).

A signer need not be able to sign. `grantSigner(grant)` (§4.7) answers every
`delegate` call with the one note an account home granted, unchanged, and
refuses once `grant.expiresAt` has passed. A node started from a grant
therefore never gets a fresh note: its "renewal" returns the same note, and when
it runs out the app must connect again (§4.9).

> Rationale: one root signature an hour, never one per write. The root — a seed
> in a page, an account home, anything — can stay out of reach of the code that
> writes.

`node.delegate({ audience, capabilities, expiration? })` passes a narrower note
from the session key on to another key. The capabilities MUST be no broader
than the session note's, and `expiration` is capped at the session note's. It
returns `{ token, proofs: [<session note>] }`.

`node.delegation()` returns the note the session key writes under now.

*Source: `src/node/node.ts` (`delegate`, `scheduleRenewal`, `SESSION_CAPABILITY`), `src/session/connect.ts` (`grantSigner`). Tests: `tests/node.test.ts` ("the delegation is renewed before it expires", "records outlive the session that wrote them").*

### 1.5 The spaces a node keeps

The node's **registry** store lists every space it holds, with its key(s), its
invite secret while one is waiting to be used, its role as last seen, the
relays the space names and, for an app without the account key, its member
key. Its storage format is an *implementation detail* of `space-manager.ts`
([03](03-spaces.md)).

Three kinds of space are the account's own machinery and are **hidden** from
`spaces.list`:

| Space | Derived from | Notes |
|---|---|---|
| The account registry | the account key | Never in the node's registry; opened directly. Cannot be left. |
| The contacts space | the account key, or `config.contactsSpace` | Held in the registry, hidden. Cannot be left. |
| Carry spaces | one per carrier the account uses (§6) | Held in the registry, hidden. |

In these three kinds of space, a record signed under an agent's note never
counts (§5.1), and they are always held whole (§1.8).

**Following the account.** With an account key, the node makes its spaces
match the account's list — the `sys.joined` records in the account registry,
one per space, keyed `space:<id>`, whose format is in [03](03-spaces.md). This
*reconciliation* runs at start and whenever records change in the account
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
5. brings every carrier's passes and subscriptions up to date (§6.2);
6. names the account's carriers as keepers of the open spaces it manages (§6.2);
7. asks every host the account uses how it stands, handing it the spaces if it
   has been paid since (§6.5) — without waiting for the answer.

Only `sys.joined` records that verify and whose root is the account itself
count. Creating or joining a space writes its `sys.joined` record; leaving
deletes it. A record whose space key changed is rewritten with an invite
carrying the key in use now, so a new device joins with it.

A node writing under an agent's note never writes the account registry: no
`sys.joined`, no passes, no name, no hosting receipts (every peer would ignore
them; §5.1).

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

*Source: `src/node/node.ts` (`reconcileOnce`, `remember`, `forget`, `finishJoining`, `publishProfile`, `spaces`). Tests: `tests/node.test.ts` ("the account registry"), `tests/profiles.test.ts`, `tests/space-access.test.ts`.*

### 1.6 Stores

A node asks for stores by path through its `StoreFactory`:

| Path | Holds | Sealed |
|---|---|---|
| `registry` | the node's list of spaces and their keys | yes: the node asks for `{ seal: true }` |
| `spaces/<spaceId>` | one space's records and what the node keeps about it | no |

What a path means is the factory's choice:

- `indexedDBStores(prefix)` — one IndexedDB database per path, named
  `<prefix>:<path with / replaced by :>`. Never sealed: the browser profile
  already guards it.
- `folderStores(directory, { basePath?, vaultKey? })` — a directory tree under
  `basePath`; the `registry` is sealed under `vaultKey` when one is given.

Sign-in (§3) uses `storesFor(account)`: IndexedDB with prefix
`weave:<dataPath with : for />` in the browser, or `folderStores(pod,
{ basePath: account.dataPath, vaultKey })` in a pod, where `dataPath` is
`accounts/<id>/stores`. A connected app uses `indexedDBStores('weave-app:<account DID>')`
by default. These names are *implementation details*; a pod's layout is in
[05](05-sync-and-storage.md).

`copyAccountData({ from, to, did, accountKey? })` copies every space an
account holds, with its key and records, from one set of stores to another —
the account registry too, when `accountKey` is given. It is a union: every
version goes through the same ordering rule as sync, so copying into a store
that holds some of it already is safe, and copying twice changes nothing.

*Source: `src/node/stores.ts`, `src/node/copy.ts`, `src/session/places.ts` (`storesFor`). Tests: `tests/account.test.ts`, `tests/folder-adapter.test.ts`.*

### 1.7 Opening and holding spaces

A space is opened (its store read, its peers joined, sync started) the first
time anything asks for it — a read, a write, a status — and stays open until
it is released or the node closes. Opening a space also: publishes the
account's profile in it (§1.5), checks whether the session note was revoked
there (§1.9, `revoked`), and names the account's carriers as keepers if the
account manages it (§6.2).

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

*Source: `src/node/node.ts` (`runtime`, `hold`, `closeRuntime`). Tests: `tests/live.test.ts` ("holding a space").*

### 1.8 Holding part of a space

With `config.cache`, and once a space names at least one keeper
([03](03-spaces.md), `sys.keepers`), the node holds only the collections it
uses, besides the space's own `sys.*` collections. Everything about this is the
node's own choice; how it tells peers what it holds is in
[05](05-sync-and-storage.md). As implemented:

- Collections listed in `cache.collections` are held from the start and never
  dropped.
- A query marks the collections it reads (its own and every `include … from`)
  as used; sync then fetches them. A query's result has `complete: false`
  until the node has once been level with a node holding the whole space for
  every collection it reads.
- Until the node has once caught up fully with a node holding the whole space,
  it cannot know whether the space names keepers, so it holds only what it uses.
- The node's own writes are *pending* until `min(keepers named, max(copies ?? 2,
  cache.copies ?? 0))` of the space's named keepers have them. A collection
  holding a pending write is never dropped.
- A collection unused for `cache.unusedAfterDays` (default 30) days is dropped
  when the space opens and every 6 hours while it stays open.
- A space that names no keeper is held whole.

The account registry, the contacts space and carry spaces are always held
whole. Apps connected to an account home use `cache: {}` by default (§4.8).

*Source: `src/node/space-runtime.ts` ("Holding part of the space"). Tests: `tests/caches.test.ts`.*

### 1.9 Events

`node.subscribe(listener)` delivers `NodeEvent`s and returns an unsubscribe
function. A listener that throws does not stop the others.

| `type` | Fields | When |
|---|---|---|
| `records` | `space` | Records were added, changed or deleted in a space, locally or by sync. |
| `status` | `space` | Connection state or peers changed. A status change in the account registry is re-emitted for every open space (which peers are the account's own is read off the registry's peers). |
| `spaces` | — | The node's list of spaces changed: created, joined, left, a role or waiting invite changed. |
| `account` | — | The account's profile may have changed (records changed in the account registry, or `setName`). |
| `rejected` | `space`, `peer`, `reason` | A peer sent a version that failed validation. |
| `message` | `space`, `from`, `peer`, `agent`, `message` | A live message arrived (§1.10). |
| `revoked` | `space` | The note this node writes under was revoked in that space. Emitted at most once per space per node. |

*Source: `src/node/types.ts` (`NodeEvent`), `src/node/node.ts` (`fromRuntime`, `checkRevoked`). Tests: `tests/node.test.ts` ("events announce local writes"), `tests/connect.test.ts` ("disconnecting revokes the note").*

### 1.10 Live messages and status

`spaces.send(id, message, to?)` sends a JSON value to the peers connected in
the space right now, kept nowhere and signed as nothing. `to` is either an
account DID (every connected device that showed a note from that account) or a
session DID (one device). The encoded message MUST be at most 64 KiB; larger
is refused locally. The wire format, the per-peer allowance (a burst of 60,
then 20 per second) and how the sender's account is established are in
[04](04-network.md).

A received live message is emitted as a `message` event:

| Field | Meaning |
|---|---|
| `from` | The account behind the sending device, proven by the note it showed, made out to the key the connection proved. `null` for a peer that showed no note (a carrier, a node serving sockets). |
| `peer` | The sending device's session DID — also where a reply to that device goes. |
| `agent` | `true` when the sender's note is an agent's (§5.1). |
| `message` | The value sent. |

`spaces.status(id)` returns `SpaceStatus`:

| Field | Meaning |
|---|---|
| `connection` | `offline` (no network), `connecting`, `connected` (as soon as any one transport connects), `error`. |
| `peers` | Session DIDs connected in the space. |
| `own` | Of `peers`, the account's own other devices and apps: those also connected in the account registry, minus carriers. Empty without an account key. |
| `carriers` | Of `peers`, the account's carriers, by the keys `sys.carrier` records name. |
| `accounts` | Session DID → account, for each peer that showed a valid note. |
| `fingerprint` | A fingerprint of every version held; equal on two nodes means identical data ([05](05-sync-and-storage.md)). |
| `rejected` | How many versions peers sent failed validation. |
| `holds` | `"all"`, or the sorted list of collections held (§1.8). |
| `pending` | This node's writes still waiting for keepers (§1.8). |

> Rationale: a peer's key does not say whose it is, but only the account's own
> devices and apps can read its registry, so a peer there is one of ours.

*Source: `src/node/node.ts` (`spaces.send`, `spaces.status`), `src/node/space-runtime.ts` ("Live messages", `status`, `send`). Tests: `tests/live.test.ts`.*

### 1.11 The rest of the node's surface

The node's other parts are specified where their data lives; the node only
exposes them:

- `node.spaces` — create, invite, preview, join, leave, access, `setMember`,
  `putRole`, `removeRole`, `closeInvite`, `changeKey`, `setRelays`,
  `setKeepers`, `revoke`, `profiles`, `authenticator` ([03](03-spaces.md),
  [04](04-network.md)). Default invite role: the lowest role ranked below the
  inviter's own; with none below, a view-only invite.
- `node.records`, `node.collections` — [02](02-records.md). `records.watch`
  re-runs a query after every `records` event for its space, one run at a time,
  with at most one more queued.
- `node.account` — `profile()`, `setName(name)` (writes `sys.profile`, key
  `profile`, in the account registry, then republishes the profile in every
  open space), `revoke(token)` (in the account registry). All need the account
  key.
- `node.contacts` — [03](03-spaces.md). `ask` and `accept` make or join a space
  for two, so they need a session note with `with: "*"` (whole-account access).
- `node.doors` — [07](07-doors.md). Needs the contact key; knocking and
  accepting also need whole-account access.
- `node.carriers`, `node.hosting`, `node.notifications` — §6.
- `node.iceServers()` — the configured ICE servers plus TURN servers a relay
  offers ([04](04-network.md)); what calls use (§7).
- `node.asAgent({ keys, note })` — §5.2.

*Source: `src/node/types.ts`, `src/node/node.ts`. Tests: `tests/node.test.ts`, `tests/contacts.test.ts`, `tests/profiles.test.ts`.*

---

## 2. Node actions

`NODE_ACTIONS` describes the node's operations once, as data. Each action has:

| Field | Meaning |
|---|---|
| `name` | Matches `[a-z_]+`, so it is a valid tool name everywhere. |
| `description` | One or more sentences for a person or model. |
| `input` | A JSON Schema object (`type: "object"`, `properties`, `required`). |
| `readOnly` | Reads only. An agent may run it without asking. |
| `sensitive` | The result grants access (an invite carries a key). A front end SHOULD confirm with a person before handing it on. |
| `destructive` | Removes or overwrites something, or brings in someone else's space. A front end SHOULD ask a person before an agent runs it. |
| `peerContent` | The result includes what other people wrote. A front end SHOULD tell a model to treat it as data, not instructions. |
| `run(node, input)` | Runs it. Inputs and outputs are plain JSON; nothing returned is a key, handle or function. |

`runAction(node, name, input)` checks the input with `checkActionInput` first.
It refuses: a non-object input; a missing required field; **any field not in
`properties`**; a value outside an `enum`; a value whose JSON type differs from
`type` (`integer` must be a whole number). Array item schemas are not checked.

The actions (R = readOnly, S = sensitive, D = destructive, P = peerContent):

| Name | Flags | Input (required in **bold**) | Does |
|---|---|---|---|
| `node_info` | R | — | `{ did, sessionDid }` |
| `spaces_list` | R | — | `spaces.list()` |
| `spaces_create` | | **`name`**, **`visibility`** (`private`\|`public`), `roles` (`solo`\|`team`\|`community`; default `solo`) | Creates a space with that role preset. |
| `spaces_invite` | S | **`space`**, `role`, `viewOnly` (bool) | `{ invite }`. `viewOnly: true` wins over `role`. |
| `spaces_preview_invite` | R | **`invite`** | `spaces.preview()` |
| `spaces_join` | D | **`invite`** | `spaces.join()` |
| `spaces_leave` | D | **`space`** | `{ left: <id> }` |
| `spaces_access` | R | **`space`** | `spaces.access()` |
| `spaces_set_member` | D | **`space`**, **`did`**, **`role`** (`""` removes) | Then returns `spaces.access()`. |
| `spaces_close_invite` | D | **`space`**, **`key`** | Then returns `spaces.access()`. |
| `spaces_status` | R | **`space`** | `spaces.status()` |
| `spaces_profiles` | R P | **`space`** | `spaces.profiles()` |
| `collections_list` | R P | **`space`** | `collections.list()` |
| `collections_define` | D | **`space`**, **`name`**, **`schema`**, `title`, `description`, `version`, `history` (`latest`\|`all`), `links`, `permissions`, `rules`, `screen` | The definition, plus `summary`: what its rules allow, in words. |
| `apps_list` | R P | **`space`** | Proposed apps: `key`, `title`, `description`, `proposedBy`, `viaAgent?`, `screen?`, `added`, `problem`, `needs[]`. |
| `apps_screen_guide` | R | — | The screen-writing guide text. |
| `apps_propose` | | **`space`**, **`title`**, **`needs`** (array of definitions), `description` | Writes an app proposal record; returns `{ key, proposed, added: false, next, needs }`. |
| `collections_delete` | D | **`space`**, **`name`** | `collections.delete()` |
| `records_list` | R P | **`space`**, `collection`, `limit`, `newestFirst` | `records.list()` |
| `records_query` | R P | **`space`**, **`collection`**, `where`, `include`, `sort`, `limit`, `cursor` | `records.query()` ([02](02-records.md)) |
| `records_get` | R P | **`space`**, **`key`** | `records.get()` |
| `records_history` | R P | **`space`**, **`key`** | `records.history()` |
| `records_put` | | **`space`**, **`collection`**, **`body`**, `key`, `links` | `records.put()` |
| `records_linked` | R P | **`space`**, **`key`**, `rel`, `collection` | `records.linked()` |
| `records_can` | R | **`space`**, **`action`** (`create`\|`edit`\|`delete`), **`target`** | `records.can()` → boolean |
| `records_update` | D | **`space`**, **`key`**, **`body`**, `links` | `records.update()` |
| `records_delete` | D | **`space`**, **`key`** | `{ deleted: <key> }` |

The app-proposal record format (`apps_propose`, `apps_list`) belongs with
records and is *Not yet specified* in this part.

**Front ends.** Each exposes the same list under the same names:

- **CLI** (`weave <action>`): flags from `input`. *Implementation detail.*
- **MCP** (`weave mcp`, stdio, newline-delimited JSON-RPC 2.0): `initialize`
  (protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`;
  capability `tools`), `ping`, `tools/list`, `tools/call`. Each action becomes a
  tool with `inputSchema = input` and annotations `readOnlyHint = readOnly`,
  `destructiveHint = destructive`, `idempotentHint = readOnly`,
  `openWorldHint = peerContent || !readOnly`; a `sensitive` action's
  description gains "Confirm with the user before sharing the result." A
  `peerContent` result is preceded by a text block telling the model to treat
  it as data. A failed action is a result with `isError: true`, not a
  JSON-RPC error. Serving an agent's node, the tools that need a person are not
  offered: `spaces_create`, `spaces_invite`, `spaces_join`, `spaces_leave`,
  `spaces_set_member`, `spaces_close_invite`, `collections_define`,
  `collections_delete`.
- **WebMCP** (the example app): every action except `collections_define` and
  `collections_delete`, registered on `document.modelContext` at page load.
  *Implementation detail of the example.*

*Source: `src/node/actions.ts`, `cli/src/mcp.ts`, `example/src/webmcp.ts`. Tests: `tests/node.test.ts` ("actions"), `tests/cli.test.ts` ("MCP").*

---

## 3. Signing in

`createWeaveAuth(config)` is the whole sign-in flow of a page that holds the
seed — an account home, or an app that signs people in itself — as a state to
read and actions to call. It is a client convenience: nothing in it goes over
the wire except what the node it starts does. It is specified here because an
account home's behaviour (§4) depends on it.

### 3.1 Places

A **place** is where accounts and their data are kept (`Place`):

| `kind` | Accounts are kept | Data is kept |
|---|---|---|
| `browser` | the browser account store (IndexedDB) | IndexedDB, per account (§1.6) |
| `folder` (a *pod*) | the folder's account store | the folder, per account, registry sealed under the vault key |

A pod is a directory picked through the File System Access API. The last one
picked is remembered and re-opened without a prompt when permission is still
granted. A place holds any number of accounts; `listAccounts` returns them most
recently used first. Account files and vault formats are in [01](01-identity.md).

*Source: `src/session/places.ts`. Tests: `tests/account-store.test.ts`.*

### 3.2 Stages

`AuthState.stage` is one of:

| Stage | Meaning |
|---|---|
| `starting` | Looking for accounts and a kept sign-in. |
| `where` | Asking where data should live (a pod, or this browser). Asked once. |
| `welcome` | The place holds no accounts. |
| `signIn` | Choose an account and unlock it. |
| `create` | Name a new account; then, with `freshCode` set, save its password. |
| `pair` | Opened from a phone-pairing link ([01](01-identity.md)). |
| `ready` | Signed in; `session` is set. |

Transitions:

| From | Action | To |
|---|---|---|
| `starting` | `start()`, a kept sign-in for an account in the place (§3.4) | `ready` |
| `starting` | `start()`, a pairing ticket in the URL | `pair` |
| `starting` | `start()`, no pod, no accounts, folders available, browser never chosen | `where` |
| `starting` | `start()`, otherwise | `signIn` if the place has accounts, else `welcome` |
| `starting` | `start()` fails | `welcome` (with `error`) |
| any | `changeStorage()` | `where` |
| `where` etc. | `choosePod()` / `useBrowser()` while signed out | `signIn` or `welcome` |
| `ready` | `choosePod()` while signed in | `ready`, with `podChoice` set; `confirmPod('combine' \| 'switch')` restarts the session in the pod |
| `welcome`, `signIn` | `startCreating()` | `create` |
| any | `showSignIn()` | `signIn` |
| `signIn` | `signInWithCode` / `signInWithPassword` / `signInWithPasskey` succeeds | `ready` |
| `create` | `createAccount(name)` | `create`, with `session` and `freshCode` set |
| `create` | `codeSaved()` | `ready` |
| `pair` | `acceptPairing()` | `ready` (signs in with the ticket's code, then collects from the desktop) |
| `pair` | `dismissPairing()` | `ready` if signed in, else `signIn` / `welcome` |
| `ready` | `signOut()` | `starting`, then `signIn` / `welcome` |

A failed action sets `error` (`{ message, hint?, code? }`) and leaves the stage
as it was. A dismissed passkey or folder prompt sets no error.

*Source: `src/session/auth.ts`. Tests: `tests/auth.test.ts`.*

### 3.3 Ways in

- **The account password** is the recovery code: the seed written out, 26
  characters ([01](01-identity.md)). It works on any site without anything
  stored there. If an account is selected and the code opens a different one,
  sign-in fails with a reason. If the code's account is new to this place, it
  is filed there with an empty vault (no wraps) under the selected account's
  name or `My account`.
- **A short password** unwraps the seed from the vault's `passphrase` wrap.
- **A passkey** is a gate, not a key: the WebAuthn ceremony proves presence,
  and the seed is unwrapped with a non-extractable device key kept in this
  site's storage, named by the vault's `device` wrap for this `rpId`. Only a
  wrap whose device key is present in this browser is offered.

A new account's seed is random. Creating one writes its vault with no wraps,
starts its session, writes its name to `sys.profile` in the account registry,
and shows the account password once (`freshCode`).

*Source: `src/session/auth.ts`, `src/session/credentials.ts`. Tests: `tests/auth.test.ts`, `tests/account-vault.test.ts`.*

### 3.4 The session a sign-in starts

A sign-in starts a node with the local root signer from the seed, the account
key (`deriveVaultKeyBytes(seed)`), the contact key (`deriveContactKeyBytes(seed)`),
the place's stores for that account (§1.6) and the configured network. The
session (`WeaveSession`) is `{ account, did, sessionDid, node }`. The seed stays
inside the auth object; `accountPassword()` returns it as a recovery code.

The account's name follows the account: on every `account` event the node's
`account.profile()` is read, and a different name is adopted locally (the vault
label and passkey labels). The name is written to the registry only at creation
and on `rename`, never on a plain start.

### 3.5 Staying signed in

After an unlock, the seed MAY be kept on the device so a reload does not ask
again. It is wrapped with a fresh non-extractable device key and stored with an
expiry that is pushed forward each time it is used. Choices: `never`, `1d`,
`7d` (default), `30d`. A kept sign-in resumes only for the same kind of place
it was made in (`browser` or `folder`). Signing out, choosing `never`, or
finding it expired deletes the device key.

*Implementation detail:* kept in `localStorage` as `<prefix>.stay-signed-in`
(the choice) and `<prefix>.remembered-session`:

```json
{ "accountId": "k3j2h4g5f6d7", "place": "browser", "wrap": { "kind": "device", "...": "…" }, "expiresAt": 1791027701000 }
```

Other keys the flow keeps: `<prefix>.last-account`, `<prefix>.storage-choice`,
and at an account home `<prefix>.connections:<accountId>` (§4.10). `prefix`
defaults to `weave`.

*Source: `src/session/stay-signed-in.ts`, `src/session/auth.ts`. Tests: none.*

### 3.6 Moving into a pod

Picking a pod while signed in sets `podChoice` with what the pod holds
(`inspectPod`: this account's copy, other accounts, whether it is the pod in use).
`confirmPod('switch')` uses the pod's own copy and brings nothing.
`confirmPod('combine')` writes the account and a union of both vaults' wraps
into the pod, copies every space into it (`copyAccountData`, §1.6), and
restarts the session there. `forgetBrowserCopy()` then deletes the browser's
copy. Other accounts in the pod are never touched.

*Source: `src/session/auth.ts` (`confirmPod`), `src/session/places.ts`. Tests: `tests/account.test.ts`.*

---

## 4. The account home protocol

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

### 4.1 The app's key

An app MUST make its own P-256 key and keep the private half non-extractable.
The reference `appKey(name = 'default')` keeps it in the IndexedDB database
`weave-app-key`, object store `keys`, under `name`. `forgetAppKey` deletes it;
the next connection makes a new one. The key's DID is the grant's audience, and
the app's node signs with this key (`sessionKey`), not a fresh one.

### 4.2 The home's address

`homeAddress(input)` turns what a person typed into the home's connect page:

- no scheme → `https://`, or `http://` for `localhost`, `127.0.0.1`, `[::1]`;
- the host MUST be a loopback name or a domain name with a TLD of two or more
  letters;
- the scheme MUST be `https:`, or `http:` on loopback;
- a path of `/` or empty becomes `/connect`; query and fragment are dropped.

Example: `weave.example.com` → `https://weave.example.com/connect`.

### 4.3 The exchange

The app:

1. MUST open the home in a popup from a user gesture, before awaiting anything
   (reference: name `weave-home`, features `popup,width=460,height=720`).
2. Listens for `message` events and MUST ignore any whose `source` is not the
   popup it opened or whose `origin` is not the home's origin.
3. On `{ type: "weave:hello" }`, posts `{ type: "weave:request", request }` to
   the popup with `targetOrigin` = the home's origin.
4. On `{ type: "weave:grant", grant }`, checks the grant (§4.6) and resolves.
   On `{ type: "weave:denied", reason? }`, fails with `reason`.
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
4. If the request is malformed (§4.4), answers `weave:denied` with a reason
   saying it did not understand, to that origin, and closes.
5. Otherwise waits for the person, then posts exactly one of `weave:grant` or
   `weave:denied` to that origin only, and closes itself 100 ms later.
6. Gives up silently if no request arrives within the timeout.

*Source: `src/session/connect.ts` (`connectToHome`, `askHome`, `receiveConnectRequest`, `homeAddress`). Tests: `tests/connect.test.ts` ("the home receiving a request", "an account home typed by a person").*

### 4.4 The request

`ConnectRequest`:

| Field | Type | Meaning |
|---|---|---|
| `v` | `1` | |
| `audience` | string | The app's key, `did:key:…`. The note is made out to it. |
| `name` | string, ≤ 80, optional | What the app calls itself. Shown, never trusted. |
| `access` | `read` \| `write` \| `carry` | `write` to change the spaces given, `read` only to look, `carry` for a carrier (§6.3). |
| `scope` | `spaces` \| `account`, optional | `spaces` (default): the spaces the person picks and any made for the app. `account`: every space, the account's list, making and joining spaces. |
| `create` | `NewSpace[]`, optional | Spaces the home should make for the app: at most 8, each with a non-empty `name` ≤ 80, `visibility`, and valid starting `roles`/`creatorRole` if given. |
| `contacts` | boolean, optional | The contacts space and the contact key. |
| `chooseSpaces` | boolean, optional | Whether to offer the person's existing spaces. Default true. UI only. |
| `agent` | boolean, optional | The audience is an agent's key (§5). |
| `days` | integer 1–365, optional | How long the note should last. The home decides; default 7. |

A home MUST refuse a request (as in §4.3 step 4) unless: `v` is `1`; `audience`
starts with `did:key:`; `access` is one of the three; `scope`, `name`,
`contacts`, `create`, `days` are absent or valid as above; and, when
`agent: true`, `access` is not `carry`, `create` is absent and `contacts` is
not true.

Example:

```json
{ "type": "weave:request",
  "request": { "v": 1, "audience": "did:key:zDnaeyrPwbZxpDVLsnvAvAEGYazWB2ZrM7QL4Qb1JPzfiYpKy",
               "name": "Todo", "access": "write", "scope": "spaces",
               "create": [{ "name": "Todos", "visibility": "private" }], "days": 30 } }
```

### 4.5 The grant

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
6. Remembers the connection (§4.10) and answers with the grant.

`Grant` (the home sends it without `home`; the app adds `home` = the connect
page it opened):

| Field | Type | Meaning |
|---|---|---|
| `v` | `1` | |
| `did` | string | The account. |
| `name` | string | The account's name, for showing who is connected. |
| `token` | string | The encoded note. |
| `access` | `read` \| `write` | |
| `scope` | `spaces` \| `account` | |
| `spaces` | `{ id, name, invite, memberKey? }[]` | Granted spaces; `memberKey` is base64url. |
| `accountKey` | base64url, optional | With `scope: account`: the vault key bytes. It opens every private space and the account registry, but cannot sign as the account. |
| `contactKey` | base64url, optional | With `contacts` or `scope: account`: the contact key's secret. |
| `contactsSpace` | string, optional | With `contacts` and `scope: spaces`: which of `spaces` is the contacts space. |
| `relays` | string[], optional | Relays the home uses; the app joins them too, so the two always share one. |
| `expiresAt` | number | Unix seconds. |
| `agent` | `true`, optional | The note is an agent's. |
| `home` | string | Added by the app. |

Example (token shortened):

```json
{ "type": "weave:grant",
  "grant": {
    "v": 1, "did": "did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ", "name": "Leif",
    "token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsInVjdiI6IjAuMTAuMCJ9.eyJhdHQiOlt7ImNhbiI6…",
    "access": "write", "scope": "spaces",
    "spaces": [{ "id": "bafk…", "name": "Todos", "invite": "…", "memberKey": "q0v…" }],
    "relays": ["wss://p2p-web-relay.fly.dev"],
    "expiresAt": 1792614901 } }
```

whose note's payload is

```json
{ "iss": "did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ",
  "aud": "did:key:zDnaeyrPwbZxpDVLsnvAvAEGYazWB2ZrM7QL4Qb1JPzfiYpKy",
  "att": [{ "can": "expression/*", "with": "space:bafk…" }],
  "exp": 1792614901, "nbf": 1790022901, "nnc": "a6b6617b6ed4fba0", "prf": [] }
```

> Rationale: the note limits **writing**, per space, and every peer checks it.
> It cannot limit **reading** a private space it was given: reading is holding
> the space's key. Invites are view-only because what lets the app write is the
> note, under the account's own role — never a secret of the space's.

*Source: `src/session/auth.ts` (`grant`), `src/session/connect.ts` (`ConnectRequest`, `Grant`, `grantCapabilities`, `isRequest`). Tests: `tests/connect.test.ts`.*

### 4.6 What the app checks

Before using a grant the app MUST check that the note verifies
([01](01-identity.md)), that its `aud` is the app's own key, and that its `iss`
is `grant.did`. An app that asked for `agent: true` MUST refuse a note without
the agent fact.

### 4.7 Starting a connected node

`startConnectedNode({ grant, key?, network?, stores?, cache? })` starts a node
with:

- `signer = grantSigner(grant)`: `did` = `grant.did`, `custody: "remote"`,
  `delegate()` returns the granted note (whatever was asked) and throws once
  `expiresAt` has passed;
- `sessionKey` = the app's key;
- stores `indexedDBStores('weave-app:<grant.did>')` unless given;
- `cache: {}` unless `cache: false` (§1.8);
- `accountKey`, `contactKey`, `contactsSpace` from the grant when present;
- relays = the app's relays ∪ `grant.relays`.

It then joins each granted space it does not hold yet, passing its `memberKey`.
Without an account key it sees only the spaces it was given; with one it
follows the whole account (§1.5).

*Source: `src/session/connect.ts` (`startConnectedNode`, `grantSigner`, `grantStore`). Tests: `tests/connect.test.ts`.*

### 4.8 Scope

| | `scope: spaces` | `scope: account` |
|---|---|---|
| Note | `space:<id>` per granted space | `*` |
| Account key | no | yes |
| Sees | the granted spaces | every space; the account registry |
| Makes or joins spaces | the home makes them at grant time | itself; they land in the account's list |
| Contacts | only with `contacts: true` (list and requests; not `ask`/`accept`) | yes, including `ask`/`accept` |
| Member keys | one per granted private space | derived from the account key |

Either way the app never gets the seed: it cannot sign in as the account, change
its password or passkeys, or keep access past `expiresAt`.

### 4.9 Expiry and renewal

A note is never renewed in place. When `expiresAt` passes, the app's writes stop
counting everywhere. To continue, the app connects again, which produces a new
note (and, at the home, replaces the old connection record). The reference
client (`createWeaveConnection`, §4.11) switches to `expired` at `expiresAt`
and does not load an expired grant from storage.

### 4.10 Connections and revocation

*Implementation detail:* the home remembers each connection per account in its
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

Revoking writes a `sys.revoke` record naming the note ([03](03-spaces.md)).
From then on nothing written under the note counts, except versions the revoker
had already seen. What the app could already read, it keeps. A node that sees
its own note revoked in a space emits `revoked` (§1.9); the reference client
then forgets the grant and the app key.

*Source: `src/session/auth.ts` (`disconnect`, `connections`), `src/node/node.ts` (`checkRevoked`). Tests: `tests/connect.test.ts` ("disconnecting …").*

### 4.11 The app-side client

`createWeaveConnection({ home, request, network?, storage?, stores? })` is the
app's twin of §3: statuses `starting`, `disconnected`, `connecting`, `ready`,
`expired`. It keeps the grant in `localStorage` under `weave.grant` and the
person's chosen home under `weave.home` (`home` in the config is only a
default). A client convenience, not protocol.

*Source: `src/session/connection.ts`. Tests: none.*

---

## 5. Agents

### 5.1 Agent notes, and what peers refuse from them

An agent is not an identity. It writes for a person under a note from their
account, like an app; the note carries the fact `{ "weave": "agent" }`
(`AGENT_FACT`, [01](01-identity.md)). A note is an agent's when any entry of its
`fct` has `weave === "agent"`.

Every record written under an agent's note shows as `viaAgent: true`. Every
peer MUST refuse, from a version whose proof is an agent's note:

| What | How it is refused |
|---|---|
| Any record in the access log collections (`sys.role`, `sys.member`, `sys.invite`, `sys.revoke`, `sys.collection`, `sys.key`, `sys.relays`, `sys.keepers`) | It is never an access event: it changes nothing about who may do what, or which collections exist. |
| Any record in the account registry, the contacts space or a carry space | It does not stand ("Only the account itself writes here, not an agent"). |

Recipients additionally ignore:

- a contact request (`std.contact-request`) written `viaAgent`: it is never
  opened ([03](03-spaces.md));
- call messages from an agent (§7).

A node writing under an agent's note never names relays, seals member keys or
rotates a space key; in a private space it only learns keys.

*Source: `src/identity/agent-note.ts`, `src/node/space-runtime.ts` (`buildEvent`, `judgeStanding`, `write`, `upkeep`). Tests: `tests/agents.test.ts` ("a definition an agent signs by hand is ignored by every peer", "taking someone out of the space, signed by an agent, is ignored too", "it never writes the account itself").*

### 5.2 A node acting as an agent

`node.asAgent({ keys, note })` returns the same node acting as an agent. It
throws unless the note verifies, carries the agent fact, is made out to `keys`,
and was issued by `node.did`. The agent:

- signs with its own key, under its note, so what it writes shows "via agent";
- reaches only spaces its note names (`space:<id>`), or every space for `*`;
  events for other spaces are filtered out;
- refuses, locally, everything that needs a person: making, inviting, joining
  or leaving spaces; changing members, roles, invites or revocations; defining
  or deleting collections; live messages (`send` — a live message carries no
  note to say "via agent"); renaming or revoking at the account level; adding or
  removing carriers; notifications; hosting; changing, blocking, asking or
  accepting contacts; everything about doors (its list of doors is empty);
  `delegate`; `asAgent`;
- sees the contact list only if the contacts space is within its note.

Closing the agent leaves the underlying node running.

An agent granted `scope: account` gets a `*` note, the account key and — as
implemented — the contact key in its grant (§4.5), so the whole contact list is
within its note. Whether a home should withhold the contact key from an agent
is *Not yet specified*; the CLI agent does not pass it to its node (§5.4).

*Source: `src/node/node.ts` (`asAgent`). Tests: `tests/agents.test.ts` ("an agent acting for a person").*

### 5.3 Connecting an agent with a code

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

| `type` | From | Sealed body |
|---|---|---|
| `agent-link:ask` | terminal, on connecting to a peer | `{ "did": "<agent key>", "name": "Agent on leifs-macbook" }` (name ≤ 80) |
| `agent-link:heard` | app | `{ "heard": true }` |
| `agent-link:answer` | app | `{ "grant": <Grant> }` or `{ "denied": "<reason>" }` |
| `agent-link:done` | terminal | `{ "ok": true }` |

**Flow.**

1. The app starts offering: makes a code, joins the room, shows the code.
2. The terminal joins the room and, to each peer that connects, sends `ask`.
3. The app takes the **first** valid `ask` only (a `did` starting `did:key:`),
   answers `heard`, and shows the person the agent's name. Later asks are
   ignored; the code is good for one agent.
4. The person allows it, which opens the account home (§4) with
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

*Source: `src/session/agent-link.ts`, `example/src/components/ConnectAgent.tsx`. Tests: `tests/agents.test.ts` ("connecting an agent with a code").*

### 5.4 The agent on a computer

*Implementation detail of the CLI.* `weave connect` makes a P-256 key once and
keeps it as JWK in `<home>/agent/key.json` (mode 0600), the grant in
`grant.json`, and the spaces in `data/`. `weave mcp` then starts a node of its
own: signer `grantSigner(grant)`, session key = the agent key, the grant's
account key when present, relays = the grant's ∪ `$WEAVE_RELAYS` (default
`wss://p2p-web-relay.fly.dev`), WebRTC via `node-datachannel`; joins any granted
spaces it lacks; wraps the node with `asAgent`; holds every space; and serves
MCP over stdio with the person-only tools removed (§2).

*Source: `cli/src/agent.ts`, `cli/src/mcp.ts`. Tests: `tests/agents.test.ts` ("an agent running a node of its own"), `tests/cli.test.ts` ("MCP").*

---

## 6. Carriers and hosts

### 6.1 What a carrier holds, and sees

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

*Source: `src/space/pass.ts`, `src/node/carrier.ts`. Tests: `tests/carrier.test.ts` ("passes", "a carrier").*

### 6.2 Carry spaces and passes

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
step with the account, on every reconciliation (§1.5): one `sys.pass` record per
space, and one `sys.subscription` per notification subscription.

**Pass records.** Collection `sys.pass`, key
`pass:<hex of the first 20 bytes of SHA-256(utf8(space id))>`, body `SpacePass`:

| Field | Meaning |
|---|---|
| `v` | `1` |
| `space` | The space's genesis (`Space`, [03](03-spaces.md)). |
| `read` | Private spaces: the read key seed (`deriveReadSeed(spaceKey)`), base64url. |
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

**Keepers.** When a space opens, and on every reconciliation, a node holding
the account key that may `manage` a space names the account's live carriers as
its keepers (`{ did, name }`, at most 16, [03](03-spaces.md)) and stops naming
carriers the account removed. Other keepers stay. So apps holding part of a
space (§1.8) can rely on the carriers.

*Source: `src/node/node.ts` (`carriers`, `syncPasses`, `nameKeepers`), `src/space/pass.ts`, `src/space/account-registry.ts`. Tests: `tests/carrier.test.ts`.*

### 6.3 Connecting a carrier through the account home

A carrier (a browser extension) asks the home with `access: "carry"` (§4.4),
from a page that stays open until the answer comes. The home calls
`auth.grantCarry`, which replaces any earlier carrier from the same origin,
calls `carriers.add({ did: audience, name })`, and answers with a `CarryGrant`:

```json
{ "v": 1, "kind": "carry", "did": "<account>", "name": "Leif",
  "carry": { "space": "<carry space id>", "invite": "<view-only invite>" },
  "pod": { "dataPath": "accounts/k3j2h4g5f6d7/stores", "folder": "Weave" },
  "relays": ["wss://…"] }
```

`pod` is `null` when the account lives in the home's browser storage. The
carrier MUST check that `kind` is `carry`, that the invite is to the named
space, that the space is private, created by `did`, and that the invite carries
its key; and that `pod.dataPath` has no empty or `..` segments. A carry
connection has no expiry (`expiresAt: 0` in the home's record) and no note to
revoke; disconnecting it removes the carrier (§6.2).

*Source: `src/session/connect.ts` (`connectCarrier`, `checkCarryGrant`, `CarryGrant`), `src/session/auth.ts` (`grantCarry`). Tests: `tests/connect.test.ts` ("connecting a carrier to an account home").*

### 6.4 Notifications through carriers

"Let me know when…" subscriptions (`node.notifications`, needs the account
key) are kept in the account registry as `sys.notify` records, key
`notify:<base32 of 10 random bytes>`, body `NotifyWhen`:
`{ label (≤ 120), collection (not sys.*), spaces ("all" or 1–256 ids), topic?: { field, value }, others? (default true), open? (https URL), paused?, since (ISO date) }`.

Each device copies every subscription into every carry space as
`sys.subscription` (same key), with the topic value replaced by the tag it has
in each space ([02](02-records.md)):
`{ v: 1, label, collection, spaces, tags?: { <spaceId>: [<tag>] }, others, open?, paused, since }`.
A private space whose key the device lacks gets no tag.

A carrier notifies for a record that arrives when all hold: not paused; same
collection; `seq` 0 and not deleted; the space is in `spaces`; `createdAt` is
not before `since` and within the last 24 hours; with `others`, the record's
root is not the account; with `tags`, the record carries one of that space's
tags. What it reports is only the subscription, the space and the record's key,
collection and `createdAt`.

*Source: `src/space/notify.ts`, `src/node/node.ts` (`notifications`, `syncPasses`), `src/node/carrier.ts` (`arrived`). Tests: `tests/carrier.test.ts` ("notifications through a carrier").*

### 6.5 Hosts

A **host** is a carrier for many accounts, run as a service. Each account that
uses it has a **subscription**: a key pair the account made, a date it is paid
until, and, once a device hands it over, the account's carry space. Spaces
several subscriptions name are held once.

**The subscription key.** When an account first uses a host
(`node.hosting.use(url)`), the node makes a 32-byte random seed, derives a
P-256 key pair from it, and keeps a `sys.hosting` record in the account
registry, key `hosting:<hex of the first 20 bytes of SHA-256(utf8(url))>`, body:

| Field | Meaning |
|---|---|
| `url` | The host's origin: `https://`, or `http://` on `localhost`/`127.0.0.1`. |
| `host` | The host's DID, from its description when first used. |
| `seed` | The subscription key's seed, base64url. |
| `since` | ISO date. |
| `name` | The host's name, as it described itself. |
| `receipt` | The latest `SignedStatus` the host gave (below). |

Every device of the account signs as the same subscription. It is not the
account's key: the host learns a subscription, not who pays.

**Description.** `GET <url>/.well-known/weave-host`, public:

| Field | Meaning |
|---|---|
| `weave` | `"host/1"` |
| `did` | The host's key: its identity to peers, and what signs its statuses. |
| `name` | For people. |
| `free` | Every subscription counts as paid. |
| `price` | Optional, free text. |
| `pay` | Optional: the pay page, relative to the host's address or absolute. Absent: it takes no payments. |
| `terms` | Optional, for people. |

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

| Call | Body | Answer |
|---|---|---|
| `GET /host/subscriptions/<id>` | — | `SignedStatus` |
| `PUT /host/subscriptions/<id>/carry` | `{ "account": "<account DID>", "invite": "<carry invite, ≤ 16 000 chars>" }` | `SignedStatus`. 402 when not paid (or lapsed); 403 when the host carries only named accounts and this is not one; 400 for a bad invite. |
| `DELETE /host/subscriptions/<id>/carry` | — | `SignedStatus`. Stops carrying; the subscription stays. |

Errors are `{ "error": "<message>" }` with 400, 401 (not signed by the
subscription), 402, 403, 404, 405. The reference host sends
`Access-Control-Allow-Origin: *` on these paths and answers `OPTIONS`.

**Signed status.** `SignedStatus = { payload, sig }`, where `payload` is the JSON
text of a `HostStatus` and `sig` is the host key's signature (base64url) over
`utf8("weave-host-status/v1\n" + payload)`. `HostStatus`:

| Field | Meaning |
|---|---|
| `subscription` | The subscription DID. |
| `host` | The host's DID. |
| `state` | `active` (paid, or a free host), `grace` (past `paidUntil`, within the grace period), `lapsed`, `none` (no such subscription). |
| `paidUntil` | Unix seconds; 0 before any payment. |
| `renews` | Paid through something that renews by itself (a card). |
| `carrying` | Whether it carries the account's spaces now. |
| `spaces` | How many spaces the carry space's passes name. |
| `at` | When the host said it, unix seconds. |

A device MUST accept a status only if it verifies under the host's recorded DID,
its `host` equals that DID, and its `subscription` is the device's own. Example:

```json
{ "payload": "{\"subscription\":\"did:key:zDnaet57…\",\"host\":\"did:key:zDnaeXL64…\",\"state\":\"active\",\"paidUntil\":1821536000,\"renews\":true,\"carrying\":true,\"spaces\":4,\"at\":1790422901}",
  "sig": "cC4uQLCnF0tkMzhAuxHp58tjc2XWhdRpj9RpWgb-wYIhzKvhXhi97DoBn_hvcz9NLyv0ch2bqFMJfTIXgYxQhw" }
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
are the host's business and are *Not yet specified*. Example link:

```
https://host.example/pay#s=did%3Akey%3AzDnaet57TmtMH7vQJT8HzNLSZV5sc5JGJub2ZzpX3oHshR2k2&at=1790422901&sig=-EIgo2A2JYBWDwiJdfQR4v6rBL2WFqw07YgOJqAQB9_FdmTuq0f9uR1f2DSCOM3xw4sqytIJQ4hfz29T-uAbPA
```

**What a device does.** `hosting.list()` asks each host the account uses for its
status. When the status says it is not carrying and it is paid (`active`,
`grace`, or a free host not `lapsed`), the device hands over the carry space
with `PUT …/carry`, making the carrier (§6.2) for the host's DID first if the
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
anything. It runs the carrier of §6.1–6.2 for every carry space.

How a device reaches a host's sockets is outside this protocol: the reference
host takes peers at `wss://<host>/peer` ([04](04-network.md)), which a device
must be configured with as a node (`network.nodes`). *Not yet specified*: the
host description does not advertise it, and `hosting.use` does not add it.

*Source: `src/session/hosting.ts`, `src/node/host.ts`, `src/node/node.ts` (`hosting`), `cli/src/host.ts`, `cli/src/pay-page.ts`, `docs/blocks/BLOCK-23-paying-a-host.md`. Tests: `tests/host.test.ts`.*

---

## 7. Calls

Calls add nothing to the protocol below them. A call is live messages
(`spaces.send`, §1.10) in the space it belongs to, plus one WebRTC connection of
its own between each pair of devices in it (a full mesh). The setup travels
over the space's peer connection, whose handshake proved who is at the other
end; a relay only introduces devices and never sees a call.

### 7.1 Messages

Every call message is a JSON object with a `type` and a `call` id (a string of
1–64 characters; the reference makes 12 random bytes in lowercase hex). A
receiver MUST ignore a call message that is not one of these types, lacks a
valid `call`, comes from a peer with no account (`from: null`), or comes from an
agent (`agent: true`).

| `type` | Sent to | Fields | Meaning |
|---|---|---|---|
| `call.here` | the space, every `heartbeat` (5 s); or one device | `since` (ms, when the sender joined), `camera` (bool), `muted` (bool) | "I am in this call." |
| `call.ring` | one account | — | Ring that account's devices. |
| `call.answered` | the caller's account, and the answerer's own account | — | Answered; stop ringing. |
| `call.declined` | the caller's account, and the decliner's own account | — | Declined; stop ringing. |
| `call.cancel` | the rung account | — | The caller stopped ringing. |
| `call.signal` | one device | `description` (`{ type: "offer"\|"answer", sdp }`) or `candidate` (`RTCIceCandidateInit`) | Connection setup. |
| `call.leave` | the space | — | "I left", now rather than after the timeout. |

Examples:

```json
{ "type": "call.here", "call": "3f9a1c0b7e2d4a6f8b1c2d3e", "since": 1790422901000, "camera": false, "muted": false }
{ "type": "call.signal", "call": "3f9a1c0b7e2d4a6f8b1c2d3e", "description": { "type": "offer", "sdp": "v=0\r\n…" } }
```

### 7.2 Who takes part

Only **members** — accounts holding a role in the space ([03](03-spaces.md)) —
take part. A receiver MUST ignore `call.here`, `call.ring` and `call.signal`
from an account that holds no role there (a view-only reader). The reference
caches the member list for 10 s and asks once more for someone not in it.

A device MUST NOT ring for more than 3 `call.ring`s from one account in any 60 s;
later ones are ignored. `call.cancel` is honoured only from the account that
rang.

### 7.3 Presence

A device is in at most one call per space at a time: a `call.here` for another
call moves it. A device not heard from for 15 s (`gone`) is dropped, and the
connection to it closed. On hearing a new device's first `call.here` in the call
it is in, a device sends its own `call.here` straight to that device.

### 7.4 Joining, and which call

`start(space)` joins the call already going on in the space — the one with the
lowest id, if several — or starts one with a new id. Joining holds the space
(§1.7) for as long as the call lasts, so moving between screens never interrupts
it. When a device alone in its call (no connections yet) hears a `call.here`
for a call with a lower id in the same space, it moves into that call: two calls
started at once merge into the lower id.

### 7.5 Connections

- Between two devices, the one with the **lower session DID** (by string
  comparison) makes the offer. A device MUST ignore an offer from a device whose
  session DID is higher than its own, and an answer on a connection it did not
  offer or that already has one.
- Each connection is made with one audio and one video transceiver
  (`sendrecv`) from the start. Muting, turning the camera on or off and sharing
  the screen replace the sender's track and are announced with `call.here`;
  they never renegotiate.
- Candidates arriving before the remote description are queued (at most 64).
- When a connection fails, the offering side offers again after 2 s if the other
  device is still in the call.
- ICE servers come from `node.iceServers()`.

### 7.6 Ringing

1. The caller starts (or joins) the call, sends `call.ring` to the callee's
   account and shows `outgoing: ringing`.
2. The callee's devices ring for 45 s unless answered, declined or cancelled.
3. Answering: stop ringing, join the call (with that id), send `call.answered`
   to the caller's account and to one's own account (so other devices stop).
   Declining: `call.declined` the same way.
4. The caller on `call.answered` clears `outgoing`; on `call.declined` shows
   `declined` and, if nobody else is in the call 2.5 s later, leaves.
5. After 45 s unanswered, the caller sends `call.cancel`, writes a missed-call
   record (§7.8), shows `missed`, and leaves 2.5 s later if alone.

Group calls do not ring: a call going on shows to everyone with the space open.

### 7.7 Leaving

Leaving closes every connection, stops the local tracks, sends `call.leave` to
the space, and — if still ringing someone — sends `call.cancel` and writes a
missed-call record. If nobody else is left in the call and anyone else was ever
in it, the leaver writes an ended-call record. The space's hold is released 1 s
later, so the goodbye gets out first.

### 7.8 The `std.call` record

Calls themselves are kept nowhere. Their history is a `std.call` record in the
space, written only if the space defines `std.call`:

| Field | Type | Meaning |
|---|---|---|
| `status` | `"missed"` \| `"ended"` | required |
| `to` | string ≤ 256 | For a missed call: who was rung. |
| `startedAt` | string ≤ 64 (ISO date) | required |
| `endedAt` | string ≤ 64 (ISO date) | For an ended call. |
| `people` | string[] ≤ 64 items, each ≤ 256 | For an ended call: every account seen in it. |

Rules: `edit: creator`, `delete: creator` ([02](02-records.md)).

```json
{ "status": "ended", "startedAt": "2026-09-26T10:00:00.000Z", "endedAt": "2026-09-26T10:14:02.311Z",
  "people": ["did:key:zDnaeSm3…", "did:key:zDnaeXL64…"] }
```

*Implementation detail:* the call a device is in is kept in `sessionStorage`
under `weave-call` as `{ space, call }`, so after a reload the page can offer to
rejoin while the call is still going on.

*Source: `src/calls/calls.ts`, `src/schemas/index.ts` (`call`). Tests: `tests/calls.test.ts`.*

---

## 8. Client conveniences

These are not protocol; another client may draw sign-in and calls however it
likes.

- **`<weave-auth>`** draws the flow of §3 into its own light DOM (so password
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

*Source: `src/elements/weave-auth.ts`, `src/react/`. Tests: none.*
