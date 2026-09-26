# @weaveprotocol/core

A peer-to-peer data protocol for the browser. You own your identity as a
written-down code, keep your data in signed records that sync directly between
devices, and every app is a view onto that data rather than its owner.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Applications                          │
├──────────────┬───────────┬────────────┬──────────┬───────────┤
│   Accounts   │  Spaces   │ Validation │ Privacy  │   Sync    │
│ seed, vault, │ roles,    │ crypto →   │ AES-GCM  │ MST anti- │
│ root signer, │ members × │ structural │ per      │ entropy   │
│ UCAN, pairing│ pub/priv  │ → UCAN     │ space    │ gossip    │
├──────────────┴───────────┴────────────┴──────────┴───────────┤
│    Storage: Merkle Search Tree over a StorageAdapter         │
│    IndexedDB (per origin) · data folder (shared by origins)  │
├──────────────────────────────────────────────────────────────┤
│    Network: WebRTC data channels                             │
│    several relays at once · peers introduce peers            │
├──────────────────────────────────────────────────────────────┤
│    Web Crypto · WebAuthn · IndexedDB · File System Access ·  │
│    WebRTC · @noble/curves · @scure/base                      │
└──────────────────────────────────────────────────────────────┘
```

## Key Principles

- **No authority.** No server issues identities or holds the truth. Relays only
  introduce peers; an always-on node adds availability, never authority.
- **Apps are views.** Data lives in spaces the user owns, as signed records any
  app can read and verify.
- **Local-first.** Works offline, syncs when peers are reachable.
- **Few, boring dependencies.** Native browser APIs first. Where a problem is
  hard and already solved — elliptic-curve arithmetic, for one — a very stable,
  widely used library instead of our own. See [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).
- **Isomorphic.** Runs in browsers, Node and Bun via `globalThis`.
- **Functional.** Plain functions and frozen data, no class hierarchies.
- **Standard Schema.** Bring your own validator (Zod, Valibot, ArkType, …).

## Quick Start

```typescript
import {
  generateSeed, seedToRecoveryCode, createIdentityManager, createLocalRootSigner,
  publicKeyToDid, P256_MULTICODEC, createSigner, createExpression,
  createIndexedDBAdapter, createStorageProvider, createSpaceManager,
} from '@weaveprotocol/core';

// 1. An account is a 16-byte seed. Show the code once; the user keeps it.
const seed = generateSeed();
console.log(seedToRecoveryCode(seed));      // 'K7N6-ERYP-68TZ-A7HN-VJW3-QWKN-CG'

const manager = createIdentityManager();
const me = await manager.fromSeed(seed);   // same seed → same DID, anywhere
const provider = manager.getProvider();

// 2. The root key signs one thing: permission for a session key to write.
const root = createLocalRootSigner(me, provider);
const session = await provider.generateKeyPair();
const sessionDid = publicKeyToDid(await provider.exportPublicKey(session.publicKey), P256_MULTICODEC);
const ucan = await root.delegate({
  audience: sessionDid,
  capabilities: [{ with: '*', can: 'expression/*' }],
  expiration: Math.floor(Date.now() / 1000) + 3600,
});

// 3. A space to put things in
const spaces = createSpaceManager(await createIndexedDBAdapter('my-app/registry'));
const { space } = await spaces.create({ name: 'Notes', visibility: 'public', creator: me.did });

// 4. A signed record, stored in that space's own Merkle tree
const storage = createStorageProvider(await createIndexedDBAdapter(`my-app/space/${space.id}`));
const signed = await createSigner(provider).sign(
  createExpression({
    author: sessionDid,
    collection: 'app.example.note',
    space: space.id,
    body: { text: 'Hello, decentralized world!' },
    proof: ucan.encoded,
  }),
  session.privateKey,
);
await storage.addExpression(signed);
```

Syncing it to other devices is a network manager plus a sync engine with the
validation engine in front — see *Sync* below. Or skip all of this and use a
node, which does the wiring for you — next.

## The node — start here

Most applications never touch the modules below directly. `createNode` wires an
identity, its spaces, validation, encryption and sync into one object, and its
API is plain data in and out:

```typescript
import { createNode, createIdentityManager, createLocalRootSigner, indexedDBStores, rolePresets } from '@weaveprotocol/core';

const manager = createIdentityManager();
const me = await manager.fromRecoveryCode(code);

const node = await createNode({
  signer: createLocalRootSigner(me, manager.getProvider()), // or anything that signs
  stores: indexedDBStores('my-app'),                       // or folderStores(directory, …)
  network: { relays: ['wss://relay.example'] },
});

const space = await node.spaces.create({ name: 'Groceries', visibility: 'private', ...rolePresets.team });
const milk = await node.records.put(space.id, 'app.todo.item', { text: 'milk', done: false });
await node.records.update(space.id, milk.key, { text: 'milk', done: true }); // same key, next version
node.subscribe((event) => { if (event.type === 'records') redraw(); });

const invite = await node.spaces.invite(space.id);  // a friend calls node.spaces.join(invite) — and joins as an Editor
const view = await node.spaces.invite(space.id, { write: false });  // they can read, not change
await node.spaces.closeInvite(space.id, invite);    // nobody else joins with that link
```

What it takes care of:

- **One root signature an hour.** The node signs with a session key and asks the
  root signer for a fresh delegation before the old one runs out.
- **A record keeps its key; edits are versions.** `update` writes the next
  version — same key, `seq` one higher, `prev` naming the version it replaces —
  and `delete` writes a version marked deleted. Which version is current is
  decided by `seq`, then id, never by a clock: a replayed old version cannot
  roll a record back, a delete stays deleted, and two devices that edited apart
  agree on the winner. Only the current version is kept, unless a collection
  is defined with `history: 'all'`, which keeps every version as a hash-linked
  chain (`records.history`). Anyone who may write in a space may edit and delete
  in it.
- **Records outlive their session.** A delegation is judged at the moment a
  record was signed, so a peer arriving next week still accepts last week's data.
- **Unknown collections are kept.** Records in collections the node has no
  schema for are stored and synced on the strength of their signature and
  capability, so an always-on node — or an agent inventing a collection — does
  not need every app's schema.

Every operation is also described in `NODE_ACTIONS` — a name, a sentence and a
JSON Schema for its input — which is what the CLI, MCP and WebMCP front ends are
generated from. `runAction(node, 'records_put', { … })` runs one by name.

### Live messages, and spaces kept open

Some things should reach whoever is connected right now and be kept nowhere:
typing, presence, setting up a call. `spaces.send` is for those:

```typescript
await node.spaces.send(space.id, { type: 'typing' });            // everyone connected in the space
await node.spaces.send(space.id, { type: 'nudge' }, anna);        // only Anna's devices (her account DID)
await node.spaces.send(space.id, { type: 'hi' }, annasLaptop);    // one device (its session DID)

node.subscribe((event) => {
  if (event.type === 'message') event.from; event.peer; event.message;  // account, device, what was sent
});
```

A live message is never signed as a record, never written and never synced;
a peer who isn't connected misses it. It travels over the space's own peer
connections, so in a private space only people holding its read key can
receive one. At most 64 KB each, and each peer gets a burst of 60 and 20 a
second after that.

`event.from` is the **account**, not just a key. When two peers connect in a
space, each sends the other its note — the delegation from its account to its
session key, the same one its records carry. The note names the key it was
made out to, and that has to be the key the connection proved, so a note
copied off someone's record is no use to anyone else. `spaces.status(id).accounts`
lists who is connected, by account. A peer that shows no note (a carrier, a
node serving sockets) is `from: null`.

To keep a space syncing, **hold** it, and let go when you're done:

```typescript
const release = await node.spaces.hold(space.id);
await release();
```

Anything that needs a space live holds it: a screen showing it, a call in it.
It stops syncing once nothing does, so a screen going away never cuts off a
call. Each hold lets go only of itself, and letting go twice does nothing.
Reading or writing needs no hold. In React, `useHoldSpace(space)` holds a
space while a view is on screen, and lets go a few seconds late so that
clicking away and straight back doesn't rebuild the space's sync.

### Calls (`@weaveprotocol/core/calls`)

Voice and video between the members of a space, built only from live
messages and the browser's WebRTC:

```typescript
import { createCalls } from '@weaveprotocol/core/calls';

const calls = createCalls(node);
await calls.start(space.id, { video: true });   // join the call going on in the space, or start one
await calls.ring(space.id, anna);               // start one, and ring Anna's devices
calls.subscribe(() => draw(calls.getState()));  // { current, ringing, around, rejoin }
await calls.answer(ringing.id);  calls.setMuted(true);  await calls.shareScreen();  await calls.leave();
```

- **A call belongs to a space, not to a screen.** It keeps its space open for
  as long as it runs, so people can move between spaces and keep talking. One
  call at a time. In React, `<CallsProvider>` above whatever changes as people
  move around, and `useCalls()` below it.
- **Only members take part.** Someone with no role in the space (a view-only
  reader) is never rung by, counted in or connected to a call.
- **Group calls don't ring.** A call going on shows in `around` for everyone
  with the space open; only `ring`, aimed at one person, rings. One account
  can ring you three times a minute.
- **Everyone connects to everyone**, each pair on a WebRTC connection of its
  own, apart from the one sync uses. Good up to about six people with video.
  The setup goes over the space's peer connection, whose handshake proved who
  is at the other end, so a relay can't put itself in the middle of a call.
- **History, if the space wants it.** Where the space defines `std.call`, a
  ring nobody answered leaves a `missed` record, and the last one out of a
  call writes who was in it. Nothing else about a call is stored.
- **TURN.** `node.iceServers()` gives the configured ICE servers plus TURN
  servers a relay hands out (see the relay, below), with passwords fresh for
  a while. A call asks for them when it starts.

The messages, and the reasoning, are at the top of `src/calls/calls.ts`.

### Contacts

A DID is a **name, not an address**: it's on everything you sign, so knowing
it must not be enough to reach you. What lets two people reach each other is a
space they share. So **a contact is a private space for two**: records you
write there wait for the other person, and live messages reach them when
they're online. There's no directory to look people up in, and no inbox
strangers can knock on.

```typescript
// In a space you share with Anna — the book club — ask her to add you.
const { space } = await node.contacts.ask(club.id, anna, { note: "it's Leif from book club" });

// On Anna's side:
const [request] = await node.contacts.requests(club.id);   // { from, name, note, pairSpace, … }
await node.contacts.accept(club.id, request.key);           // joins the space for two, adds Leif

await node.contacts.list();          // [{ did, name, space, note, blocked }]
await node.contacts.put({ did, name: 'Anna K' });   // what you call them — only you see it
await node.contacts.remove(anna);    // off the list, and out of your space with her
await node.contacts.block(anna);     // and her requests are hidden in every space
await node.contacts.others(anna);    // anyone else in your space with her: [] unless someone was let in
```

- **The list** is one `std.contact` per person, in a **contacts space**
  derived from the account key the way the account registry is: every device
  of the account has it, nobody else can find it, and it's hidden from
  `spaces.list`. `contacts.space()` gives its id. A carrier carries it, so a
  restore brings the list back.
- **Asking** (`ask`) makes a private space for the two of you, puts them on
  your list with it, and posts a `std.contact-request` in the shared space:
  the new space's invite, **sealed with their contact key**. The other members
  can see that you asked, not what. The seal is bound to the space it was
  posted in and to who asked whom, so a request copied into another space, or
  re-posted by someone else, doesn't open. Joining is the answer: there's no
  reply record.
- **The contact key** is a P-256 key for encryption, derived from the seed
  under its own label (`deriveContactKeyBytes`), so it's the same on every
  device and comes back with the recovery code. Its public half goes on your
  profile in every space you write in (`spaces.profiles(id)[n].contactKey`),
  and only counts on a profile signed by your own account. An app without the
  key never takes it off: a profile keeps the newest key it was given.
- **Conversation or group** is decided by how the space was made, not by how
  many people are in it: a space is your conversation with Anna because your
  list says so. A space made with "New space" and shared with one person is
  never one. If a third account turns up in a space for two, `others` says so,
  and an app can offer to start a new space with just the two of you, or a new
  group with everyone.

**What an app gets.** A home gives the contacts to an app that asks with
`contacts: true`: the contacts space as one more space in its grant, and the
contact key, which opens requests sent to you. Asking someone and accepting
also make or join a space, so those need `scope: 'account'`, which includes
the contacts. Agents never get them.

## Signing in — the element, and React

Getting to a node takes a sign-in flow: where the data lives (a pod or this
browser), which account, the ways into it (its password, a passkey, a device
password), creating one, staying signed in, arriving from a phone-pairing QR.
The protocol ships it, so an app does not write it:

```html
<weave-auth app-name="Todo" relays="wss://relay.example"></weave-auth>
<script type="module">
  import '@weaveprotocol/core/elements';
  document.querySelector('weave-auth').addEventListener('weave-session', (event) => {
    const session = event.detail.session;      // { account, did, sessionDid, node }, or null
    if (session) start(session.node);
  });
</script>
```

The element fits whatever it is put in — a page, a modal, a side panel — by
sizing to its container, and draws nothing once someone is in. It renders into
the page rather than a shadow root, because password managers fill forms there
reliably and the account password living in one is the point. Colours, font and
radius are custom properties (`--weave-accent`, `--weave-font`, …).

Underneath it is `createWeaveAuth` (`@weaveprotocol/core/session`): the same flow as
state and actions, with no framework. The element draws it; an app that wants
its own screens draws it itself. Either way the seed stays inside it.

```tsx
import { createWeaveAuth } from '@weaveprotocol/core/session';
import { WeaveProvider, WeaveAuth, useWeave, useNode, useQuery } from '@weaveprotocol/core/react';

const auth = createWeaveAuth({ appName: 'Todo', network: { relays: ['wss://relay.example'] } });

createRoot(root).render(
  <WeaveProvider auth={auth}>
    <App />
  </WeaveProvider>,
);

function App() {
  const { state } = useWeave();
  if (state?.stage !== 'ready') return <WeaveAuth />;
  return <Todos space={…} />;
}

function Todos({ space }) {
  // Re-renders as records change here or arrive from peers.
  const { result } = useQuery(space, { collection: 'app.todo.item', sort: { '@createdAt': 'asc' } });
  const node = useNode();
  const add = (text) => node.records.put(space, 'app.todo.item', { text, done: false });
  …
}
```

Everything below the provider asks for what it needs:

| Hook | Gives |
|---|---|
| `useWeave()` | The flow, its state and the session — or nulls, before sign-in |
| `useAuth()` / `useSession()` / `useNode()` | The same, for components that only exist once someone is in |
| `useSpaces()` | The account's spaces, kept current, with `create`, `join`, `leave` |
| `useQuery(space, query)` | Records matching a query, kept current |
| `useRecord(space, key)` / `useLinked(space, key)` | One record; what points at it |
| `useCollections(space)` / `useProfiles(space)` / `useSpaceStatus(space)` | What a space holds, who is in it, whether it is connected |
| `useCan(space, action, target)` | Whether this account may create, edit or delete — for hiding a button |
| `useHoldSpace(space)` | Keeps a space syncing while a view is on screen |
| `useLive(space, load, deps)` | Anything else, reloaded as the space changes |

An app connected to an account home passes its node instead:
`<WeaveProvider node={node}>`. React is an optional peer dependency; only
`@weaveprotocol/core/react` imports it.

## Apps without the seed — the account home

An app does not have to sign anyone in at all. It can ask an **account home** —
a page, at an address the person chose, that holds their account — for access,
and never see the seed. `home/` is one, ready to deploy as your own:

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/leifriksheim/weave&base=home)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/leifriksheim/weave&root-directory=home)

An app connects with `createWeaveConnection` — the twin of `createWeaveAuth`,
for apps:

```tsx
import { createWeaveConnection } from '@weaveprotocol/core/session';
import { WeaveProvider, useConnection } from '@weaveprotocol/core/react';

const connection = createWeaveConnection({
  home: 'https://weave-home.netlify.app/connect',
  request: {
    name: 'Todo',
    access: 'write',                                                      // or 'read'
    scope: 'spaces',                                                      // or 'account': every space
    create: [{ name: 'Todos', visibility: 'private' }],                   // made by the home, in the account
  },
  network: { relays },
});

<WeaveProvider connection={connection}><App /></WeaveProvider>;

function App() {
  const { connection, state } = useConnection();
  if (state.status !== 'ready') return <button onClick={() => connection.connect()}>Connect with Weave</button>;
  return <Todos />;   // useNode(), useQuery(…) — the same hooks as anywhere
}
```

It remembers the grant between visits, starts the node from it, and says
`expired` when the note runs out; connecting again renews it.

The `home` an app names is only a suggestion. The home belongs to the person:
`connection.connect('weave.example.com')` uses their own, and the app remembers
it — for reconnecting and for "account settings". The grant carries the home's
relays, and the app joins them, so an app and a home configured with different
relays still meet. Underneath are
`connectToHome`, `startConnectedNode` and `grantStore`, for apps without React.

1. The app makes its own key, kept in its own site's storage and never
   exportable (`appKey()`).
2. The home opens in a popup. The person unlocks there — the account password
   from their password manager, or a passkey — and picks which spaces the app
   gets.
3. The home signs a note from the account to the app's key: these spaces, read
   or change, for seven days. It hands the note back with invites for those
   spaces, to the app's origin only.
4. The app's node signs with its own key under that note. It acts *for* the
   account — records show the account as their author — but every peer checks
   the note, so it cannot write anywhere it was not given.

What the note limits: **writing**, per space, checked by every peer. What it
cannot limit: **reading** a private space it was given — whoever holds a space's
key can read all of it, and that key does not change yet. Spaces an app wants
for itself are created by the home, as part of the approval, so they land in
the account's list on every device.

An app that is a view onto *everything* — like the example — asks for
`scope: 'account'`: a note for every space, plus the key the account's space
list is derived from, so it sees every space and can make and join them. It
gets the contacts too (see Contacts, above). It
still never holds the seed: it cannot sign in anywhere as the account, change
its password or passkeys, or keep access past the note's date.

The home side is `receiveConnectRequest()` and `auth.grant(…)`; see
[home/README.md](home/README.md).

## Modules

### Identity (`@weaveprotocol/core/identity`)

| Export | Description |
|--------|-------------|
| `generateSeed()` / `seedToRecoveryCode()` / `recoveryCodeToSeed()` | The account seed and its written form |
| `createIdentityManager()` | `fromSeed`, `fromRecoveryCode`, `fromPassword`; passkey-PRF derivation as an option |
| `createLocalRootSigner()` | A `RootSigner` for a seed unlocked in this page |
| `createFolderAccountStore()` / `createBrowserAccountStore()` | Where accounts live: a data folder, or this browser |
| `wrapSeedWithDeviceKey()` / `wrapSeedWithPassphrase()` | Local ways to unlock a stored seed |
| `deriveVaultKey()` | Key for sealing an account's space registry at rest |
| `pairingRoomId()` / `encodePairingTicket()` / `sealPairingPayload()` | Bringing a phone into an account |
| `issueUCAN()` / `verifyUCAN()` | Capability tokens (UCAN 0.10, `ES256` JWTs) |
| `delegateCapabilities()` | Attenuated delegation from a parent token |
| `validateDelegationChain()` | Verify a full root → … → leaf proof chain |
| `createP256Provider()` | ECDSA P-256 crypto provider (swappable) |
| `publicKeyToDid()` / `didToPublicKey()` | `did:key` encoding |

#### The account is a seed

An identity is 16 random bytes. HKDF-SHA256 stretches them to 48, `@noble/curves`
reduces those to a P-256 private key the standard way (FIPS 186-5, appendix
A.2), and the compressed public key becomes a spec-conformant `did:key`
(`did:key:zDn…`). The same seed always yields the same DID, and anything that
DID signs verifies for anyone who holds only the DID. Golden tests pin known
seeds to their DIDs, because a silent change here would give every account a
new identity.

The seed's written form is the **recovery code**: 128 bits in Crockford base32.
It is the primary way in, not a fallback. It is the only credential that works
on a domain that has never seen you, because there is nothing stored there for
anything else to unlock.

```typescript
const code = generateRecoveryCode();            // 'K7N6-ERYP-68TZ-A7HN-VJW3-QWKN-CG'
const me = await createIdentityManager().fromRecoveryCode(code);
// case, spacing and the usual O/0, I/1 slips are all forgiven on the way back in
```

To a password manager the code is an ordinary generated password, so Bitwarden,
1Password, iCloud Keychain and the rest can store and autofill it. The example
app presents it in a username/password form for exactly that reason.

#### Unlocking on a device you've used before

Typing the code every visit would be tedious, so each origin can keep **wraps**:
encrypted copies of the seed, each opened a different way.

| Wrap | Opened by | Notes |
|---|---|---|
| `device` | A random, non-extractable key kept in this origin, with a passkey as the gate in front of it | Works with every passkey provider, because nothing is derived from the passkey |
| `passphrase` | PBKDF2-SHA256 → AES-GCM | A short password for this device |

See *Locking the folder* below for how wraps are stored.

#### Why passkeys are a gate, not the identity

A passkey can only hand an app a secret through the WebAuthn **PRF** extension.
Several major credential managers — Bitwarden and 1Password among them — store
passkeys without PRF, or report it inconsistently. An identity *derived* from a
passkey would lock those users out, and it would still be a different identity
on every domain, since a passkey is bound to one.

So the passkey only decides whether this origin may use its device key. PRF
derivation is still available (`identity.register()` / `authenticate()`, with
`inspectPasskeyPrf()` to diagnose what a provider actually does), but nothing in
the example depends on it.

#### UCAN delegation

A root identity — a passkey you never expose to a web app — delegates narrow,
expiring capabilities to keys that do the day-to-day signing:

```typescript
import { issueUCAN, delegateCapabilities, validateDelegationChain } from '@weaveprotocol/core';

// Root grants a session key everything it may do with todos, for an hour
const sessionUcan = await issueUCAN({
  issuer: { did: me.did, privateKey: me.privateKey },
  audience: sessionDid,
  capabilities: [{ with: 'space:app.example.todo', can: 'expression/*' }],
  expiration: Math.floor(Date.now() / 1000) + 3600,
}, provider);

// The session key hands a guest a strictly weaker, read-only capability
const guestUcan = await delegateCapabilities({
  parent: sessionUcan,
  issuer: { did: sessionDid, privateKey: sessionKey },
  audience: guestDid,
  capabilities: [{ with: 'space:app.example.todo', can: 'expression/read' }],
}, provider);

// Any peer can check the whole chain back to the root DID
const chain = await validateDelegationChain(guestUcan.encoded, [sessionUcan.encoded], provider);
chain.valid; // true
```

Escalation is refused at issue time (a child capability must be a subset of its
parent), a delegation can never outlive its parent, and only the audience of a
token may delegate it onward.

### Schema (`@weaveprotocol/core/schema`)

Typed, signed data expressions using [Standard Schema](https://standardschema.dev/).

| Export | Description |
|--------|-------------|
| `createSchemaEngine()` | Register collections with Standard Schema validators |
| `validateJsonSchema()` / `asStandardSchema()` | The JSON Schema a space stores, and its Standard Schema adapter |
| `createSigner()` | Sign and verify expressions (JWS-style) |
| `createExpression()` | Build unsigned expressions (optionally carrying a UCAN `proof`) |
| `canonicalize()` | Deterministic JSON serialization |

### Storage (`@weaveprotocol/core/storage`)

Local-first storage with Merkle Search Tree for efficient sync.

| Export | Description |
|--------|-------------|
| `createStorageProvider()` | MST-backed expression storage; `compact()` deletes tree nodes the root no longer reaches |
| `createIndexedDBAdapter()` | IndexedDB storage adapter, scoped to this origin |
| `createFolderAdapter()` | A user-picked directory, shared by every origin given access |
| `createEncryptedAdapter()` | Seals chosen keys (space records, space keys) at rest |
| `reconcileFolder()` | Rebuilds the tree after another writer touched a folder |
| `insertIntoMST()` / `listMSTEntries()` | Direct MST operations; a listing can stop at a key prefix |
| `createMirror()` | Keeps a space in a dumb file store too, synced like a peer that never runs code |
| `createS3BlobStore()` / `createMemoryBlobStore()` | File stores a mirror can use: any S3-compatible bucket (R2, B2, MinIO, AWS), or memory |

**Mirrors.** A bucket or an app folder can hold a space: each writer (one store
on one device, with a random id) only ever adds immutable segments in its own
folder, named by a counter and the hash of their bytes — so nothing is written
twice and nothing needs a lock. A segment holds versions exactly as they travel,
private bodies still sealed, and everything read back passes the same gates as a
peer's records: the store can hide things, not forge them. What a writer knows
the store holds, it never uploads again; a writer compacts its own segments
into fewer. Merging is the protocol's own — a set of versions that only grows.

### Spaces

A space is the container everything else lives in. It is **public** (signed in
the clear) or **private** (every body encrypted with the space key), and who
may write in it is decided by its **roles** — the space's own, not the
protocol's. A private notebook is a space whose creator never invited anyone;
a team list is one where everyone invited holds an Editor role.

| Export | Description |
|--------|-------------|
| `createSpaceManager()` | Create, list, join and forget spaces; mint invites |
| `parseSpaceInvite()` | Read an invite without joining, to show what it offers |
| `checkSpace()` / `spaceIdOf()` | Whether a space you were handed is the one its id names |
| `rolePresets` | Starting roles to use or ignore: `solo`, `team`, `community` |
| `replayAccess()` | The access history, replayed — who holds what, as of any point |
| `deriveInviteKey()` / `deriveReadKey()` | An invite link's key, and a private space's read key |

```typescript
const spaces = createSpaceManager(adapter);

const { space, key } = await spaces.create({
  name: 'Move house',
  visibility: 'private',   // key generated, bodies encrypted
  creator: me.did,
  ...rolePresets.team,     // Owner, and Editor for whoever is invited
});
```

Give each space its own storage and its own MST and a peer you share one list
with learns nothing about the others.

#### Who may write: roles, and a history every peer replays

Three questions decide every write, each with its own mechanism:

1. **Who is really writing?** A note (UCAN): "this key speaks for this account."
2. **What standing does that account have here?** Its **role** in the space.
3. **Does this action on this record allow it?** The collection's **rules**.

A **role** is a name, a rank and a list of permissions. Three permissions are
the protocol's own — `manage` (roles and members), `invite` and `define`
(collections) — and every other one belongs to a collection (`app.poll/moderate`).
A `*` matches anything: `*` is every permission, `*/*` every collection's. The
**rank rule** is the only check rules cannot express: you may change people
and roles ranked below you, and give out roles up to your own rank. Two people
at the same rank can never remove each other, only themselves — so the creator
**hands over** by giving someone their role, then leaving, and the space goes on.

Roles, members, invites, revoked notes, collection definitions and changes of a
private space's key are records (`sys.role`, `sys.member`, `sys.invite`,
`sys.revoke`, `sys.collection`, `sys.key`), and
every record written anywhere names the latest of them its writer knew, as
`seen`. That makes the **access history** a small graph, which every peer
replays the same way (`space/roles.ts`): a change comes after what it saw;
changes that did not see each other go taking-away first — counting everything
on the way to one — then the higher-ranked author, then the lower id; a change
counts only if its author had the power both as of what they saw and at its
turn. A record is judged by its author's role, and the definition in force, as
of its own `seen`.

**Taking access back.** Removing someone, lowering a role or closing an invite
carries a **keep list**: the records the remover had seen. A record that relied
on what was taken away, and had not seen it go, stands only if it is kept — so
claiming an old point in history, or an old date, gets a removed member
nothing, while what they wrote before stays. Apps connected through an account
home write under a note, never a secret of the space's; **Disconnect** writes a
`sys.revoke` for that note, and nothing under it counts from then on except
what the home had seen.

**Invites** are one per role. `node.spaces.invite(space)` opens one for the
lowest role below yours — or makes a view-only one when there is none — and
the link carries its secret (and a private space's key): shown once, kept
nowhere. The joiner writes their own member record, signed a second time by
the invite's key over the space and their identity; it counts once the
invite's record has reached them, so joining finishes on the first sync.
`closeInvite` takes the link itself.

Roles, members, invites and revokes stay **in the clear**, even in a private
space: a relay, a mirror or a host holding no secret of the space's replays the
same history and reaches the same verdict as a member, so a stranger who knows
a space's id cannot get a record stored anywhere. That shows who holds which
role — DIDs are on every signed record anyway. Collection definitions stay
sealed.

A private space also has a **read key**, derived from the space key, so everyone
who can read has it. Every connection — to an always-on node, or peer to peer
through a relay — starts with a handshake before anything else crosses it:
each side signs a fresh challenge with the key its DID names, so nobody can
connect under someone else's name, and in a private space with the read key
too, checked against its public half. A stranger who learns a space's id, or a
relay that sees its room, gets no ciphertext. A peer-to-peer handshake also
signs both ends' DTLS fingerprints, so a relay that swapped in its own offer to
sit in the middle is caught.

**Removing someone from a private space changes its key**, the way Keybase
changes a team's key. Whoever manages the space, seeing someone lose their
place (removed, left, or their role deleted), makes a new key by itself and
writes a `sys.key` record: the new key's id and public read key, and every
earlier key sealed under the new one. It is part of the access history, so two
new keys made apart resolve like any other change, and only `manage` may make
one. Each member's copy goes in a `sys.box`, sealed to their **member key**: a
key pair per account per space, derived from the account's vault key, whose
public half each member publishes in the clear (`sys.memberkey`). An account
home hands an app the member keys of exactly the spaces it grants.

From then on new records are sealed with the new key. Someone removed keeps what
they could already read, and nothing after it. Holding the current key opens
every earlier one, so a newcomer reads the space's past. A member who was away
when the key changed still holds only the older read key: they prove that, and
send their note sealed under the older key, and a peer holding it lets them in
if they are still a member. A host with no key takes the current read key only.
View-only links made before the change stop working; share a new one.
`node.spaces.changeKey(space)` does the same by hand, for a lost device.

A space's **id is the hash of what is fixed at creation**: creator, visibility,
starting roles and which one the creator holds, time, a random nonce and the
first read key (the name is left out, so it can change). `join` refuses an
invite whose space does not hash to its id — so whoever passes an invite on
cannot change who started the space, or with which roles. The key an invite
carries may be a later one; its id is its hash, so it is either the key the
history names or one that opens nothing.

**Spaces describe themselves.** A space stores its collections' definitions —
name, title, description and a JSON Schema — as signed records in
`sys.collection`, so an app or an agent that has never seen a space can ask what
it holds (`node.collections.list`) and what each thing looks like. Records are
checked against the definition when written, and flagged (`conforms`) when read;
nothing is refused during sync for its shape, so peers that saw definitions in
different orders still converge. `node.collections.define` publishes one — the
same call an agent makes through MCP.

**Links.** A record can point at another in a named role — `{ rel: 'about',
to: <key> }` — and `node.records.linked(space, key)` answers what points at a
thing. Links point at keys, so a comment stays on a post however often the post
is edited; in a private space they are sealed with the body, so a relay cannot
see what points at what. Collections declare their links in their definition,
so an agent reading `collections_list` sees how a space's things connect.

**Standard schemas, optional.** The protocol has no built-in kinds of record.
For the patterns nearly every app needs there is a small library of ordinary
collection definitions, named `std.*`, in `@weaveprotocol/core/schemas`: things that
attach to any record (`reaction`, `comment`, `tag`, `attachment`, `reference`)
and a few common nouns (`message`, `task`, `column`, `poll`, `vote`). Nouns kept in a hand-made
order carry a `position` string; `positionBetween(a, b)` makes one between two
neighbours, so moving a card rewrites only that card:

```typescript
import { reaction, useSchemas } from '@weaveprotocol/core/schemas';

await useSchemas(node, space.id, [reaction]);   // defines only what the space lacks
await node.records.put(space.id, reaction.name, { emoji: '👍' }, { links: [{ rel: 'about', to: post.key }] });
```

Using the same ones is how two apps agree — reactions from one show up in the
other. The example app's Apps tab is built on this: a chat, a kanban board and
polls, each appearing in a space once it holds the collections it needs
(`std.message`; `std.task` and `std.column`; `std.poll` and `std.vote`). An app that wants its own shape defines its own collection instead.

**Rules, enforced by every peer.** A definition can say who may create, edit and
delete its records, what must be unique, and which fields are fixed:

```typescript
await node.collections.define(space.id, {
  name: 'app.poll.vote',
  schema: voteSchema,
  links: { about: { to: ['app.poll'], cardinality: 'one' } },
  rules: { edit: 'creator', onePer: ['@author', 'link:about'] },  // one vote per person per poll
});
```

`create`/`edit`/`delete` take `member` (anyone holding a role), `creator` — a
fact about the record, which nobody decides — or `can:<permission>`, naming a
permission the collection declares in `permissions`. The test for which: did a
person have to decide it? "The creator edits" follows from the data; "moderators
delete" needs `can:moderate`, and the space decides which roles hold
`app.poll/moderate`. `onePer` derives the record's key from what must be
unique, so voting again *is* changing your vote — no peer ever needs to see every
vote to stop a second one. `fixed` fields keep their first value. Each version
is judged by the definition in force as of the access history it saw, so every
peer judges it by the same rules: a forged edit or a second vote is refused
during sync, and something that arrives before what it depends on waits instead
of being guessed about. `node.records.can(space,
'edit', key)` asks first — for hiding a button rather than showing an error.

**Queries.** `node.records.query(space, { collection, where, include,
sort, limit, cursor })` finds records with Mongo-style filters (`{ done: false,
amount: { $gt: 10 } }`; `@author`, `@createdAt` and friends for the record
itself) and pulls in what links to them — `include: { likes: { rel: 'about',
from: 'std.reaction', count: true } }`. A query is plain JSON, so an agent
sends the same thing over `records_query`; `node.records.watch` re-runs one as
records sync in. Only records this device can read come back, so `body` is
never null.

**Typed queries.** Name a collection by its definition instead of a string, and
the results are typed from its schema — including everything `include` pulls
in, and `number` for a `count`. `collection()` keeps a definition's types; the
standard schemas already carry theirs; `Typed<T>` names a collection whose
schema is plain JSON Schema. Before a query runs, every reference becomes its
name, so the query is still plain data.

```typescript
import { collection } from '@weaveprotocol/core';

const polls = collection({ name: 'app.poll', schema: Poll });    // Poll is a Zod object
const votes = collection({ name: 'app.poll.vote', schema: Vote });

await node.records.put(space.id, polls, { question: 'Where?', options: ['Oslo', 'Lisbon'] }); // checked against Poll

const { records } = await node.records.query(space.id, {
  collection: polls,
  include: { votes: { rel: 'about', from: votes } },
});
records[0].body.question;                  // string
records[0].included.votes[0].body.choice;  // number
```

**The account registry.** Which spaces an account belongs to is itself kept in
a space: a private one whose id and key are derived from the account's vault
key, so every device of the account finds it and nobody else can. Creating or
joining a space writes a membership record there (carrying the invite, so the
key too); every other device and node of the account syncs it and joins by
itself. A membership deleted on any device means the account left, and every device leaves.
Pass `accountKey` to `createNode` to turn it on. The account's name lives there
too (`node.account.setName`), so a rename on one device or site reaches every
other one — and a site opening the account for the first time shows its name.

**Profiles.** Other people see you by that name. The node publishes it into
every space it opens, and again on a rename, as a `sys.profile` record keyed by
a hash of your identity; `node.spaces.profiles(space)` (and the
`spaces_profiles` action) says who is who. Every version is kept and the one
shown is the newest signed by the identity the key names, so nobody can rename
anyone else. Someone following a space without a role publishes nothing there.

**Moving and merging.** `copyAccountData` copies an account's spaces, keys and
records from one set of stores to another — out of a browser's own database into
a data folder, for instance. Because every record is signed, named by its
content, and deletes are records too, merging into a folder that already holds
the same account is the same operation: the result is everything from both, and
whatever either side deleted stays deleted. A space lives on the devices that hold it,
not inside the identity — bringing a DID back on a new device restores who you
are, and an invite (even one you send yourself) restores what you had. Expressions name their space in a signed
field, which stops one being replayed into another.

**Encrypt, then sign.** A private space encrypts the body *before* the expression
is signed, so the signature covers the ciphertext: peers without the key still
verify and relay the data, they simply cannot read it. The structural gate steps
aside for encrypted bodies — their shape is checked by members after decryption.

### Network (`@weaveprotocol/core/network`)

Browser-to-browser communication via WebRTC.

| Export | Description |
|--------|-------------|
| `createMesh()` | One node's WebRTC connections through relays, shared by every space: `mesh.join(room, auth)` gives a space its peers |
| `createNetworkManager()` | Peers over a transport that dials on its own — a node's socket, a local link |
| `createSignalingClient()` | WebSocket signaling for ICE/SDP exchange |
| `createMultiSignalingClient()` | Several relays used at once, de-duplicated |
| `createRTCTransport()` | WebRTC data channel management (the default transport) |
| `createWebSocketTransport()` | A socket to one always-on node — no relay, no TURN |
| `createMeshAuth()` | The peer-to-peer handshake: each side proves its DID, and in a private space that it may read |
| `createClientAuth()` / `createServerAuth()` | The handshake with a node: the client proves its DID (and the read key, if private), the node signs with its own |

#### Signaling relay

`server/relay.mjs` is a dumb relay in a couple hundred lines of Node with no
dependencies of its own. It runs on its own as `server/signaling-server.mjs`
(an HTTP server and the `ws` library around it), and inside every always-on
node (`weave serve`), so the two are the same relay. A peer holds one socket and joins a room on it for
each space, and the relay passes join notices and WebRTC offers, answers and
candidates between peers that share a room. (A socket opened with `?room=` is
the older one-room form, still served.) The room is a hash of
the space's id (`relayRoom`), so the relay cannot tell which space a room is.
Expression data never touches it — that flows peer to peer — and it cannot
read a private space.

It is open to anyone, so it keeps to limits: small messages, a cap on
connections per address, peers per room and rooms per socket, a message rate
per socket, and one DID per socket, which cannot be claimed twice in a room. Every message
it forwards carries the sender's DID as it joined, whatever the message says.

```bash
npm run signal          # ws://localhost:8787; /health says {"ok":true}
```

It can also hand out **TURN** passwords, for calls between people on networks
that won't let two browsers connect directly. Run coturn with
`use-auth-secret`, and give the relay the same secret:

```bash
TURN_SECRET=… TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349 npm run signal
```

Each socket that joins a room gets servers and a password that stops working
after `TURN_TTL_SECONDS` (4 hours by default). The password is an HMAC of when
it expires (the "TURN REST API" scheme), so nothing is stored. The relay can't
tell a Weave peer from anyone else, so set coturn's own quotas (`user-quota`,
`total-quota`, `max-bps`). TURN only forwards encrypted packets; it can't
see or hear a call.

Only peers already in a room hear about a newcomer, so exactly one side creates
the offer and the two never collide.

### Sync (`@weaveprotocol/core/sync`)

Anti-entropy gossip protocol for eventual consistency.

| Export | Description |
|--------|-------------|
| `createSyncEngine()` | Automatic MST reconciliation with heartbeat |
| `verifyNode()` / `unknownChildren()` | The pieces of a tree walk |

Two peers compare roots — equal means identical, one round trip. Otherwise each
walks the other's tree from the root, skipping every subtree already in its own,
so cost follows the size of the difference: one changed entry in 10,000 costs
about 37 KB on the wire, where sending every key cost 508 KB. Whether a subtree
is already here is one lookup in the store, not a read of the whole local tree.

The engine's `validate` hook is the seam where the validation engine sits.
Expressions a peer sends are only committed if it accepts them; the rest are
dropped and surface as a `rejected` event with the reason.

### Validation (`@weaveprotocol/core/validation`)

A pipeline of gates for incoming expressions.

| Export | Description |
|--------|-------------|
| `createValidationEngine()` | Full gatekeeper pipeline |
| `createCryptoGate()` | Expression id + signature verification |
| `createStructuralGate()` | Schema conformance via Standard Schema |
| `createCapabilityGate()` | UCAN authorization: may this key write this? |
| `createStatefulGate()` | Custom Wasm rules |

The crypto gate settles *who* signed an expression. The capability gate answers
the next question: were they allowed to? An expression signed by a delegated key
carries its UCAN in `proof` — a signed field, so it cannot be swapped out — and
the gate walks that chain back to a root identity, rejecting anything expired,
issued to a different key, broader than its parent, or rooted in an identity the
application does not trust.

```typescript
const validation = createValidationEngine({
  cryptoGate: createCryptoGate(provider),
  structuralGate: createStructuralGate(schema),
  statefulGate: createStatefulGate(),
  capabilityGate: createCapabilityGate({
    provider,
    requiredCapability: (expression) => ({ with: `space:${expression.collection}`, can: 'expression/write' }),
    isTrustedRoot: (did) => spaceMembers.has(did),
  }),
  resolvePublicKey: async (did) => provider.importPublicKey(didToPublicKey(did).publicKeyBytes),
  getExpression: (id) => storage.getExpression(id),
});
```

### Privacy (`@weaveprotocol/core/privacy`)

End-to-end encryption for private Spaces.

| Export | Description |
|--------|-------------|
| `createPrivacyGuard()` | Transparent E2EE orchestrator |
| `generateSpaceKey()` | AES-GCM-256 space keys |
| `wrapSpaceKey()` | ECDH + AES-KW key distribution |

## Storage Adapters

The protocol uses an adapter pattern for storage flexibility:

```typescript
interface StorageAdapter {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  putExpression(expression: Expression): Promise<void>;
  getExpression(id: string): Promise<Expression | null>;
  deleteExpression(id: string): Promise<void>;
  queryExpressions(collection: string, limit?: number): Promise<Expression[]>;
  // ... more
}
```

**Built-in**:

- `createIndexedDBAdapter(name)` — works in every browser. Origin-scoped.
- `createFolderAdapter(directory, namespace)` — a directory the user picked, via the File System Access API. **Not** origin-scoped. Chrome, Edge and Opera on the desktop.

The always-on node (`weave run`) uses the folder adapter on disk, in the same layout. **Planned**: mirrors, which keep a space in storage the user already pays for (a Dropbox app folder, Drive, S3) and sync with it like a peer — see `docs/blocks/BLOCK-03-mirrors.md`. OPFS is not on the list: it is origin-private, so it would inherit exactly the limitation a data folder exists to avoid.

### Data folders — storage that outlives the origin

(The app calls a data folder a **pod**.)

Every in-browser store is keyed by origin. IndexedDB, localStorage, Cache API and OPFS (the name is the spec: *Origin Private* File System) all partition by it, so two deployments of one app on two domains can never read each other's data, and a passkey — bound to an RP ID, which is a domain — derives a different identity on each. Two views of the same app become two unrelated accounts.

A directory handle is the exception. Each origin asks for permission once, and both end up looking at the same files:

```
<folder>/
  accounts.json                       name, DID and id of each account (readable without unlocking)
  accounts/<id>/account.json          that account's seed, encrypted once per way of unlocking it
  accounts/<id>/stores/<namespace>/
    kv/<key>                          MST nodes, the root pointer, space records (sealed)
    expressions/<cid>.json            one signed record per file
```

A folder is a disk, not a person: several accounts can live in one. A browser
with no folder keeps the same shape in IndexedDB, so an app has one model
rather than two.

```typescript
import {
  pickDataFolder, createFolderAccountStore, recoveryCodeToSeed, deriveVaultKey,
  createFolderAdapter, createEncryptedAdapter, reconcileFolder,
  createIdentityManager, createStorageProvider,
} from '@weaveprotocol/core';

const folder = await pickDataFolder();                 // needs a user gesture
const accounts = createFolderAccountStore(folder);
const [account] = await accounts.list();               // names and DIDs; nothing unlocked yet

const seed = recoveryCodeToSeed(code);                 // or open one of its wraps, below
const identity = await createIdentityManager().fromSeed(seed);

const adapter = await createFolderAdapter(folder, `${account.dataPath}/spaces/${spaceId}`);
const storage = createStorageProvider(adapter);
await reconcileFolder(storage, adapter);               // pick up other writers

// The registry is sealed under a key only an unlocked folder can derive.
const registry = createEncryptedAdapter(
  await createFolderAdapter(folder, `${account.dataPath}/registry`),
  await deriveVaultKey(seed),
);
```

**Expressions are the truth; the MST is an index over them.** That inversion is what lets several writers share one folder without taking a lock. Every expression file is named by its own content hash, so concurrent writers can only ever add files that agree; the single mutable thing, the root pointer, is derived state that either side can rebuild. `reconcileFolder()` rebuilds it — call it on an interval, on window focus, or after a sync round, since the web has no filesystem change notification.

Two consequences worth having:

- **The folder is the account.** Copy it to a USB stick and it is your whole identity. Put it in iCloud, Dropbox or Syncthing and several devices converge with no relay at all — the folder becomes a second transport alongside WebRTC, and both meet in the same anti-entropy merge.
- **It changes nothing about the mesh.** A folder-backed node is an ordinary peer that happens to be durable and readable by several origins — an availability role, never an authority one. Where there is no folder (Safari, Firefox, mobile) a node keeps an origin-scoped replica and gossips exactly as before.

### Locking the folder

A folder whose account file held the seed in the clear would be a bearer token — copying it would be enough to become its owner, and the AES key for every private space sits in the same directory as the ciphertext it opens. So the seed is never stored. Each `account.json` holds **wrapped copies** of it, one per way of unlocking:

```
account seed (16 bytes, never written in the clear)
  ├── HKDF → vault key ──encrypts──> space keys and space records at rest
  └── stored only as wraps:
        device      a random local key, gated by any passkey (one per origin)
        passphrase  PBKDF2-SHA256 → AES-GCM
```

A device wrap is opened by a random key kept in one origin's storage, with a passkey as the gate in front of it — **not** derived from the passkey (see *Why passkeys are a gate, not the identity*). So every provider works, and each origin adds a wrap of its own:

```typescript
const deviceKey = await createDeviceKey();                 // non-extractable, local
const wrap = await wrapSeedWithDeviceKey(seed, deviceKey, { rpId, credentialId });
await accounts.write(account, withWrap(vault, wrap));
```

`deviceWrapsFor(vault, rpId)` says which wraps this origin can even attempt; the rest name keys it cannot reach. The gate is enforced in application code rather than by cryptography — see `src/identity/device-key.ts` for what that does and does not protect against. The recovery code needs no wrap, because it *is* the seed in printable form — it opens the folder anywhere, including on a phone or in a browser with no File System Access API, and it is shown once and stored nowhere.

`createEncryptedAdapter` seals `space:`, `spacekey:`, `spaceinvite:` and `spacerole:` values under the vault key, which is what makes a private space genuinely unreadable to someone holding the folder. It is scoped deliberately narrowly: expressions and MST nodes pass through, so what stays legible is each record's author, timestamp and collection, plus anything in a space its owner made public. Sealing those too would mean an opaque blob store, which would cost the property that makes a folder worth having.

### Where the root key lives

The root key signs exactly one thing: a note saying a session key may write for
the next hour. Everything else is signed by the session key. That one signature
is the only reason an app needs the identity — so it is the only thing that has
to move for the key to live somewhere else:

```typescript
export interface RootSigner {
  readonly did: string;
  readonly custody: 'local' | 'remote';
  delegate(params: { audience, capabilities, expiration }): Promise<UCANToken>;
}
```

`createLocalRootSigner` signs in the page, for a seed unlocked here. Anything
else that holds the key can implement the same interface and sign where it is,
so the seed never crosses into the page. Nothing downstream changes either
way, because DIDs, expressions, validation and sync never see the root key
under any arrangement.

### Meeting peers

Two browsers cannot find each other unaided — neither can accept an incoming
connection — so something has to make the introduction. That something is a
relay, and it is worth being precise about how little it is: it forwards
connection offers, never sees an expression, and drops out of the conversation
the moment two peers are talking.

Two things keep it from being an authority:

```typescript
const mesh = createMesh({
  // Used all at once, not as failover: two people who picked different relays
  // would otherwise never meet.
  relays: ['wss://relay-a.example', 'wss://relay-b.example'],
  did: sessionDid,
  introductions: true, // the default
});
const peers = mesh.join(await relayRoom(spaceId), createMeshAuth(spaceId, session, read, provider));
```

**One connection per pair of devices**, however many spaces they share: one
socket per relay, one WebRTC connection per peer, and each space proves itself
on it separately before any of its data crosses — so a peer you share one
space with is a peer in that one only.

**Several relays**, so there is no single phone book — a peer announced by two
of them is announced upward once, and replies go back the way they arrived.

**The space says where it meets**, like a Nostr relay list, but the space's
own. `sys.relays` is part of the access history, so only someone who manages
the space changes it (`node.spaces.setRelays`), and a new space names its
creator's relays by itself. Invites carry the list, so a joiner whose app uses
other relays reaches the space before anything has synced. Every member then
joins the space's room on those relays as well as their own
(`mesh.useRelays(room, relays)`); relays only one space names are joined for
that space's room alone, and dropped once no open space names them. Moving a
space to another relay, a self-hosted one say, is one change, and everyone
follows. No DHT: browsers can't be DHT nodes, and would need a relay to reach
one anyway.

**Peers introduce peers**, so a relay is only needed for the *first* connection.
Once you are connected to someone, their data channel carries signalling for the
peers you have not met: `__peers` says who I can see, `__signal` carries
somebody else's offer onward, bounded by a hop count and de-duplicated by id.
Both sides of a new pair learn of each other at once, so the lower identifier
offers and the other waits — otherwise every introduction would open two
connections. After that the mesh introduces itself and the relay can go away.

`server/` has a Dockerfile and a `fly.toml` for running one.

### Pairing a phone

No mobile browser has the File System Access API, so a phone keeps its own
replica like any other peer. Getting it started takes two things — the identity,
and the list of spaces — and only the first fits in a QR code:

```typescript
import {
  pairingRoomId, derivePairingKey, encodePairingTicket,
  sealPairingPayload, openPairingPayload,
} from '@weaveprotocol/core';

// Desktop: a link for the QR. The fragment never reaches a server.
const ticket = encodePairingTicket({ v: 1, code: seedToRecoveryCode(seed), relay });
const url = `${origin}${pathname}#pair=${ticket}`;

// Both sides, independently — no negotiation, nothing sent.
const room = await pairingRoomId(seed);
const key = await derivePairingKey(seed);

// Desktop, once the phone turns up in that room:
send(await sealPairingPayload(utf8Encode(JSON.stringify({ spaces: invites })), key));
```

The room is derived from the **seed**, not the DID. A DID appears in every
expression an account has ever signed, so a room named after one could be found
by anyone who had seen its data; a room named after the seed can only be found by
someone who already has it.

Encoding a URL rather than raw data means phone cameras open it natively — no
scanner, and it works on iOS. Afterwards the phone is a full peer that syncs with
anyone in the space, not a satellite of the machine that paired it.

## Swappable Crypto

The `CryptoProvider` interface abstracts key algorithms:

```typescript
// Default: ECDSA P-256
const provider = createP256Provider();

// Future: Ed25519, etc.
const identity = createIdentityManager({ provider: myEd25519Provider });
```

## Standard Schema Integration

A space stores its collections' shapes as JSON Schema, so any app in any
language can read them. You don't have to write it by hand: pass a validator
that can describe itself as JSON Schema — [Standard JSON
Schema](https://standardschema.dev/json-schema): Zod 4.2+, ArkType 2.1.28+,
Valibot through `toStandardJsonSchema` — and the node stores what it accepts.

```typescript
import * as z from 'zod';

const Poll = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1)).min(2).max(10),
});

await node.collections.define(space.id, { name: 'app.poll', schema: Poll });
```

A space can store only a small subset of JSON Schema, the part every language
agrees on (types, required, enums, lengths and sizes, number bounds, labelled
choices). A validator feature with no stored equivalent — `z.email()`, whose
check is a regex — is refused when you define the collection, saying what is
supported, rather than quietly not being enforced by other apps.

Lower down, the schema engine takes any [Standard Schema
v1](https://standardschema.dev/) validator directly, for local checks:

```typescript
import { createSchemaEngine } from '@weaveprotocol/core';

const schema = createSchemaEngine();
schema.registerCollection({ name: 'app.example.post', schema: PostSchema });
```

## Command line, always-on node, and agents

`cli/` is `weave`: every node operation from a terminal, `weave run` to keep an
account's spaces syncing on a server (browsers connect to it over WebSocket, and
it doubles as a relay), and `weave mcp` to hand the same operations to an agent.
It reads and writes the same data folder layout a browser does. See
[cli/README.md](cli/README.md).

**Hosting.** `weave host` keeps many accounts' spaces online without being able
to read them: it is the extension's carrier (`createCarrierNode`) with one carry
space per paying account (`createHostNode`), each space held once however many
members pay for it. A subscription is a key the account makes and keeps in its
registry (`sys.hosting`), so every device signs as it; `node.hosting.use(url)`
starts one, and whichever device notices it is paid hands the host the carry
space. Every call to the host is signed over method, path, time and body.
The home knows nothing about payment (BLOCK-23): a host describes itself at
`/.well-known/weave-host` (like a Nostr relay's NIP-11 document), signs every
status it gives — the home keeps the latest in the registry as the person's
proof — and takes payments on its own pay page, which `node.hosting.payPage(url)`
links to with a signature by the subscription key, valid for an hour at that
host only. On the page: Stripe Checkout and the Customer Portal (card, Apple
Pay, Google Pay), whose webhook moves a paid-until date taken from Stripe's own
billing period; and USDC from a crypto wallet straight to the host's address,
checked on the network by the host. Past the date: a grace period, then the host drops
the spaces and deletes its copy. With a bucket (`WEAVE_S3_*`) the host's disk
is only a cache — every carried space and the subscription list live in the
bucket, sealed, and a new machine starts from it. The account home's Settings
has **Keep my spaces online**.

## Example app

`example/` is the Weave website — a landing page for developers at `/`, and
why Weave, for people, at `/why` — and, at `/app`, a general-purpose app for your spaces — Vite + React, consuming
the protocol straight from `src/`. It knows no kinds of data in advance: every
screen is worked out from what a space says about itself (see *Derived UI* below):

```bash
npm install && (cd example && npm install) && (cd home && npm install)   # the CLI is a workspace: the first one installs it
npm run dev
```

That starts everything, with coloured output per part, and Ctrl-C stops it all:

| Part | Where | What |
|---|---|---|
| app | http://localhost:5173 | The example app |
| home | http://localhost:5174 | The account home it connects to |
| node | port 8787 | An always-on node that is also the relay; a throwaway identity on first run (`cli/.env.dev`, data in `.weave-dev/`) |
| host | http://localhost:8788 | `weave host`, what "Keep my spaces online" uses, with its pay page at `/pay`; settings in `cli/.env.host.dev` |
| stripe | — | Only when you add a Stripe test key (below): forwards Stripe's webhooks to the host |

`example/.env.development` and `home/.env.development` point the app and home
at the rest. Override any of them in a `.env.local`, and the host in
`cli/.env.host.local`.

**Trying hosting and payments.** In the home: Settings, **Keep my spaces
online**, **Keep online** (the dev host is filled in), then **Payment**, which
opens the host's pay page in a new tab. What you can pay with there:

- **A browser wallet, on by default.** Payments go to Base Sepolia, a test
  network: test money only. In MetaMask (or any browser wallet), get test ETH
  for the fee from a Base Sepolia faucet (Coinbase's, or Alchemy's) and test
  USDC from faucet.circle.com (choose Base Sepolia). Pay, and the pay page
  says "Payment received"; back in the home's tab, the host shows "paid until"
  and takes your spaces. To see payments arrive, set your own address as
  `WEAVE_WALLET_ADDRESS` in `cli/.env.host.local`.
- **A card, in Stripe's test mode.** In `cli/.env.host.local`, add
  `STRIPE_SECRET_KEY=sk_test_…` and the price ids of a monthly and a yearly
  recurring test price (`STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`, from the Stripe
  dashboard in test mode). With the Stripe CLI installed, `npm run dev`
  forwards Stripe's webhooks to the host by itself. Pay with card
  4242 4242 4242 4242, any future date, any CVC.
- **Phone wallets, by QR code.** Add `WEAVE_WALLETCONNECT_PROJECT_ID` (free at
  dashboard.reown.com, with localhost allowed in the project) to
  `cli/.env.host.local`; `npm run dev` builds what the pay page needs. The
  wallet has to be on Base Sepolia too.

`npm test` covers the same paths without any of this: a fake network, fake
Stripe calls, and the home's side against a real host.

The example never signs anyone in: "Connect with Weave" opens the home, where
you make an account or sign in, and allow the example your whole account. Its
avatar menu opens the home for account settings.

To give the node a space, create an invite link in the app and:

```bash
npm run weave -- spaces join --invite '<link>'
npm run weave -- records list --space <id>
```

Close every browser holding the space, open the link somewhere else, and the
records come from the node. Or make the node your own account's — see
[cli/README.md](cli/README.md) — and it serves every space you make, unasked.

Between them they exercise the stack end to end. At the home: choose where
your data lives (a pod, or this browser), create an account (a password your
password manager keeps) or sign in to one, stay signed in, add a passkey, move
between pods, pair a phone by QR code, and see which apps you connected. In the
example: make private or public spaces, just yours or with people you invite, and share one with a
friend via an invite link. Everyone in a space is shown by the name
they gave. Every record is signed by a delegated session key, stored in that
space's MST, encrypted first if the space is private, and gossiped to peers over
WebRTC; a record says *verified* once its signature and its delegation chain
check out here, and *encrypted* when it arrived encrypted.

**Derived UI.** A space opens on its **Apps** tab: apps built on the standard
schemas (a chat, a kanban board) show up once the space holds the collections
they need, and adding one defines what is missing. The **Collections** tab
lists every collection down the side — the space's catalogue. Each one is a list you can search and add to in one line, or a
table, or — when it has a field with fixed choices — a board you drag cards
across; a yes/no field becomes a checkbox on each row. A record opens in a
panel beside the list: its fields as properties you edit in place, what it
points at and what points at it, and reactions, tags and comments, which get a place on every record once the
space has added them from the library. And there is a "+ Add …" button for every collection
that declares a link to this collection: define `app.poll.vote` with
`about → app.poll` and every poll gets "+ Add vote". Choices show by their label: `oneOf: [{ const, title }]`
for fixed ones, and `x-choicesFrom: { rel: 'about', field: 'options' }` for a
field that picks from a list in the linked record — so a vote stored as `1`
shows as "Lisbon", its form offers the poll's options, and the poll shows a
tally. The helpers that work this out are pure functions
(`example/src/derive/schema-ui.ts`), with nothing DOM-specific in them. An
empty space offers a small "define a collection" form; an agent can do the
same over WebMCP.

**Calls.** Every space you have a role in has "Start a call" at the top, or
"Join call · 3" while one is going on, and People & roles has "Call" beside
each member, which rings them. The call sits in a panel in the corner, over
whatever page you're on: open other spaces, go back to the list, and you keep
talking. The sidebar marks the space a call is in. The panel grows to fill the
screen, or moves into a picture-in-picture window where the browser has one,
so it stays in view when you switch tabs. Someone ringing you shows as a card
on any page. The **Calls** app keeps a log of a space's calls (`std.call`).
The calls themselves are `createCalls` (above), made once in `App.tsx`,
above everything that changes as you move around.

**Agents in the browser (WebMCP).** When `/app` loads, it registers
every node operation as a WebMCP tool on `document.modelContext`
(`example/src/webmcp.ts`, with `@mcp-b/webmcp-polyfill`: Chrome's own WebMCP
when present, a polyfill otherwise). A browser agent or extension sees the same
tools as the CLI and `weave mcp` — `spaces_list`, `records_query`,
`records_put`, `apps_propose`… — and works as the person, with nothing to
switch on: anything that can call a page's tools can already click through the
page, so a key of its own would stop nothing. It isn't offered
`collections_define`: it proposes apps (`apps_propose`) and a person adds
them. Anything that changes a space's people, or hands out its key, asks the
person first. An app may bring its own screen: a collection definition's
`screen`, one HTML document, which the example runs in a sandboxed frame with
no network, talking to the space only through a message port
(`createScreenBridge`, `apps_screen_guide`). `docs/screens/chess.html` is one
an agent wrote.

**Agents on your computer (Claude Code, Claude Desktop, Cursor).** "Connect an
agent", in the account menu, shows one command:
`npx @weaveprotocol/cli connect wv_…`. The terminal makes its own key, finds
the tab through the relay, and the person allows it at their account home,
which signs an agent's note for the whole account, for as long as they chose.
Everything said on the way is sealed with a key from the code, so the relay
learns nothing (`src/session/agent-link.ts`). The command then adds `weave` to
the agents it finds, and they start `weave mcp` themselves: a node of its own,
over WebRTC (`node-datachannel`), that follows the account and keeps working
with every tab closed. What it writes shows "via agent", and every peer
ignores an agent changing collections, who may do what, or the account's own
list of spaces. See BLOCK-20.

## Releasing

`@weaveprotocol/core` (this folder) and `@weaveprotocol/cli` (`cli/`, an npm
workspace) are released together, always with the same version:

```bash
npm run release
```

It typechecks and runs the tests, then [bumpp](https://github.com/antfu-collective/bumpp)
asks for the next version, writes it to both packages, and commits and tags
it (`v0.1.2`). Both are published (each builds itself first: `dist/` for the
core, one bundled file for the CLI), and only then is the commit pushed. The
settings are in `bump.config.ts`.

## Tests

```bash
npm test
```

Covers key derivation — checked against the public keys Web Crypto generates
for the same private scalars, and pinned to recorded DIDs so an accidental
change cannot slip through; recovery codes; account vaults, wraps and account
stores; data folders with several writers; spaces, invites and
encrypt-then-sign; UCAN issuing, attenuation and chain validation; phone
pairing; peer introductions; the MST; the validation gates; and two peers
reconciling over the anti-entropy protocol, including the forged, stolen,
unauthorized and malformed expressions their gatekeepers reject. Above those:
the node API — versioned records, links, queries, collection definitions,
profiles, the account registry, moving and merging accounts — and the CLI.

## License

MIT
