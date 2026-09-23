# BLOCK-02 — MetaMask as a login option

## What this delivers

A wallet becomes a fourth way to get an identity, alongside passkey, recovery
code and demo name. One signature prompt per device, then a completely ordinary
P-256 identity that signs expressions exactly like every other one.

**No protocol changes.** This block touches identity and the example app only.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'fromRecoveryCode' src/identity/identity-manager.ts && \
grep -q 'deriveKeyPairFromSeed' src/types.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — see below"
```

**If it prints NOT READY:** either `IdentityManager.fromRecoveryCode` is gone (this
block copies its shape), `CryptoProvider.deriveKeyPairFromSeed` is gone (this
block relies on it), or the project doesn't typecheck. Fix the typecheck first.

**Depends on no other block.** Free to start. Unaffected by anything happening in
storage, sync or networking.

---

## Step 0 — Settle the one real risk first (1 hour, do not skip)

The whole design assumes `personal_sign` is **deterministic**: signing the same
message with the same account must return identical bytes every time. MetaMask
uses RFC 6979 deterministic ECDSA, so it should be — but verify before building
on it.

Open a browser console on any page with MetaMask installed:

```js
const [account] = await ethereum.request({ method: 'eth_requestAccounts' });
const msg = 'p2p-web identity derivation v1';
const hex = '0x' + [...new TextEncoder().encode(msg)]
  .map(b => b.toString(16).padStart(2, '0')).join('');
for (let i = 0; i < 5; i++) {
  console.log(await ethereum.request({ method: 'personal_sign', params: [hex, account] }));
}
```

All five must be byte-identical. Repeat in Rabby and once over WalletConnect.

**If they differ for some wallet:** that wallet cannot use seed derivation. Fall
back to the UCAN-delegation path in *Alternative design* below for that wallet
only — don't abandon the block.

---

## Background

### Why not just sign expressions with the wallet

MetaMask never exposes a private key and won't sign arbitrary hashes. It signs
`personal_sign`, which is an EIP-191-prefixed keccak256 digest over secp256k1.
Using it directly as the expression-signing key means:

- a MetaMask popup on **every single write** — fatal for a local-first app
- every verifier needs keccak256 + EIP-191 + secp256k1, none of which the
  protocol has

### What we do instead

Use the wallet as a **seed source**, which is exactly how `fromRecoveryCode` and
`fromPassword` already work:

```
personal_sign(fixed message)  →  65-byte deterministic signature
                              →  HKDF-SHA256
                              →  32-byte seed
                              →  deriveKeyPair(seed, provider)   [already exists]
                              →  ordinary P-256 identity + did:key
```

One popup per device. The resulting identity is indistinguishable from a
recovery-code identity everywhere downstream. The example app's existing
session-key flow (`startSession` mints an ephemeral key and delegates to it with
a UCAN) then works with no changes at all.

---

## Files

| File | Change |
|---|---|
| `src/identity/wallet.ts` | **New.** Pure functions, no `window.ethereum` |
| `src/identity/identity-manager.ts` | Add `fromWallet(signature)` beside `fromRecoveryCode` |
| `src/index.ts` | Export the new functions and types |
| `tests/wallet.test.ts` | **New** |
| `example/src/wallet-provider.ts` | **New.** The only file that touches EIP-1193 |
| `example/src/protocol.ts` | Add `kind: 'wallet'` to `RememberedAccount`; add `signInWithWallet` |
| `example/src/hooks/useProtocol.ts` | Expose `signInWithWallet` from `useSession` |
| `example/src/components/LoginScreen.tsx` | Add the button |

### `src/identity/wallet.ts`

Keep it free of browser APIs so it stays testable and isomorphic — the caller
passes the signature in.

```ts
/** The message a wallet signs to derive its protocol identity. Versioned: changing it changes every derived DID. */
export function walletSeedMessage(appId: string): string;

/** HKDF-SHA256 over a wallet signature, producing a 32-byte seed for deriveKeyPair. */
export function walletSignatureToSeed(signature: Uint8Array): Promise<Uint8Array>;

/** Parses the 0x-prefixed hex a wallet returns into the raw 65 signature bytes. */
export function parseWalletSignature(hex: string): Uint8Array;
```

Use `info: 'p2p-wallet-seed-v1'` for the HKDF, matching the convention in
`src/identity/keys.ts`.

### `src/identity/identity-manager.ts`

Add to the interface and the implementation, mirroring `fromRecoveryCode`:

```ts
/** Derives the root identity from a wallet's signature over walletSeedMessage(). */
fromWallet(signature: Uint8Array): Promise<Identity>;
```

### `example/src/protocol.ts`

`RememberedAccount` is a discriminated union already carrying `'passkey'` and
`'recovery'`. Add:

```ts
| {
    /**
     * A wallet identity. Only the address is kept — the signature is a secret
     * and is re-requested on each return visit.
     */
    readonly kind: 'wallet';
    readonly address: string;
    readonly label: string;
    readonly did: string;
  }
```

And a sign-in function shaped exactly like `signInWithRecoveryCode`:

```ts
export async function signInWithWallet(): Promise<Session> {
  const { address, signature } = await signWithWallet(walletSeedMessage(APP_ID));
  const identityManager = createIdentityManager();
  const identity = await identityManager.fromWallet(signature);
  rememberAccount({ kind: 'wallet', address, label: shortenAddress(address), did: identity.did });
  return startSession(identity, identityManager.getProvider());
}
```

---

## Steps

1. Do **Step 0** above. Don't build on an unverified assumption.
2. Write `src/identity/wallet.ts` and its tests. This is pure byte manipulation —
   get it green before touching a browser.
3. Add `fromWallet` to the identity manager. Roughly ten lines; it funnels into
   the same `deriveKeyPair` every other root uses.
4. Export from `src/index.ts`.
5. Write `example/src/wallet-provider.ts`: detect `window.ethereum`, request
   accounts, `personal_sign`, return `{ address, signature }`. Handle "no wallet
   installed" and "user rejected" as distinct, explainable errors — the login
   screen already has an `AuthError` shape for this.
6. Wire `signInWithWallet` into `example/src/protocol.ts`.
7. Expose it through `useSession` in `useProtocol.ts` and add the button to
   `LoginScreen.tsx`.
8. Manual test: log in, write a todo, reload, confirm the same DID comes back.

---

## Testing

`tests/wallet.test.ts` — no browser needed, the signature is an input:

- A fixed known signature produces a known DID (**golden vector** — commit the
  expected DID string; this catches any accidental change to the derivation)
- Same signature twice → identical DID
- One bit flipped in the signature → different DID
- A malformed hex string is rejected with a clear error, not a silent bad key
- `walletSeedMessage` output is stable — changing it is a breaking change, so the
  test should assert the exact string

---

## Acceptance criteria

- [ ] Log in with MetaMask, write a todo, reload the page, same DID returns
- [ ] The same wallet on a second browser yields the **same** DID
- [ ] A different wallet account yields a different DID
- [ ] Declining the signature prompt shows a real message, not a crash
- [ ] With no wallet installed, the button explains itself rather than throwing
- [ ] `localStorage` contains the address and **never** the signature
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

**Native secp256k1 / `did:pkh` identities.** Tempting, but `createCryptoGate` and
`createSigner` each take a *single* `CryptoProvider`, so mixed-curve authors
would need a provider registry keyed on multicodec threaded through the signer,
the crypto gate and UCAN verification — plus a secp256k1 implementation, since
WebCrypto has none. Real work, no user-visible benefit over this block. Revisit
only if wallet-native DIDs become a product requirement.

**WalletConnect / hardware wallets.** Same derivation works if Step 0 confirms
determinism, but ship MetaMask first.

---

## Gotchas

- **Smart-contract wallets don't work with this.** ERC-4337 accounts and Safe use
  ERC-1271 signatures — there's no private key to derive from and no determinism
  guarantee. Detect and show a clear message rather than deriving a garbage
  identity. Checking whether the address has code (`eth_getCode` returns
  something other than `0x`) is a decent signal.
- **Losing the wallet means losing the identity.** There's no recovery path from
  a wallet-derived DID. Prompt wallet users to also generate a recovery code —
  `RecoveryCodeSetup.tsx` already exists for this.
- **Never display the derived key as "your wallet key."** It's a separate
  identity that happens to be derived from the wallet. Conflating them will
  eventually make someone think their funds are at risk.
- **`walletSeedMessage` is load-bearing forever.** Changing the string changes
  every derived DID and silently orphans everyone's data. Version it in the
  string itself (`v1`) and treat a change as a migration, not an edit.
- **Chain ID is deliberately not in the message.** The same account should give
  the same identity regardless of which network the wallet is pointed at.

---

## Alternative design (if Step 0 fails, or for stronger security later)

Instead of deriving a seed, have the wallet act as a **UCAN delegator**: the
wallet identity (`did:pkh:eip155`) delegates a capability to a browser-generated
P-256 session key. One wallet signature mints a scoped, expiring, revocable
session.

The machinery already exists — `delegateCapabilities`, `validateDelegationChain`,
`isCapabilitySubset` and proof resolvers are all in `src/identity/ucan.ts`, and
`example/src/protocol.ts` already delegates root → session key this way.

It's strictly better security (revocable, doesn't tie identity lifetime to the
wallet) but it does require verifying a secp256k1 signature on the delegation
proof, which drags in the multi-curve work listed under *Out of scope*. That
tradeoff is why seed derivation is the default here.
