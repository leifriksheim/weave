# BLOCK-02 — Wallet login (parked: superseded by `snap/`)

## Status

**Parked.** The goal of this block — MetaMask as a way into an account — shipped
by another route: the MetaMask Snap in `snap/`, wired into the example through
`example/src/snap.ts` and the `RootSigner` interface
(`src/identity/root-signer.ts`).

The original design is in git history (the baseline commit). It is kept out of
the working tree because it would now steer someone the wrong way.

## Why the Snap is the better design

The original plan derived an identity from a `personal_sign` signature over a
fixed message: one popup, then the seed lives in the page.

| | `personal_sign` derivation (this block) | Snap (shipped) |
|---|---|---|
| Where the seed lives | In the page, after derivation | Inside the extension; never handed over |
| What an app gets | The whole account | A one-hour delegation for a session key |
| Disconnecting an app | Meaningless — it had the seed | Real — it only ever had a note |
| Depends on | The wallet signing deterministically (RFC 6979) | A standard BIP-32 path, reproducible with any library from the recovery phrase |
| Works on a brand-new domain | Yes | Yes |

## What is still open, if anyone asks for it

- **Wallets that cannot run Snaps** (Rabby, WalletConnect, hardware wallets on
  their own). `personal_sign` derivation is the only option there. If it is
  ever built, the original Step 0 still applies: confirm signing is
  byte-identical across five calls before trusting it, and refuse smart-contract
  wallets (ERC-1271), which have no deterministic signature.
- **`did:pkh` wallet-native identities.** Needs a provider registry keyed by
  key type, threaded through the signer, crypto gate and UCAN verification.
  `@noble/curves` (already a dependency) supplies secp256k1, so the curve is no
  longer the obstacle — the plumbing is.

Neither has a user asking for it. Reopen this block when one does.
