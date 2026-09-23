# BLOCK-06 — A CLI whose `run` command is the always-on node

> **Done (2026-09-23).** `cli/`. Tests: `tests/cli.test.ts`. Reshaped from "a
> daemon binary" into one CLI with three jobs, all over the Node API
> (BLOCK-13). See `cli/README.md` for use.

## What it delivers

- `p2p spaces …` / `p2p records …` — every `NODE_ACTIONS` operation, flags
  generated from each action's input schema
- `p2p run` — keeps every space open and syncing, serves the WebSocket
  transport at `/peer?space=`, the signaling relay on any other path, and
  `/health`; notices spaces added by other processes
- `p2p mcp` — the same actions as MCP tools over stdio
- `bun build.ts` — single-file executables for this machine, `linux-x64` and
  `linux-arm64`; `p2p-node.service` for systemd

The data folder has the exact layout a browser's does (`accounts.json`,
`accounts/<id>/…`), through `cli/src/fs-directory.ts`, a Node/Bun implementation
of the directory handle the folder adapter already expects.

## Verified

- **Two devices never online at the same time converge through the node** —
  automated (`tests/cli.test.ts`), and in real browsers: Alice made an encrypted
  list, the node joined via `p2p spaces join`, Alice closed her browser, Bob
  joined later and received her items from the node, and Bob's item reached the
  node.
- The compiled binary (Bun, native) runs `init`, writes an encrypted record,
  serves `/health` and shuts down cleanly on SIGTERM. The Linux cross-compiles
  were not run here; Spike C showed they work.
- The seed never appears on disk in the clear (tested).

## Decisions

- **WebSocket, not WebRTC, on the node.** Bun has no `RTCPeerConnection`, and a
  native addon would cost cross-compilation. Browsers dial the node directly.
- **`ws` for the server**, which runs unchanged under Node and Bun, rather than
  `Bun.serve` — so the node is testable in the same test runner as everything
  else. It is the CLI's one runtime dependency.
- **MCP by hand, not the SDK.** Only stdio and tools are needed: four JSON-RPC
  methods. The official SDK brings an HTTP stack and a schema library. Revisit
  when HTTP transport or resources are wanted.
- **One-shot commands are offline.** They write to the folder; a running node
  picks the change up within its poll interval and syncs it. No second process
  competing for peers.
- **Identity by recovery code or passphrase wrap**, from the environment, a
  file or a prompt — never a flag value, never a plaintext file.

## Found and fixed on the way

- **A folder adapter remembered "not here" forever.** A lookup before another
  process wrote a key cached the miss, and later listings could not reach the
  new value. Listing now clears stale misses (regression test in
  `tests/folder-adapter.test.ts`).
- **Joining a personal space relabelled it shared** for the joiner, so the
  joiner's copy kept writes the owner's rejected and they never converged. The
  type is now the same everywhere.

## Next

- Signed hello on `/peer`, so only members can pull a space.
- The account-wide registry space, so the node learns about new spaces by
  syncing rather than by being told.
- BLOCK-07 (hosting) now has a node to multiply.
