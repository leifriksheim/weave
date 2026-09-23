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

Development only: `typescript`, `tsx`, and `ws` — a real WebSocket server for `tests/ws-transport.test.ts`, since Node has a WebSocket client but no server.

## Decided, not yet needed

| Package | For | Instead of |
|---|---|---|
| `aws4fetch` | S3-compatible blob driver (BLOCK-04) | Hand-writing SigV4 |
| `@cfworker/json-schema` | Stored collection definitions (BLOCK-08) | A home-grown validator. Chosen over Ajv, which generates code at runtime and breaks under a strict Content Security Policy |
| `ws` (at runtime) | The Node signaling relay, if it outlives the daemon | Speaking the WebSocket protocol by hand |
| `node-datachannel` | WebRTC on a headless node, only if measurement says WSS is not enough | — |

## Considered and declined

| Area | Decision | Why |
|---|---|---|
| Merkle Search Tree | Keep ours (`src/storage/mst.ts`) | No standalone, widely used MST library exists. The closest, `@atproto/repo`, is bound to the AT Protocol's data model. Ours is covered by order-independence and inverse-delete tests. |
| UCAN | Keep ours (`src/identity/ucan.ts`, UCAN 0.10) | The official libraries are migrating to UCAN 1.0 with a different envelope — the opposite of stable. Revisit when that settles. |
| Browser WebRTC wrappers (`simple-peer` etc.) | Use the native API | Thinly maintained; they would add risk, not remove it. Connection stability comes from negotiation patterns and TURN, not a wrapper. |

## Keeping the list honest

Any new entry goes in this file with the reason it clears the bar. If you cannot
fill in that column, it does not go in.
