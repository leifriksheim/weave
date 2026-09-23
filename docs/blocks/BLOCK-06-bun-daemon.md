# BLOCK-06 — Your data daemon, as a single binary

> **Under review.** Before building this, decide whether the first always-on
> node should be a daemon, a CLI, or a consumer app — and what shared API all
> three (plus agents over WebMCP) would sit on. That decision may reshape this
> block. The mechanics below (transport, SQLite, compile targets) hold either way.

**Framing:** this is *your* node — the durable home for your own data, which
every device and app syncs with. It is an **anchor, not a host**: it adds
availability, never authority. Any peer can do anything it does; it is just
always there.

## What this delivers

One executable that holds a persistent DID, keeps an MST warm, and gossips 24/7.
Drop it on a cheap VPS or a Raspberry Pi and the mesh gains the one thing a
browser-only network cannot have: **durability**.

Right now two peers who are never online at the same time never converge. One
always-on node makes the whole mesh eventually consistent for real — and it's
still not a server. It has no special authority, just uptime.

---

## Before you start

Paste this. It tells you which of two paths you're on.

```bash
( cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit
  command -v bun >/dev/null 2>&1 || { echo "NOT READY — install bun: curl -fsSL https://bun.sh/install | bash"; exit; }
  npx tsc --noEmit >/dev/null 2>&1 || { echo "NOT READY — project does not typecheck"; exit; }
  test -f src/network/transport.ts \
    && echo "READY — transport seam already exists (BLOCK-05 done), skip Step 0" \
    || echo "READY — do Step 0 first, the transport refactor is included in this document" )
```

**You do not need BLOCK-05 finished.** The part of it this block depends on is
about thirty lines and is written out in Step 0. If you later do BLOCK-05
properly, it supersedes Step 0 cleanly — same seam, more polish.

---

## What's already proven

Spike C compiled the protocol core and ran it. Don't re-litigate these:

| | |
|---|---|
| Protocol core in a compiled binary | **11/11 checks pass** |
| P-256, HKDF, PBKDF2, AES-GCM, SHA-256, UCAN | all work under Bun |
| Identity from a recovery code, headless | works |
| `bun:sqlite` inside a compiled binary | works |
| Cross-compile `linux-x64` / `linux-arm64` | works (97 MB / 92 MB) |
| Browser-only modules (`indexeddb-adapter`, `rtc-transport`) | bundle fine, just never called |
| Native build time | ~190 ms |

**One landmine, already found:** `--bytecode` emits CommonJS and **rejects
top-level `await`**. Wrap the entry point in `async function main()` and call it.
Verified: fails without the wrapper, works with it.

---

## Step 0 — The transport seam (skip if `src/network/transport.ts` exists)

`createNetworkManager` in `src/network/network-manager.ts` hardcodes its transport:

```ts
const rtcTransport = createRTCTransport({ iceServers: config.iceServers });
```

Everything below that line is transport-agnostic already. Make it injectable:

1. Create `src/network/transport.ts`:

```ts
/** What the network manager needs from any way of moving bytes between peers. */
export interface PeerTransport {
  readonly send: (peerId: string, data: Uint8Array) => void;
  readonly close: (peerId: string) => void;
  readonly closeAll: () => void;
  readonly on: <K extends keyof PeerTransportEvents>(e: K, cb: PeerTransportEvents[K]) => void;
  readonly off: <K extends keyof PeerTransportEvents>(e: K, cb: PeerTransportEvents[K]) => void;
}

export type PeerTransportEvents = {
  data: (peerId: string, data: Uint8Array) => void;
  connected: (peerId: string) => void;
  disconnected: (peerId: string) => void;
  error: (peerId: string, error: Error) => void;
};
```

2. Add to `NetworkManagerConfig`:

```ts
readonly createTransport?: () => PeerTransport;
// signalingUrls: required only for the WebRTC path
```

3. Use it, defaulting to today's behaviour:

```ts
const transport = config.createTransport?.() ?? createRTCTransport({ iceServers: config.iceServers });
```

4. Only wire the signaling handlers when the transport is a WebRTC one
   (`'createOffer' in transport`) and relays are configured. Introductions are
   WebRTC-only too.

**Verify the example app still works before continuing.** Omitting
`createTransport` must be a no-op.

---

## Design

### What the daemon is

A peer with uptime. It holds a DID derived from a recovery code, joins the spaces
it's configured for, validates everything that arrives, and stores it. It has no
authority the protocol recognises.

### Storage tiers

`bun:sqlite` is the hot tier — compiled into the binary, no native module to ship.

If BLOCK-03 is done, wrap it in a `PackedAdapter` so durable data goes to the
operator's own blob store and the box becomes disposable. If not, SQLite on local
disk is a perfectly good v1. **Design the config so this is a one-line switch**,
because "the node holds nothing" is the whole hosting pitch.

### Transport: WebSocket, not WebRTC

Bun has no `RTCPeerConnection`. Rather than binding a native addon (awkward with
`--compile`, kills cross-compilation), the daemon speaks WSS and browsers connect
to it with their native `WebSocket`. Browser↔browser stays WebRTC.

This also sidesteps TURN for peer↔node traffic, which is the actual bandwidth
cost in a hosted deployment.

### One process, both jobs

`Bun.serve()` carries the signaling relay (port the logic from
`server/signaling-server.mjs`, which is already dependency-free) **and** the WSS
peer endpoint. A self-hoster runs one binary to bootstrap an entire space.

---

## Files

| File | Change |
|---|---|
| `daemon/main.ts` | **New.** Entry point — must be `async function main()` |
| `daemon/config.ts` | **New.** Env + file config, validated on boot |
| `daemon/sqlite-adapter.ts` | **New.** `StorageAdapter` over `bun:sqlite` |
| `daemon/ws-server.ts` | **New.** `Bun.serve` — signaling relay + peer endpoint |
| `daemon/ws-peer-transport.ts` | **New.** `PeerTransport` over inbound sockets |
| `daemon/build.ts` | **New.** Compile script |
| `daemon/p2p-node.service` | **New.** systemd unit |
| `daemon/README.md` | **New.** How to run it |
| `src/network/transport.ts` | Step 0, if absent |
| `src/network/network-manager.ts` | Step 0, if absent |

A working SQLite adapter was already written and verified during Spike C — the
shape is a straight mapping of the 11 `StorageAdapter` methods onto two tables
(`kv(key, val)` and `expr(id, collection, json)`), with `db.transaction()` for
`batch`. It round-tripped through `createStorageProvider` in a compiled binary.

### Config

```ts
export interface DaemonConfig {
  readonly recoveryCode: string;        // P2P_RECOVERY_CODE — the node's identity
  readonly port: number;                // default 8787
  readonly dataDir: string;             // default ./data
  readonly spaces: ReadonlyArray<string>;
  readonly publicUrl?: string;          // wss://… advertised to peers
  readonly blobStore?: { kind: 's3' | 'drive' | 'fs'; /* … */ };  // BLOCK-03/04
}
```

Fail loudly on boot if `recoveryCode` is missing. A node that silently generates
a fresh identity on restart loses its peers and is maddening to debug.

---

## Steps

1. Step 0, if needed. Verify the example app is unaffected.
2. `daemon/sqlite-adapter.ts` + a test that runs the existing storage-provider
   assertions against it.
3. `daemon/config.ts`. Validate everything up front.
4. `daemon/main.ts`: load config → derive identity from the recovery code →
   open storage → build the validation engine → start the sync engine. Log the
   DID on boot.
5. `daemon/ws-server.ts`: `Bun.serve` with the signaling relay on one path and
   the peer endpoint on another. Keep `/health` from the existing relay.
6. `daemon/ws-peer-transport.ts`: adapt inbound sockets to `PeerTransport`.
7. `daemon/build.ts`: compile native + both Linux targets.
8. Run the acceptance test below. It's the whole point of the block.

---

## Testing

- SQLite adapter passes the same assertions as the memory adapter
- Daemon boots, derives a stable DID from a fixed recovery code, and **the same
  code yields the same DID across restarts**
- A browser connects over WSS and syncs
- Daemon restarts and still holds its data
- Malformed frames don't crash it
- SIGTERM shuts down cleanly (and flushes, if using `PackedAdapter`)

### Acceptance test — the one that matters

Two browser peers that are **never online at the same time** converge through the
daemon:

1. Browser A connects, writes 10 todos, disconnects
2. Daemon holds them
3. Browser B connects (A is gone), receives all 10
4. B writes 5 more, disconnects
5. A reconnects and receives B's 5

If that works, the product thesis is real.

---

## Acceptance criteria

- [ ] `bun build --compile` produces a working binary
- [ ] Cross-compiles to `linux-x64` and `linux-arm64`
- [ ] `--bytecode` build succeeds (entry wrapped in `main()`)
- [ ] Stable DID across restarts from a fixed recovery code
- [ ] Data survives restart
- [ ] **Two never-simultaneous browsers converge through it**
- [ ] Runs under systemd, restarts on failure
- [ ] Binary is one file with no runtime dependencies (`ldd` shows only libc)
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

- **Multi-tenancy, OAuth brokering, per-tenant credentials** — BLOCK-07.
- **Native WebRTC on the node.** If browsers turn out to need it,
  `node-datachannel` drops into the same transport seam. Measure first.
- **TURN.** Decide after measuring how many browsers fail to reach the node
  directly over WSS. It may be none.

---

## Gotchas

- **`--bytecode` + top-level `await` fails.** Wrap in `main()`. Already verified.
- **`--minify` does not strip the ELF.** Linux builds land around 97 MB. `strip`
  them if it matters.
- **Cross-compiling downloads a Bun runtime per target** on first use. First
  build is slow and needs network; don't debug it as a hang.
- **The node needs a recovery code, and that code *is* the identity.** Treat it
  as a secret: env var or mode-600 file, never a CLI argument (visible in `ps`),
  never logged.
- **`bun:sqlite` returns `Buffer` for BLOB columns.** It's a `Uint8Array`
  subclass and mostly transparent, but normalize on the way out — the MST hashes
  bytes, and anything that serializes differently breaks CIDs.
- **Validate everything from peers.** `SyncEngineConfig.validate` is optional and
  a daemon without it accepts whatever it's sent. Wire the full `ValidationEngine`
  — this box is reachable from the open internet, unlike a browser tab.
- **Without space keys the node stores ciphertext it can't read.** That's correct
  and desirable — it's what makes the hosted tier zero-knowledge. Don't
  "fix" it by requiring keys.
