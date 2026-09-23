# @p2p-web/protocol

Self-sovereign, peer-to-peer protocol for the browser. Own your identity via hardware-backed passkeys, structure data with cryptographically signed schemas, and sync state across a distributed network using efficient gossip mechanisms.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Application Layer                     │
├────────────┬──────────┬──────────┬──────────┬───────────┤
│  Identity  │  Schema  │ Privacy  │Validation│   Sync    │
│  Manager   │  Engine  │  Guard   │  Engine  │  Engine   │
├────────────┴──────────┴──────────┴──────────┴───────────┤
│                   Storage Provider                       │
│              (Merkle Search Tree + Adapter)               │
├─────────────────────────────────────────────────────────┤
│                   Network Manager                        │
│           (WebRTC + WebSocket Signaling)                  │
├─────────────────────────────────────────────────────────┤
│                   Browser Native APIs                    │
│      WebCrypto · WebAuthn · IndexedDB · WebRTC           │
└─────────────────────────────────────────────────────────┘
```

## Key Principles

- **Zero dependencies** — uses only native browser APIs (`Web Crypto`, `WebRTC`, `WebAuthn`, `IndexedDB`)
- **Isomorphic** — runs in browsers, Deno, and Bun via `globalThis`
- **Functional** — pure functions, immutable data, no class hierarchies
- **Standard Schema** — bring your own validator (Zod, Valibot, ArkType, etc.)
- **Local-first** — works offline, syncs when connected

## Quick Start

```typescript
import {
  createIdentityManager,
  createSchemaEngine,
  createSigner,
  createExpression,
  createStorageProvider,
  createIndexedDBAdapter,
  createNetworkManager,
  createSyncEngine,
  createValidationEngine,
  createPrivacyGuard,
} from '@p2p-web/protocol';

// 1. Create an identity from a passkey
const identity = createIdentityManager();
const me = await identity.register('alice');
console.log(me.did); // did:key:z...

// 2. Register a schema (Standard Schema compatible — use Zod, Valibot, etc.)
const schema = createSchemaEngine();
schema.registerCollection({
  name: 'app.example.post',
  schema: myZodSchema, // any Standard Schema v1 compatible validator
});

// 3. Create and sign an expression
const signer = createSigner(identity.getProvider());
const unsigned = createExpression({
  author: me.did,
  collection: 'app.example.post',
  body: { text: 'Hello, decentralized world!' },
});
const signed = await signer.sign(unsigned, me.privateKey);

// 4. Store locally with MST
const adapter = await createIndexedDBAdapter('my-app');
const storage = createStorageProvider(adapter);
await storage.addExpression(signed);

// 5. Connect to peers and sync
const network = createNetworkManager({
  signalingUrl: 'wss://signal.example.com',
  did: me.did,
});
await network.connect();

const sync = createSyncEngine({
  storageProvider: storage,
  sendToPeer: (peerId, data) => network.send(peerId, { type: 'sync', from: me.did, payload: data }),
  // Nothing a peer sends is committed until it passes every gate
  validate: async (expression) => {
    const result = await validation.validate(expression);
    return { valid: result.valid, reason: result.gates.find(g => !g.passed)?.reason };
  },
});
sync.start();
```

## Modules

### Phase 1: Identity (`@p2p-web/protocol/identity`)

Decentralized identity via WebAuthn passkeys with PRF extension support.

| Export | Description |
|--------|-------------|
| `createIdentityManager()` | Full identity lifecycle (register, authenticate, derive keys) |
| `inspectPasskeyPrf()` | Diagnose what a provider does with the PRF extension |
| `generateRecoveryCode()` | 128-bit written-down alternative to a PRF secret |
| `createP256Provider()` | ECDSA P-256 crypto provider (swappable) |
| `publicKeyToDid()` | Format public key as `did:key` |
| `deriveKeyPair()` | HKDF key derivation from PRF output |
| `issueUCAN()` / `verifyUCAN()` | Capability tokens (UCAN 0.10, `ES256` JWTs) |
| `delegateCapabilities()` | Attenuated delegation from a parent token |
| `validateDelegationChain()` | Verify a full root → … → leaf proof chain |

Key derivation is deterministic: a seed (passkey PRF output, or a password via
PBKDF2) is stretched with HKDF and mapped onto a P-256 scalar, whose public point
is computed directly — so the same seed always yields the same DID, and anything
that DID signs verifies for anyone holding only the DID.

#### PRF support

The identity key is derived from the passkey's PRF (`hmac-secret`) output, so a
passkey without PRF cannot anchor an identity. Two things make this awkward in
practice, and the implementation accounts for both:

- **PRF must be requested when the credential is created.** A passkey made before
  a provider supported PRF can never produce a secret, and cannot be upgraded —
  the user has to create a new one.
- **What a provider *says* about PRF at creation is unreliable.** Several
  credential managers, including Bitwarden, return no `prf.enabled` flag (or
  return `false`) from the creation ceremony and then evaluate PRF perfectly well
  during an assertion. `register()` therefore never trusts that flag: it asks for
  the secret and only gives up if none comes back, throwing a
  `PRF_UNSUPPORTED` protocol error carrying a `hint` a UI can show.

```typescript
try {
  await identity.register('alice');
} catch (error) {
  if (isProtocolError(error, 'PRF_UNSUPPORTED')) {
    showMessage(error.message, error.hint);
  }
}
```

When it does fail, `inspectPasskeyPrf()` reports what each ceremony actually
returned — the provider's AAGUID (named for common ones), whether `prf` came back
at all, and how many bytes of secret each step produced — so the failure can be
pinned on the authenticator, the provider, or the browser instead of guessed at:

```typescript
const report = await inspectPasskeyPrf({ credentialId }); // omit to test a throwaway passkey
report.provider.name;   // 'Bitwarden'
report.prfWorks;        // false
report.summary;         // '…returned no `prf` entry at all, which usually means…'
```

When an installed credential manager takes over passkeys but has no PRF, the
ceremony can be steered back to the device's own authenticator:

```typescript
await identity.register('alice', { preferPlatform: true });  // hints: ['client-device']
```

#### Identity without PRF

Not every provider evaluates PRF, so the root key can also come from a **recovery
code**: 128 bits in Crockford base32, which the user writes down and can type on
any device to derive the same DID. It is the same strength as a PRF secret, just
held by a person instead of an authenticator.

```typescript
const code = generateRecoveryCode();            // 'K7N6-ERYP-68TZ-A7HN-VJW3-QWKN-CG'
const me = await identity.fromRecoveryCode(code);
// case, spacing and the usual O/0, I/1 slips are all forgiven on the way back in
```

A code is also an ordinary password as far as a credential manager is concerned,
so presenting it in a username/password form lets a PRF-less manager store the
identity and autofill it on return — most of passkey convenience, from a provider
that cannot do PRF. The example app does exactly this.

Passkeys are registered as discoverable credentials, so `authenticate()` can be
called with a known credential id or with none at all, letting the user pick any
passkey for the origin:

```typescript
const identity = createIdentityManager({ rpName: 'My App' });

const me = await identity.register('alice');   // mints the passkey and the DID
me.credentialId;                                // persist this for a one-tap return

const again = await identity.authenticate(me.credentialId);
again.did === me.did;                           // true — the PRF seed is stable
```

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

### Phase 2: Schema (`@p2p-web/protocol/schema`)

Typed, signed data expressions using [Standard Schema](https://standardschema.dev/).

| Export | Description |
|--------|-------------|
| `createSchemaEngine()` | Register collections with Standard Schema validators |
| `createSigner()` | Sign and verify expressions (JWS-style) |
| `createExpression()` | Build unsigned expressions (optionally carrying a UCAN `proof`) |
| `canonicalize()` | Deterministic JSON serialization |

### Phase 3: Storage (`@p2p-web/protocol/storage`)

Local-first storage with Merkle Search Tree for efficient sync.

| Export | Description |
|--------|-------------|
| `createStorageProvider()` | MST-backed expression storage |
| `createIndexedDBAdapter()` | IndexedDB storage adapter |
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

### Phase 4: Network (`@p2p-web/protocol/network`)

Browser-to-browser communication via WebRTC.

| Export | Description |
|--------|-------------|
| `createNetworkManager()` | Full P2P networking (signaling + RTC + discovery) |
| `createSignalingClient()` | WebSocket signaling for ICE/SDP exchange |
| `createRTCTransport()` | WebRTC data channel management |

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

### Phase 5: Sync (`@p2p-web/protocol/sync`)

Anti-entropy gossip protocol for eventual consistency.

| Export | Description |
|--------|-------------|
| `createSyncEngine()` | Automatic MST reconciliation with heartbeat |
| `compareRoots()` | Quick root CID comparison |
| `findMissingExpressions()` | Identify missing data |

The engine's `validate` hook is the seam where the validation engine sits.
Expressions a peer sends are only committed if it accepts them; the rest are
dropped and surface as a `rejected` event with the reason.

### Phase 6: Validation (`@p2p-web/protocol/validation`)

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

### Phase 7: Privacy (`@p2p-web/protocol/privacy`)

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

**Planned**: SQLite WASM adapter (via OPFS) for complex queries and better performance. Aligns with Turso/libsql direction.

### Data folders — storage that outlives the origin

Every in-browser store is keyed by origin. IndexedDB, localStorage, Cache API and OPFS (the name is the spec: *Origin Private* File System) all partition by it, so two deployments of one app on two domains can never read each other's data, and a passkey — bound to an RP ID, which is a domain — derives a different identity on each. Two views of the same app become two unrelated accounts.

A directory handle is the exception. Each origin asks for permission once, and both end up looking at the same files:

```
<folder>/
  p2p-account.json          the seed, encrypted once per way of unlocking it
  README.txt
  stores/<namespace>/
    kv/<key>                MST nodes, the root pointer, space records (sealed)
    expressions/<cid>.json  one signed record per file
```

```typescript
import {
  pickDataFolder, readFolderVault, unwrapSeedWithPasskey, deriveVaultKey,
  createFolderAdapter, createEncryptedAdapter, reconcileFolder,
  createIdentityManager, createStorageProvider,
} from '@p2p-web/protocol';

const folder = await pickDataFolder();                 // needs a user gesture
const { vault } = await readFolderVault(folder);       // locked; no seed yet

const seed = await unwrapSeedWithPasskey(wrap, prfOutput);
const identity = await createIdentityManager().fromSeed(seed);

const adapter = await createFolderAdapter(folder, `spaces/${spaceId}`);
const storage = createStorageProvider(adapter);
await reconcileFolder(storage, adapter);               // pick up other writers

// The registry is sealed under a key only an unlocked folder can derive.
const registry = createEncryptedAdapter(
  await createFolderAdapter(folder, 'account/spaces'),
  await deriveVaultKey(seed),
);
```

**Expressions are the truth; the MST is an index over them.** That inversion is what lets several writers share one folder without taking a lock. Every expression file is named by its own content hash, so concurrent writers can only ever add files that agree; the single mutable thing, the root pointer, is derived state that either side can rebuild. `reconcileFolder()` rebuilds it — call it on an interval, on window focus, or after a sync round, since the web has no filesystem change notification.

Two consequences worth having:

- **The folder is the account.** Copy it to a USB stick and it is your whole identity. Put it in iCloud, Dropbox or Syncthing and several devices converge with no relay at all — the folder becomes a second transport alongside WebRTC, and both meet in the same anti-entropy merge.
- **It changes nothing about the mesh.** A folder-backed node is an ordinary peer that happens to be durable and readable by several origins — an availability role, never an authority one. Where there is no folder (Safari, Firefox, mobile) a node keeps an origin-scoped replica and gossips exactly as before.

### Locking the folder

A folder whose account file held the seed in the clear would be a bearer token — copying it would be enough to become its owner, and the AES key for every private space sits in the same directory as the ciphertext it opens. So the seed is never stored. `p2p-account.json` holds **wrapped copies** of it, one per way of unlocking:

```
account seed (16 bytes, never written in the clear)
  ├── HKDF → vault key ──encrypts──> space keys and space records at rest
  └── stored only as wraps:
        device      a random local key, gated by any passkey (one per origin)
        passphrase  PBKDF2-SHA256 → AES-GCM
```

A shortcut is a random key kept in one origin's storage, with a passkey as the gate in front of it — **not** derived from the passkey, because only the PRF extension can yield a passkey's secret and several popular providers store passkeys without it. So every provider works, and each origin adds a shortcut of its own:

```typescript
const deviceKey = await createDeviceKey();                 // non-extractable, local
const wrap = await wrapSeedWithDeviceKey(seed, deviceKey, { rpId, credentialId });
await writeFolderVault(folder, withWrap(vault, wrap));
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

It exercises the stack end to end: sign in with a passkey (or a recovery code),
make private, public, personal and shared lists, and share one with a friend via
an invite link. Every todo is an Expression signed by a delegated session key,
stored in that space's MST, encrypted first if the space is private, and gossiped
to peers over WebRTC. Each item shows 🔐 once its signature *and* its delegation
chain verify locally, and 🔑 when it arrived encrypted.

## Tests

```bash
npm test
```

Covers spaces, invites and encrypt-then-sign; UCAN issuing, verification,
attenuation and chain validation; the curve
arithmetic behind key derivation, cross-checked against the public keys Web
Crypto generates for the same private scalars; the validation gates; and two
peers reconciling over the anti-entropy protocol, including the forged, stolen,
unauthorized and malformed expressions their gatekeepers reject.

## License

MIT
