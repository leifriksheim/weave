# Working on Weave

Weave is a protocol first and a library second. `spec/` says what goes over
the wire, what is stored, what is signed and what every peer must check;
`packages/core/src/` is the reference implementation, and `packages/core/docs/`
describes the library built on it. Read the part of the spec, or the page of
the docs, a change touches before changing the code.

## Layout

| Folder                                        |                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `spec/`                                       | The protocol specification, `README.md` plus parts 01–07. Normative.                          |
| `packages/core`                               | `@weaveprotocol/core`: the protocol library, its tests (`tests/*.test.ts`) and docs (`docs/`) |
| `packages/cli`                                | `@weaveprotocol/cli`: `weave`, the always-on node, hosting, agents, MCP                       |
| `packages/relay`                              | The signaling relay and its mailbox                                                           |
| `apps/home`, `apps/example`, `apps/extension` | The account home, the website and example app, the Chrome extension                           |
| `apps/liquid`                                 | Liquid, a mini app: standalone, and inside the example (`apps/shared/src/mini-app.ts`)        |
| `apps/shared`                                 | What the apps share: styles, relay settings, components, the mini app contract                |

Everything imports the protocol as `@weaveprotocol/core`, only through what it
exports. Inside the workspace the `@weaveprotocol/source` condition resolves it
to `packages/core/src`, so nothing needs building first.

## Commands

```bash
npm install          # once, at the root
npm test             # every workspace
npm run typecheck    # every workspace, and core's tests (TypeScript 7)
npm run lint         # oxlint, type-aware (.oxlintrc.json)
npm run format       # Prettier
npm run fallow       # unused files, exports and dependencies, import cycles
npm run check        # all of the above but tests, as CI runs it
npm run dev          # node, host, home and example together (scripts/dev.mjs)
# one test file, from packages/core
node --experimental-vm-modules --import tsx --test tests/sync.test.ts
```

Releasing is `npm run release`; see the README before running it.

A pre-commit hook runs oxlint and Prettier on staged files.

## Types

Every workspace extends `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`,
no unused locals, `erasableSyntaxOnly`, so no enums, namespaces or parameter
properties). oxlint bans `any` and type assertions (`as Foo`; `as const` is
fine). Narrow `unknown` with a type guard, or use `satisfies`. Where a cast
truly can't be avoided, disable the rule for that line with a reason:
`// eslint-disable-next-line <rule> -- <why>` (oxlint reads ESLint's comments
and rule names).

## The spec and the code change together

The spec is strict. It holds only what two implementations must agree on to
work together: bytes on the wire, what is stored and signed, what a peer
checks or refuses, and exchanges between two parties (an app and its account
home, a carrier, a relay). What a record body means, how the library is
called and how an app shows something are not protocol, however useful: the
standard collections (`std.*`), the query format, node actions, `std.app` and
screens are described in `packages/core/docs/` instead.

- A change to anything in the spec's scope changes the spec in the same PR.
  Where the spec and the code disagree, one of them is a bug: fix it, or open
  an issue that says which.
- A change to a standard collection, the query format, the node's interface
  or an app convention changes its page in `packages/core/docs/` instead, in
  the same PR, with a _Source:_ line and tests in the same way. Those pages
  say "must" in plain words, not RFC 2119 capitals.
- Follow the conventions in `spec/README.md`: RFC 2119 words only where they
  are meant, exact formats with an example, and a _Source:_ line naming the
  files and tests for each section.
- Work that is designed but not built is a **Planned** section in the part it
  belongs to, and is listed in the Planned table in `spec/README.md`. Something
  the implementation does that the protocol should not require is a
  `> **Known defect:**` blockquote. Both link their GitHub issue when one
  exists, and every such issue links back to the section. When the work lands,
  the Planned text becomes the specification and the note goes.
- Cite code by its full path from the repository root (`packages/core/src/...`),
  in the spec, in issues and in comments, and name the function rather than a
  line. The label registry in `spec/01-identity.md` §5 is the exception: its
  `file:line` references must be kept current when the code moves.
- Tests are the executable half of the spec. A rule a peer must check gets a
  test that shows a peer refusing the thing that breaks it.

## Issues and pull requests

Track bugs, planned work and open questions as GitHub issues (`gh issue`).
Before starting, look for an issue that covers the work. A PR links every
related issue in its description: `Fixes #N` when it closes one, `Refs #N`
when it only touches it.

## Style

Plain functions and frozen data, no class hierarchies. Isomorphic: browsers,
Node and Bun via `globalThis`, native Web APIs first. Comments and docs are
short plain sentences that say why; match the prose around you.

## Dependencies

Use a library when the problem is hard, already solved, and easy to get
subtly wrong, and only one that clears all of these:

1. **Solves something genuinely hard**: cryptographic primitives, a wire
   protocol, a spec with a long tail of edge cases. Not a helper we could
   write in an afternoon.
2. **Established**: years of releases, heavy real-world use, ideally an audit.
3. **Small and self-contained**: zero or near-zero transitive dependencies, no
   native addons in anything the browser or the compiled daemon loads.
4. **Isomorphic**: works in browsers, Node and Bun without shims.
5. **Not mid-rewrite**: a spec or major version in flux fails this.

Otherwise write the code, and test it against the real thing where one exists
(`packages/core/tests/identity.test.ts` checks our curve output against Web
Crypto's). Adding a runtime dependency means adding it to the list below, with
why it clears the bar.

What the protocol uses (`packages/core`):

- `@noble/curves` (with `@noble/hashes`), `packages/core/src/identity/crypto-p256.ts`:
  seed to P-256 key (FIPS 186-5 A.2), point compression. Audited, used by viem
  and ethers.
- `@scure/base`, `packages/core/src/identity/did.ts`: base58btc for `did:key`.
  Same author and audit as noble.
- `@cfworker/json-schema`, `packages/core/src/schema/collection-def.ts`:
  validates stored collection definitions. Interprets rather than compiles, so
  it runs under a strict CSP and in extensions.
- `aws4fetch`, `packages/core/src/storage/blob/s3.ts`: S3 SigV4 signing, whose
  rules differ in small ways between providers. `fetch` and `crypto.subtle` only.

The protocol reads validators only through the Standard JSON Schema interface,
so it needs none of Zod, Valibot or ArkType; `zod` is a dev dependency to test
that.

Elsewhere:

- `ws` in `packages/cli` and `packages/relay`: Node has a WebSocket client but
  no server.
- `node-datachannel` in `packages/cli`: WebRTC for `weave mcp` and headless
  nodes.
- `@reown/appkit`, a dev dependency of `packages/cli`, bundled into the host's
  pay page only (`packages/cli/pay/`). It brings ~250 packages, which fails the
  bar anywhere near a key; the pay page runs on the host's own address and can
  reach only the payment a person approves in their wallet. Never import it
  from `packages/core` or the apps.
