# BLOCK-16 — Contacts and direct messages

> **Status (2026-09-25):** part 1, live messages, is built (on branch
> `calls`, for BLOCK-21) and described in the main README. It differs from
> the plan below in one way: the account behind a peer isn't added to the
> mesh handshake. Each side sends its note as the first message after the
> handshake instead, and the receiver checks the note was made out to the key
> the handshake proved. That works the same over every transport (the mesh, a
> node's socket, a test's), not only the mesh. `to` also takes one device's
> session DID. Parts 2–6 are still to do.

## What this delivers

A way to keep people, not only spaces. When this block is done:

- you can send **live messages** to the people in a space: chat that isn't
  kept, presence, typing, call setup. Nothing is stored;
- you keep a **contact list** that every app you allow can read, the same on
  every device;
- inside any space you share, you can **ask someone to add you** as a contact.
  Only they can read the invite, even though it sits in a space others can
  read;
- **knowing someone's DID gets you nothing.** No one can reach you unless you
  gave them a way to, and each way is for one person and can be closed on its
  own.

On purpose, it has **no directory** (no "look up @anna") and **no public
inbox** (no address strangers can knock on). Both would need an authority or
bring spam, and nothing here needs them.

Only two parts touch the protocol: **live messages** (part 1) and the
**contact key** (part 2). The rest is two standard schemas and two helpers,
built from spaces as they are.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'export function createMeshAuth' src/network/peer-auth.ts && \
grep -q 'export async function profileKey' src/node/space-runtime.ts && \
grep -q 'export async function wrapSpaceKey' src/privacy/key-distribution.ts && \
grep -q "PROFILE_COLLECTION = 'sys.profile'" src/space/account-registry.ts && \
grep -q "name: 'std.reaction'" src/schemas/index.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — the mesh handshake, profiles, key wrapping, the account registry or the schema library is missing, or the project does not typecheck"
```

**Depends on** nothing else. The contact key is published on your profile
(`sys.profile`), which exists today. Spaces an app creates still need the
account home to add them to the account registry. That's an open item from the
account home work, and pair spaces run into it like any other space.

Each part says what attack it must close. Add those to
`tests/attacks.test.ts`, failing before and passing after.

---

## The idea in one paragraph

A DID is a **name, not an address**. It shows up on everything you sign, so it
can't be what lets someone reach you. What lets two people reach each other is
a space they share. So a contact is **a private shared space with two
members**: records you write there wait for the other person, and live
messages you send there reach them if they're online. Your contact list is a
record per person, naming their DID and that space. You add someone by giving
them the space's invite: by link or QR, or inside a space you already share,
**sealed** with their contact key so only they can read it.

| | Today | After |
|---|---|---|
| Reaching one person | A space for two, invite shown to everyone | A space for two, invite sealed for them |
| Messages that aren't stored | Not possible | `node.spaces.send` |
| Who a connected peer is | A session key | The account behind it |
| Where contacts live | Nowhere; each app invents it | A derived contacts space, `std.contact` |
| Telling a contact's space apart | — | Your contact list points at it |

---

## 1. Live messages

### What to build

```ts
node.spaces.send(spaceId, message, to?)   // to everyone connected, or one account
node.subscribe((event) => {
  if (event.type === 'message') event.space; event.from; event.message;
});
```

- Live messages get their own network message type next to `sync`, so they
  never reach the sync engine. They are never signed as records, never
  written, never synced. A peer who isn't connected misses them. That's the
  point.
- They travel over the space's existing peer connections (WebRTC data
  channels, encrypted between the two ends). In a private space those
  connections only exist between people holding the space's read key, so a
  relay, or a stranger who learns the room, gets nothing.
- `to` sends to one account's connected devices only. The others in the space
  never receive it.
- Limit size (64 KB) and rate per peer, as the relay does.

### Knowing who sent it

The mesh handshake (`src/network/peer-auth.ts`) proves the peer holds the
**session key** its DID names. That was enough for sync, because each record
carries its own note back to the account. A live message carries no note, and
you need to know it's Anna, not "some key".

Add the session's note (the UCAN from root to session, the one records already
carry as `proof`) to the handshake's `proof` message. The checking side
verifies it names this session key as its audience and hasn't expired, and
then knows the peer's **account DID**. `event.from` is that DID. This also
lets presence show people, not devices.

**Attacks to close:** a peer presenting someone else's note with its own
session key is refused (the note names a different audience). A live message
sent `to` Anna doesn't arrive at a third member's node.

## 2. The contact key

Sealing something for one person needs a key of theirs that can decrypt, and
that works when they're offline. The options, and why it's this one:

- **The account's root key** can only be used by the account home (apps never
  hold the seed), so every contact request would open the home. Using one key
  to both sign and encrypt is also poor practice.
- **A session key** is per device and replaced every hour. A request read next
  week would be locked to a key that's gone.
- **A contact key**: a P-256 ECDH key pair derived from the seed like the root
  key, with its own label (`weave/p256-contact-key/v1`). It's the same on every
  device and comes back with the recovery code.

Where its halves go:

- **Public half:** on your profile (`sys.profile`) in every space you write
  in, as `contactKey`. A profile is keyed by its account and only counts when
  signed under that account's note (`profileKey` in `space-runtime.ts`), so
  the key is yours and not someone else's. It isn't on your member record
  (BLOCK-15), because admins write those.
- **Private half:** kept by the account home, and given to apps you allow to
  handle contacts. It travels the same way the whole-account grant already
  carries the registry key (`src/session/connect.ts`). The connect screen says
  so in plain words: "can read contact requests sent to you".

**Attack to close:** a contact key published on a profile signed by a
different account is ignored.

## 3. The contact list

Contacts live in a **contacts space**, derived from the account's vault key
the same way the account registry is (`src/space/account-registry.ts`, the
`expand` helper), with its own label (`weave-contacts/v1`). Nothing needs
exchanging to find it, every device of the account has it, and nobody else can
find it.

It is its own space, not part of the registry, so the home can grant an app
**contacts without the whole account**: it's one more space in the existing
per-space grant.

```ts
export const contact = {
  name: 'std.contact',
  title: 'Contact',
  description: 'Someone you can reach, and the space you share with them.',
  schema: {
    type: 'object',
    properties: {
      did: { type: 'string' },
      name: { type: 'string', maxLength: 200 },
      space: { type: 'string' },     // the id of your space for two
      note: { type: 'string', maxLength: 2000 },
      blocked: { type: 'boolean' },
    },
    required: ['did', 'name'],
  },
  rules: { onePer: ['did'] },
} as const satisfies DefineCollection;
```

The space's invite doesn't need to be stored here. Joining it already put it in
the account registry, which is how your other devices join it too.

`blocked: true` with no `space` is how you block someone: your apps hide their
contact invites in every space.

### Telling spaces apart, with no tag

Spaces have no "kind" field, and this block doesn't add one. An app that wants
to draw a contact's space differently has two things to go on, and both exist:

- **Your contact list.** A space is "the space with Anna" because your
  `std.contact` for Anna names it. The relationship lives with you, not in the
  space, so Anna's list and yours can each call it what they like.
- **What the space holds.** `node.collections.list(spaceId)` returns every
  collection defined in the space and every collection with records in it. A
  space holding `app.chat.message` is a chat; one holding `app.todo.item` is a
  list. That's how apps already work in Weave: the data's type decides the view.

## 4. Asking to be added: `std.contactInvite`

```ts
export const contactInvite = {
  name: 'std.contactInvite',
  title: 'Contact request',
  description: 'An invite to a space for two, sealed so only one person can read it.',
  schema: {
    type: 'object',
    properties: {
      to: { type: 'string' },       // the recipient's account DID
      sealed: { type: 'string' },   // base64url, see below
    },
    required: ['to', 'sealed'],
  },
  rules: { edit: 'creator', delete: 'creator' },
} as const satisfies DefineCollection;
```

Two helpers next to it, so apps never handle the cryptography:

```ts
sealContactInvite(node, spaceId, toDid, { note?: string }): Promise<{ record; space }>
openContactInvite(node, record): Promise<{ from: string; invite: string; note?: string } | null>
```

`sealContactInvite` creates the space for two, seals its invite and posts it.
`openContactInvite` returns an ordinary invite string, which the app passes to
`node.spaces.join`.

**Sealing** follows `wrapSpaceKey` in `src/privacy/key-distribution.ts`: a
fresh ephemeral ECDH key, a shared secret with the recipient's `contactKey`
(from their profile in that space), then AES-GCM over `{ invite, note }`. The
additional data is `space id | from DID | to DID`, so a sealed invite copied
into another space, or re-posted by someone else, doesn't open.

**The flow:**

1. You press "Add Anna as a contact" in the book club. Your app creates a
   private shared space for the two of you, saves a `std.contact` for Anna
   naming it, and posts the sealed invite in the book club.
2. Anna's app sees a `std.contactInvite` with `to` = her DID, opens it, and
   asks "Leif wants to connect — 'it's Leif from book club'". Accepting joins
   the space and saves a `std.contact` for you.
3. Her profile turns up in the space. There's no reply record: joining *is* the
   reply.
4. If she ignores it, you delete the invite and leave the space after a while.
   Nothing leaked.

The same invite can also be given outside Weave, as a link or QR code. That's
how you add someone you share no space with.

**Attacks to close:** another member of the space can't open an invite meant
for Anna; an invite copied into another space doesn't open; a request whose
author isn't the account it claims to be from is dropped.

## 5. Conversations and groups

A space with two people in it can be two different things: a conversation
with Anna, or a group that happens to have two members so far. Counting members
can't tell them apart, so the difference is recorded when the space is made,
and it's recorded by how it was made:

- **"Add Anna as a contact"** makes a space *as* your conversation with her.
  Both of you record it in your contact lists (`std.contact.space`): you when
  you send the invite, she when she accepts.
- **"New space", then "Invite Anna"** makes an ordinary space. No contact
  record names it, so it's never treated as a conversation. It can have two
  members or two hundred, and inviting more people is just inviting.

The space itself carries no marker. Only the two of you should be in it, and
you both already have the marker in your own lists. A marker in the space would
also be a promise nobody can enforce: anyone holding the invite can still bring
someone in. "My conversation with Anna" is a fact about your relationship with
her, not about the space.

What apps do with that:

- **Adding a third person to a conversation** is a choice, not something done
  behind your back:

  > This is your conversation with Anna.
  > **Start a group with Anna and Bob** · Invite Bob here anyway

  The first option makes a new ordinary space and invites both of them. That
  way your contact record for Anna still means "just us", and Bob doesn't get
  your history with her: a private space has no per-member cut-off, so an
  invite into the old space would let him read back to the first message.
  The second option is allowed, because it's your space. Your `std.contact`
  for Anna then drops its `space`, and the app offers to make a new one for the
  two of you.
- **Someone joining uninvited** is visible. Every member who writes has a
  profile, and every connected peer shows up as an account (part 1). When a
  space your contact list names has a third account, the app says so: "Bob
  joined your conversation with Anna." You can leave and start a new
  conversation with her. She's still your contact; only the space changes.

## 6. Removing someone

Delete their `std.contact` and leave the space. Every contact has their own
space, so nobody else is affected. If they had passed the invite on, whoever
they gave it to loses the way to reach you at the same moment.

Live messages were never stored, so there's nothing to take back. Records
already written to the space stay readable to them, because a private space's
key can't be changed yet. That's BLOCK-14 §2.

---

## What is left out, on purpose

- **A separate "channel" below spaces.** A space for two does the same job.
  The only saving would be not creating a space, and a space the two of you
  rarely write to costs almost nothing.
- **A kind or tag on spaces.** See "Telling spaces apart" and part 5.
- **A directory.** No lookup by name or handle. You connect through a space you
  share or a link someone gave you.
- **A public inbox.** No address anyone can knock on. That's what keeps spam
  out.
- **Hiding who asked whom.** `to` is readable, so the other members see that
  you sent Anna a request, just not what's in it. Hiding it would mean every
  member trying to open every invite. Not worth it now.

## Open questions

- **One relay socket per room.** Each space is its own room, and today that
  means its own WebSocket per relay. With 200 contacts, staying connected to
  all of them isn't practical. First version: connect to a contact's space
  only while the conversation is open, and let a host keep it online for
  delivery. Later: the relay carries many rooms over one socket. That's a
  relay change, not a protocol change.
- **The relay sees session DIDs.** It could notice the same key turning up in
  many rooms. Session keys change every hour, which limits this.
- **Live messages in big spaces.** `node.spaces.send` to everyone in a
  200-person space is 200 sends. Fine for presence, not for anything heavy.

---

## Done when

- Two nodes in a private space exchange live messages, each sees the other as
  an account DID, and nothing is written to either store.
- A live message sent `to` one account doesn't reach a third member.
- A contact invite posted in a three-person space is opened by its recipient
  and not by the third member; copied into another space, it doesn't open.
- Accepting an invite leaves both people in a space for two and a
  `std.contact` on both sides, on every device of both accounts.
- An app granted only the contacts space can list contacts and open invites,
  and can't read the account registry.
- A space made with "New space" and then shared with one person is never
  treated as a conversation; a third account turning up in a space a contact
  names is reported.
- Removing a contact leaves that space; the other contacts' spaces keep
  working.
- The README describes live messages, contacts and the two schemas, and this
  block is removed.
