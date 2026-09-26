# 04 — Network

How peers find each other and talk: the relay and the signaling protocol
spoken with it, using several relays at once, the relays a space names for
itself, the transports (WebRTC data channels, a WebSocket to an always-on
node), the handshake that proves who is at the other end of a connection, the
mesh that shares connections between spaces, peers introducing peers, live
messages, and ICE/TURN.

What travels *inside* an authenticated connection — the sync protocol — is
in [05 — Sync and storage](05-sync-and-storage.md). Keys, DIDs and notes
(UCAN delegations) are in [01 — Identity](01-identity.md). Read keys, space
keys, roles and the access log are in [03 — Spaces](03-spaces.md). The relay
mailbox used by doors is in [07 — Doors](07-doors.md).

```
                 ┌──────────── relay (WebSocket, JSON text frames) ────────────┐
                 │  rooms: join / leave notices; offer / answer / candidate;   │
                 │  TURN passwords (ice)                                        │
                 └────────▲───────────────────────────────────────▲────────────┘
                          │ signaling                              │
   peer A ── WebRTC data channel "data" (binary frames of UTF-8 JSON) ── peer B
            │ per room: __auth-hello ×2, __auth-proof ×2, then who, sync, live, …
            │ introductions: __peers, __signal (offers for third parties)

   peer ── WebSocket  wss://node/peer?space=<id>  ── always-on node
            challenge → hello → welcome (text), then binary frames of UTF-8 JSON
```

Terms used below:

- **session DID** — the `did:key` of the session key a node signs with
  ([01 — Identity](01-identity.md)). It is a peer's identity on the wire:
  in rooms, in handshakes and in every message's `from`.
- **account DID** — the root DID behind a session, proven by the session's
  **note** (the delegation from the account to the session key).
- **room** — a name on a relay under which peers are introduced.
- **space id**, **read key**, **space key** — see [03 — Spaces](03-spaces.md).

---

## 1. The relay

A relay is a public WebSocket server that introduces peers. It holds no data
of any space, has no authority, and is trusted for nothing but liveness: a
relay that lies can at worst fail to introduce, or introduce the wrong peer —
which the peer handshake (§6) catches.

> Rationale: a relay is a phone book, not an authority. Everything a relay
> could forge (offers, names) is checked end to end by the peers.

### 1.1 Endpoint

- A relay accepts a WebSocket upgrade on **any path** (the always-on node
  reserves `/peer` for itself, §5.3, and hands every other path to its relay).
- The optional query parameter `?room=<name>` opens a **one-room socket**
  (§1.5). Without it the socket is a **multi-room socket**.
- `GET /health` answers `200` with `{"ok":true}` (`content-type:
  application/json`). It MUST NOT reveal how many rooms or peers exist.
- Any other plain HTTP request answers `426` with a text body.
- All relay messages are **text frames** carrying one JSON object each.
  Binary frames are counted against the rate budget (§1.6) and otherwise
  ignored. Text that is not a JSON object with a string `type` is ignored.
- Per-message compression is off (*implementation detail*: `perMessageDeflate:
  false`).

Before a socket is opened, the relay MAY refuse the upgrade with a plain HTTP
response and `Connection: close`:

| Status | Reason phrase | When |
|---|---|---|
| `503` | `Room full` | a one-room socket's `?room=` cannot be entered (§1.6) |
| `503` | `Relay full` | the relay holds `MAX_CONNECTIONS` sockets |
| `429` | `Too many connections` | the client address holds `MAX_CONNECTIONS_PER_IP` sockets |

The client address is the TCP peer address. *Implementation detail:* only
when the environment variable `FLY_APP_NAME` is set is the `Fly-Client-IP`
header believed instead; anywhere else a header is whatever the client says.

*Source: `server/relay.mjs` (`upgrade`, `clientIp`), `server/signaling-server.mjs`, `cli/src/serve.ts` (`serve`). Tests: `tests/cli.test.ts` ("answers /health…", "is a relay too…"), `tests/network-manager.test.ts` ("the mesh, through real relays").*

### 1.2 One name per socket

A socket is nameless until its first accepted `join`. That `join`'s `from`
fixes the socket's DID for the life of the socket.

- A DID is accepted if it is a string of at most 256 characters matching
  `^did:key:z[1-9A-HJ-NP-Za-km-z]+$` (a base58btc multibase `did:key`). The
  relay does not check that it decodes to a key.
- Every later `join` on that socket MUST carry the same `from`; one that does
  not is ignored.
- Everything the relay forwards carries `from` = the socket's DID, whatever
  the sender wrote. A peer cannot speak for someone else.
- **The first socket to hold a DID in a room keeps it.** A `join` naming a
  room in which *another* socket already holds the same DID makes the relay
  close the joining socket with WebSocket close code **`4009`** (reason
  `DID already in room`). The whole socket is closed, not just that join.

> Rationale: taking over a DID would let anyone who learns it receive the
> offers meant for it. A peer that reconnects after a silent drop is refused
> until the heartbeat (§1.6) reaps its old socket; its client retries.

*Source: `server/relay.mjs` (`handleMessage`, `isDid`, `CLOSE_DID_TAKEN`). Tests: none pin the 4009 close directly — see Open questions.*

### 1.3 Rooms

A room is an opaque string of 1 to 128 characters. The relay does not
interpret it.

**A space's room** is derived from its id so that a relay learns which
connections belong together but not which space they are:

```
room = lowercase( base32( SHA-256( UTF-8("weave-room/v1|" + spaceId) )[0..20) ) )
```

`base32` is RFC 4648 (alphabet `A–Z2–7`), no padding, output lowercased. 20
bytes give exactly 32 characters.

Example: space id `example-space-id` →
SHA-256 prefix `4cb4dac634926d7b5a4de659ec8ea1328d616cca` →
room **`js2nvrrusjwxwwsn4zm6zdvbgkgwc3gk`**.

A client MUST use this derivation for a space's room; two implementations
that differ here never meet.

Other protocols meet in rooms of their own on the same relays, with names
derived elsewhere: device pairing (`pairingRoomId`, [01 — Identity](01-identity.md))
and the agent link ([06 — Nodes, sessions and apps](06-nodes-and-sessions.md)).
The relay treats them all alike.

*Source: `src/node/space-runtime.ts` (`relayRoom`), `src/utils/hash.ts` (`base32Encode`). Tests: `tests/space-relays.test.ts`, `tests/network-manager.test.ts`.*

### 1.4 Messages

Every message is a JSON object. Fields not listed are ignored by the relay
and are not forwarded (forwarded messages are rebuilt from known fields).

#### Client → relay

| `type` | Fields | Effect |
|---|---|---|
| `join` | `from`: DID, `room`: string | Enter `room` (§1.2 for `from`). On success, every *other* socket in the room receives a relay `join`. The joiner receives no acknowledgement and no list of who is present. On the socket's first successful join, the relay also sends an `ice` offer if it has TURN (§1.7). |
| `leave` | `room`: string | Leave `room`, if in it. Every other socket in the room receives a relay `leave`. |
| `offer`, `answer`, `candidate` | `to`: DID, `payload`: any JSON | Delivered to the socket holding `to` in the first room it shares with the sender (in the sender's join order), as the relay form below. Dropped if the sender has not joined, or shares no room with `to`, or `to` is the sender itself. |
| `ice` | — | Ask for TURN servers (§1.7). Ignored before the socket's first join, and by a relay without TURN. |

The reference client adds `from` (its DID) to every message it sends,
including `leave`, `ice` and the signals; the relay reads `from` only on
`join`.

The relay never replies with an error. A message that fails any check is
dropped silently (except the `4009` close of §1.2 and the flood cut-off of
§1.6).

#### Relay → client

| `type` | Fields | Meaning |
|---|---|---|
| `join` | `from`: DID, `room`: string | `from` entered `room`. |
| `leave` | `from`: DID, `room`: string | `from` left `room` — by `leave`, or because its socket closed or was reaped. |
| `offer`, `answer`, `candidate` | `from`: DID (the sender's, as joined), `to`: DID, `payload` | A signal from `from`. The relay does not say which room it was routed through. |
| `ice` | `payload`: `{ servers: RTCIceServer[], expiresAt: number }` | TURN servers and when their passwords stop working (ms since the epoch). |

Only peers already in a room hear about a newcomer; the newcomer hears of
nobody. So exactly one side of each pair learns of the other through the
relay, and that side makes the offer (§7.3).

`payload` of `offer` / `answer` is an `RTCSessionDescriptionInit`
(`{ "type": "offer" | "answer", "sdp": string }`); of `candidate`, an
`RTCIceCandidateInit` (`{ candidate, sdpMid, sdpMLineIndex, usernameFragment }`).
The relay passes it through untouched.

Examples (DIDs shortened for readability; real ones are full `did:key`s):

```json
→ {"type":"join","room":"js2nvrrusjwxwwsn4zm6zdvbgkgwc3gk","from":"did:key:zDnaeV1Sz…"}
← {"type":"join","from":"did:key:zDnaebEo…","room":"js2nvrrusjwxwwsn4zm6zdvbgkgwc3gk"}
→ {"type":"offer","to":"did:key:zDnaebEo…","payload":{"type":"offer","sdp":"v=0\r\n…"},"from":"did:key:zDnaeV1Sz…"}
← {"type":"offer","from":"did:key:zDnaeV1Sz…","to":"did:key:zDnaebEo…","payload":{"type":"offer","sdp":"v=0\r\n…"}}
→ {"type":"candidate","to":"did:key:zDnaeV1Sz…","payload":{"candidate":"candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host","sdpMid":"0","sdpMLineIndex":0},"from":"did:key:zDnaebEo…"}
→ {"type":"leave","room":"js2nvrrusjwxwwsn4zm6zdvbgkgwc3gk","from":"did:key:zDnaeV1Sz…"}
← {"type":"leave","from":"did:key:zDnaeV1Sz…","room":"js2nvrrusjwxwwsn4zm6zdvbgkgwc3gk"}
→ {"type":"ice","from":"did:key:zDnaeV1Sz…"}
← {"type":"ice","payload":{"servers":[{"urls":["turn:turn.example.com:3478"],"username":"1790000000:3q2-7wX0aBcD","credential":"n3Jk…="}],"expiresAt":1790000000000}}
```

*Source: `server/relay.mjs` (`handleMessage`, `announce`, `offerTurn`), `src/network/signaling.ts`. Tests: `tests/network-manager.test.ts` ("the mesh, through real relays"), `tests/relay-turn.test.ts`, `tests/introductions.test.ts` ("several relays at once").*

### 1.5 One-room sockets

A socket opened with `?room=<name>` is the older, one-room form. For it, any
message without a `room` field means `<name>`: `{"type":"join","from":…}`
joins it, `{"type":"leave"}` leaves it. It may still join other rooms by
naming them. One-room and multi-room sockets meet in the same rooms, and
relay `join` / `leave` notices always carry `room`.

A relay SHOULD keep serving one-room sockets; app versions from before the
mesh use them. New clients MUST use multi-room sockets.

*Source: `server/relay.mjs` (`upgrade`, `handleMessage`). Tests: `tests/network-manager.test.ts` ("the relay still serves the older one-room sockets…").*

### 1.6 Limits

A relay is open to anyone and MUST bound what one client can cost it. The
values below are the reference relay's; a compatible relay MAY choose others,
and clients MUST tolerate being refused or cut off at any of them.

| Limit | Value | On exceeding |
|---|---|---|
| Message size (`MAX_MESSAGE_BYTES`) | 64 KiB | the WebSocket library closes the socket (1009) |
| Open sockets, whole relay | 5 000 | upgrade refused `503 Relay full` |
| Open sockets per client address | 32 | upgrade refused `429 Too many connections` |
| Rooms, whole relay | 10 000 | `join` of a new room ignored |
| Rooms per socket | 256 | `join` ignored |
| Peers per room | 64 | `join` ignored (`503 Room full` for a one-room socket's upgrade) |
| Room name length | 1–128 chars | `join` ignored |
| DID length | ≤ 256 chars | `join` ignored |
| Message rate per socket | token bucket: 50/s, burst 100 | socket terminated with no close frame |
| Heartbeat | ping every 15 s | a socket that did not pong since the last ping is terminated; its rooms are left (with `leave` notices) and its DID freed |
| Send buffer per recipient | 1 MiB | the *recipient* is terminated rather than buffered for |
| Addresses holding a TURN password | 20 000 | new addresses get no `ice` until old passwords expire |

Every message counts against the rate budget, including binary and malformed
ones.

*Source: `server/relay.mjs` (constants at the top, `withinBudget`, `send`, heartbeat). Tests: not pinned by tests — see Open questions.*

### 1.7 TURN passwords

A relay MAY hand out TURN credentials for a TURN server (coturn run with
`use-auth-secret`) that shares a secret with it — the "TURN REST API"
scheme, in which nothing is stored and nothing needs revoking.

```
expires    = floor(now_seconds) + ttlSeconds
username   = decimal(expires) + ":" + base64url(9 random bytes)      (12 chars after the colon)
credential = base64( HMAC-SHA1( key = secret, message = UTF-8(username) ) )   (standard base64, padded)
```

The relay sends

```json
{"type":"ice","payload":{"servers":[{"urls":[…TURN_URLS],"username":"<username>","credential":"<credential>"}],"expiresAt":<expires × 1000>}}
```

- unprompted, to a socket on its first successful `join`, and
- on each `{"type":"ice"}` from a socket that has joined at least once.

**One password per network.** All sockets from one IPv4 address, or one
IPv6 /64, share a username. A held one is reused while more than half its
TTL remains; after that a new one is minted. So asking again is free, and
coturn's per-user quota caps an address rather than each request.
IPv4-mapped IPv6 (`::ffff:a.b.c.d`) counts as the IPv4 address.

A relay without TURN never answers `ice`.

*Source: `server/relay.mjs` (`turnFromEnv`, `offerTurn`, `networkOf`). Tests: `tests/relay-turn.test.ts`.*

### 1.8 Running a relay

*Implementation detail.* `server/signaling-server.mjs` wraps `createRelay`
in an HTTP server; every always-on node (`weave serve` / `weave run`, and the
host) runs the same relay on its own port. Configuration is by environment:

| Variable | Meaning | Default |
|---|---|---|
| `PORT` (or first CLI argument) | listening port of `signaling-server.mjs` | `8787` (`8080` in the Docker image) |
| `TURN_SECRET` | shared secret with coturn; TURN is off without it | — |
| `TURN_URLS` | comma-separated TURN URLs handed out | — (TURN off if empty) |
| `TURN_TTL_SECONDS` | password lifetime | `14400` (4 h) |
| `FLY_APP_NAME` | when set, believe `Fly-Client-IP` | — |
| `TURN_PUBLIC_IP` | coturn's external IP (`server/start.sh` only) | — |

*Source: `server/relay.mjs`, `server/relay.d.mts`, `server/signaling-server.mjs`, `server/start.sh`, `server/fly.toml`, `cli/src/serve.ts`. Tests: `tests/relay-turn.test.ts`, `tests/cli.test.ts`.*

---

## 2. The signaling client

A client holds **one socket per relay** and joins one room per space (and
per pairing or agent link) on it.

- On open, the client MUST (re)send `join` for every room it is in: a relay
  forgets everything when a socket closes.
- `join` for a room already joined is not resent; `leave` is sent only for a
  room joined.
- Received `offer` / `answer` / `candidate` are handed up as signals.
  Received `join` / `leave` without a string `room` are ignored.
- A received `ice` is kept only if it has the right shape: `servers` an
  array (only the first 4 considered), each with `urls` (string or array) of
  which only strings shorter than 256 characters matching `^turns?:` are
  kept, and string `username` and `credential`; `expiresAt` a finite number.
  An offer with no usable server is dropped.

*Implementation detail:* after an unexpected close the reference client
redials with backoff 1, 2, 4, 8, 16 s and gives up after 5 attempts in a
row; a successful open resets the count.

*Source: `src/network/signaling.ts`. Tests: `tests/introductions.test.ts` ("several relays at once").*

---

## 3. Several relays at once

A client MAY be configured with several relays. It uses **all of them at
once**, not in order: it connects to every one and joins every room on every
one. Connecting succeeds once any relay answers, and fails only when none
does.

> Rationale: failover still strands two people when one is on the first
> relay and the other on the second. Being present on all of them means they
> meet wherever either is looking.

Because the same peer is announced by each relay it shares with us, the
client de-duplicates:

- **Presence** is kept per `(room, peer)` as the set of relays that
  announced it. `peer-joined` is raised when the set becomes non-empty;
  `peer-left` only when the last relay says the peer left (or is dropped).
  A client MUST NOT raise a second `peer-joined` for a peer already present
  in that room — both sides would open a second connection.
- **Routes.** A client remembers which relays a peer has been seen on (by a
  `join` or a signal from it). Signals to that peer are sent on every
  *connected* relay it was seen on; to a peer not seen on any, on every
  connected relay.
- **TURN.** `ice` offers are kept per relay; the client's TURN servers are
  the union of all relays' servers, expiring at the earliest `expiresAt`.
- `requestIce` is sent to every connected relay.

A peer may therefore receive the same signal once per relay the two share.
Not yet specified: how a receiver must treat such duplicates (§7.3).

*Source: `src/network/multi-signaling.ts`. Tests: `tests/introductions.test.ts` ("several relays at once"), `tests/network-manager.test.ts` ("a relay connects the first pair…").*

---

## 4. A space's own relays

A space may name the relays its members meet on, so that people whose apps
are configured with different relays still meet.

- They are the body of the single record with key `relays:space` in the
  collection **`sys.relays`**: `{ "relays": [url, …] }`, stored in the clear
  even in a private space. It is part of the access log and only an author
  holding the `manage` permission may change it; see
  [03 — Spaces](03-spaces.md) for how the current value is chosen.
- A valid list has at most **8** entries, no duplicates, each a string of at
  most 200 characters that parses as a URL with scheme `wss:` — or `ws:` when
  the host is `localhost`, `127.0.0.1` or `[::1]`. An invalid list is not
  applied.

```json
{ "relays": ["wss://relay.example", "wss://relay.other.example"] }
```

A node joins a space's room on **its configured relays plus the space's
relays**, the latter for that room only. Until the space names some, it uses
the relays named by the invite that brought it
([03 — Spaces](03-spaces.md)). When the list changes, the node joins the room
on the new relays and leaves it on relays no longer named; a relay socket
opened only for spaces' own relays is closed once no room needs it.

A node that holds `manage` in a space that names no relays names its own
configured relays (valid ones, at most 8) by itself.

*Source: `src/space/roles.ts` (`RELAYS_COLLECTION`, `MAX_RELAYS`, `checkRelays`), `src/space/space-access.ts` (`SPACE_RELAYS_RECORD`), `src/node/space-runtime.ts` (`useRelays`, `nameRelays`, `setRelays`), `src/network/multi-signaling.ts` (`join`, `release`), `src/network/mesh.ts` (`useRelays`). Tests: `tests/space-relays.test.ts`, `tests/network-manager.test.ts` ("a room that names its own relay…").*

---

## 5. Transports

A transport moves opaque byte messages between this node and peers named by
their session DID. Two kinds exist:

- **Signalled** (WebRTC): a connection starts with an offer and an answer
  carried by something else — a relay or a peer (§8).
- **Unsignalled** (a WebSocket to an always-on node; an in-process link):
  it dials by itself and authenticates, or is trusted, by itself.

On every transport a message is **one binary frame containing UTF-8 JSON**.
Transports do not fragment, compress or re-order messages. Not yet
specified: a maximum message size on peer connections other than the limits
of §9.

*Source: `src/network/transport.ts`. Tests: `tests/network-manager.test.ts`.*

### 5.1 WebRTC data channels

- The offerer creates **one data channel labelled `data`**, `ordered: true`
  (reliable, in order). The answerer uses the channel it receives. Messages
  are binary (`binaryType = 'arraybuffer'`); text messages are ignored.
- ICE candidates are trickled: each local candidate is sent as a separate
  `candidate` signal as it is found.
- A connection counts as open when the data channel opens, and as gone when
  the channel closes or the connection state becomes `failed` or `closed`.
- One connection per peer: making or accepting a new one for a peer closes
  any existing one with it.
- **Channel binding.** Each side takes, from the local and the remote
  session description, the first `a=fingerprint:<alg> <value>` line and
  renders it as `lowercase(alg) + " " + uppercase(value)`, e.g.
  `sha-256 3A:9F:…:C1`. These two strings bind the peer handshake to this
  connection (§6.2). A transport without certificates has no binding; both
  strings are then empty.
- The ICE servers are asked for each new connection (§10), since TURN
  passwords change.

*Source: `src/network/rtc-transport.ts`. Tests: none directly; the mesh tests replace WebRTC with the fake signalled transport in `tests/helpers/fake-transport.ts`.*

### 5.2 WebSocket to an always-on node (client side)

Browsers cannot accept connections, but they can dial a node with a DNS name
and a TLS certificate. A node configured with `network.nodes` holds one
socket per node **per space**, to

```
<node URL>?space=<encodeURIComponent(spaceId)>        (&space=… if the URL already has a query)
```

e.g. `wss://node.example.com/peer?space=abc123`. The node appears as a
single peer, named by its session DID.

The handshake is three text frames, then binary frames either way:

```
1. node   → client   {"type":"challenge","nonce":<Nₛ>,"did":<node DID>}
2. client → node     {"type":"hello","did":<client session DID>,"nonce":<N꜀>,"sig":…,"read"?:…,"readKey"?:…,"member"?:…}
3. node   → client   {"type":"welcome","did":<node DID>,"sig":<…>}
4. binary frames of UTF-8 JSON, either way
```

The proof fields and what is signed are in §6.1. The client:

- MUST refuse (close `4002`, "protocol error") a first frame that is not a
  `challenge` with a string `nonce` and non-empty string `did`, and a second
  that is not a `welcome` with a non-empty `did`;
- MUST refuse a welcome whose `did` differs from the challenge's, or whose
  `sig` does not verify (§6.1);
- MUST process frames one at a time, so no data frame overtakes the welcome;
- ignores text frames after the welcome.

*Implementation detail:* the client redials without limit after an
unexpected close, with backoff `base/2 + random·base/2` where
`base = min(1 s · 2ⁿ, 30 s)`; a deliberate close is never redialled.

*Source: `src/network/ws-transport.ts`, `src/node/space-runtime.ts` (network setup), `src/network/network-manager.ts`. Tests: `tests/ws-transport.test.ts`, `tests/host.test.ts`, `tests/cli.test.ts`.*

### 5.3 The `/peer` endpoint (node side)

An always-on node serves `/peer` on the same port as its relay.

1. On upgrade the node MUST send the `challenge` at once — before looking at
   whether it holds the space — with a fresh nonce and its **session DID**.
   A node that does not hold the space refuses the hello exactly as it
   refuses a stranger.
2. It waits for one text frame. Close codes:

| Code | Reason | When |
|---|---|---|
| `4000` | `missing ?space=` | no `space` query parameter |
| `4008` | `no hello` | no frame within 10 s (*implementation detail*: configurable) |
| `4002` | `expected a hello frame` | binary, not JSON, `type` ≠ `hello`, `did` not matching `^did:key:z[1-9A-HJ-NP-Za-km-z]{1,250}$`, or `nonce` not a string |
| `4003` | `not a reader of this space` | the node does not serve the space, or the proof fails (§6.1) |
| `1011` | `could not open space` / `internal error` | the node failed |
| `4009` | `replaced by a newer connection` | the same DID connected again in this space; the older socket is closed |
| `1001` | `node shutting down` | — |

3. On success it sends the `welcome` and treats the socket as the peer named
   by the hello's `did`. Only binary frames are data; text frames are
   ignored. *Implementation detail:* `maxPayload` is 16 MiB on `/peer`.

*Source: `cli/src/serve.ts` (`onPeer`, `parseHello`, `createSpacePeers`), `src/node/node.ts` (`authenticator`), `src/node/host.ts`. Tests: `tests/host.test.ts`, `tests/cli.test.ts` ("two devices that are never online together converge through it"), `tests/key-change.test.ts`.*

### 5.4 In-process links

*Implementation detail.* `createLocalHub()` links every transport made from
it that has connected, delivering on a later task with the bytes copied. It
performs no handshake. It is exported, but nothing in `src/` or `cli/src/`
uses it at present (its header still describes a carrier use that mirrors
now serve).

*Source: `src/network/local-transport.ts`. Tests: none.*

---

## 6. Peer authentication

Nothing in an offer or a WebSocket URL proves who is at the other end. So on
every connection, and before a byte of a space crosses it, each side proves
the session DID it claims by signing with **the key that DID names**, and in
a private space proves it may read, by signing with the space's **read key**.

Common rules:

- Nonces are 16 random bytes, base64url (22 characters).
- Signatures are ECDSA P-256 / SHA-256, 64-byte P1363, base64url
  (86 characters), over the UTF-8 bytes of a label below.
- A signature is checked against the public key decoded from the DID
  ([01 — Identity](01-identity.md)); a DID that does not start with
  `did:key:` or does not decode fails.
- `spaceId` in a label is the **space id**, not the room.

### 6.1 Client and node (WebSocket, `weave-peer/v3`)

```
H  = "weave-peer/v3|client|" + spaceId + "|" + clientDid + "|" + nodeDid + "|" + Nₛ
W  = "weave-peer/v3|server|" + spaceId + "|" + nodeDid + "|" + N꜀
```

- The client's hello carries `sig` = client session key signs `H`.
- The node MUST verify `sig` against `clientDid`. In a private space it MUST
  also check the read proof (§6.3) over the same `H`.
- The welcome carries `sig` = node session key signs `W`. The client MUST
  verify it against the node DID from the challenge.

> Rationale: naming the node in `H` keeps a hello from being replayed to a
> different node; `W` proves the welcome comes from the node that issued the
> challenge. Which node to trust at all is the client's choice of URL.

*Source: `src/network/peer-auth.ts` (`createClientAuth`, `createServerAuth`). Tests: `tests/ws-transport.test.ts` ("a public space", "a private space", "a node that does not welcome properly is refused"), `tests/key-change.test.ts` ("the current key lets you in; an old one only with a note…").*

### 6.2 Between peers (mesh, `weave-mesh/v1`)

Run once per room on a WebRTC connection (§7.2 gives the frames):

```
A → B   __auth-hello  { nonce: Nₐ }
B → A   __auth-hello  { nonce: N_b }
A → B   __auth-proof  proof over T(A, B, N_b)
B → A   __auth-proof  proof over T(B, A, Nₐ)

T(prover, verifier, nonce) =
  "weave-mesh/v1|" + spaceId + "|" + proverDid + "|" + verifierDid + "|" + nonce
                  + "|" + proverCert + "|" + verifierCert
```

`proverCert` / `verifierCert` are the channel-binding fingerprints of §5.1,
each as its owner's end: the prover signs with `(local, remote)` as it sees
them; the verifier checks with `(remote, local)` as it sees them. Without a
binding both are empty strings.

A proof is `{ "sig": …, "read"?: …, "readKey"?: …, "member"?: … }`, `sig`
being the prover's session key over `T`. The verifier MUST check `sig`
against the prover's DID and, in a private space, the read proof (§6.3)
over the same `T`.

In a room that asks no proof (a pairing or agent-link room, which secure
their own payloads), the hellos are still exchanged and no proofs are sent.

Example (public space, placeholder fingerprints):

```
T = "weave-mesh/v1|example-space-id|did:key:zDnaeV1SzGREx4fjGtUofWfZfnH42TV5EboaJ6deJLxvmo6jd|did:key:zDnaebEoAa6Zv2oVPznMq3oDqaXb9jCUUX15n4LzqpwMRLxzp|_8bGsP1hPeS2r_CFgK10jg|sha-256 AA:BB|sha-256 CC:DD"
proof = {"sig":"tSsGyRGc85v0Q6QwVpHwssS0PeNyR3wqX_bK3y8w0AGeOEew4Iyu2wZ-FlBzl67tjNv3NYsgw3NWyPup4I7CQQ"}
```

> Rationale: someone in the middle holds a different certificate pair on
> each side, so a proof relayed through them does not check out. A relay that
> swaps in its own offer is caught.

*Source: `src/network/peer-auth.ts` (`createMeshAuth`), `src/network/mesh.ts` (`onHandshake`). Tests: `tests/network-manager.test.ts` ("every peer proves who it is, in every room"), `tests/carrier.test.ts`.*

### 6.3 Proving you may read a private space

In a private space the space names a current **read key** (`did:key`, from
`sys.key`; derivation in [03 — Spaces](03-spaces.md)). A reader adds to its
proof:

- `read` — the read private key's signature over the same label (`H` or `T`).
- If the read key it holds is **not** the current one (it was offline when
  the key changed): `readKey` — the DID of the read key that signed `read`;
  and `member` — its **note** sealed with the space key behind `readKey`:

  ```
  member = base64url( iv(12 bytes) ‖ AES-256-GCM(spaceKey, iv,
                       aad = UTF-8("weave/space-membership/v1|" + spaceId),
                       plaintext = UTF-8(JSON.stringify(noteString))) )
  ```

The verifier:

1. takes `claimed = readKey` if present, else the current read key;
2. MUST verify `read` against `claimed` (a `claimed` not starting with
   `did:key:` fails);
3. accepts if `claimed` is the current read key;
4. otherwise accepts only if it holds the space key whose read key is
   `claimed`, can open `member` with it, the note inside is valid, is made
   out to the prover's session DID, and its root account is a reader of the
   space now. A verifier without that key (a host) rejects.

A node that must prove read access but holds no read key MUST NOT complete
the mesh handshake (the reference implementation throws, and the room times
out).

> Rationale: someone removed holds the older key too, but is no member. The
> note sealed under the older key shows which account is asking, and only
> those who could read the space then can open it.

*Source: `src/network/peer-auth.ts` (`proveRead`, `checkRead`), `src/node/space-runtime.ts` (`readAccess`), `src/privacy/space-encryption.ts` (`sealWith`, `openWith`), `src/space/space-access.ts` (`membershipContext`). Tests: `tests/key-change.test.ts`, `tests/ws-transport.test.ts` ("a private space"), `tests/network-manager.test.ts` ("in a private space, a peer without its key never becomes a peer").*

### 6.4 The account behind a session

A handshake proves a session DID, not whose it is. So the first message each
side sends on a space's connection, as soon as the peer is admitted, is
`who` (§9.1), carrying its note. The receiver resolves the note's
delegation chain ([01 — Identity](01-identity.md)) and takes the root DID as
the peer's account **only if** the chain is valid and its audience is the
peer's proven session DID. A note longer than 16 384 characters, invalid, or
made out to another key gives the peer **no account** (`null`). Whether the
note is an agent's note is recorded alongside.

> Rationale: a note copied off someone's record names their key, not the
> copier's, so it is useless to anyone else.

*Source: `src/node/space-runtime.ts` (`accountOf`, `WHO_MESSAGE`). Tests: `tests/live.test.ts` ("a peer showing someone else's note is known as nobody").*

---

## 7. The mesh

A node holds **one socket per relay and one WebRTC connection per peer**,
however many spaces they share. Each space is a room; a connection is shared
by every room both peers are in, and a peer proves itself separately in each
room before anything of that room crosses. A peer is a peer only in the
rooms it proved itself in.

The mesh's identity is the node's session DID.

### 7.1 Frames

Every message on a mesh connection is a JSON object:

```json
{ "room": "<room>", "type": "<type>", "from": "<sender session DID>", "payload": <any> }
```

- `room` is present on every frame about a room; `__signal` frames carry
  none (a connection belongs to no one space).
- `from` is informational: a receiver MUST take the sender to be the peer
  the connection is with, never `from`.
- Reserved types (never delivered to the application): `__auth-hello`,
  `__auth-proof`, `__peers`, `__signal`, `__leave`.

| `type` | `room` | `payload` | Accepted from |
|---|---|---|---|
| `__auth-hello` | yes | `{ "nonce": string }` | anyone connected |
| `__auth-proof` | yes | proof (§6.2) | anyone connected |
| `__peers` | yes | array of DIDs | a peer admitted in that room |
| `__leave` | yes | — | a peer admitted in that room |
| `__signal` | no | relayed signal (§8) | a peer admitted in any room |
| anything else | yes | application | a peer admitted in that room |

Any other frame from a peer is dropped.

*Source: `src/network/mesh.ts`, `src/network/introductions.ts`. Tests: `tests/network-manager.test.ts`, `tests/introductions.test.ts` ("mesh housekeeping").*

### 7.2 Admission to a room

For each `(room, peer)` a side keeps a handshake with its own fresh nonce.

- A side **greets** — sends `__auth-hello` with its nonce — when the
  connection opens and it knows the peer is in the room, or when it knows
  the peer is in the room and a connection is already open, or on receiving
  the peer's `__auth-hello` if it has not greeted yet.
- On the peer's `__auth-hello` (the first one only), it sends its
  `__auth-proof` over the peer's nonce (none in a room without proofs).
- On the peer's `__auth-proof` it checks it (§6.2); a failed check ends the
  handshake.
- The peer is **admitted** once this side has both sent its proof and
  verified the peer's (or the room asks none). Admission raises
  `peer-connected` for that room.
- A handshake not finished within **10 s** is abandoned.
- A connection that is in no room and in no handshake is closed; a newly
  opened connection that no room has taken up within 10 s is closed.

Leaving a room: a side sends `__leave` (with `room`) to each peer admitted
there, and leaves the room on the relays. A receiver of `__leave` drops the
peer from that room, and closes the connection if no room uses it.

*Source: `src/network/mesh.ts` (`greet`, `onHandshake`, `admit`, `closeIfIdle`). Tests: `tests/network-manager.test.ts` ("two spaces shared by two devices use one connection", "a peer is a peer only in the rooms it shares…", "failing to prove it in one room costs nothing in another").*

### 7.3 Who connects

- **Through a relay:** a relay `join` names a peer in a room. If a
  connection to it is open, the node greets it there. Otherwise, if no
  connection with it has been started, the node creates the offer and sends
  offer and candidates through the relays (§3); it greets once the channel
  opens. Only existing members of a room hear a `join`, so only they offer.
- **Through an introduction:** see §8; the side with the lexically smaller
  DID offers.
- **Receiving a signal** from a peer already admitted in any room is ignored:
  a proven connection is never replaced by an offer that proved nothing.
  Otherwise an `offer` is answered (replacing any unproven connection with
  that peer) and the `answer` and candidates go back the way the offer came
  (relay, or mesh); an `answer` or `candidate` is applied.

Not yet specified: suppression of a duplicate offer that arrives through a
second shared relay (§3). The reference implementation answers each.

*Source: `src/network/mesh.ts` (`meet`, `offerTo`, `onSignal`). Tests: `tests/network-manager.test.ts`.*

### 7.4 Limits

| Limit | Value |
|---|---|
| Peers per room | bounded by the relay (64 in the reference relay); the mesh sets none of its own |
| Handshake timeout (`authTimeoutMs`) | 10 s |
| Idle connection timeout | 10 s after opening |
| Peers named per `__peers` | 64 (`MAX_INTRODUCED`); the rest are ignored |
| Relayed-signal hops | 3 (`MAX_HOPS`) |
| Remembered relayed-signal ids | 512 |

*Source: `src/network/mesh.ts`, `src/network/introductions.ts`. Tests: `tests/introductions.test.ts`.*

---

## 8. Introductions

Once connected to one peer, its data channel is used to arrange the next
connection, so a relay is needed only to meet the first peer in a room.
Introductions are on by default and MAY be turned off (pairing and agent-link
rooms turn them off).

**`__peers`.** When a peer is admitted to a room, the admitting side sends
the newcomer `{ room, type: "__peers", payload: [every other admitted peer in
the room] }`, and each of those peers `{ room, type: "__peers", payload:
[newcomer] }`. A receiver takes at most the first 64 entries, skips anything
that is not a DID (string ≤ 256 matching `^did:key:z[1-9A-HJ-NP-Za-km-z]+$`),
and for each: if a connection to it is open, greets it in that room;
otherwise, if `ourDid < theirDid` (JavaScript string comparison, i.e. UTF-16
code units), sends it an offer through the mesh; otherwise waits for its
offer.

> Rationale: both sides are told about each other at the same moment. The
> comparison is free and both sides agree on it, so exactly one offers.

**`__signal`.** Signaling for a connection not yet open travels over the mesh:

```json
{ "type": "__signal", "from": "<sender>", "payload": {
  "id": "9f1c2a7b04d3e6aa",
  "origin": "<DID wanting to connect>",
  "target": "<DID it wants>",
  "kind": "offer" | "answer" | "candidate",
  "data": <RTCSessionDescriptionInit | RTCIceCandidateInit>,
  "hops": 3
} }
```

- `id` is 8 random bytes as 16 lowercase hex characters, fresh per signal.
- The sender floods it to every connected peer admitted in *any* room.
- A receiver drops it if `id` is not a string of at most 64 characters or was
  seen before (it remembers the last 512), if `origin` or `target` is not a
  DID, or if `kind` is not one of the three.
- If `target` is itself, it acts on it as a signal from `origin` (§7.3) and
  replies through the mesh with new ids.
- Otherwise, if `hops > 0`, it forwards to every admitted peer except the one
  it came from, with `hops = min(hops, 3) − 1`.

*Source: `src/network/introductions.ts`, `src/network/mesh.ts` (`handlePeerList`, `floodSignal`, `onRelayedSignal`). Tests: `tests/introductions.test.ts`, `tests/network-manager.test.ts` ("a relay connects the first pair, and a peer introduces the rest").*

---

## 9. Messages on a space's connections

On every transport, a space's peers exchange messages of the form

```json
{ "type": string, "from": "<sender session DID>", "payload": <any> }
```

— on a mesh connection wrapped in the frame of §7.1 (the frame's `room`
added), on a node socket or local link as the whole binary frame. The
receiver MUST attribute a message to the connection's peer, not to `from`.

| `type` | Payload | Specified in |
|---|---|---|
| `sync` | a sync message | [05 — Sync and storage](05-sync-and-storage.md) |
| `who` | `{ "note": string }` | §6.4, §9.1 |
| `live` | any JSON | §9.2 |

Pairing and agent-link rooms carry their own types (`src/session/pairing.ts`,
`src/session/agent-link.ts`); see [01 — Identity](01-identity.md) and
[06 — Nodes, sessions and apps](06-nodes-and-sessions.md). Unknown types are
ignored.

### 9.1 `who`

Sent by each side to each newly admitted peer of a space, **before any
`live` message**: `{"type":"who","from":<session DID>,"payload":{"note":<the
session's encoded note>}}`. Handling is in §6.4. A peer that sends none has no
account.

### 9.2 Live messages (`spaces.send`)

A live message reaches whoever is connected in the space right now. It is
not signed as a record, not stored and not synced; a peer not connected
misses it. In a private space it reaches only peers that proved the read key.

**Sending** — `node.spaces.send(spaceId, message, to?)`:

- The message is `JSON.stringify(message ?? null)`; if that string is longer
  than 65 536 characters the call fails ("A live message can be at most 64 KB").
- It is sent as `{"type":"live","from":<session DID>,"payload":<message>}` to
  every connected peer of the space (once per peer, over whichever network
  it was last connected on).
- With `to`, only to peers whose **session DID** equals `to` (one device), or
  whose **account DID**, as learned from their `who`, equals `to` (every
  device of that account). A peer whose `who` has not been checked yet is
  matched by session DID only.
- *Implementation detail:* the node's agent API refuses `send`.

**Receiving** — a receiver:

- MUST rate-limit per peer: a token bucket of **burst 60, 20 per second**;
  messages beyond it are dropped (the connection stays open);
- MUST drop a message whose `JSON.stringify(payload)` is longer than 65 536
  characters;
- delivers `{ type: "message", space, from: <account DID or null>, peer:
  <session DID>, agent: <boolean>, message: <payload> }`, where `from` and
  `agent` come from the peer's `who` (§6.4).

Example:

```json
{"type":"live","from":"did:key:zDnaeV1SzGREx4fjGtUofWfZfnH42TV5EboaJ6deJLxvmo6jd","payload":{"type":"typing"}}
```

*Source: `src/node/space-runtime.ts` (`send`, `onLive`, `withinAllowance`, `LIVE_MESSAGE`, `MAX_LIVE_BYTES`, `LIVE_BURST`, `LIVE_PER_SECOND`), `src/node/types.ts` (`LiveMessage`, `NodeSpaces.send`), `src/node/node.ts`. Tests: `tests/live.test.ts`.*

---

## 10. ICE and TURN (client side)

- The default ICE servers are STUN only: `stun:stun.l.google.com:19302` and
  `stun:stun1.l.google.com:19302`. `network.iceServers` replaces them.
- Each new WebRTC connection uses the configured servers plus the TURN
  servers relays offered (§1.7, §3), the latter only while `expiresAt` is in
  the future.
- `node.iceServers()` returns the same list for connections of the
  application's own (a call's). Before answering it refreshes: if any relay
  is connected and the TURN passwords held are missing or expire within
  10 minutes, and it has not asked in the last 10 minutes, it sends `ice` to
  every connected relay and waits up to **1.5 s** for an answer (relays
  without TURN never answer), then returns what it has. A node with no relays
  returns the configured servers.

*Source: `src/network/rtc-transport.ts` (`DEFAULT_ICE_SERVERS`), `src/network/mesh.ts` (`iceServers`, `ICE_REFRESH_MS`, `ICE_WAIT_MS`), `src/node/node.ts` (`iceServers`), `src/calls/calls.ts`. Tests: `tests/relay-turn.test.ts` (the relay side only; the client-side refresh is untested).*

---

## 11. Conformance summary

A compatible **relay** MUST: accept multi-room sockets on any path; fix one
DID per socket on first `join`; refuse a second socket claiming a DID in a
room (close `4009`); announce `join`/`leave` with `from` and `room` to the
*other* members only; forward `offer`/`answer`/`candidate` only between
sockets sharing a room, rewriting `from` to the sender's DID; announce `leave`
for every room of a socket that closes or dies; and bound sizes, rates and
counts (§1.6). It SHOULD serve one-room sockets and `/health`, and MAY hand
out TURN passwords (§1.7).

A compatible **client** MUST: derive rooms as in §1.3; rejoin all rooms on
reconnect; de-duplicate presence across relays (§3); run the mesh handshake
of §6.2 in every room before sending anything of it, or the node handshake
of §6.1 on a node socket; attribute every message to the connection, not to
`from`; send `who` before `live`; and apply the receive limits of §9.2.

---

## Open questions

- **Duplicate signals across relays.** With two relays in common, an offer
  and its candidates are sent on both, and the receiver answers each offer,
  replacing the connection it just made (`src/network/multi-signaling.ts:207-209`,
  `src/network/mesh.ts:279-296`). Not yet specified whether receivers must
  de-duplicate.
- **Size limits on peer connections.** No maximum WebRTC message size is
  specified or enforced; browsers' SCTP limits apply.
- **"64 KB"** for live messages is measured in UTF-16 code units of the JSON
  string, not bytes.
- **Untested relay behaviour.** The `4009` DID-taken close, the rate limit,
  the per-address and per-room caps and the heartbeat have no tests.
- **Signaling client gives up** after 5 failed reconnects in a row
  (`src/network/signaling.ts:138`), while the WebSocket transport retries
  forever. Not yet specified what a client should do.
