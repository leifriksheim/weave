# @weaveprotocol/core

A peer-to-peer data protocol for the browser. You own your identity as a
written-down code, keep your data in signed records that sync directly between
devices, and every app is a view onto that data rather than its owner.

> **Building an app?** Short guides — sign-in, collections and rules,
> queries, screens, agents — are in [packages/core/docs](packages/core/docs/README.md),
> and ship in the package as `node_modules/@weaveprotocol/core/docs/`, so a
> coding agent finds the ones that match the installed version.
>
> **Building a client, or an agent that needs the architecture?** The
> protocol is specified in [spec](spec/README.md): wire formats,
> what is signed, and what every peer must check. The tests are its
> executable half.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Applications                          │
├──────────────┬───────────┬────────────┬──────────┬───────────┤
│   Accounts   │  Spaces   │ Validation │ Privacy  │   Sync    │
│ seed, vault, │ roles,    │ crypto →   │ AES-GCM  │ Negentropy│
│ root signer, │ members × │ structural │ per      │ per       │
│ UCAN, pairing│ pub/priv  │ → UCAN     │ space    │ collection│
├──────────────┴───────────┴────────────┴──────────┴───────────┤
│    Storage: signed versions + plain index over an adapter    │
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
  widely used library instead of our own. See [CLAUDE.md](CLAUDE.md#dependencies).
- **Isomorphic.** Runs in browsers, Node and Bun via `globalThis`.
- **Functional.** Plain functions and frozen data, no class hierarchies.
- **Standard Schema.** Bring your own validator (Zod, Valibot, ArkType, …).

## Quick Start

```typescript
import {
  generateSeed,
  seedToRecoveryCode,
  createIdentityManager,
  createLocalRootSigner,
  publicKeyToDid,
  P256_MULTICODEC,
  createSigner,
  createExpression,
  createIndexedDBAdapter,
  createStorageProvider,
  createSpaceManager,
} from '@weaveprotocol/core';

// 1. An account is a 16-byte seed. Show the code once; the user keeps it.
const seed = generateSeed();
console.log(seedToRecoveryCode(seed)); // 'K7N6-ERYP-68TZ-A7HN-VJW3-QWKN-CG'

const manager = createIdentityManager();
const me = await manager.fromSeed(seed); // same seed → same DID, anywhere
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

// 4. A signed record, stored in that space's own store
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

That is the protocol by hand. Most apps never do it: `createNode` wires an
identity, its spaces, validation, encryption and sync into one object, and its
API is plain data in and out:

```typescript
import {
  createNode,
  createIdentityManager,
  createLocalRootSigner,
  indexedDBStores,
  rolePresets,
} from '@weaveprotocol/core';

const manager = createIdentityManager();
const me = await manager.fromRecoveryCode(code);

const node = await createNode({
  signer: createLocalRootSigner(me, manager.getProvider()), // or anything that signs
  stores: indexedDBStores('my-app'), // or folderStores(directory, …)
  network: { relays: ['wss://relay.example'] },
});

const space = await node.spaces.create({ name: 'Groceries', visibility: 'private', ...rolePresets.team });
const milk = await node.records.put(space.id, 'app.todo.item', { text: 'milk', done: false });
await node.records.update(space.id, milk.key, { text: 'milk', done: true }); // same key, next version
node.subscribe((event) => {
  if (event.type === 'records') redraw();
});

const invite = await node.spaces.invite(space.id); // a friend calls node.spaces.join(invite) — and joins as an Editor
const view = await node.spaces.invite(space.id, { write: false }); // they can read, not change
await node.spaces.closeInvite(space.id, invite); // nobody else joins with that link
```

## Where everything is described

| Topic                                                                              | Library (how to call it)                                                                                                                                                         | Protocol (what peers agree on)                                                           |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| The node: records and versions, live messages, holding spaces, actions             | [node](packages/core/docs/node.md), [records and queries](packages/core/docs/records-and-queries.md), [actions](packages/core/docs/actions.md)                                   | [02 Records](spec/02-records.md), [06 Nodes and sessions](spec/06-nodes-and-sessions.md) |
| Signing in, `<weave-auth>`, React hooks                                            | [building an app](packages/core/docs/building-an-app.md), [sign-in](packages/core/docs/sign-in.md)                                                                               | [01 Identity](spec/01-identity.md)                                                       |
| The account home, app grants, keepers, topic tags, notifications                   | [building an app](packages/core/docs/building-an-app.md), [node](packages/core/docs/node.md), [apps/home](apps/home/README.md)                                                   | [06 Nodes and sessions](spec/06-nodes-and-sessions.md), [03 Spaces](spec/03-spaces.md)   |
| Identity: the seed, recovery code, wraps, passkeys, UCAN, root signers             | [sign-in](packages/core/docs/sign-in.md), [node](packages/core/docs/node.md#root-signers-and-notes)                                                                              | [01 Identity](spec/01-identity.md)                                                       |
| Spaces: roles, who may write, invites, key changes, profiles, the account registry | [spaces](packages/core/docs/spaces.md)                                                                                                                                           | [03 Spaces](spec/03-spaces.md)                                                           |
| Collections, schemas, rules and checks, links, queries, the standard library       | [collections](packages/core/docs/collections.md), [query format](packages/core/docs/query-format.md), [standard library](packages/core/docs/standard-library.md)                 | [02 Records](spec/02-records.md)                                                         |
| Calls, contacts, doors, direct messages                                            | [calls](packages/core/docs/calls.md), [contacts](packages/core/docs/contacts.md), [doors](packages/core/docs/doors.md), [direct messages](packages/core/docs/direct-messages.md) | [07 Doors](spec/07-doors.md), [04 Network](spec/04-network.md)                           |
| Network: the relay, TURN, meeting peers, introductions, pairing a phone            | [node](packages/core/docs/node.md#the-network), [packages/relay](packages/relay/README.md)                                                                                       | [04 Network](spec/04-network.md)                                                         |
| Sync, storage adapters, data folders and locking them, mirrors                     | [storage](packages/core/docs/storage.md)                                                                                                                                         | [05 Sync and storage](spec/05-sync-and-storage.md)                                       |
| The CLI, the always-on node, hosting, agents and MCP                               | [packages/cli](packages/cli/README.md), [agents](packages/core/docs/agents.md)                                                                                                   | [06 Nodes and sessions](spec/06-nodes-and-sessions.md)                                   |
| The example app, Liquid and mini apps                                              | [apps/example](apps/example/README.md)                                                                                                                                           | —                                                                                        |
| Planned work                                                                       | [docs](packages/core/docs/README.md#planned-in-the-library)                                                                                                                      | [spec](spec/README.md)                                                                   |

## Running it locally

```bash
npm install     # one install for the whole workspace: core, CLI, relay and the apps
npm run dev
```

That starts everything, with coloured output per part, and Ctrl-C stops it all:

| Part   | Where                 | What                                                                                                                         |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| app    | http://localhost:5173 | The example app                                                                                                              |
| liquid | http://localhost:5190 | Liquid, a standalone app for one job: liquid democracy                                                                       |
| home   | http://localhost:5174 | The account home it connects to                                                                                              |
| node   | port 8787             | An always-on node that is also the relay; a throwaway identity on first run (`packages/cli/.env.dev`, data in `.weave-dev/`) |
| host   | http://localhost:8788 | `weave host`, what "Keep my spaces online" uses and what spaces chip in for; settings in `packages/cli/.env.host.dev`        |
| stripe | —                     | Only when you add a Stripe test key: forwards Stripe's webhooks to the host                                                  |

`npm run signal` runs the relay alone. Trying it all out, payments included,
is in [apps/example](apps/example/README.md).

## Repository layout

One npm workspace, installed once at the root (`npm install`):

| Folder           | Package                           |                                                                             |
| ---------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `packages/core`  | `@weaveprotocol/core` (published) | The protocol library, and its tests                                         |
| `packages/cli`   | `@weaveprotocol/cli` (published)  | `weave`: the always-on node, hosting, agents, MCP                           |
| `packages/relay` | `@weaveprotocol/relay` (private)  | The signaling relay and its mailbox, run alone on Fly and inside every node |
| `apps/home`      | —                                 | The account home                                                            |
| `apps/example`   | —                                 | The website and the example app                                             |
| `apps/liquid`    | —                                 | Liquid, a standalone example app: liquid democracy                          |
| `apps/extension` | —                                 | The Chrome extension                                                        |
| `apps/shared`    | `@weave/app-shared` (private)     | Styles, relay settings and components the home and the website share        |
| `spec`           | —                                 | The protocol specification                                                  |

Everything imports the protocol by name, `@weaveprotocol/core`, and only
through what it exports. Inside the workspace, the `@weaveprotocol/source`
export condition resolves those imports to `packages/core/src`, so the apps,
the CLI and the tests run on the source with no build step; published copies
use `dist`. The CLI bundles the protocol and the relay into one file, so
`npx @weaveprotocol/cli` and the single-file binaries need nothing else.

## Releasing

`@weaveprotocol/core` (`packages/core/`) and `@weaveprotocol/cli`
(`packages/cli/`) are released together, always with the same version:

```bash
npm run release
```

It checks you're logged in to npm first (and runs `npm login` if not),
typechecks and runs the tests, then [bumpp](https://github.com/antfu-collective/bumpp)
asks for the next version, writes it to both packages, and commits and tags
it (`v0.1.2`), locally. Both are published (each builds itself first: `dist/`
for the core, one bundled file for the CLI), and only then are the commit and
tag pushed.

If a release stops partway — npm login, a one-time password, the network —
fix it and run `npm run release` again. It sees the version isn't fully on npm
yet and publishes what's missing, instead of bumping again. `npm run release
-- --dry-run` does everything but publish and push. The script is
`scripts/release.mjs`; bumpp's settings are in `bump.config.ts`.

## Tests

```bash
npm test        # every workspace: core's tests, then the CLI's
npm run typecheck
```

Covers key derivation — checked against the public keys Web Crypto generates
for the same private scalars, and pinned to recorded DIDs so an accidental
change cannot slip through; recovery codes; account vaults, wraps and account
stores; data folders with several writers; spaces, invites and
encrypt-then-sign; UCAN issuing, attenuation and chain validation; phone
pairing; peer introductions; Negentropy, checked against the reference
implementation; the validation gates; and two peers reconciling, including the forged, stolen,
unauthorized and malformed expressions their gatekeepers reject. Above those:
the node API — versioned records, links, queries, collection definitions,
profiles, the account registry, moving and merging accounts — and the CLI.

## License

MIT
