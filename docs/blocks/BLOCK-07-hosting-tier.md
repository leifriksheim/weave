# BLOCK-07 — Hosting: a device that never sleeps

## What this delivers

A paid service that keeps people's spaces online when all their devices are
off. One process serves many spaces for many people, and it is **blind**: it
never holds a seed, a vault key or a space key. It keeps encrypted records
moving and stored, checks that each one is signed and allowed, and can't read
or forge any of them.

What the user sees:

1. Settings, then **"Keep my spaces online"**, with one sentence: *your spaces
   stay reachable when your devices are off; we store them encrypted and can't
   read them.*
2. Pay. Done. No provider to pick, nothing to set up.
3. If they've connected storage (BLOCK-03, "Back up to…"), the host writes to
   that. If not, it writes to the host's own bucket in the same layout.

**You sell uptime.** Storage is the user's (BLOCK-03). A host is one more writer
into their folder, so switching host means handing another one the same folder.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
test -f cli/src/daemon.ts && test -f cli/src/serve.ts && \
test -f src/storage/mirror.ts \
  && echo "READY" \
  || echo "NOT READY — needs mirrors (BLOCK-03)"
```

**Needs BLOCK-03.** Without mirrors a host can only
keep data on its own disk, which works but isn't the design. BLOCK-04 adds the cloud drivers; until then,
use the directory driver.

---

## Why one machine can serve many people safely

What matters is what the host holds, not how many people share the box:

| If the host held… | A break-in would… |
|---|---|
| a seed | let the attacker become the user. **Never.** |
| space keys | expose every private space on the box. **Never.** |
| storage grants | give access to one app folder full of encrypted records |
| encrypted records | give nothing readable and nothing forgeable |

A blind host holds only the last two. A stolen grant reaches only the folder
the service scoped it to (a Dropbox or OneDrive app folder, Drive
`drive.file`, a bucket-scoped key), and that folder holds what the host already
holds. What an attacker *can* do is delete, which is softened by the service's
version history, by S3 object lock where available, and by every device's own
copy.

Today's `weave run` is the opposite: it unlocks an account and opens every
space with its key. That stays, for people running their own server. The hosted
mode is a different way to start the same node code.

### What the host still learns

Which spaces exist, their sizes, when they change, IP addresses, and record
envelopes: author, collection name, record key, `seq`. Say so in the privacy
copy. Encrypting collection names would help both the host and the mirrors; it
belongs to the protocol, not this block (see the blocks README).

---

## Design

### Spaces, not accounts

The host doesn't know accounts. It knows **subscriptions**, and a subscription
is a list of space ids plus a quota. No per-user node identity, no delegation
from the user's root: a blind node never signs a record, so it needs no
permission to write one. The host has one identity of its own, used only to
connect to peers.

This also gives a family plan without designing one: **a space stays online if
any member pays for it.** Share a space with your family and it's online for
all of them.

### Knowing who may write, without the key

The host runs the same gates as any peer. Crypto and capability work without
the key: a record carries its signature and its delegation, and a personal
space accepts only its owner, whom the space record names.

Shared spaces are closed too (README, *Who may write, checked without a
secret*): every record carries a second signature by the space's write key,
whose public half is hashed into the space id, and the host checks it with no
secret, as every peer does. Who may *read* a private space is checked the same
way, against the space's public read key (`createServerAuth`), and the space id
vouches for owner and type, so a device can't mislead the host about either.

### How a device hands spaces to the host

1. Paying creates a subscription and returns a **subscription secret**.
2. The device stores host URL and secret as a record in the account registry
   (`sys.hosting`, encrypted like every registry record). Every other device of
   the account learns about the host by syncing, with nothing to set up.
3. Any device of the account keeps the host's list in step with the
   registry: new space, add it; left a space, remove it. The registry space
   itself is on the list too, so a full restore works from the recovery code
   alone.
4. With each space it sends what the gates need: the space's genesis (owner,
   type, public keys), which the host checks against the space id
   (`checkSpace`). Never the space key or the write secret.

### Storage grants

When the user has connected storage, the device seals the grant (for Dropbox, a
refresh token) to the host's public key and sends it. The host keeps it
encrypted at rest under a key that lives outside its database (a secret
manager, or `age`), decrypts it when it needs an access token, and never logs
it. That's good practice; it's no longer what the whole design rests on, because
a leaked grant exposes only ciphertext.

Without connected storage, the host mirrors into its own bucket, one prefix per
subscription, in exactly the BLOCK-03 layout. "Move to my Dropbox" later is
just adding the user's store as a second mirror: the host pushes everything,
and the user's devices see it arrive.

### One process, many spaces

One Bun process runs many space runtimes, each with its own mirror and peer set.
The risk is one space's failure taking the others down: catch per space, log,
restart that space alone. Cap memory per space so one big space can't evict the
rest. The local disk is a cache; lose it and every space rehydrates from its
mirrors.

### When someone stops paying

Grace period (30 days), then the host drops the spaces. Data in the user's own
storage is untouched. Data in the host's bucket is deleted after the grace
period, and the app says so plainly before it happens.

---

## Files

| File | Change |
|---|---|
| `cli/src/host.ts` | **New.** Blind mode: no signer, spaces come from subscriptions |
| `cli/src/host/subscriptions.ts` | **New.** Subscriptions, their spaces and quotas |
| `cli/src/host/grants.ts` | **New.** Sealed storage grants, encrypted at rest |
| `cli/src/host/api.ts` | **New.** Add and remove spaces, send a grant, status. Signed by the subscription secret |
| `cli/src/host/metrics.ts` | **New.** Bandwidth and storage per subscription |
| `src/node/…` | The node runs with no signer and no account: store, check, sync, mirror |
| `example/src/…` | "Keep my spaces online" in Settings, and an "Always online" mark on covered spaces |

---

## Steps

1. **Blind mode.** A node started with a list of spaces and no account syncs,
   checks and mirrors them. Test: two browsers that are never online together
   converge through it, and it can't read a private record.
2. **Measure whether TURN is needed at all.** Browsers dial the host over WSS
   directly. Try home, mobile and a corporate VPN before paying for any relay.
3. Subscriptions and the API, then the Settings screen.
4. Grants: Dropbox first (see Gotchas), then Drive and OneDrive.
5. Metrics. You can't price what you don't measure.
6. Load test: 1,000 spaces on one small box; record memory and bandwidth.

---

## Testing

- The host never receives a space key, seed or vault key. Assert on every
  message the API and the sync path accept.
- A record by someone without the space write key is refused by the host
  (`tests/space-access.test.ts`, run against a blind node)
- Two subscriptions can't see each other's spaces, grants or metrics
- One space throwing repeatedly doesn't disturb the others
- Deleting the host's disk and restarting restores every space from mirrors
- A revoked Dropbox grant shows the user a clear error, not a quiet stall
- A space paid for by one member stays online for all of them
- **No grant or secret appears in any log at any level.** Grep a full test run.

---

## Acceptance criteria

- [ ] Blind: the host holds no key that can read or sign a record
- [ ] The host refuses writers without the space write key
- [ ] 1,000 spaces on one box, memory measured and written down
- [ ] Bandwidth and storage metered per subscription
- [ ] Works with the user's Dropbox, and with no storage connected
- [ ] TURN decided **from measurement**, and written down
- [ ] What happens on a breach is written down before launch
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

- **Billing internals.** Use a payment provider's checkout; the host needs only
  "this subscription is paid until …".
- **An admin dashboard.** The API first.
- **Autoscaling.** One box until it isn't enough. The disk is a cache, so
  splitting spaces across boxes later is simple.

---

## Gotchas

- **Not every provider lets a server keep a grant a browser obtained.** Dropbox
  issues long-lived refresh tokens to browser apps (PKCE, no secret), so the
  device can hand one over. Google gives browser apps no refresh token, and
  OneDrive's browser-app refresh tokens expire within a day, so for those the
  consent has to finish on the host, with the code exchanged there. Check the
  current rules before building; they change.
- **One grant, two users.** If the device and the host share one refresh token,
  revoking the host in Dropbox's settings disconnects the device too. Either
  accept it and say so, or ask for a second consent for the host.
- **Provider reviews take calendar time.** Dropbox wants a production review
  after 50 users; Google reviews `drive.file` lightly, but it's still a review.
  Start early.
- **A user deleting their app folder looks like data loss.** It isn't, since
  devices still have copies, but say plainly what happened instead of reporting
  a sync failure.
- **Precise copy beats a slogan.** "We can't read your data" is true.
  "We hold nothing" isn't: the host holds encrypted records, metadata and,
  if given, a storage grant. Say exactly that.
