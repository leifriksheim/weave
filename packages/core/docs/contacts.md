# Contacts

A contact is someone you share a **private space for two** with. The account
keeps its list of them in its contacts space, and asks someone to become a
contact by posting a sealed invite in a space both belong to.

This is a convention built on the protocol, not part of it. Peers that have
never heard of `std.contact` or `std.contact-request` sync, store and judge
them like any other record. Only apps that want to read each other's contact
lists and requests have to agree on what follows. It uses these protocol
parts: the contacts space ([spec 03 §13.1](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)),
profiles (§11), invites (§7), and the contact key and `sealFor`
([spec 01 §9.1, §9.4](https://github.com/leifriksheim/weave/blob/main/spec/01-identity.md)).
Asking someone you share **no** space with goes through a door
([spec 07](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md)).

## The list: `std.contact`

The list lives in the account's contacts space (derived with the label
`weave/contacts`), one record per person:

```
std.contact  (rules: onePer ["did"])
{ did: string ≤256, name: string ≤200, space?: string ≤256, note?: string ≤2000,
  blocked?: boolean, door?: string ≤64 }
record key = onePerKey("std.contact", ["did"], …)
           = "one:" + hex40("std.contact\ndid=" + JSON.stringify(did))     // spec 02
```

`name` is what you call them; they never see it. `space` is the id of the
space for two. `blocked` hides that person's contact requests in every space.
`door` is set while a knock's answer is still to be written ([spec 07](https://github.com/leifriksheim/weave/blob/main/spec/07-doors.md)).

A reader must ignore a record whose key is not the one its `did` derives. It
also ignores one whose root is not the account, as it does for every record in
the account's derived spaces (spec 03 §13.1).

## The contact key

A request is sealed to the askee's contact key: the public half, published as
`contactKey` on their profile in the space (spec 03 §11). How it is derived is
in spec 01 §9.1. A node holds the private half only when it was given it
(`config.contactKey`); an agent never is.

## `std.contact-request`

```
std.contact-request  (rules: edit "creator", delete "creator"; create: any member)
{ to: <askee account DID, ≤256>, sealed: string ≤16000 }
```

Posted in a space both people belong to. In a private space the body is also
encrypted with the space key, so other members see that `to` was asked, not
what.

### Sealing

```
value   = { invite: <role invite to the space for two>, note?: string ≤2000 }
context = "weave/contact-request|<spaceId>|<askerAccountDid>|<askeeAccountDid>"
sealed  = sealFor(askee.contactKey, value, context)
```

`sealFor` is the seal of spec 01 §9.4. A sealed `{"invite":"x"}` is
65 + 12 + 14 + 16 = 107 bytes.

Example: in space `bspace`, `did:key:zA` asking `did:key:zB` seals under
`weave/contact-request|bspace|did:key:zA|did:key:zB`.

### Opening

The receiver must open a request only when the record verifies and stands, is
not written under an agent note, is in `std.contact-request`, `to` is the
receiver's account, and `from` (the record's root) equals the root of the
record's first version and is not the receiver. It must use the context built
from the space the record is in and that `from`. It must then reject the value
unless `invite` parses as an invite (spec 03 §7.4) to a **private** space whose
`creator` is `from` and which carries a `key`.

Binding the seal to the space and to who asked whom means a request copied
into another space, or re-posted by someone else, does not open.

## `node.contacts`

- `space()`: the contacts space's id, or null for a node not given it.
- `list()`, `get(did)`: the list, blocked people too, by name.
- `put({ did, name, space?, note? })`: adds someone, or changes what the list
  says about them.
- `ask(space, did, { note? })` needs whole-account access and the askee's
  `contactKey` on their profile in that space. It defines
  `std.contact-request` in the space if missing (needs `define`), creates a
  private `team` space named `"<my name> & <their name>"`, opens an `editor`
  invite to it, writes a `std.contact` for them with that space, then posts
  the sealed request. It returns the space for two and the request's key.
- `requests(space)` lists requests that open for this account, skipping
  blocked senders and requests whose space for two the account already holds.
- `accept(space, requestKey)` joins the invite (spec 03 §7.6) and writes a
  `std.contact` for the asker with the space for two. There is no reply
  record: joining is the answer.
- `remove(did)` leaves the space for two (locally, spec 03 §6.2) unless
  another contact names it, and deletes the `std.contact`.
- `block(did)` leaves the space for two likewise and writes the contact with
  `blocked: true`.
- `others(did)` lists accounts other than the two seen in the space for two
  (members, profiles, connected peers).

`ask` and `accept` need a session note with `with: "*"`. An app granted
`contacts` sees the list and requests, but may not ask or accept
([spec 06 §2.5](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)).

_Source: `packages/core/src/schemas/contacts.ts`, `packages/core/src/identity/contact-key.ts` (`sealFor`, `openSealed`, `deriveContactKeyBytes`), `packages/core/src/node/node.ts` (contacts section: `requestContext`, `openRequest`, `contacts`), `packages/core/src/node/types.ts` (`NodeContacts`), `packages/core/src/space/account-registry.ts` (`deriveContactsSpace`). Tests: `packages/core/tests/contacts.test.ts`, `packages/core/tests/attacks.test.ts`._

## Planned: requests that can be taken back

A list that never names a space the account left, and requests that can be
taken back. Today the `std.contact` does not record where `ask` posted the
request, so `remove` and `block` leave it standing: the askee can still accept
it, into a space nobody holds. And `spaces.leave` on a space for two leaves the
`std.contact` naming it.

- `std.contact` gains `asked?: { space: string ≤256, key: string ≤256 }`, the
  space and record key of the request. `ask` writes it.
- `remove(did)` and `block(did)` delete the `std.contact-request` at `asked`
  when the space is still held and the record still stands, before leaving the
  space for two.
- `spaces.leave(id)` on a space a `std.contact` names does what `remove` does
  for that contact.
- `ContactView` gains `waiting: boolean`, true while the other account has no
  member record in the space for two.

Tracked in [#40](https://github.com/leifriksheim/weave/issues/40).
