# @p2p-web/protocol

A peer-to-peer data protocol for the browser. You own your identity as a
written-down code, keep your data in signed records that sync directly between
devices, and every app is a view onto that data rather than its owner.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Applications                          │
├──────────────┬───────────┬────────────┬──────────┬───────────┤
│   Accounts   │  Spaces   │ Validation │ Privacy  │   Sync    │
│ seed, vault, │ personal/ │ crypto →   │ AES-GCM  │ MST anti- │
│ root signer, │ shared ×  │ structural │ per      │ entropy   │
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
} from '@p2p-web/protocol';

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
const { space } = await spaces.create({ name: 'Notes', type: 'personal', visibility: 'public', owner: me.did });

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
validation engine in front — see *Sync* below, and `example/src/space-session.ts`
for the full wiring.

## The node — start here

Most applications never touch the modules below directly. `createNode` wires an
identity, its spaces, validation, encryption and sync into one object, and its
API is plain data in and out:

```typescript
import { createNode, createIdentityManager, createLocalRootSigner, indexedDBStores } from '@p2p-web/protocol';

const manager = createIdentityManager();
const me = await manager.fromRecoveryCode(code);

const node = await createNode({
  signer: createLocalRootSigner(me, manager.getProvider()), // or a Snap, or anything that signs
  stores: indexedDBStores('my-app'),                       // or folderStores(directory, …)
  network: { relays: ['wss://relay.example'] },
});

const space = await node.spaces.create({ name: 'Groceries', type: 'shared', visibility: 'private' });
const milk = await node.records.put(space.id, 'app.todo.item', { text: 'milk', done: false });
await node.records.update(space.id, milk.id, { text: 'milk', done: true });
node.subscribe((event) => { if (event.type === 'records') redraw(); });

const invite = await node.spaces.invite(space.id);  // a friend calls node.spaces.join(invite)
```

What it takes care of:

- **One root signature an hour.** The node signs with a session key and asks the
  root signer for a fresh delegation before the old one runs out.
- **Deletes that stay deleted.** A delete is a signed tombstone that syncs;
  without one, the next sync would pull a removed record straight back from a
  peer. Only a record's author or the space's owner can delete it.
- **Records outlive their session.** A delegation is judged at the moment a
  record was signed, so a peer arriving next week still accepts last week's data.
- **Unknown collections are kept.** Records in collections the node has no
  schema for are stored and synced on the strength of their signature and
  capability, so an always-on node — or an agent inventing a collection — does
  not need every app's schema.

Every operation is also described in `NODE_ACTIONS` — a name, a sentence and a
JSON Schema for its input — which is what the CLI, MCP and WebMCP front ends are
generated from. `runAction(node, 'records_put', { … })` runs one by name.

## Modules

### Identity (`@p2p-web/protocol/identity`)

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
import { issueUCAN, delegateCapabilities, validateDelegationChain } from '@p2p-web/protocol';

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

### Schema (`@p2p-web/protocol/schema`)

Typed, signed data expressions using [Standard Schema](https://standardschema.dev/).

| Export | Description |
|--------|-------------|
| `createSchemaEngine()` | Register collections with Standard Schema validators |
| `createSigner()` | Sign and verify expressions (JWS-style) |
| `createExpression()` | Build unsigned expressions (optionally carrying a UCAN `proof`) |
| `canonicalize()` | Deterministic JSON serialization |

### Storage (`@p2p-web/protocol/storage`)

Local-first storage with Merkle Search Tree for efficient sync.

| Export | Description |
|--------|-------------|
| `createStorageProvider()` | MST-backed expression storage |
| `createIndexedDBAdapter()` | IndexedDB storage adapter, scoped to this origin |
| `createFolderAdapter()` | A user-picked directory, shared by every origin given access |
| `createEncryptedAdapter()` | Seals chosen keys (space records, space keys) at rest |
| `reconcileFolder()` | Rebuilds the tree after another writer touched a folder |
| `insertIntoMST()` / `diffMST()` | Direct MST operations |

### Spaces

A space is the container everything else lives in, described by two independent
choices: **who writes** (`personal` — the owner alone; `shared` — anyone invited)
and **who can read** (`public` — signed in the clear; `private` — every body
encrypted with the space key). That covers the four combinations an app usually
wants, from a private notebook to an open collaborative list.

| Export | Description |
|--------|-------------|
| `createSpaceManager()` | Create, list, join and forget spaces; mint invites |
| `parseSpaceInvite()` | Read an invite without joining, to show what it offers |

```typescript
const spaces = createSpaceManager(adapter);

const { space, key } = await spaces.create({
  name: 'Move house',
  type: 'shared',
  visibility: 'private',   // key generated, bodies encrypted
  owner: me.did,
});

// Hand this to a friend — for a private space it carries the key, so it belongs
// in a URL fragment, which browsers never send to a server
const invite = await spaces.createInvite(space.id, me.did);
await theirSpaces.join(invite, friend.did);
```

Give each space its own storage and its own MST and a peer you share one list
with learns nothing about the others. A space lives on the devices that hold it,
not inside the identity — bringing a DID back on a new device restores who you
are, and an invite (even one you send yourself) restores what you had. Expressions name their space in a signed
field, which stops one being replayed into another.

**Encrypt, then sign.** A private space encrypts the body *before* the expression
is signed, so the signature covers the ciphertext: peers without the key still
verify and relay the data, they simply cannot read it. The structural gate steps
aside for encrypted bodies — their shape is checked by members after decryption.

### Network (`@p2p-web/protocol/network`)

Browser-to-browser communication via WebRTC.

| Export | Description |
|--------|-------------|
| `createNetworkManager()` | Full P2P networking (signaling + RTC + discovery + introductions) |
| `createSignalingClient()` | WebSocket signaling for ICE/SDP exchange |
| `createMultiSignalingClient()` | Several relays used at once, de-duplicated |
| `createRTCTransport()` | WebRTC data channel management (the default transport) |
| `createWebSocketTransport()` | A socket to one always-on node — no relay, no TURN |

#### Signaling relay

`server/signaling-server.mjs` is a dumb relay in a couple hundred lines of
dependency-free Node: it speaks WebSocket by hand, groups peers by
`?room=<spaceId>`, and passes join notices and WebRTC offers, answers and
candidates between them. Expression data never touches it — that flows peer to
peer — and it cannot read a private space.

```bash
npm run signal          # ws://localhost:8787, /health reports rooms and peers
```

Only peers already in a room hear about a newcomer, so exactly one side creates
the offer and the two never collide.

### Sync (`@p2p-web/protocol/sync`)

Anti-entropy gossip protocol for eventual consistency.

| Export | Description |
|--------|-------------|
| `createSyncEngine()` | Automatic MST reconciliation with heartbeat |
| `compareRoots()` | Quick root CID comparison |
| `findMissingExpressions()` | Identify missing data |

The engine's `validate` hook is the seam where the validation engine sits.
Expressions a peer sends are only committed if it accepts them; the rest are
dropped and surface as a `rejected` event with the reason.

### Validation (`@p2p-web/protocol/validation`)

Three-gate validation pipeline for incoming expressions.

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

### Privacy (`@p2p-web/protocol/privacy`)

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

**Planned**: a SQLite adapter (`bun:sqlite`) for the always-on node, and a packed adapter that keeps durable data in blob storage the user already pays for — see `docs/blocks/`. OPFS is not on the list: it is origin-private, so it would inherit exactly the limitation a data folder exists to avoid.

### Data folders — storage that outlives the origin

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
} from '@p2p-web/protocol';

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

`createEncryptedAdapter` seals `space:` and `spacekey:` values under the vault key, which is what makes a private space genuinely unreadable to someone holding the folder. It is scoped deliberately narrowly: expressions and MST nodes pass through, so what stays legible is each record's author, timestamp and collection, plus anything in a space its owner made public. Sealing those too would mean an opaque blob store, which would cost the property that makes a folder worth having.

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

`createLocalRootSigner` signs in the page, for a seed unlocked here. A MetaMask
Snap implements the same interface and signs inside the extension, so the seed
never crosses into the page — see `snap/`. Nothing downstream changes either
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
const network = createNetworkManager({
  // Used all at once, not as failover: two people who picked different relays
  // would otherwise never meet.
  signalingUrls: ['wss://relay-a.example', 'wss://relay-b.example'],
  did: sessionDid,
  introductions: true, // the default
});
```

**Several relays**, so there is no single phone book — a peer announced by two
of them is announced upward once, and replies go back the way they arrived.

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
and the list of lists — and only the first fits in a QR code:

```typescript
import {
  pairingRoomId, derivePairingKey, encodePairingTicket,
  sealPairingPayload, openPairingPayload,
} from '@p2p-web/protocol';

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

Collections accept any [Standard Schema v1](https://standardschema.dev/) compatible validator:

```typescript
import { z } from 'zod';
import { createSchemaEngine } from '@p2p-web/protocol';

const PostSchema = z.object({
  text: z.string().max(300),
  tags: z.array(z.string()).optional(),
});

const schema = createSchemaEngine();
schema.registerCollection({
  name: 'app.example.post',
  schema: PostSchema, // Zod implements Standard Schema v1
});
```

## Example app

`example/` is a collaborative todo list — Vite + React, consuming the protocol
straight from `src/`:

```bash
cd example
npm install
npm run dev
```

Run `npm run dev:full` instead to start the signaling relay alongside it, which
is what lets two browsers find each other.

It exercises the stack end to end: create an account (a code your password
manager keeps), choose a data folder or this browser to hold it, unlock later
with a passkey or short password, sign in through the MetaMask Snap in `snap/`,
pair a phone by QR code, make private, public, personal and shared lists, and share one with a friend via
an invite link. Every todo is an Expression signed by a delegated session key,
stored in that space's MST, encrypted first if the space is private, and gossiped
to peers over WebRTC. Each item shows 🔐 once its signature *and* its delegation
chain verify locally, and 🔑 when it arrived encrypted.

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
unauthorized and malformed expressions their gatekeepers reject.

## License

MIT
