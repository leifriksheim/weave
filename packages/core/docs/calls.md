# Calls

A call is voice and video between the members of a space. It is live messages
in that space ([spec 04 §9.2](https://github.com/leifriksheim/weave/blob/main/spec/04-network.md)),
plus one WebRTC connection of its own between each pair of devices in it (a
full mesh). Its history is a [`std.call`](standard-library.md#stdcall)
record.

This is a convention built on the protocol, not part of it. Peers that have
never heard of calls sync, store and judge every record the same way; a call
message is a live message like any other to them. Only apps that want to call
each other have to agree on the messages below. It uses these protocol parts:
live messages and the space's peer connection
([spec 04](https://github.com/leifriksheim/weave/blob/main/spec/04-network.md)),
roles ([spec 03](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)),
and TURN from relays (spec 04 §10).

The setup travels over the space's peer connection, whose handshake proved
who is at the other end, so an offer really comes from that device. A relay
only introduces devices and never sees a call.

In the library, `createCalls(node)` from `@weaveprotocol/core/calls` runs all
of it; in React, `CallsProvider` and `useCalls` ([node.md](node.md#client-conveniences)).

```ts
import { createCalls } from '@weaveprotocol/core/calls';

const calls = createCalls(node);
await calls.start(space); // join the call going on here, or start one
await calls.ring(space, account); // or ring one person
```

## Messages

Every call message is a JSON object with a `type` and a `call` id: a string
of 1–64 characters (the library makes 12 random bytes in lowercase hex). A
receiver must ignore a call message that is not one of these types, lacks a
valid `call`, comes from a peer with no account (`from: null`), or comes from
an agent (`agent: true`).

| `type`          | Sent to                                              | Fields                                                                                    | Meaning                                      |
| --------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| `call.here`     | the space, every `heartbeat` (5 s); or one device    | `since` (ms, when the sender joined), `camera` (bool), `muted` (bool)                     | "I am in this call."                         |
| `call.ring`     | one account                                          | —                                                                                         | Ring that account's devices.                 |
| `call.answered` | the caller's account, and the answerer's own account | —                                                                                         | Answered; stop ringing.                      |
| `call.declined` | the caller's account, and the decliner's own account | —                                                                                         | Declined; stop ringing.                      |
| `call.cancel`   | the rung account                                     | —                                                                                         | The caller stopped ringing.                  |
| `call.signal`   | one device                                           | `description` (`{ type: "offer"\|"answer", sdp }`) or `candidate` (`RTCIceCandidateInit`) | Connection setup.                            |
| `call.leave`    | the space                                            | —                                                                                         | "I left", now rather than after the timeout. |

Examples:

```json
{ "type": "call.here", "call": "3f9a1c0b7e2d4a6f8b1c2d3e", "since": 1790422901000, "camera": false, "muted": false }
{ "type": "call.signal", "call": "3f9a1c0b7e2d4a6f8b1c2d3e", "description": { "type": "offer", "sdp": "v=0\r\n…" } }
```

## Who takes part

Only **members**, accounts holding a role in the space, take part. A receiver
must ignore `call.here`, `call.ring` and `call.signal` from an account that
holds no role there (a view-only reader). The library caches the member list
for 10 s and asks once more for someone not in it.

A device must not ring for more than 3 `call.ring`s from one account in any
60 s; later ones are ignored. `call.cancel` is honoured only from the account
that rang.

> **Planned: blocked people do not ring.** A device will ignore `call.ring`
> from an account the person has blocked (`contacts.block`,
> [spec 03](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)).
> Today a ring is checked only for membership and rate. Tracked in
> [#20](https://github.com/leifriksheim/weave/issues/20).

## Presence

A device is in at most one call per space at a time: a `call.here` for
another call moves it. A device not heard from for 15 s (`gone`) is dropped,
and the connection to it closed. On hearing a new device's first `call.here`
in the call it is in, a device sends its own `call.here` straight to that
device.

## Joining, and which call

`start(space)` joins the call already going on in the space (the one with the
lowest id, if several) or starts one with a new id. Joining holds the space
([holding a space](node.md#opening-and-holding-spaces)) for as long as the
call lasts, so moving between screens never interrupts it. When a device
alone in its call (no connections yet) hears a `call.here` for a call with a
lower id in the same space, it moves into that call: two calls started at
once merge into the lower id.

## Connections

- Between two devices, the one with the **lower session DID** (by string
  comparison) makes the offer. A device must ignore an offer from a device
  whose session DID is higher than its own, and an answer on a connection it
  did not offer or that already has one.
- Each connection is made with one audio and one video transceiver
  (`sendrecv`) from the start. Muting, turning the camera on or off and
  sharing the screen replace the sender's track and are announced with
  `call.here`; they never renegotiate.
- Candidates arriving before the remote description are queued (at most 64).
- The offering side keeps at most one connection to each device, and offers
  only to a device it has none with.
- When a connection fails, or its offer or answer cannot be applied, the
  offering side offers again after 2 s if the other device is still in the
  call. A connection not connected within `gone` (15 s) of its offer counts as
  failed too: an offer or answer lost on the way leaves a connection that
  never fails, only never connects.
- ICE servers come from `node.iceServers()` ([node.md](node.md)): the
  configured ones plus TURN servers a relay offers.

## Ringing

1. The caller starts (or joins) the call, sends `call.ring` to the callee's
   account and shows `outgoing: ringing`.
2. The callee's devices ring for 45 s unless answered, declined or cancelled.
   A ring also stops when the caller's device has left the call, or has not
   been heard in it for `gone` (15 s): a page that closed without a
   `call.leave` rings nobody.
3. Answering: stop ringing, join the call (with that id), send
   `call.answered` to the caller's account and to one's own account (so other
   devices stop). Joining a call that is ringing the device, by any route, is
   answering it. Declining: `call.declined` the same way.
4. The caller on `call.answered` clears `outgoing`; on `call.declined` shows
   `declined` and, if nobody else is in the call 2.5 s later, leaves. A
   `call.here` in the call from the rung account clears `outgoing` too, so an
   answer lost on the way still stops the ringing.
5. After 45 s unanswered, the caller sends `call.cancel`, writes a missed-call
   record ([`std.call`](standard-library.md#stdcall)), shows `missed`, and
   leaves 2.5 s later if alone.

A device must not ring again for a call it stopped ringing for (answered,
declined, cancelled or timed out) in the last 90 s: the same `call.ring` can
arrive twice.

Group calls do not ring: a call going on shows to everyone with the space
open.

## Leaving

Leaving closes every connection, stops the local tracks, sends `call.leave`
to the space, and, if still ringing someone, sends `call.cancel` and writes a
missed-call record. If nobody else is left in the call and anyone else was
ever in it, the leaver writes an ended-call record. The space's hold is
released 1 s later, so the goodbye gets out first.

The call a device is in is kept in `sessionStorage` under `weave-call`, so
after a reload the page can offer to rejoin
([`std.call`](standard-library.md#stdcall)).

Reference values, all in `createCalls`'s options or constants: `heartbeatMs`
5 s, `goneMs` 15 s, `ringMs` 45 s; 2 s before offering again, 2.5 s before
giving up on a declined or missed ring, 1 s before letting go of the space,
10 s for the member list.

_Source: `packages/core/src/calls/calls.ts` (`createCalls`, `isCallMessage`, `RINGS_PER_MINUTE`, `GIVE_UP_MS`, `LEAVE_LINGER_MS`, `MEMBERS_MS`, `RETRY_MS`), `packages/core/src/react/use-calls.ts`. Tests: `packages/core/tests/calls.test.ts`._

## Planned

> **Planned.** Not settled.
>
> - **Ringing with the app closed.** A ring reaches only devices with the
>   space open. Reaching a closed browser or a phone needs Web Push from a
>   carrier ([spec 06 §4.4](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md), Planned);
>   the extension, always running while the browser is, could ring too. Not
>   designed: a live message is not a record, so a carrier has nothing to
>   match a ring against today.
> - **Big calls.** Past about 6 video streams a full mesh runs out of upload
>   bandwidth. The known answer is a forwarding server (an SFU) with
>   end-to-end encryption on top (SFrame), so it forwards media it cannot
>   watch. A host could run one. Not designed.
> - **Listening without talking.** View-only readers are kept out of calls
>   ([who takes part](#who-takes-part)). A space where readers may listen
>   could come as a role permission, e.g. `call: "listen" | "talk"`
>   ([spec 03](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)). Open.
> - **Calls across apps.** A call lives in the app that started it; another
>   app on another origin does not see it. Moving a call between apps would
>   need the account home to hold it. No plan yet.
