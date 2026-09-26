# BLOCK-07 — Hosting: a device that never sleeps

## What this delivers

A paid service that keeps people's spaces online and backed up when all their
devices are off. One process on one server serves many spaces for many people,
and it is **blind**: it never holds a seed, a vault key or a space key. It keeps
encrypted records moving and stored, checks that each one is signed and
allowed, and can't read or forge any of them.

What the user sees:

1. In the account home, Settings, then **"Keep my spaces online"**, with one
   sentence: *your spaces stay reachable and backed up when your devices are
   off; we store them encrypted and can't read them.*
2. **Payment** opens the host's own pay page in a new tab (BLOCK-23): monthly
   or a year up front, by card, Apple Pay or Google Pay (Stripe's checkout),
   or from a **crypto wallet** (USDC). No Weave account to make, nothing to
   set up, and the home itself knows nothing about how the host is paid.
3. Back in the home, the spaces show **"Always online"**, and Settings shows
   **"Paid until 12 Oct 2027 · Manage"**.
4. The payoff to lead with: **lose every device, type the recovery code on a
   new one, and everything comes back.** Without a host, losing every device
   means losing the data.

**You sell uptime and backup.** The host stores into its own bucket by default.
If the user has connected their own storage (BLOCK-03, "Back up to…"), the host
writes there too, so switching host means handing another one the same folder.

---

## Status (2026-09-25, branch `spaces-relays-and-removal`)

**Built:** the host as a carrier for many accounts (`src/node/host.ts`,
`weave host`), subscriptions with paid-until and a grace period, the signed
API, Stripe Checkout / Portal / webhook, `node.hosting` so every device hands
the host its spaces, mirrors into R2 (BLOCK-03's core and BLOCK-04's S3
driver), a restart from the bucket alone, and **Keep my spaces online** in the
home's Settings. Removing members (BLOCK-14 §2) is done too. **Wallet
payments** (`cli/src/wallet.ts`): USDC on Base straight to the host's address,
checked on the network by the host, no company in between. How a home and a
host talk about paying — a description, signed statuses, a pay page opened
with a signed link — is BLOCK-23.

**Decided while building:** the host is the extension's carrier with many carry
spaces, not a second kind of node — so it learns which account asked for which
space (through its carry space), besides the space ids. The subscription key is
separate from the account's, so the host can't tie a payment to an account
except through that carry space.

**Left:** metering bytes and requests per subscription, quotas, the 1,000-space
load test, TURN measured, user storage as a second mirror (Dropbox, Drive),
BTCPay (Bitcoin and Lightning), a real Stripe test-mode run end to end in a
browser, and a real wallet payment on Base Sepolia (see BLOCK-23).

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
test -f cli/src/serve.ts && test -f server/relay.mjs && \
test -f src/storage/mirror.ts && test -f src/storage/blob/s3.ts \
  && echo "READY" \
  || echo "NOT READY — needs mirrors (BLOCK-03) and the S3 driver (BLOCK-04)"
```

**Needs BLOCK-03 and the S3 half of BLOCK-04.** The host's own bucket is
S3-compatible (Cloudflare R2), so the S3 driver is the first driver to build,
before Drive or Dropbox. Without mirrors a host can only keep data on its own
disk, which works but isn't the design.

**Fix before charging money:** member removal (BLOCK-14). Today a removed
member keeps read access forever, and people assume a paid product handles
that.

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

### Not one node per person

Running a container or VM per person looks simpler and is worse: more cost,
more to operate, and each one would need that person's keys to run, which
puts every key in one place. The host is **one blind node carrying many
spaces**. That's the carrier node BLOCK-17 built for the extension, started on
a server with its spaces coming from subscriptions.

A node that acts *as* someone (runs agents or automations with their keys) is
a different product. If it's ever offered, it's a one-click deploy to the
person's own Fly or Railway account, not something we run.

### What the host still learns

Which spaces exist, their sizes, when they change, IP addresses, and record
envelopes: author, collection name, record key, `seq`. And, for card payments,
who paid: the payment provider knows the payer, and the host knows which spaces
that payment covers. Only crypto keeps that link anonymous. Say all of this in
the privacy copy. Encrypting collection names would help both the host and the
mirrors; it belongs to the protocol, not this block (see the blocks README).

---

## Where it runs

| Piece | What |
|---|---|
| Server | One Hetzner VPS (about €5–10 a month, 20 TB traffic included in the EU), Caddy for HTTPS |
| On it | The relay (`server/relay.mjs`, already shared with `weave serve`), the blind node, and the billing API |
| Storage | Cloudflare R2: one prefix per subscription, in the BLOCK-03 layout. No charge for downloads, which suits sync |
| Database | SQLite on the box, backed up to R2: subscriptions, their spaces, paid-until dates |
| Local disk | A cache. Lose it and every space reloads from R2 and from members' devices |

**One box until it isn't enough.** Scaling is splitting spaces across boxes by
space id; since the disk is a cache, moving a space is trivial. The relay can
move to its own box first if it's the busy part.

**The host never polls its own bucket.** Nobody else writes into the host's
prefixes (devices reach the host over the mesh, not through the bucket), so it
lists only when a space starts on a fresh disk. On R2, listing is billed like a
write; polling a thousand spaces a minute would cost more than storing them.

---

## Design

### Spaces, not accounts

The host doesn't know accounts. It knows **subscriptions**, and a subscription
is a list of space ids, a quota and a **paid-until date**. No per-user node
identity, no delegation from the user's root: a blind node never signs a
record, so it needs no permission to write one. The host has one identity of
its own, used only to connect to peers.

This also gives a family plan without designing one: **a space stays online if
any member pays for it.** Share a space with your family and it's online for
all of them. Their own personal spaces aren't covered unless they pay too.

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

1. Before paying, the home makes a **subscription key pair** (random, not
   derived from the seed, so it can't tie the subscription to the account).
   The host only ever sees the public half. Every API call is signed with the
   private half.
2. The home stores host URL and subscription key as a record in the account
   registry (`sys.hosting`, encrypted like every registry record). Every other
   device of the account learns about the host by syncing, with nothing to set
   up.
3. Any device of the account keeps the host's list in step with the
   registry: new space, add it; left a space, remove it. The registry space
   itself is on the list too, so a full restore works from the recovery code
   alone.
4. With each space it sends what the gates need: the space's genesis (owner,
   type, public keys), which the host checks against the space id
   (`checkSpace`). Never the space key or the write secret.
5. **Restore on a new device:** the home tries the hosted host by default, so
   a device holding only the recovery code finds its registry there, and from
   it every space.

### Paying: every payment moves one date forward

The host needs to know one thing: *this subscription is paid until X*. Every
way of paying just adds time to that date, so there is one code path, whatever
the method.

1. The host's pay page (BLOCK-23) asks for a checkout, with the pay link the
   home signed and the chosen plan.
2. The API creates a checkout session with the provider, tagged with the
   subscription id (the hash of the public key), and returns its URL.
3. The person pays on the provider's page and comes back to the host's pay
   page, which says it's done. The home, in its own tab, asks again.
4. The provider's webhook tells the API; the API moves paid-until forward (one
   month, or a year). Renewals arrive the same way.
5. "Change card or cancel" on the pay page opens the provider's customer
   portal. We build no billing screens.

| Method | How | Notes |
|---|---|---|
| Card, Apple Pay, Google Pay | Stripe Checkout + Customer Portal | Apple Pay and Google Pay appear by themselves in Checkout. On the web, Apple takes no cut; that rule applies only inside a native iOS app. |
| Crypto, easy route | Stripe's stablecoin (USDC) payments | Same checkout, same webhook. Check it's available to the account, and for the plan type, before relying on it. |
| Crypto wallet, built | USDC on Base, straight to the host's address, **time paid up front** | No company in the middle. The pay page asks the wallet to send the plan's price plus a fraction of a cent no other open payment has (36.004217); the host reads the transaction on the network, and the exact amount says whose it is. The wallet's address is never kept. The person needs a little ETH on Base for the fee (about a cent). Payments are public on the chain: anyone can see that address paid the host. |
| Crypto, private route | BTCPay Server / Lightning, **prepaid only** | Self-hosted, no company in the middle, no subscription to cancel. The only way to pay without anyone learning who paid. After launch. |

The host stores the provider's customer reference next to the subscription,
and nothing else about the payer: no name, no email, no card details.

**Tax.** Selling digital services abroad means VAT or sales tax in the buyer's
country. Two ways to handle it:

- **Stripe with Stripe Tax** (the default): one integration for cards, Apple
  Pay, Google Pay and stablecoins. Stripe works out and collects the tax; we
  still register where required (in the EU, one OSS registration covers every
  member state) and file.
- **A merchant of record** (Paddle, Lemon Squeezy, or Stripe's own if
  available): they are the seller, so they register and file everywhere. About
  5% + 50¢ a payment, and no crypto, so BTCPay payments would stay ours to
  declare.

Start with Stripe. Move to a merchant of record if tax filings become the
biggest chore. Get an accountant's view before launch; this isn't tax advice.

### Pricing

**One plan at launch: $4 a month, or $36 a year. 10 GB. Crypto: $36 a year.**

What it costs to serve one person, roughly, as of 2026:

| Cost | Per person per month |
|---|---|
| Storage on R2 (2 GB average, $0.015/GB) | $0.03 |
| Writes to R2 (batched segments, ~20,000 a month) | $0.09 |
| Share of the server (a €10 box for ~1,000 people) | $0.01 |
| **Total** | **about $0.15** |
| Payment fee, monthly plan (Stripe, card) | $0.30–0.45 |
| Payment fee, yearly plan (per month) | about $0.10 |

Fixed costs (a second box for staging and backups, monitoring, domain, email)
come to roughly $30–50 a month, whoever pays.

| | Monthly plan | Yearly plan |
|---|---|---|
| Kept per person per year, after fees and costs | about $40 | about $32 |
| People needed to cover fixed costs | ~15 | ~20 |
| 500 people | ~$15,000 a year before our time | |

Why these numbers:

- **The closest precedent is Obsidian Sync**: encrypted sync for a local-first
  app, about $4 a month paid yearly. People who want Weave already understand
  that price. iCloud's 50 GB for $1 isn't the comparison: we sell always-on
  and backup, not gigabytes.
- **Small monthly charges lose most to fees**: a flat 30¢ per payment is 8% of
  $4. The yearly plan is cheaper for the person and nearly all of it reaches
  us, so make it the highlighted choice.
- **One plan.** A second plan is for when files and avatars (BLOCK-03, *Out of
  scope*) make storage heavy: add 100 GB then, or $1 per extra 10 GB (R2
  charges about 15¢ for that).
- **No free hosting tier at launch.** The public relay stays free, and the
  extension (BLOCK-17) already keeps spaces online while the browser is open.
  A free tier mostly attracts abuse, and it's easy to add, hard to remove.
- **Check against metrics before launch** (step 6). If one busy space costs
  ten times the average, the quota needs a bandwidth line too. Calls over TURN
  are the likely outlier, about 0.5–1 GB an hour of video; the box's 20 TB
  covers a lot of that, but measure it.

### Storage grants

When the user has connected storage, the device seals the grant (for Dropbox, a
refresh token) to the host's public key and sends it. The host keeps it
encrypted at rest under a key that lives outside its database (a secret
manager, or `age`), decrypts it when it needs an access token, and never logs
it. That's good practice; it's no longer what the whole design rests on, because
a leaked grant exposes only ciphertext.

Without connected storage, the host mirrors into R2, one prefix per
subscription, in exactly the BLOCK-03 layout. "Move to my Dropbox" later is
just adding the user's store as a second mirror: the host pushes everything,
and the user's devices see it arrive.

### One process, many spaces

One Bun process runs many space runtimes, each with its own mirror and peer set.
The risk is one space's failure taking the others down: catch per space, log,
restart that space alone. Cap memory per space so one big space can't evict the
rest.

### When someone stops paying

Paid-until passes, then a 30-day grace period, then the host drops the spaces.
Data in the user's own storage is untouched. Data in R2 is deleted after the
grace period, and the home says so plainly (and early) before it happens.

---

## Files

| File | Change |
|---|---|
| `cli/src/host.ts` | **New.** Blind mode: no signer, spaces come from subscriptions |
| `cli/src/host/subscriptions.ts` | **New.** Subscriptions, their spaces, quotas and paid-until, in SQLite |
| `cli/src/host/billing.ts` | **New.** Create checkouts, receive provider webhooks, move paid-until |
| `cli/src/host/grants.ts` | **New.** Sealed storage grants, encrypted at rest |
| `cli/src/host/api.ts` | **New.** Add and remove spaces, send a grant, status. Signed by the subscription key |
| `cli/src/host/metrics.ts` | **New.** Storage, R2 requests and bandwidth per subscription |
| `src/node/…` | The node runs with no signer and no account: store, check, sync, mirror |
| `home/src/…` | "Keep my spaces online", checkout, paid-until and Manage in Settings; the hosted host tried on restore |
| `example/src/…` | An "Always online" mark on covered spaces |

---

## Steps

1. **Blind mode in `weave serve`.** A node started with a list of spaces and
   no account syncs, checks and mirrors them. Reuse BLOCK-17's carrier node.
   Test: two browsers that are never online together converge through it, and
   it can't read a private record.
2. **Mirror into R2** with the S3 driver (BLOCK-04). Test: wipe the disk,
   restart, every space comes back.
3. **Measure whether TURN is needed at all.** Browsers dial the host over WSS
   directly. Try home, mobile and a corporate VPN before paying for any relay.
4. **Subscriptions and the API**, then the Settings screen in the home.
5. **Stripe**: Checkout, webhook, customer portal, Stripe Tax. Test mode
   first, end to end, including a failed renewal and a cancel.
6. **Metrics, then the load test**: 1,000 spaces on one small box; write down
   memory, bandwidth and R2 requests. Check the pricing table against it.
7. After launch: BTCPay for crypto without a middleman, then Dropbox and Drive
   as your-own-storage.

---

## Testing

- The host never receives a space key, seed or vault key. Assert on every
  message the API and the sync path accept.
- A record by someone without the space write key is refused by the host
  (`tests/space-access.test.ts`, run against a blind node)
- Two subscriptions can't see each other's spaces, grants or metrics
- One space throwing repeatedly doesn't disturb the others
- Deleting the host's disk and restarting restores every space from R2
- A new device with only the recovery code restores everything through the host
- A webhook replayed twice extends paid-until once
- An unsigned or forged webhook changes nothing
- Lapsed past the grace period: spaces dropped, R2 prefix deleted, the user
  warned beforehand
- A revoked Dropbox grant shows the user a clear error, not a quiet stall
- A space paid for by one member stays online for all of them
- **No grant or secret appears in any log at any level.** Grep a full test run.

---

## Acceptance criteria

- [ ] Blind: the host holds no key that can read or sign a record
- [ ] The host refuses writers without the space write key
- [ ] Full restore from the recovery code alone, through the host
- [ ] Paid with a card and with Apple Pay in Stripe test mode, end to end
- [ ] 1,000 spaces on one box: memory, bandwidth and R2 requests written down
- [ ] Pricing checked against those numbers
- [ ] TURN decided **from measurement**, and written down
- [ ] What happens on a breach is written down before launch
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

- **Billing screens.** The provider's checkout and customer portal do it.
- **An admin dashboard.** The API and SQLite first.
- **Autoscaling.** One box until it isn't enough.
- **A node that acts as the user.** See *Not one node per person*.

---

## Gotchas

- **Not every provider lets a server keep a grant a browser obtained.** Dropbox
  issues long-lived refresh tokens to browser apps (PKCE, no secret), so the
  device can hand one over. Google gives browser apps no refresh token, and
  OneDrive's browser-app refresh tokens expire within a day, so for those the
  consent has to finish on the host, with the code exchanged there (or in the
  extension, via `chrome.identity`). Check the current rules before building;
  they change.
- **One grant, two users.** If the device and the host share one refresh token,
  revoking the host in Dropbox's settings disconnects the device too. Either
  accept it and say so, or ask for a second consent for the host.
- **Provider reviews take calendar time.** Dropbox wants a production review
  after 50 users; Google reviews `drive.file` lightly, but it's still a review.
  Start early.
- **A native iOS app changes the payment rules.** Inside an iOS app, Apple
  wants its own in-app purchase for subscriptions. Keep paying on the web
  (the home), where Apple Pay works with no cut.
- **Webhooks arrive late, twice, or out of order.** Make "extend paid-until"
  keyed by the provider's payment id, so a repeat is a no-op, and never cut
  anyone off because a webhook hasn't arrived yet: that's what the grace
  period is for.
- **A user deleting their app folder looks like data loss.** It isn't, since
  devices still have copies, but say plainly what happened instead of reporting
  a sync failure.
- **Precise copy beats a slogan.** "We can't read your data" is true.
  "We hold nothing" isn't: the host holds encrypted records, metadata, which
  spaces a payment covers and, if given, a storage grant. Say exactly that.
