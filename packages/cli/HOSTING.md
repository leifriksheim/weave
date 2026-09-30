# Running a host for other people

What to do before `weave host` takes anyone's money, and what to do when
something goes wrong. How to run it is in the [README](README.md#hosting-other-peoples-spaces).

## What it costs to run

Measured with `tests/bench/host-load.ts` (1,000 spaces over 20 accounts, 20
records each, plus each account's registry, contacts and carry space: 1,060
spaces), on an M-series Mac, the host run from source under `tsx`:

|                                      |                       |
| ------------------------------------ | --------------------- |
| Memory, nothing carried              | 112 MB                |
| Memory, carrying 1,060 with peers on | 488 MB (0.36 MB each) |
| Memory after a restart, no peers     | 381 MB (0.25 MB each) |
| A restart, until every space is open | 33 s                  |
| Disk                                 | 35 MB (33 KB each)    |

So memory is the limit, not disk: a 512 MB machine carries about 1,000
spaces, and 1 GB about 2,500. An account holds three spaces of its own besides
the ones it uses, so count six to ten spaces an account: 100 to 170 accounts on
the smallest Fly machine (about $3.50 a month with its volume). At $4 an
account a month, the machine is paid by its first account. Run the bench again
before raising prices or machine sizes: `node --conditions=@weaveprotocol/source --import tsx tests/bench/host-load.ts 2000 40 20`.

A restart takes the host offline for about half a minute per thousand spaces,
while it opens them. Devices keep their own copies, so nothing is lost, but
deploy at a quiet hour.

TURN is not needed for a host: devices reach it over its WebSocket, never
WebRTC. It matters only for devices meeting each other.

## Before launch

1. **Deploy** with `fly.toml` (commands at its top). Set `WEAVE_HOST_URL` to
   the public address, and the R2 bucket, so the disk is only a cache.
2. **A Stripe test-mode run, end to end.** With `sk_test_…` keys and test
   prices:
   - In a home built with `VITE_WEAVE_HOST`, **Keep online**, pay with
     `4242 4242 4242 4242`. The home should say "renews" with the date within
     a minute, and the host's log "paid until".
   - **Change card or cancel** in the home opens Stripe's portal. Cancel,
     and the webhook for the end of the period should leave the date as is.
   - A space: **Chip in** twice with the one-off price; its date moves twice.
   - Replay a webhook from Stripe's dashboard: the date must not move again.
3. **A wallet payment on Base Sepolia** (`WEAVE_WALLET_NETWORK=base-sepolia`),
   with test USDC from faucet.circle.com.
4. **Tax.** Selling a digital service to consumers makes you liable for VAT
   in the EU and UK from the first sale, and for sales tax in some US states.
   The simplest route is a merchant of record (Paddle or Lemon Squeezy), which
   sells in its own name and handles all of it; the `Billing` interface in
   `src/host.ts` is where one plugs in. Stripe Tax is the other route, but
   leaves registering and filing to you. Decide before the first real payment.
5. **Reminders by email**: set `WEAVE_MAIL_API_KEY` and `WEAVE_MAIL_FROM`
   with a domain verified at the mail service, and ask for one on the pay
   page to see the confirmation arrive.
6. **Terms** at `WEAVE_HOST_TERMS`: what is kept (sealed spaces, a
   subscription's payment reference, an optional email), for how long after
   lapsing (the grace period, 30 days by default), and that the host cannot
   read what it keeps.

## Bots

A bot costs its model's tokens: with `WEAVE_BOT_DAILY_CAP=1` a bot spends at
most $1 a day, about $30 a month if it is busy every day, and most are far
under that. Price a month of one above what you expect a typical bot to
spend (`WEAVE_WALLET_BOT`, `STRIPE_ONCE_PRICE_BOT`), and watch spending per
bot in the host's log. Each bot is also a node in the host's process, about
the memory of the spaces it holds. Unlike the spaces a host carries, a bot's
keys are on the host's disk, in `bots/`: keep that volume as private as the
host's own key.

## If something goes wrong

What a host holds decides what a breach can expose. It holds no account's
seed, no space's key and no note: spaces are sealed as they travel, and a host
that is fully taken over can read none of them. What it does hold:

- **Its own key** (`host-key` in the data folder). With it, someone can sign
  statuses as the host and take peers' sockets as the host.
- **Which spaces exist**, their size, when they change, and which account
  asked for which (through carry spaces).
- **Payment references**: Stripe customer ids, wallet transactions.
- **The keys of the bots it runs**, in `bots/`. With them, someone can read
  and write what those bots may, in the spaces they are in, until an admin
  removes them. After a breach, tell each community with a bot to remove it
  and add a new one.
- **Email addresses** given for reminders.
- **Mail and payment secrets** in its environment.

When a breach is suspected:

1. **Contain.** Stop the machine (`fly scale count 0`). Rotate every secret
   in its environment: Stripe keys and webhook secret, the mail service key,
   the bucket's keys.
2. **Look.** Fly's logs, the bucket's access logs, Stripe's dashboard for
   refunds or payouts you didn't make.
3. **If the host key may have leaked,** it has to change: a new key is a new
   host, and every home asks the person to use it again. Start on a fresh
   `host-key` with the same bucket; the subscriptions come back, and each
   device hands its spaces over again when it next looks. Say so on the pay
   page and by email to those who gave one.
4. **Tell people** within 72 hours when personal data was exposed (GDPR,
   Art. 33 and 34): the email addresses and payment references are personal
   data; the sealed spaces are not readable, so say that too.
5. **Write down** what happened, when it was found, and what changed.
