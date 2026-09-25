# BLOCK-21 — Calls that follow you around

> **Status (2026-09-25):** built on branch `calls` and described in the main
> README (live messages, `spaces.hold`, `@weaveprotocol/core/calls`,
> the relay's TURN passwords, and the example's calls). Checked in a real
> Chrome with its fake camera: two accounts signed in through the account
> home, a call started, joined, rung and answered, video arriving both ways,
> and the call kept up while one person moved to another space and back to
> the list. What's left is under **Still open** at the end. Where the build
> differs from the plan below, that section says so.

## What this delivers

Voice and video calls between people who share a space. When this block is
done:

- you can **call someone** in any space you share with them. Their devices
  ring wherever they are in the app;
- a space can have **a call going on** that anyone in it can join, the way a
  Discord voice channel or a Slack huddle works. It doesn't ring anyone; it
  shows quietly as "3 people in a call";
- **the call stays up while you move around.** Open another space, switch
  tabs inside it, go back to the space list: you keep talking. A small bar
  says where the call is, and a floating video tile shows the others;
- the video and sound go **straight between the people in the call**,
  encrypted, and no one in the middle can listen in. That includes the relay,
  which already can't read the spaces.

It is a **library module plus an app**, not a new kind of thing in the
protocol. Three small protocol changes make it possible: live messages from
BLOCK-16, spaces that stay open while anything needs them, and TURN
credentials from the relay.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'send(spaceId' src/node/types.ts && \
grep -q 'export function createRTCTransport' src/network/rtc-transport.ts && \
grep -q 'binding' src/network/peer-auth.ts && \
grep -q "id: 'chat'" example/src/components/apps/index.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — live messages (BLOCK-16 part 1) aren't built yet, or the project does not typecheck"
```

**Depends on** BLOCK-16 **part 1 only** (live messages, and knowing which
account a peer belongs to). The rest of BLOCK-16 (contact key, contact list)
isn't needed: you can call anyone in a space you share. With contacts built,
"call Anna" means "call Anna in your space for two", and nothing here changes.

---

## Where it comes from

Nothing here is new. It's three well-known designs put together:

| Part | Borrowed from |
|---|---|
| Call setup sent as messages inside the room you share | Matrix 1:1 VoIP (`m.call.invite` / `answer` / `candidates` / `hangup`) |
| A call belongs to a room, everyone connects to everyone, membership shown by people who are in it | Matrix group calls (MSC3401, Element Call's full mesh mode) |
| Stay in the call while browsing; bar at the bottom of the sidebar | Discord voice channels, Slack huddles |
| Changing the call (camera on, screen share) without glitches when both sides act at once | WebRTC "perfect negotiation" (W3C/MDN pattern) |
| Short-lived TURN passwords handed out by a server you already trust | The TURN REST API (coturn's `use-auth-secret`) |
| Video that keeps showing when you switch browser tabs | Document Picture-in-Picture API |

Weave only adds the glue: the "room" is a space, the messages are
`node.spaces.send`, and whether you may join comes from the space's roles.

---

## Why the relay can't listen in

In most WebRTC apps the call setup goes through a server, and that server
could swap in its own encryption keys and sit in the middle. Here it doesn't
go through a server. The setup (each side's offer, which includes the
fingerprint of its encryption key) goes as **live messages over the space's
existing peer connection**. That connection's handshake already proves who is
on the other end (`src/network/peer-auth.ts`, bound to the channel's own
fingerprints). So the offer you receive really came from Anna's device, and
the browser refuses media from any key other than the one it names.

The relay only introduced the two devices in the first place. It never sees a
call.

---

## 1. Spaces stay open while anything needs them

**The problem.** The hook for a space's screen opened the space when the
screen showed it and called `node.spaces.close` when the screen went away. `close` shuts the space
down whatever else is using it (`closeRuntime` in `src/node/node.ts`). So
navigating away from the space your call is in would cut the connection the
call's setup and hang-up messages travel over.

**The change.** `open` and `close` are replaced by `hold`, which hands back
a function that lets go of that one hold:

```ts
const screen = await node.spaces.hold(spaceId);
const call = await node.spaces.hold(spaceId);
await screen();   // the screen goes away: the call still holds it
await call();     // the call ends: nothing holds it, it stops syncing
```

A hold can only let go of itself, and letting go twice does nothing, so no
screen can close a space out from under a call. The hook is now
`useHoldSpace`. Contacts (later) hold the spaces you want to be reachable in.

The hook lets go a few seconds late, so quickly clicking back and forth
doesn't tear down and rebuild the space's sync.

## 2. Live messages to one device

BLOCK-16 part 1 sends to everyone in a space, or to one **account**. A call
needs one step more: when Anna answers on her laptop, the call goes to the
laptop, and her phone stops ringing. So:

- a `message` event carries `from` (the account DID) **and** `peer` (the
  device's session DID);
- `to` accepts either an account DID (all its connected devices) or a
  session DID (that one device).

A small addition to BLOCK-16's API. If BLOCK-16 is built first, this is a
one-line change there; if not, build it that way from the start.

## 3. TURN, so calls work on strict networks

Weave only lists Google's STUN servers. They help two browsers find each other,
but on some office, hotel and mobile networks a direct connection is
impossible. Sync gets by because it falls back to a WebSocket through the
relay. Video can't. Without TURN, somewhere around one call in ten won't
connect.

- Run **coturn** next to the signalling server (another Fly app), set up with
  a shared secret (`use-auth-secret`).
- The relay hands any socket that has joined a room a **TURN username and
  password that expire after a few hours**, computed from that secret. That's
  the TURN REST API; nothing is stored. The relay doesn't check who a socket
  is, so coturn's own quotas are what stop freeloaders.
- The node passes them into `iceServers` for **call** connections. Sync
  connections can use them too, but that's not required for this block.

TURN forwards encrypted packets it can't read. It costs bandwidth, so it's
the one piece of this block with a running cost, and it's only used when a
direct connection fails.

## 4. The call module: `weave-protocol/calls`

The call logic lives in the library, not the example app, so any Weave app
can have calls. It's built only from `spaces.hold`, `spaces.send`,
`spaces.access` and the browser's WebRTC. It adds nothing to the protocol.

```ts
const calls = createCalls(node, { iceServers });

calls.start(spaceId, { video: true });           // a call in this space, or join the one going on
calls.ring(spaceId, annaDid);                    // start, and ring Anna's devices
calls.answer(ringing.id);  calls.decline(ringing.id);
calls.leave();
calls.setMuted(true);  calls.setCamera(false);  calls.shareScreen();

calls.current      // the call you're in: space, people, their streams, your mute state
calls.ringing      // calls ringing you now, from any held space
calls.around       // calls going on in spaces you have open, that you're not in
calls.subscribe(listener)
```

React gets `useCalls()` from `weave-protocol/react`.

### Rules the module keeps

- **One call at a time per app.** Joining another call asks first:
  "Leave the call in Book club and join this one?" (Discord does the same.)
- **The call belongs to the space, not to the screen.** It keeps the space
  open (part 1), and it's created once per node, above all navigation.
- **Only people who may write in the space can join its call.** Before
  answering someone's offer, the module checks their role (`spaces.access`).
  View-only readers of a public space can't join, or listen. A public space's
  call UI says "anyone who joins this space can join the call".
- **Group calls don't ring.** They show up in `around`. Only a `ring` aimed at
  one person rings, so a 200-person space can't make everyone's laptop go off.
  Contacts you've blocked (BLOCK-16's `blocked`) don't ring.
- **Everyone connects to everyone** (full mesh). Each pair of people has its
  own media connection, separate from the sync connection. Hanging up closes
  it and sync carries on. That works well up to about **6 people with video**,
  more with sound only. The UI stops offering video past that; see
  "Left out" for bigger calls.

### The messages

All live (`node.spaces.send`), never stored, JSON with `type` starting
`call.`:

| Message | Sent to | Meaning |
|---|---|---|
| `call.here { call, since, camera, muted }` | everyone in the space, every 5 s | "I'm in this call." No heartbeat for 15 s means gone. This is how `around` and the people list are built |
| `call.ring { call }` | one account | Ring its devices |
| `call.answered { call }` / `call.declined { call }` | the caller's account | Stops the ringing on your other devices too |
| `call.signal { call, description? , candidate? }` | one device | Offer, answer, network candidates |
| `call.leave { call }` | everyone in the space | Leaving now, instead of waiting for the heartbeat to stop |

**Who sends the offer:** someone joining sends an offer to each person already
in the call. After that, renegotiation (camera on, screen share) uses
perfect negotiation, with the lower session DID as the "polite" side.

**Two calls started at once** in the same space, like both of you pressing
"Call" in the same second: whoever sees a `call.here` with a smaller call id
than their own moves into that call. Everyone ends up in the same call.

**Leaving and rejoining:** a page reload ends the call. The module remembers
the call id in `sessionStorage`, and if a `call.here` for it still turns up,
the app offers "Rejoin the call in Book club".

## 5. Call history: `std.call` (small, optional)

Live messages vanish, so without a record, "Anna called while you were away"
is lost. One standard schema, written only when something is worth
remembering:

```ts
export const call = {
  name: 'std.call',
  title: 'Call',
  schema: {
    type: 'object',
    properties: {
      to: { type: 'string' },                          // who was rung, for a missed call
      status: { enum: ['missed', 'ended'] },
      startedAt: { type: 'string', format: 'date-time' },
      endedAt: { type: 'string', format: 'date-time' },
      people: { type: 'array', items: { type: 'string' } },
    },
    required: ['status', 'startedAt'],
  },
  rules: { edit: 'creator', delete: 'creator' },
} as const satisfies DefineCollection;
```

- A ring nobody answered: the caller writes `missed`, with `to`. Anna's app
  shows "Missed call from Leif" when her device next syncs the space.
- A call that ended: whoever was in it longest writes `ended` with who was
  there. It's in the space, like Chat's messages. The Chat app can show it
  between messages.

Written in the call's space and nowhere else. It's the only thing a call
stores.

## 6. The example app

### Where the call lives

`Workspace` in `example/src/App.tsx` is the shell that stays on screen while
spaces change. The call goes there, not in `SpaceView`:

```
<CallsProvider>                 ← createCalls(node) once, for the whole app
  <SpaceRail … />               ← dots on spaces with calls; call bar at the bottom
  <SpaceView key={open.id} />   ← comes and goes as you navigate
  <CallTile />                  ← floating video, when the call isn't the page you're on
  <IncomingCall />              ← "Anna is calling — Answer / Decline", on any page
</CallsProvider>
```

`SpaceView` can come and go as you navigate because the call never lived in it.

### What people see

- **The call bar**, pinned to the bottom of the space rail while you're in a
  call: the space's name, how long you've been talking, mute, camera, hang
  up. Clicking the name takes you to the call.
- **The floating tile** shows the others' video in a corner when you're
  somewhere other than the call's own page. You can drag it and shrink it to
  just faces. A button moves it into a **Picture-in-Picture window**, so it
  stays visible when you switch to another browser tab.
- **The Call app** in each space's Apps tab is the full view: a grid of
  people, "Start a call" / "Join (3 people)". It needs no collections, so it's
  offered in every space. It uses `std.call` if the space has it.
- **The rail** marks spaces with a call going on: a small speaker dot and the
  faces of the people in it (from `calls.around`). You only see this for
  spaces you're connected to. See "Being reachable".
- **"Call" beside a person** in People & roles rings them, in that space.
- **Ringing** shows as a card on whatever page you're on. Camera and
  microphone permission are asked for only when you answer or start a call,
  never earlier.

### Being reachable

You can only hear a ring in a space your app is connected to. What's
connected in this block:

- the space you're looking at;
- the space your call is in;
- with contacts built (BLOCK-16): your contacts' spaces for two. The app keeps
  them open while it runs.

Keeping many spaces open is cheap on the network now: the mesh
(`src/network/mesh.ts`) uses one socket per relay and one WebRTC connection
per pair of devices for every space they share, and a space is only a room on
them. What each open space still costs is its own store and sync. That's fine
for a few dozen contacts. Ringing with the app closed needs Web Push and a
server that can wake a phone, and that isn't in this block.

### Why the call gets its own connection

Two devices already share one WebRTC connection for all their spaces. Video
could ride on it, but adding video means renegotiating that connection, which
every space's sync depends on, and hanging up would mean renegotiating it
again. So a call opens **its own connection per pair of people**, set up by
live messages that travel in the space's room on the shared connection. Sync
never notices a call starting or ending.

---

## Attacks to close

Add to `tests/attacks.test.ts`, failing before and passing after:

- An offer from a peer with no write role in the space is ignored, so a
  view-only reader can't join or listen.
- A `call.signal` from one device naming another device's session as the
  sender is dropped. The sender is whoever the handshake proved, never a
  field in the message.
- A `call.ring` from an account the recipient has blocked doesn't ring.
- Rings are rate-limited per sender (say, 3 a minute), so nobody can ring you
  endlessly.
- A space closed by the screen showing it stays open while a call
  has it open. Once the call ends and nothing else has it open, it closes.

## Done when

- Two browsers in a private space: one presses Call, the other rings and
  answers, and both see and hear each other. Nothing but the optional
  `std.call` is written to either store.
- During the call, both people open other spaces, switch tabs inside them and
  go back to the space list, and the call keeps going. The rail's call bar
  and the floating tile stay on screen.
- Three people join a call in a group space. None of them was rung, and a
  fourth member sees "3 people in a call" on the rail and can join.
- Anna has the app open on two devices: both ring, she answers on one, and the
  other stops.
- With TURN on and direct connections blocked (Chrome with
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` or similar),
  the call still connects.
- An unanswered ring leaves a `std.call` "missed" that the other person sees
  later.
- The README describes calls, `spaces.hold` and `std.call`, and this block is
  removed.

## Rough size

~1½ weeks, not counting BLOCK-16 part 1:

| Part | Size |
|---|---|
| `spaces.hold` (part 1) | ½ day |
| Device addressing on live messages (part 2) | ½ day |
| coturn + credentials from the relay (part 3) | 1 day |
| `weave-protocol/calls` (part 4) | 4 days |
| `std.call` (part 5) | ½ day |
| Example app: provider, bar, tile, ringing, Call app (part 6) | 3 days |

---

## Left out, on purpose

- **Big calls.** Past ~6 video streams, full mesh runs out of upload
  bandwidth. The known fix is a forwarding server (an SFU) with
  end-to-end encryption on top (SFrame, as Jitsi and Webex use), so the server
  forwards video it can't watch. A host (BLOCK-07) could run one. That's a
  block of its own.
- **Calls across apps.** A call lives in the app that started it. Another
  Weave app on another origin doesn't see it. Moving a call between apps
  would need the account home to hold it, and there's no reason to yet.
- **Ringing with the app closed.** Needs Web Push. The extension (BLOCK-17)
  is always running while the browser is open and could ring. Worth a look
  after this.
- **Recording.** Not now. When it comes, everyone in the call has to see that
  it's on.

## Open questions

- **Readers listening in.** This block keeps view-only readers out of calls
  entirely. A "webinar" space where readers may listen but not talk could
  come later as a role permission: `call: 'listen' | 'talk'`.
- **Phones.** Mobile browsers may pause a page that isn't on screen, which
  drops the call when you switch apps. A PWA helps a bit; a native wrapper is
  the real answer. Tested on desktop first.

---

## Still open

- **Run coturn.** The relay hands out TURN passwords once `TURN_SECRET` and
  `TURN_URLS` are set, but no TURN server is running yet. It needs a coturn
  deployment (a Fly app next to the relay works: UDP 3478, TLS 5349) with
  `use-auth-secret` and quotas, and the two secrets set on both. It's the
  one part with a running cost.
- **Test across real networks and on phones.** Tested so far: one machine,
  Chrome's fake camera, a local relay. Still to try: two devices on different
  networks, one behind a strict NAT (to see TURN used), Safari, and a phone
  switching apps mid-call.

### Where the build differs from the plan

- **Knowing who a peer is** is a message each side sends right after the
  handshake (its note), not an addition to the handshake. See BLOCK-16's
  status note.
- **No call bar in the sidebar.** The sidebar is too narrow for controls, so
  the call bar and the floating video are one panel in the corner, which can
  grow to fill the screen. The sidebar only marks the space the call is in.
- **The Calls app is a call log** (it defines `std.call`), not the only place
  to start a call: "Start a call" / "Join call" sits at the top of every space.
- **No renegotiation.** Every call connection is made with an audio and a
  video slot from the start. Turning the camera on or sharing the screen
  swaps the track in the slot, so the "perfect negotiation" pattern isn't
  needed; the lower session DID always makes the offer.
- **`useHoldSpace` lets go 3 seconds late** rather than the node waiting, so
  letting go of the last hold closes a space at once, which tests that take
  a node offline rely on.
