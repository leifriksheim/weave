# BLOCK-23 — Paying a host: the home knows no payment providers

> **Status (2026-09-26):** built on branch `spaces-relays-and-removal`, on top
> of BLOCK-07's host. The pay page was checked in a real browser (Chromium)
> with a stand-in wallet: found through EIP-6963, the network added, the
> marked amount sent, the payment counted, "paid until" moved a year; and
> WalletConnect's window opens on it. What's left is under "Still open".

## What this delivers

Weave should work like Nostr and the AT Protocol: many hosting providers, any
account home working with any of them, and a home anyone can run themselves.
So the home must not know how a host gets paid. Before this block it did: it
drew the host's Stripe plans, and for crypto it found the wallet, built the
transfer and told the host about it. A host that wanted to take Lightning
would have needed every home to change.

Now the contract between a home and a host is three small things, and payment
isn't one of them:

1. **A description.** `GET /.well-known/weave-host`, public: the host's key,
   its name, a price as plain text ("$4 a month or $36 a year"), where its
   pay page is, and whether it's free.
2. **A signed status.** Asked with the subscription key, the host answers
   "subscription X is paid until 12 Oct 2027, carrying 4 spaces", signed with
   its own key. The home keeps the latest one in the account registry.
3. **A signed pay link.** The home signs a link to the host's pay page with
   the subscription key and opens it in a new tab. Everything about paying
   happens there: plans, card, crypto wallets, topping up, changing a card.

What the person sees in the home: the host's name, "paid until …", and one
**Payment** button. It opens the host's own page in a new tab. Coming back to
the home, it asks the host again.

## Precedent

- **Nostr paid relays (NIP-11).** A relay publishes a small description of
  itself, including `fees` and a `payments_url`. Clients show the fee and link
  to the relay's page; they know nothing about how it takes money. Relays
  taking cards and relays taking Lightning work with every client. The
  description here is the same idea.
- **AT Protocol's "credible exit".** Your account records which server hosts
  you, and moving is always possible, so you don't have to trust a host to
  stay good. Here the account registry records the hosts, the host is blind,
  every device and mirror keeps a copy, and stopping one host and using
  another is one click.
- **Pre-signed links (S3).** A link that carries its own signature and a time
  limit, so whoever opens it can do one thing for a while, with no login. The
  pay link is one.
- **Signed receipts (JWS-style).** The host signs the exact bytes it sends; the
  home checks them against the key it recorded when it started using the host.

## Why it's shaped like this

**Payment code never runs on the home's address.** The home holds the seed
while it's open, and anything running on its address can reach it (see
`src/session/stay-signed-in.ts`). The pay page is the host's, on the host's
address, and never sees a key. So a host may use whatever it likes there — the
wallet library with its 248 packages included — without putting accounts at
risk.

**The home stays in its own tab.** The pay page opens in a new tab with
`noopener`, so it can't reach back into the home, and the home never follows a
link the host hands it. A dishonest host therefore can't send someone to a
lookalike home. This is what makes "trust only your home's address" true.

**The pay link can do little, and not for long.** It names the subscription,
the host's key and a time, signed by the subscription key. It's valid for an
hour, only at that host (a host can't replay it at another, because the host's
key is in what's signed), and only for paying: seeing the status, starting a
payment, managing a card. It sits in the URL's fragment (`#…`), which browsers
never send to a server, so it doesn't end up in logs or `Referer` headers.

**The signed status is evidence, not enforcement.** The host enforces payment
itself; the home doesn't need proof to work. The receipt is for people: every
device shows "paid until …" from the registry, the home can say it when the
host is down, and if a host later claims it was never paid, the person holds
its own signed word. It's rewritten only when what it says changes.

**No directory.** A home lists the hosts its builder configured
(`VITE_WEAVE_HOST`) and takes any host address typed in, like Nostr clients
and relays.

## What the person trusts, and what they don't

| Risk | How it's handled |
|---|---|
| Payment code steals the account | It never runs on the home's address |
| The host reads or changes data | It's blind, and every record is signed |
| The host fakes the home to phish | The home stays in its tab; nothing links back into it |
| The host says it was never paid | The person holds its signed status |
| The host disappears with prepaid time | At most that time is lost; the data is on the devices and mirrors, and another host is one click |
| The host is offline | Two hosts, or a host and a mirror |

The last two need trust, and no protocol removes them: this is paying someone
to keep a machine running. The design keeps what's at stake small.

## The contract, precisely

`GET /.well-known/weave-host` (CORS open, no signature):

```json
{
  "weave": "host/1",
  "did": "did:key:zDnae…",
  "name": "Weave Hosting",
  "free": false,
  "price": "$4 a month or $36 a year",
  "pay": "/pay",
  "terms": "https://…"
}
```

`pay` may be relative to the host's address, or anywhere else a host chooses.
Absent means the host takes no payments (it's free, or for named accounts).

The status, `GET /host/subscriptions/<subscription>` signed with the
subscription key as before, answers `{ "payload": "<json>", "sig": "…" }`.
The signature is the host key's P-256 signature over
`weave-host-status/v1\n<payload>`. The payload: `subscription`, `host` (its
key), `state`, `paidUntil`, `renews`, `carrying`, `spaces`, and `at`, when it
was said.

The pay link: `<pay>#s=<subscription>&at=<unix seconds>&sig=<signature>`,
where the signature is the subscription key's over
`weave-pay/v1\n<host key>\n<subscription>\n<at>`. The pay page sends those
three to its host's `/pay/api/…` calls in an `Authorization: WeavePay …`
header.

## The host's pay page

`weave host` serves it at `/pay`, with whatever the host was set up with:

- **Card, Apple Pay, Google Pay** through Stripe Checkout, and the Stripe
  portal for changing a card or cancelling. Stripe sends people back to
  `/pay`, which says it's done and that the tab can be closed.
- **Browser wallets** (MetaMask, Coinbase Wallet, Rabby, Phantom, Brave…)
  through EIP-6963, the standard every browser wallet announces itself with.
  No library.
- **Every other wallet** — phone wallets by QR code, desktop wallet apps —
  through WalletConnect, with Reown AppKit, the WalletConnect team's own
  library, when the host is given a WalletConnect project id
  (`WEAVE_WALLETCONNECT_PROJECT_ID`, free at dashboard.reown.com). Built by
  `npm run bundle:pay` in `cli/`, and loaded only on the pay page.

The wallet payment itself is BLOCK-07's: USDC on Base straight to the host's
address, an amount marked with a fraction of a cent, checked on the network by
the host (`cli/src/wallet.ts`).

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
test -f cli/src/host.ts && test -f cli/src/wallet.ts && test -f src/session/hosting.ts \
  && echo "READY" || echo "NOT READY: BLOCK-07's host is missing"
```

## Still open

- Tried with a real wallet on Base Sepolia, and Stripe in test mode, in a
  browser, end to end.
- Privacy Pass (RFC 9576) tokens, so a host can't tie a payment to the account
  it carries: pay once, get anonymous tokens, spend them for time.
- A Lightning route (BTCPay), as another method on the pay page.
- Gasless USDC (EIP-3009, as x402 does), so a person needs no ETH for the fee.
