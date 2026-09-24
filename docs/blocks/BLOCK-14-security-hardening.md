# BLOCK-14 — Security hardening, round two

## What this delivers

The parts of the September 2026 security audit that change the protocol's
design rather than fix a bug in it. When this block is done:

- nobody can freeze a record, or take over who created it;
- removing someone from a space actually cuts them off;
- pairing a phone no longer puts the whole account on screen;
- a private space no longer gives away who voted for what;
- one peer cannot make another do unbounded work.

The first round is done and described in the README: handshakes on every
connection, hashed relay rooms, relay limits, the write key sealed at rest,
first-version checks in rules, keys that cannot be copied out of the page, and
delegations with a start and an end.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'const firstOf' src/node/space-runtime.ts && \
grep -q 'createMeshAuth' src/network/peer-auth.ts && \
test -f tests/attacks.test.ts && \
node --experimental-vm-modules --import tsx --test tests/attacks.test.ts >/dev/null 2>&1 && \
echo READY || echo "NOT READY — the first round of fixes is missing"
```

Each part below comes with a way to show the attack. Add each one to
`tests/attacks.test.ts` as a test that fails before the fix and passes after
it. That file's `forge()` helper signs whatever version a member likes.

---

## 1. Versions whose history can be checked

**The problem.** Which version is current is decided by `seq`, then by id
(`records/version.ts`). `seq` is whatever the writer puts there, and only the
current version is kept, so nobody can check that it is one more than the
version before. Two attacks follow, both open to any member of a shared space:

- **Freezing a record.** Write a version with `seq: Number.MAX_SAFE_INTEGER`.
  Nothing can ever outrank it, because `seq + 1` is no longer a safe integer and
  every peer refuses it. With a `sys.*` collection, or any collection other than
  the record's, it also hides the record, since `consistent()` hides a version
  whose collection differs from its first version.
- **Taking over a creator.** The first version a node keeps for a key is the
  one with the lowest id (`storage-provider.ts`, `demote`). A member writes their
  own `seq: 0` for someone else's key, and retries different `createdAt` values
  until its id sorts lower. This takes a few tries on average. `createdBy`, the
  `creator` rule and `can()` then name the attacker. For `collection:<name>`,
  `definedBy` becomes the attacker, who can then redefine the collection.

**The shape of a fix.**

- *Checkable `seq`.* Keep a small signed header for every version, even when its
  body is dropped: key, seq, prev, author, and the id of the body. A version is
  accepted only when `prev` names a header with `seq − 1`, whose own chain goes
  back to the first version. This costs about a hundred bytes per edit, so a long
  history might be compacted later with a checkpoint signed by the owner.
- *Keys that belong to their creator.* A random key becomes
  `hash(creator root DID ‖ nonce)`, with the nonce carried in the first version,
  so a first version by anyone else fails the check. A key the caller chooses
  (`collection:…`, `put({ key })`) gets the creator's root in its namespace, as
  `profileKey` already does, or a rule that the owner's first version beats
  everyone else's.
- Once those two hold, a version whose collection differs from its first
  version can be refused when it arrives, not just hidden when it is read.

**Watch out.** The ordering rule is load-bearing forever, and nodes running
two versions of it disagree about which version is current. Pin the new rule
with tests, like the old one. It is pre-release, so there is nothing to
migrate (see the memory note on migrations).

---

## 2. Removing someone from a space

**The problem.** The space id is a hash of the space's genesis, which includes
the read key and the write key (`space/space-access.ts`). So neither key can
ever change, and someone invited stays invited. After you "remove" them they
can still read everything and write. `members` is only for display, and an
invite's member list is taken as given. `privacy-guard.rotateSpaceKey` exists,
but nothing calls it.

**The shape of a fix.** Key epochs. The genesis names the *owner's* key and
epoch 0. A new epoch is a record signed by the owner (or a role the rules
allow) that names the new public read and write keys. It carries the new
secrets sealed to each remaining member, using `privacy/key-distribution.ts`,
which already does ECIES-style wrapping. A record is valid under the epoch
current when it was written. Readers keep old epochs' keys to read old data.
Where epochs are too much, a "move to a new space" flow is the blunt version:
copy what is current into a fresh space, and invite everyone but them.

Be honest in the UI about what removal can do. Someone removed keeps whatever
they already downloaded.

---

## 3. Pairing without showing the account

**The problem.** The pairing QR (`example/src/pairing.ts`) carries the full
recovery code. A photo of the screen, a screen share or a recording is the
account, for good. The room id is a hash of the seed, so a relay gets a
lasting tag for the account. And sealed handovers can be replayed, because the
pairing key is always the same.

**The shape of a fix.** The QR carries a random one-time secret and the relay
URL, nothing else. The two devices meet in a room named by a hash of that
secret, and run a key exchange authenticated by it: ECDH, with each side
proving it knows the secret. The desktop sends the seed only over that channel,
after the person confirms a short code shown on both screens. The secret
expires in a couple of minutes and after one use.

The same arrival screen should warn clearly when a `#pair=` link would sign
into a *different* account than the one already here. Today a link someone
sends you can sign you into their account in one tap.

---

## 4. Private votes

**The problem.** `onePer` keys (`records/rules.ts`) are plain hashes of the
collection, the author, the link target and body fields. The key travels in
the clear even in a private space. So anyone holding the ciphertext (a relay
peer, a host, a mirror's provider) can guess and check who voted on which
poll. Where a body field has few possible values, they can also work out the
value. `profile:` keys are the same: anyone can confirm which known accounts
are in a space.

**The shape of a fix.** In a private space, derive these keys with HMAC under
a key derived from the space key, so only readers can compute or check them.
Every reader derives the same key, so rules still check the same way on every
reader. A peer without the key already accepts rule verdicts it cannot check
(`'unreadable'`). This pairs with encrypting collection names (see "Written
down" in the README).

---

## 5. Rules that stay in force

**The problem.** A new record pins the definition it was written under (`def`),
and the writer chooses it. Pinning an old version without the new `onePer`
rule passes, and isn't even flagged. Leaving `def` out also passes, and is only
flagged. Queries, `linked` and tallies don't look at `conforms`, so a double
vote is counted.

**The shape of a fix.** When a record is read, flag a record whose pinned
definition is not the current one, if the rules differ. Queries and `linked`
should leave out records that don't conform unless asked for them. A record
written today with no `def`, in a collection that has rules, could simply be
refused.

---

## 6. Limits on how much work a peer can cause

Smaller, and each one on its own:

- **`sync-request`** with a `rootCid` from inside the victim's own tree makes
  it walk the whole tree, as often as the peer asks. Limit the rate per peer,
  and cache the set of reachable nodes per root.
- **Waiting records.** Up to 1,000 records waiting for their first version or
  definition, of any size. Every successful admit retries all of them. Cap
  their total size and the retry work per round.
- **Tree nodes** have no limit on `keys` or `children`, and the walk's queue can
  grow past `MAX_NODES_PER_WALK`. Cap fan-out per node, and the total queued.
- **Byte rate per peer** on every transport, and a cap on half-open connections
  from introductions.
- **The sync payload** travels as a JSON array of numbers (`space-runtime.ts`),
  about 4× its size. Base64 or binary frames.

---

## Smaller items found along the way

- **DIDs have more than one spelling.** `didToPublicKey` accepts any multicodec
  prefix, and compressed or uncompressed points. Require the P-256 prefix and
  33 compressed bytes.
- **Signatures can be rewritten into a second valid form.** WebCrypto accepts
  high-S ECDSA signatures, and `atob` tolerates non-canonical base64. Either
  changes a UCAN's `cid` without breaking it. Refuse high-S, and decode strictly.
- **UCAN header** `alg`, `typ` and `ucv` are not checked, and neither is the
  shape of `att` or `prf`.
- **The recovery code has no checksum**, so a typo quietly signs in to a new,
  empty account. Add a check character (pre-release, so the format may change).
- **Unwrapped seeds are not checked against the account.** After a password or
  passkey unlock, compare the seed's DID with the account's. Use the DID and wrap
  id as AES-GCM additional data, and enforce a minimum PBKDF2 count read from the
  file.
- **Leftover password derivation** in the public API (`keys.ts`,
  `identity-manager.fromPassword`) uses 100k PBKDF2 rounds and a fixed salt.
  Nothing calls it. Remove it.
- **Account copy** (`node/copy.ts`) stores records without validating them, as
  folder reconcile used to.
- **Socket to a node over `ws://`.** A client can pin the node's DID in the URL,
  and refuse `ws://` except to this machine.
