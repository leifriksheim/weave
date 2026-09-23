# BLOCK-07 — Hosting tier: multi-tenancy and bring-your-own-storage

## What this delivers

One box running many people's nodes, each pointed at storage they already pay
for. The product this whole architecture has been aiming at: **you sell uptime,
not storage.**

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
test -d daemon && test -f daemon/main.ts \
  && echo "READY" \
  || echo "NOT READY — do BLOCK-06 first (the daemon does not exist yet)"
```

### This is the one block with a real ordering constraint

Every other block in this folder can be started in any order. This one cannot:
it multiplies an existing daemon across tenants, and there is no sensible way to
inline "build the daemon" as a preliminary step.

**If the check says NOT READY, open [BLOCK-06](BLOCK-06-bun-daemon.md) instead.**
Nothing here will make sense without it, and you can't damage anything by
trying — you'll just have nothing to multiply.

Recommended but not required first: [BLOCK-03](BLOCK-03-packed-storage.md) and
[BLOCK-04](BLOCK-04-remote-blob-drivers.md). Without them, tenants can't actually
bring their own storage and you're just running N SQLite files — which is a fine
v1, but it isn't the pitch.

---

## The shape of the business, and why the architecture matches it

### The node is stateless

If durable data lives in the tenant's own Drive or S3 (BLOCK-03/04), the box
holds only a hot cache and an MST root. Nuke it and redeploy — it rehydrates.

No backups to run. No durability SLA. No data migration. That's an enormous
category of operational cost and liability you simply never take on.

### It's zero-knowledge even on the paid tier

With space encryption on (`src/privacy/space-encryption.ts`), the gossiper relays
and stores ciphertext it cannot read. "We hold your uptime, never your data" is
both a marketing line and a real reduction in GDPR surface — you're barely a data
processor.

**This claim has exactly one hole, and it's this block's main job to plug it:**
tenant storage credentials. See below.

### The actual cost driver is not what you'd guess

Gossip, CPU and disk on a stateless node are close to free — a €4 VPS
multi-tenants a lot of spaces. The line item that scales with users is **relayed
bandwidth**.

If BLOCK-06's WSS transport works, browsers connect *directly* to the node and
peer↔node traffic needs no TURN at all. **Measure this before provisioning any
TURN infrastructure.** It may be unnecessary, and it's the difference between a
cheap product and an expensive one.

---

## Design

### Supervisor, not one process per tenant

One Bun process hosting N tenant contexts — each with its own identity, storage
adapter, sync engine and peer set — is far cheaper than N processes, since the
runtime is ~57 MB resident.

The risk is blast radius: one tenant's unhandled rejection shouldn't take down
the others. Wrap each tenant's event handlers so failures are isolated and
logged, and give each a restart-in-place path.

```ts
interface Tenant {
  readonly id: string;
  readonly did: string;
  readonly spaces: ReadonlyArray<string>;
  readonly storage: StorageProvider;
  readonly sync: SyncEngine;
  readonly status: 'starting' | 'running' | 'failed';
}
```

### Credentials — the part that decides whether the pitch survives

Tenant refresh tokens and S3 keys are **the one genuinely sensitive thing you
hold.** If they leak, "we never hold your data" becomes false, and someone will
notice.

Non-negotiables:

- **Envelope encryption.** A KMS-held master key encrypts per-tenant data keys;
  the master key never sits on the box. Cloud KMS, or age/sops if you'd rather
  not depend on a provider.
- **Decrypt at use, never at rest in memory longer than needed.** Don't hold
  plaintext refresh tokens for the process lifetime.
- **Never log them.** The retry/backoff wrapper from BLOCK-04 is the easiest
  place to leak one by accident.
- **Scope them down.** `drive.file` (app-created files only) and per-bucket S3
  keys, never account-wide credentials.
- **Write down what happens on breach** before you launch, not after.

### OAuth broker

Google Drive needs user OAuth; there's no static key. Flow:

1. Browser starts consent, redirects to your callback
2. Callback exchanges the code for a refresh token
3. Refresh token is envelope-encrypted and stored against the tenant
4. The daemon's `getAccessToken` callback (BLOCK-04) decrypts, exchanges for an
   access token, caches it in memory until expiry

Handle revocation: a tenant can revoke access from their Google account page at
any time. Surface it as a clear tenant-facing error, not a silent sync stall.

### Node identity vs tenant identity

Each tenant's node needs a DID. **Do not derive it from the tenant's own recovery
code** — that would mean holding their root identity, which is strictly worse
than holding their storage credentials.

Generate a separate per-tenant node identity, and have the tenant's root delegate
a scoped UCAN to it. `src/identity/ucan.ts` already has `delegateCapabilities`
and `validateDelegationChain`, and the example app already delegates root →
session key this way. Same pattern, longer expiry.

This means a hosted node can be revoked by the tenant without touching their
identity. Worth building right the first time.

---

## Files

| File | Change |
|---|---|
| `daemon/supervisor.ts` | **New.** Tenant lifecycle, isolation |
| `daemon/tenant-store.ts` | **New.** Tenant records + encrypted credentials |
| `daemon/crypto/envelope.ts` | **New.** KMS envelope encryption |
| `daemon/oauth/google.ts` | **New.** Consent callback, refresh exchange |
| `daemon/admin-api.ts` | **New.** Provision, suspend, inspect |
| `daemon/metrics.ts` | **New.** Per-tenant bandwidth and storage counters |
| `daemon/main.ts` | Boot the supervisor instead of a single tenant |

---

## Steps

1. **Measure TURN necessity first.** Deploy BLOCK-06's daemon, connect from a
   handful of real networks (home, mobile, corporate VPN) and record how many
   reach it over plain WSS. This decides whether TURN is in scope at all.
2. `envelope.ts` and `tenant-store.ts`. Get credential handling right before any
   credentials exist — retrofitting this is how leaks happen.
3. `supervisor.ts` with two hardcoded tenants. Prove isolation: kill one, the
   other keeps gossiping.
4. `oauth/google.ts` + the browser-side consent flow.
5. `admin-api.ts` — provision, suspend, delete. Authenticated.
6. `metrics.ts`. You cannot price a product whose bandwidth you don't measure.
7. Load test: 50 tenants on one box, measure RSS and bandwidth.

---

## Testing

- Two tenants can't see each other's spaces, expressions or peers
- One tenant throwing repeatedly doesn't disturb the other
- Credentials round-trip through envelope encryption; ciphertext alone is useless
- A revoked Google token surfaces a clear, tenant-visible error
- A tenant's node DID is distinct from their root DID, and its UCAN validates
- Suspending a tenant stops its sync and releases its resources
- Restart restores every tenant from the store
- **No credential appears in any log at any level** — grep the output of a full
  test run

---

## Acceptance criteria

- [ ] 50 tenants on one box, RSS measured and documented
- [ ] Per-tenant bandwidth and storage metered
- [ ] Credentials envelope-encrypted, master key off-box
- [ ] Tenant isolation verified by test, not by inspection
- [ ] A tenant can point at their own Drive/S3 and the box stores nothing durable
- [ ] Tenant node identity is delegated, never derived from their root
- [ ] TURN decision made **from measurement**, and written down
- [ ] Breach runbook exists
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

- **Billing.** Separate concern. Note that wallet login (BLOCK-02) means the same
  identity that signs in could also pay.
- **A web dashboard.** Admin API first; a UI on top of it is easy and not on the
  critical path.
- **Autoscaling.** One box until one box isn't enough. The node is stateless, so
  horizontal scaling is easy later — which is exactly why you can defer it.

---

## Gotchas

- **The marketing claim and the credential store are in tension.** "We hold
  nothing" is false while you hold refresh tokens. Either be precise in the copy
  ("we never hold your data; we hold the keys you give us, encrypted, and here's
  how") or don't make the claim. Precision here is cheap and being caught is not.
- **Drive OAuth verification takes weeks.** If Drive is a launch feature, start
  the review process early — `drive.file` scope is much lighter than full
  `drive`, but it isn't instant.
- **One blob store, one writer.** The `PackedAdapter` manifest has no
  compare-and-swap (see BLOCK-03). Two nodes writing one tenant's store will
  clobber each other. Enforce single-writer per tenant in the supervisor, and
  fail loudly if a second tries.
- **A tenant deleting their own Drive files looks exactly like data corruption.**
  Detect the missing-manifest case and say so plainly, rather than reporting a
  sync failure.
- **Per-tenant memory adds up.** Each tenant holds a hot cache and an MST root.
  Cap the hot tier per tenant, or one large tenant will evict everyone else.
