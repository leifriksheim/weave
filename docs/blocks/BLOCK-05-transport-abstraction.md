# BLOCK-05 — Pluggable transport, and a WebSocket one

## What this delivers

`createNetworkManager` stops hard-wiring WebRTC and takes a transport factory
instead. Browser behaviour is unchanged. What you gain: a WebSocket transport, an
in-process fake transport for tests, and the ability for a headless node to join
the mesh at all.

Worth doing on its own merits even if the daemon never happens — it's what makes
the mesh testable without a browser.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'createRTCTransport' src/network/network-manager.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — network-manager.ts is not in its expected shape, or the project does not typecheck"
```

**Depends on no other block.** Free to start.

---

## Background

`createNetworkManager` in `src/network/network-manager.ts` constructs its
transport internally, and refuses to start without a relay:

```ts
export function createNetworkManager(config: NetworkManagerConfig): NetworkManager {
  const relays = config.signalingUrls ?? (config.signalingUrl ? [config.signalingUrl] : []);
  if (relays.length === 0) throw new Error('A network manager needs at least one relay to bootstrap from.');

  const signaling = createMultiSignalingClient(relays, config.did);
  const rtcTransport = createRTCTransport({ iceServers: config.iceServers });   // ← hardcoded
  const discovery = createPeerDiscovery();
  const introduce = config.introductions !== false;
```

Everything below that is transport-agnostic in spirit — the manager wires
signaling events to the transport, the transport's `data` events to message
parsing, and connect/disconnect to peer discovery. Two WebRTC-specific things
now live below it as well: **peer introductions** (`__peers` / `__signal`
control messages over existing data channels, which carry WebRTC offers for
peers not yet met) and the relay requirement. Both belong to the signalled path
only.

Meanwhile `SyncEngine` already proves the layering is right. It takes
`sendToPeer` as a plain callback and exposes `handleMessage(peerId, data)`:

```ts
export interface SyncEngineConfig {
  readonly storageProvider: StorageProvider;
  readonly sendToPeer: (peerId: string, data: Uint8Array) => void;
  ...
}
```

It has no idea what a transport is. That's the seam to widen.

### Why a WebSocket transport is worth having

Bun has no `RTCPeerConnection`, so a headless node either binds native WebRTC
(`node-datachannel` — a native addon, awkward with `--compile`, kills
cross-compilation) or speaks something else.

Browsers have a native `WebSocket`. An always-on node with a DNS name and a TLS
cert can accept direct WSS connections from browsers. Browser↔browser stays
WebRTC; browser↔node becomes WSS. No native dependencies, and the binary still
cross-compiles.

**This also removes most of the need for TURN**, which is the actual bandwidth
cost in a hosted deployment — relayed traffic is the line item that scales with
users. Peers that can't hole-punch to each other can still both reach the node.

---

## Design

Extract the shape `createRTCTransport` already satisfies:

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

`RTCTransport` already has all of this plus the offer/answer/candidate methods
that only make sense for WebRTC. Keep those on an extended interface:

```ts
export interface SignalledTransport extends PeerTransport {
  readonly createOffer: (peerId: string) => Promise<{ offer: RTCSessionDescriptionInit; connection: RTCPeerConnection }>;
  readonly handleOffer: (peerId: string, offer: RTCSessionDescriptionInit) => Promise<{ answer: RTCSessionDescriptionInit; connection: RTCPeerConnection }>;
  readonly handleAnswer: (peerId: string, answer: RTCSessionDescriptionInit) => Promise<void>;
  readonly addIceCandidate: (peerId: string, candidate: RTCIceCandidateInit) => Promise<void>;
}
```

The network manager wires the signaling handlers **only when the transport is
signalled**. A WebSocket transport needs no signaling at all — it just dials.

### Config

```ts
export interface NetworkManagerConfig {
  readonly did: string;
  readonly signalingUrl?: string;
  readonly signalingUrls?: ReadonlyArray<string>;  // required only for a signalled transport
  readonly introductions?: boolean;                // signalled transports only
  readonly iceServers?: ReadonlyArray<RTCIceServer>;
  /** Defaults to WebRTC over the signaling server, preserving today's behaviour. */
  readonly createTransport?: () => PeerTransport | SignalledTransport;
}
```

Omitting `createTransport` must behave **exactly** as today. This block should be
invisible to the example app.

---

## Files

| File | Change |
|---|---|
| `src/network/transport.ts` | **New.** `PeerTransport`, `SignalledTransport`, `PeerTransportEvents` |
| `src/network/network-manager.ts` | Accept `createTransport`; branch on whether it's signalled |
| `src/network/rtc-transport.ts` | Declare that it implements `SignalledTransport` — no behaviour change |
| `src/network/ws-transport.ts` | **New** |
| `src/index.ts` | Export the new types and `createWebSocketTransport` |
| `tests/helpers/fake-transport.ts` | **New.** In-process transport for tests |
| `tests/network-manager.test.ts` | **New** |

### The WebSocket transport

```ts
export interface WebSocketTransportConfig {
  readonly url: string;           // wss://node.example.com/peer
  readonly did: string;
  readonly reconnect?: boolean;   // default true
}

export function createWebSocketTransport(config: WebSocketTransportConfig): PeerTransport;
```

One socket to one node, which appears as a single peer. Mirror the reconnect
logic already in `src/network/signaling.ts` — it has exponential backoff with a
retry cap and a 30 s ceiling; reuse the approach rather than inventing a second one.

Set `binaryType = 'arraybuffer'` and send `Uint8Array` frames directly. No
base64, no JSON wrapper — `SyncEngine` already speaks bytes.

### The fake transport

The quietly valuable piece. Two `PeerTransport`s wired to each other in memory,
with optional latency and drop-rate injection, so the whole mesh can be tested in
one process with no browser and no sockets.

---

## Steps

1. Create `transport.ts` with the interfaces. Nothing else changes yet.
2. Annotate `createRTCTransport`'s return type as `SignalledTransport`. It
   already satisfies it — if TypeScript disagrees, the interface is wrong, not
   the implementation.
3. Add `createTransport` to `NetworkManagerConfig`, defaulting to the current
   construction. **Run the example app here** — it must behave identically.
4. Branch the signaling wiring on `'createOffer' in transport`. Skip it entirely
   for unsignalled transports — relays, introductions and all — and don't
   require `signalingUrls`.
5. Write `tests/helpers/fake-transport.ts` and `tests/network-manager.test.ts`.
6. Write `ws-transport.ts`.

Do step 3 and confirm the example still works before step 4. If something breaks
later you want to know which half did it.

---

## Testing

- The manager with no `createTransport` still constructs a WebRTC transport and
  connects to signaling (assert on the constructor being called)
- With a fake transport, two managers exchange messages end to end
- With an unsignalled transport, **no signaling client is constructed at all** and
  missing relays are not an error
- `peer-connected` / `peer-disconnected` fire correctly through both paths
- A transport error surfaces as a manager `error` event rather than throwing
- Full two-peer sync over the fake transport — reuse the setup in
  `tests/sync.test.ts`, which currently wires engines together by hand

That last one is the real prize: the sync suite currently fakes the network with
direct `handleMessage` calls. Running it through a transport tests more of the
stack.

---

## Acceptance criteria

- [ ] Example app behaves identically with no config change (manually verified)
- [ ] All 5 existing sync tests pass unmodified
- [ ] Two network managers over the fake transport complete a full sync
- [ ] An unsignalled transport needs no relay and builds no signaling client
- [ ] WebSocket transport connects to a plain `Bun.serve` echo endpoint and
      round-trips binary frames
- [ ] Reconnect works: kill the server, restart it, transport recovers
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

- **The daemon itself** — BLOCK-06. This block gives it the seam; it doesn't
  build the server side.
- **Native WebRTC in Bun.** If you later want the node to be a true WebRTC peer,
  `node-datachannel` implements `SignalledTransport` and drops into the same
  seam. That's the point of the interface.
- **TURN configuration.** Decide after BLOCK-06 measures how many browsers
  actually fail to reach the node directly.

---

## Gotchas

- **`RTCPeerConnection` appears in `NetworkManagerConfig` via `RTCIceServer`.**
  It's a type-only reference so it erases at compile time and Bun bundles it
  fine (Spike C confirmed this). Don't "fix" it by removing the type.
- **The existing `rtcTransport.on('data', ...)` handler ignores its `peerId`**
  (`_peerId`) and parses the message without attribution. When you generalise,
  keep the peer id — the sync engine's `handleMessage` wants it, and a transport
  carrying more than one peer per connection makes the current behaviour wrong.
- **WebSocket `close` fires for both clean and unclean shutdown.** Distinguish
  them, or `reconnect: true` will fight a deliberate `closeAll()` forever.
- **Don't let the fake transport deliver synchronously.** Real transports are
  async, and a synchronous fake hides reentrancy bugs. Put a `queueMicrotask`
  between send and deliver.
