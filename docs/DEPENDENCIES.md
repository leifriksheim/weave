# Dependencies

The protocol used to promise zero dependencies. That was the wrong rule: it
meant hand-writing elliptic-curve arithmetic, which is the one kind of code
where a subtle bug is silent and catastrophic.

The rule now:

> **Use a library when the problem is hard, already solved, and easy to get
> subtly wrong — and only a library that is very stable and very widely used.**

## The bar

A runtime dependency has to clear all of these:

1. **Solves something genuinely hard.** Cryptographic primitives, a wire
   protocol, a spec with a long tail of edge cases. Not a helper we could write
   in an afternoon.
2. **Established.** Years of releases, heavy real-world use, ideally an
   independent audit. Popular *and* boring.
3. **Small and self-contained.** Zero or near-zero transitive dependencies. No
   native addons in anything the browser or the compiled daemon loads.
4. **Isomorphic.** Works in browsers, Node and Bun without shims.
5. **Not mid-rewrite.** A library whose spec or major version is in flux fails
   this even if everything else is fine.

If a candidate fails any of these, write the code — and test it against the
real thing where one exists (see `tests/identity.test.ts`, which checks our
curve output against Web Crypto's).

## What we use

| Package | Where | Why it clears the bar |
|---|---|---|
| `@noble/curves` | `src/identity/crypto-p256.ts` | Audited, dependency-free apart from `@noble/hashes`, used by viem and ethers. Turns a seed into a P-256 key (FIPS 186-5 A.2) and compresses/decompresses points; replaced hand-written curve arithmetic and a home-grown seed-to-scalar mapping. |
| `@scure/base` | `src/identity/did.ts` | Same author and audit as noble, no dependencies. Base58btc for `did:key`; replaced a hand-written codec. |
| `@cfworker/json-schema` | `src/schema/collection-def.ts` | No dependencies, interprets schemas rather than compiling them (so it runs under a strict CSP and in extensions), and handles JSON Schema's long tail of edge cases. Validates the collection definitions a space stores. |
| `aws4fetch` | `src/storage/blob/s3.ts` | Tiny, no dependencies, `fetch` and `crypto.subtle` only, widely used against R2 and B2. Signs S3 requests (SigV4), whose canonical-request, encoding and header rules differ in small ways between providers — the kind of code not to hand-write. |

Development only: `bumpp`, which releases both packages under one version (`npm run release`), `typescript`, `tsx`, `ws` — a real WebSocket server for `tests/ws-transport.test.ts`, since Node has a WebSocket client but no server — and `zod`, to test that a validator's schema can define a collection (`tests/schemas.test.ts`). The protocol itself only reads the Standard JSON Schema interface, so it works with any library that implements it and needs none of them.

The CLI (`cli/`, a separate package) has one runtime dependency:

| Package | Where | Why it clears the bar |
|---|---|---|
| `ws` | `cli/src/serve.ts` | The standard WebSocket server for Node for over a decade, no dependencies, and runs unchanged under Bun — so the node serves browsers without a hand-written protocol implementation. |

A host's pay page (BLOCK-23) is the one place a large library is allowed,
because it runs on the host's own address and never next to a key:

| Package | Where | Why it's allowed there |
|---|---|---|
| `@reown/appkit` (dev dependency of `cli/`) | `cli/pay/walletconnect.ts`, bundled into `cli/pay/dist/walletconnect.js` | The WalletConnect team's own library: the only practical way to reach phone and desktop wallet apps. It brings ~250 packages, which fails the bar for the protocol and would be a risk in the account home, where the seed is. On the pay page it can reach no key, only the payment the person approves in their wallet. Loaded only when a host has a WalletConnect project id, and only when someone picks "another wallet". Browser wallets don't need it (EIP-6963, by hand). |

## Decided, not yet needed

| Package | For | Instead of |
|---|---|---|
| `ws` for `server/signaling-server.mjs` | Only if the standalone relay outlives `weave run`, which now serves a relay too | Speaking the WebSocket protocol by hand |
| `node-datachannel` | WebRTC on a headless node, only if measurement says WSS is not enough | — |

## Considered and declined

| Area | Decision | Why |
|---|---|---|
| Merkle Search Tree | Keep ours (`src/storage/mst.ts`) | No standalone, widely used MST library exists. The closest, `@atproto/repo`, is bound to the AT Protocol's data model. Ours is covered by order-independence and inverse-delete tests. |
| UCAN | Keep ours (`src/identity/ucan.ts`, UCAN 0.10) | The official libraries are migrating to UCAN 1.0 with a different envelope — the opposite of stable. Revisit when that settles. |
| Browser WebRTC wrappers (`simple-peer` etc.) | Use the native API | Thinly maintained; they would add risk, not remove it. Connection stability comes from negotiation patterns and TURN, not a wrapper. |
| `@modelcontextprotocol/sdk` | Hand-written stdio server (`cli/src/mcp.ts`) | Only stdio and tools are needed — four JSON-RPC methods. The SDK brings an HTTP stack and a schema library, and changes often. Revisit for HTTP transport or resources. |

## Keeping the list honest

Any new entry goes in this file with the reason it clears the bar. If you cannot
fill in that column, it does not go in.
