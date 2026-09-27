# 01 — Identity

An account is 16 random bytes. Every key the account uses is derived from them,
so the same 16 bytes give the same identity on any device and any origin. This
part specifies the seed and its written form, every key derived from it, how
keys become DIDs, how the root key delegates to the keys that actually sign
(UCANs), how the seed is stored locked on a device, and how a second device
receives an account (pairing).

```
seed (16 bytes)
 ├─ HKDF "weave/p256-identity-key/v1" ─▶ root key (P-256, ECDSA) ─▶ account DID (did:key:zDn…)
 │                                         └─ signs UCANs ─▶ session / app / agent keys ─▶ sign records
 ├─ HKDF "weave/p256-contact-key/v1"  ─▶ contact key (P-256, ECDH)
 │                                         ├─ HKDF "weave/p256-door-key/v1|<door>"      ─▶ door key per door (ECDH)
 │                                         └─ HKDF "weave/p256-door-sign-key/v1|<door>" ─▶ door signing key per door (ECDSA)
 ├─ HKDF "weave-vault-key-v1"         ─▶ vault key (AES-256) ── also the "account key" bytes
 │                                         ├─ HKDF "weave/p256-member-key/v1|<space>" ─▶ member key per space
 │                                         └─ HKDF "weave/account-registry/…", "weave/contacts/…" ─▶ account spaces
 ├─ CID("weave-pairing-room-v1" ‖ seed)     ─▶ pairing room
 └─ HKDF "weave-pairing-key-v1"       ─▶ pairing key (AES-256)
```

Conventions (MUST/SHOULD, encodings, canonical JSON) are those of the
[spec README](README.md). In this part:

- **HKDF(ikm, label, L)** is HKDF-SHA256 (RFC 5869) with an **empty salt**
  (zero-length, which RFC 5869 treats as 32 zero bytes), `info` = the UTF-8
  bytes of `label`, output length `L` bytes.
- **CID(bytes)** is `"b"` followed by the RFC 4648 base32 encoding of
  SHA-256(bytes), lowercase, without padding — always 53 characters. (It is
  "CID-like", not a real multiformats CID; [02 — Records](02-records.md) uses
  the same function.)
- **n** is the order of the P-256 group:
  `ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551`.

---

## 1. The seed

An account **seed** is exactly 16 bytes (128 bits) from a cryptographically
secure random source. It is the account: anything that holds the seed can act
as the account, and nothing else can.

- A new account MUST generate its seed with a CSPRNG
  (`crypto.getRandomValues`).
- The seed MUST NOT be stored in the clear. It is stored only as *wraps*
  (§10), or held in memory while unlocked, or written down by the person as a
  recovery code (§2).
- The seed never leaves the account home (the page or process that unlocked
  it) except as a recovery code or inside a pairing ticket (§14). Apps receive
  delegations (§7), never the seed ([06 — Nodes, sessions and apps](06-nodes-and-sessions.md)).

> Rationale: one secret, everything derived, means recovery is "type 26
> characters" on any device, with no server and no backup of anything else.

*Source:* `packages/core/src/identity/recovery-code.ts` (`generateSeed`, `RECOVERY_SEED_BYTES`).
*Tests:* `packages/core/tests/recovery-code.test.ts`, `packages/core/tests/identity.test.ts`.

---

## 2. Recovery codes

The **recovery code** is the seed written out. It is not a backup of the seed
and does not unlock anything stored: it *is* the seed. The interface shows it
once, when the account is made, to be kept somewhere safe; everyday sign-in is
a passkey or a password (§10.4).

### 2.1 Alphabet

Crockford base32, 32 symbols, value = index:

```
0123456789ABCDEFGHJKMNPQRSTVWXYZ
```

(`I`, `L`, `O`, `U` are not symbols.)

### 2.2 Encoding

1. Take the 16 seed bytes as a 128-bit big-endian bit string.
2. Split it into 5-bit groups, most significant first. The last group has 3
   bits; pad it on the right with two `0` bits. This gives **26 symbols**.
3. Group the symbols in fours, from the left, joined with `-`. The result is
   six groups of four and one of two: `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX`
   (32 characters).

Encoders MUST emit uppercase, hyphen-grouped form as above.

### 2.3 Decoding

1. **Normalize:** uppercase; remove every `-` and every whitespace character
   (`\s`); then substitute `O→0`, `I→1`, `L→1`, `U→V`.
2. **Validate:** the result MUST be exactly 26 characters, each in the
   alphabet. Otherwise the code is invalid.
3. Concatenate the 5-bit values and take the first 128 bits as the seed. The
   two trailing padding bits are ignored.

There is **no checksum**. Validation checks only length and alphabet; a
mistyped symbol decodes to a different, valid seed and therefore a different
DID. Because the two padding bits are ignored, the last symbol has four
spellings that decode to the same seed (see the example).

> Rationale: the code has to survive a password manager and a human copying it
> by hand; case, spacing and the O/0, I/1/L slips are forgiven. A caller that
> expects a particular account detects a wrong code by comparing the derived
> DID with the one it expected (`session/auth.ts` does this).

> **Planned: a check character.** A typo today signs in to a new, empty
> account. The plan adds one Crockford check symbol, so a mistyped code is
> refused instead of opening a different account. The format is pre-release
> and may change; no migration is needed. *Open:* whether to reuse
> Crockford's mod-37 check symbol (which adds `*~$=U` to the alphabet) or a
> check computed over the 26 symbols in the existing alphabet, and whether to
> add a version marker at the same time. Replaces the "checksum" line in §15.

### 2.4 Example

| | |
|---|---|
| seed (hex) | `00112233445566778899aabbccddeeff` |
| recovery code | `008J-4CT4-ANK7-F24S-NAXW-SQFE-ZW` |
| also decodes to the same seed | `008j 4ct4 ank7 f24s naxw sqfe zw`, `…-ZZ` (padding bits differ) |
| recorded example (tests) | `K7N6-ERYP-68TZ-A7HN-VJW3-QWKN-CG` → seed `99ea6763d63235f51e35dcb83bf27564` |

*Source:* `packages/core/src/identity/recovery-code.ts`.
*Tests:* `packages/core/tests/recovery-code.test.ts`, `packages/core/tests/identity.test.ts` ("a known recovery code derives its recorded DID").

---

## 3. Deriving P-256 keys

Every signing or key-agreement key in Weave that is not freshly random is
derived from bytes by one of two procedures.

### 3.1 `ScalarFrom(okm)`

Given 48 bytes `okm`:

```
d = (OS2IP(okm) mod (n − 1)) + 1          // OS2IP: big-endian unsigned integer
```

`d` is the private scalar, in `[1, n−1]`; the public key is `Q = d·G`. This is
the FIPS 186-5 Appendix A.2.1 method (48 = 32 + 16 bytes, so the bias is
negligible). The reference implementation calls
`p256.utils.randomSecretKey(okm)` from `@noble/curves`, which computes exactly
this.

### 3.2 `P256KeyFrom(ikm)` — the identity derivation

```
okm = HKDF(ikm, "weave/p256-identity-key/v1", 48)
d   = ScalarFrom(okm)
```

`ikm` MUST be at least 16 uniformly random bytes. This is what
`CryptoProvider.deriveKeyPairFromSeed` does. It is used for:

| Key | `ikm` |
|---|---|
| **Root key** (the account identity) | the 16-byte seed |
| Space invite key ([03](03-spaces.md)) | `HKDF(inviteSecret, "weave/space-invite/v1", 32)` |
| Space read key ([03](03-spaces.md)) | `HKDF(rawSpaceKey, "weave/space-read/v1", 32)` |
| PRF-derived identity (optional, §12.3) | the 32-byte WebAuthn PRF output |
| Password-derived identity (§12.4) | PBKDF2 output, 32 bytes |

The contact key and member keys (§9) use `ScalarFrom` directly, with their own
labels, without the identity label.

The resulting private key is imported non-extractable (JWK with `d`, `x`, `y`)
for ECDSA signing; *implementation detail*.

**Derivation is frozen.** Changing the label, the length, or the reduction
changes every account's DID. The recorded vectors in `packages/core/tests/identity.test.ts`
MUST keep passing.

### 3.3 Example (root key)

| | |
|---|---|
| seed | `00112233445566778899aabbccddeeff` |
| okm (48 bytes) | `40e656dfd00c34bd5fd78eafc9af158eeef351b1e9d6444662df48544eaa7db00a50db9fe92caeb7c4e3e16db0f14dd4` |
| d | `b8b27c37818b648e8cc2546eb327c6dcd27fd7cc1119666230e7826360508a75` |
| Q, compressed | `029084c70c6acbeb1bfbab099abb469443aa06c02bd1b02b830d846b1129d8c7fb` |
| DID | `did:key:zDnaeaA7BcVxAiLdNP15wLvS6SC1vaQc9zpeVxrUpEC48yxkr` |

Other recorded vectors: 16 zero bytes → `did:key:zDnaebsZZSYuq5oaFMhu2qAaAygqtwPtZwuiVJpjenjA9GwQE`;
16 `0xff` bytes → `did:key:zDnaexDGpQByMfPbsypSPAewepYNqS1yerAq5pEpDZwAmFQWS`.

*Source:* `packages/core/src/identity/crypto-p256.ts`, `packages/core/src/identity/keys.ts`, `packages/core/src/identity/identity-manager.ts` (`fromSeed`, `fromRecoveryCode`).
*Tests:* `packages/core/tests/identity.test.ts` ("deriveKeyPairFromSeed", "derivation is frozen", "noble computes the same public point Web Crypto does").

---

## 4. DIDs (`did:key`)

Every key in Weave — root, session, app, agent, invite, read — is named by a
`did:key` over its P-256 public key.

```
did = "did:key:z" ‖ base58btc( 0x80 0x24 ‖ compressedPoint )
```

- `0x80 0x24` is the unsigned-varint encoding of multicodec `p256-pub`
  (`0x1200`).
- `compressedPoint` is the 33-byte SEC1 compressed point (`0x02`/`0x03` ‖ x).
- `z` is the multibase prefix for base58btc. P-256 DIDs therefore always begin
  `did:key:zDn`.

Encoders MUST use the compressed point. Decoders:

1. MUST require the prefix `did:key:z`;
2. base58btc-decode the rest;
3. read the multicodec varint (bytes while the high bit is set, plus one);
4. treat the remainder as the public key. The implementation accepts a
   compressed (33-byte) or uncompressed (65-byte, `0x04 ‖ x ‖ y`) point and
   rejects bytes that are not a point on P-256.

Decoders SHOULD reject a multicodec other than `0x80 0x24`.

> **Known defect:** the reference decoder does not check the multicodec
> (`packages/core/src/identity/did.ts`, `didToPublicKey`), and neither does `verifyUCAN` for
> a token's `iss` (`packages/core/src/identity/ucan.ts`). A non-P-256 key fails later, only
> because it does not import as a P-256 point. A fix will reject any other
> multicodec when decoding.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20), [#19](https://github.com/leifriksheim/weave/issues/19).

> **Planned: one spelling per key.** Decoders will require the `0x80 0x24`
> prefix **and** exactly 33 compressed bytes, refusing the uncompressed form.
> Then a key has exactly one DID, and two DIDs never name the same key (which
> matters wherever DIDs are compared as strings: roots, `createdBy`, members).
> This fixes the known defect above.

Example: see §3.3; the decoded bytes are
`8024029084c70c6acbeb1bfbab099abb469443aa06c02bd1b02b830d846b1129d8c7fb`. The
did:key specification's own P-256 example,
`did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169`, round-trips.

Public keys elsewhere in Weave that are not DIDs (the contact key, member keys)
are the 33-byte compressed point, base64url.

*Source:* `packages/core/src/identity/did.ts`, `packages/core/src/identity/crypto-p256.ts` (`exportPublicKey`, `importPublicKey`).
*Tests:* `packages/core/tests/identity.test.ts` ("did:key", "reads the did:key specification's P-256 example").

---

## 5. Derivation labels

Every label under which bytes are derived anywhere in `packages/core/src/`. No two
*purposes* share a label, but see the notes below the table. Parts other than
this one own the use; this table is the registry.

| Label (UTF-8) | Mechanism | Input | Output | Used for | Defined in | Part |
|---|---|---|---|---|---|---|
| `weave/p256-identity-key/v1` | HKDF, L=48 → `ScalarFrom` | seed; or any `ikm` in §3.2's table | P-256 scalar | Root key; second stage of invite and read keys | `identity/crypto-p256.ts:9` | 01 |
| `weave/p256-contact-key/v1` | HKDF, L=48 → `ScalarFrom` | seed | P-256 scalar (ECDH) | Contact key | `identity/contact-key.ts:26` | 01 |
| `weave/p256-member-key/v1\|<spaceId>` | HKDF, L=48 → `ScalarFrom` | vault key bytes | P-256 scalar (ECDH) | Member key for one space | `identity/contact-key.ts:28` | 01, 03 |
| `weave/p256-door-key/v1\|<doorId>` | HKDF, L=48 → `ScalarFrom` | contact key's 32-byte private scalar | P-256 scalar (ECDH) | Door key (knocks are sealed to it) | `identity/contact-key.ts:29` | 01, 07 |
| `weave/p256-door-sign-key/v1\|<doorId>` | HKDF, L=48 → `ScalarFrom` | contact key's 32-byte private scalar | P-256 scalar (ECDSA) | Door signing key (proves ownership of a door) | `identity/contact-key.ts` | 01, 07 |
| `weave/door-topic/v1\|<signKey>` | SHA-256, base64url | — | mailbox topic | A door's mailbox topic on a relay: a hash of its signing key | `doors/doors.ts` (`doorTopic`) | 07 |
| `weave/contact-seal/v1` | HKDF, L=32 | ECDH shared x (32) ‖ ephemeral uncompressed point (65) | AES-256-GCM key | One sealed message to a contact or member key | `identity/contact-key.ts:27` | 01 |
| `weave-vault-key-v1` | HKDF, L=32 | seed | AES-256-GCM key / 32 bytes | Vault key: at-rest encryption; the "account key" | `identity/account-vault.ts:51` | 01, 05 |
| `weave-pairing-room-v1` | CID of prefix ‖ seed (no separator) | seed | room id | Pairing room | `identity/pairing.ts:29` | 01 |
| `weave-pairing-key-v1` | HKDF, L=32 | seed | AES-256-GCM key | Pairing handover | `identity/pairing.ts:30` | 01 |
| `weave-protocol-key-v1` | WebAuthn PRF `eval.first` salt | — | 32-byte PRF output | Optional PRF-derived identity (§12.3) | `identity/webauthn.ts:55`, `identity/passkey-diagnostics.ts:47` | 01 |
| `default-weave-salt` | PBKDF2 salt (default) | password | 32 bytes | Password-derived identity (§12.4) | `identity/identity-manager.ts:136` | 01 |
| `weave/space-invite/v1` | HKDF, L=32 → `P256KeyFrom` | 32-byte invite secret | P-256 key | Invite key | `space/space-access.ts:33` | 03 |
| `weave/space-read/v1` | HKDF, L=32 → `P256KeyFrom` | raw 32-byte space key | P-256 key | Read key of a private space | `space/space-access.ts:32` | 03 |
| `weave/account-registry/nonce/v1` | HKDF, L=32, first 12 bytes, base64url | vault key bytes | space nonce | Account registry space | `space/account-registry.ts:92,116` | 03 |
| `weave/account-registry/key/v1` | HKDF, L=32 | vault key bytes | AES-256-GCM space key | Account registry space | `space/account-registry.ts:92,117` | 03 |
| `weave/contacts/nonce/v1` | as above | vault key bytes | space nonce | Contacts space | `space/account-registry.ts:105,116` | 03 |
| `weave/contacts/key/v1` | as above | vault key bytes | AES-256-GCM space key | Contacts space | `space/account-registry.ts:105,117` | 03 |
| `weave/topic-tags/v1` | HKDF → HMAC-SHA256 key | raw space key (private) or the bytes of `weave/public-topics/v1\|<spaceId>` (public) | HMAC key | Topic tags | `records/topics.ts:61,64` | 02 |
| `weave-room/v1\|<spaceId>` | SHA-256, first 20 bytes, base32 lowercase | — | relay room name | A space's room on a relay | `node/space-runtime.ts:180` | 04 |
| `weave-agent-link-room-v1` | URI-encoded CID of prefix ‖ secret | 16-byte connect-code secret | room id | Agent link room | `session/agent-link.ts:42` | 06 |
| `weave-agent-link-key-v1` | HKDF, L=32 | 16-byte connect-code secret | AES-256-GCM key | Agent link messages | `session/agent-link.ts:43` | 06 |

Strings that separate *signed messages* or *AEAD contexts* rather than derive
keys, listed so new labels do not collide with them:

| String | Kind | Defined in | Part |
|---|---|---|---|
| `weave/space-invite/v1\|<spaceId>\|<did>` | Message signed by an invite key | `space/space-access.ts:199` | 03 |
| `weave/space-key-box/v1\|<spaceId>\|<keyId>\|<to>` | `sealFor` context | `space/space-access.ts:197` | 03 |
| `weave/space-earlier-keys/v1\|<spaceId>\|<keyId>` | Sealing context | `space/space-access.ts:185` | 03 |
| `weave/space-membership/v1\|<spaceId>` | Sealing context | `space/space-access.ts:187` | 03, 04 |
| `weave/contact-request\|<spaceId>\|<from>\|<to>` | `sealFor` context | `node/node.ts:1101` | 03 |
| `weave/knock/v1\|<doorKey>` | `sealFor` context | `doors/doors.ts` (`sealKnock`) | 07 |
| `weave/door-purge/v1\|<topic>\|<nonce>\|<ids>` | Signed by a door signing key, checked by a relay | `doors/doors.ts` (`purgeMessage`), `packages/relay/relay.mjs` | 07 |
| `weave/knock-answer/v1\|<space>\|<account>` | Signed by a door signing key | `doors/doors.ts` (`signAnswer`) | 07 |
| `weave-peer/v3\|client\|…`, `weave-peer/v3\|server\|…` | Signed peer-auth messages | `network/peer-auth.ts:123,125` | 04 |
| `weave-mesh/v1\|…` | Signed mesh proof | `network/peer-auth.ts:225` | 04 |
| `weave-host/v1\n…`, `weave-host-status/v1\n…`, `weave-pay/v1\n…` | Signed host requests | `session/hosting.ts:69,164,165` | 06 |

Notes:

- `weave/p256-identity-key/v1` is applied to more than one kind of input: the
  seed, and (as a second stage) invite and read secrets that were first
  expanded under their own labels. The first-stage label is what separates
  them.
- `weave/space-invite/v1` is both an HKDF label and the prefix of a signed
  message. The two uses are in different primitives and do not collide, but a
  new use MUST NOT reuse either string.
- New labels SHOULD follow the `weave/<purpose>/v<N>` form.

---

## 6. Keys and signers

| Key | How made | Lifetime | Signs |
|---|---|---|---|
| **Root key** | `P256KeyFrom(seed)` | The account's | UCANs only (§7) |
| **Session key** | Fresh random P-256 key pair, non-extractable, per node start | One node run | Records, peer-auth messages |
| **App key** | Fresh random P-256 key pair kept by an app (IndexedDB `weave-app-key`) | Until the app forgets it | Records, under a grant |
| **Agent key** | Fresh random P-256 key pair kept by an agent | Until the agent forgets it | Records, under an agent note (§8) |
| **Contact key** | `ScalarFrom(HKDF(seed, contact label, 48))` | The account's | Nothing; ECDH only (§9) |
| **Member key** | `ScalarFrom(HKDF(vaultKey, member label, 48))` | The account's | Nothing; ECDH only (§9) |
| **Door key** | `ScalarFrom(HKDF(contactKey, door label, 48))` | Until the door is closed | Nothing; ECDH only (§9) |
| **Door signing key** | `ScalarFrom(HKDF(contactKey, door sign label, 48))` | Until the door is closed | Purge challenges and knock answers (07) |

The root key signs exactly one kind of thing: a UCAN delegating to another key.
It MUST NOT be used to sign records directly in normal operation. (A record
with no `proof` is judged as written by its `author` key itself — see
[02 — Records](02-records.md).)

### 6.1 Root signers

A **root signer** abstracts where the root key lives. It exposes:

| Member | Type | Meaning |
|---|---|---|
| `did` | string | The account DID |
| `custody` | `'local'` \| `'remote'` | `local`: the seed is unlocked in this page. `remote`: another context (an account home) holds it |
| `delegate({audience, capabilities, expiration, facts?})` | → UCAN | Issue a UCAN from the account to `audience` |

- The **local** signer calls `issueUCAN` (§7.3) with the root key. It includes
  `fct` only when `facts` is non-empty.
- The **grant** (remote) signer used by apps returns the one note the account
  home already issued to the app key, unchanged, and refuses once the grant's
  `expiresAt` has passed. It cannot mint new notes. See
  [06 — Nodes, sessions and apps](06-nodes-and-sessions.md).

*Implementation detail:* this is an in-process interface, not a wire format.

### 6.2 The session delegation

When a node starts it creates a session key and asks the root signer for:

```
aud = session DID
att = [{ "with": "*", "can": "expression/*" }]
exp = now + ttl          (ttl default 3600 s)
nbf = now − 300          (issueUCAN default)
fct = absent             (or [{"weave":"agent"}] for an agent's own node)
prf = []
```

The node renews it at 0.75 × ttl and, on failure, retries after
min(60, ttl/4) seconds. Every record the session key signs carries the
encoded token as its `proof` ([02 — Records](02-records.md)). The node, its
TTL, and app grants are specified in [06](06-nodes-and-sessions.md).

*Source:* `packages/core/src/identity/root-signer.ts`, `packages/core/src/node/node.ts` (`SESSION_CAPABILITY`, `delegate`), `packages/core/src/session/connect.ts` (`grantSigner`, `grantCapabilities`).
*Tests:* `packages/core/tests/node.test.ts`, `packages/core/tests/connect.test.ts`.

---

## 7. UCAN delegations

A **UCAN** (also called a *note* in the code and UI) is a JWT-shaped token by
which an issuer key grants capabilities to an audience key for a time window.
Weave uses a subset of UCAN 0.10.

> **Planned: UCAN 1.0** ([#19](https://github.com/leifriksheim/weave/issues/19)).
> Tokens move to the 1.0 format: a DAG-CBOR envelope signed with a varsig
> header, delegations with `sub`, `cmd` and a policy (`pol`) in place of
> `att`, invocations that carry their chain in `prf`, and specified
> revocation. `space:<id>` becomes a policy on `.space`, which also gives
> grants narrower than a space (§7.1) and proof chains that travel (§7.5)
> without new syntax. Issuers switch outright; verifiers keep a read-only 0.10
> path for versions already stored. Not normative until built.

### 7.1 Format

```
token = b64u(canonicalJSON(header)) "." b64u(canonicalJSON(payload)) "." b64u(signature)
```

- `b64u` is base64url without padding.
- `canonicalJSON` is Weave's canonical JSON ([02 — Records](02-records.md)):
  object keys sorted, no whitespace, `undefined` members dropped.
- `signature` is ECDSA P-256 / SHA-256, 64-byte IEEE P1363 (`r ‖ s`), by the
  issuer's key over the UTF-8 bytes of `b64u(header) "." b64u(payload)`
  exactly as transmitted.

**Header** (fixed):

```json
{"alg":"ES256","typ":"JWT","ucv":"0.10.0"}
```

**Payload:**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `iss` | string (did:key) | yes | Issuer; its key signs the token |
| `aud` | string (did:key) | yes | Audience: the key receiving the capabilities |
| `exp` | integer, Unix seconds | yes | Not valid at or after this time |
| `nbf` | integer, Unix seconds | yes | Not valid before this time |
| `nnc` | string | issuers always set it | Nonce: 8 random bytes as 16 lowercase hex characters. Not checked by verifiers |
| `att` | array of Capability | yes | Capabilities granted (may be empty) |
| `prf` | array of string | yes | CIDs of parent tokens (§7.5); `[]` for a token issued directly by the root |
| `fct` | array of object | no | Facts. Omitted when there are none. Weave defines one fact (§8) |

`nbf` is optional in UCAN 0.10 but **required** here: a verifier MUST reject a
token without a finite numeric `exp` and `nbf`.

> Rationale: records are judged at the time they claim to have been signed
> (§7.4). A token with no start would let a leaked session key back-date
> records to any time before the token existed.

**Capability:**

```json
{ "with": "<resource>", "can": "<ability>" }
```

Resources and abilities in use:

| `with` | Meaning |
|---|---|
| `*` | Every space |
| `space:<spaceId>` | One space |

| `can` | Meaning |
|---|---|
| `expression/write` | Write records (what a record in a space requires: `{with: "space:<id>", can: "expression/write"}`) |
| `expression/read` | Read-only access (app grants with read access) |
| `expression/*` | Every `expression/…` ability |
| `*` | Every ability |

What each ability permits in a space is specified in
[02 — Records](02-records.md) and [06](06-nodes-and-sessions.md).

> **Planned: grants narrower than a space.** The smallest resource is a whole
> space, so an app or agent granted a private space can write in every
> collection and read all of it for as long as its note lasts. A
> per-collection resource would narrow writes. Narrowing reads also needs
> keys per collection, which is [03 — Spaces](03-spaces.md)' question. Not
> designed yet: the resource syntax, and how coverage (§7.6) treats it.

### 7.2 The token's CID

A token is referred to (in `prf`, and by revocations) by
`CID(UTF-8(token))` — the hash of the whole encoded string, signature
included.

> **Planned: one valid form per token.** ECDSA signatures are malleable: from
> a valid `(r, s)` anyone can make `(r, n − s)`, which WebCrypto also accepts,
> and a lenient base64url decoder accepts more than one spelling of the same
> bytes. Either gives a token that still verifies under a different CID, so it
> slips past a revocation that names the original CID. The plan: verifiers
> refuse a signature with `s > n/2` (high-S), issuers produce low-S only, and
> every base64url field is decoded strictly (no padding, no characters outside
> the alphabet, no non-zero trailing bits).

### 7.3 Issuing

`issueUCAN` defaults: `exp = now + 3600`, `nbf = now − 300`
(`UCAN_CLOCK_SKEW_SECONDS`), `nnc` = 16 random hex characters, `prf = []`.
`delegateCapabilities` issues a child of an existing token and MUST refuse
when:

- the issuer is not the parent's `aud`;
- any child capability is not covered by some parent capability (§7.6);
- the requested `exp` is later than the parent's `exp` (default: the parent's
  `exp`).

A child made by `delegateCapabilities` has `prf = [CID(parent)]` and no facts.

### 7.4 Verifying one token

Given a token and a time `at` (Unix seconds), a verifier:

1. MUST split on `.` into exactly three parts, and base64url/JSON-decode the
   first two.
2. MUST check that `exp` and `nbf` are finite numbers, and that
   `nbf ≤ at < exp`.
3. MUST decode `iss` as a did:key (§4), import its public key, and verify the
   signature over the first two parts as received.

The verifier does not re-canonicalize and does not check `nnc` or `fct`. A
verifier SHOULD reject a header other than the one in §7.1, and SHOULD reject
an `iss` whose multicodec is not `p256-pub` (§4).

> **Known defect:** the reference `verifyUCAN` checks neither the header
> (`alg`, `typ`, `ucv`) nor the issuer's multicodec (`packages/core/src/identity/ucan.ts`,
> `packages/core/src/identity/did.ts`). A fix will reject both. Other implementations MUST
> NOT rely on a token with a different header being accepted.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20), [#19](https://github.com/leifriksheim/weave/issues/19).

> **Planned: strict token shape.** Besides the header and the multicodec
> (the known defect above), verifiers will check the payload's shape: `att`
> is an array of `{with, can}` string pairs, `prf` an array of CID strings,
> `iss` and `aud` DIDs, `fct` (when present) an array of objects. A malformed
> token is refused rather than failing somewhere later.

`at` is the moment the token is being relied on:

- for a record's `proof`, the record's own signing time,
  `floor(Date.parse(createdAt) / 1000)` — so a record stays valid after the
  session's token expires ([02 — Records](02-records.md) bounds how far in the
  future `createdAt` may be);
- for anything else (an app checking its grant, an agent note), the current
  time.

### 7.5 Delegation chains

A token with non-empty `prf` claims authority from its parents. The chain is
resolved from the leaf toward the root:

1. Verify the leaf (§7.4) at `at`.
2. Let `current` be the leaf. Up to **10** times:
   - If `current.prf` is empty, `current.iss` is the **root DID**. Stop: the
     chain is valid; it grants the **leaf's** `att` to the **leaf's** `aud`.
   - Resolve the token whose CID is `current.prf[0]`. If none is found, the
     chain is invalid.
   - Check the link: every CID in `current.prf` must be among the provided
     proofs (only one is provided, so in effect `prf` MUST have at most one
     entry); the parent must verify (§7.4) at the same `at`; the parent's `aud`
     MUST equal `current.iss`; every capability in `current.att` MUST be
     covered by some capability in the parent's `att` (§7.6).
   - Move to the parent.
3. A chain longer than 10 links is invalid.

Because every parent is verified at the same `at`, a child is never usable
outside its parents' windows, even though the chain check does not compare
`exp` values directly.

A record-validating peer additionally requires that the leaf's `aud` equals
the record's `author`, that some leaf capability covers the capability the
record needs, and that the root DID is allowed in the space
([02 — Records](02-records.md), [03 — Spaces](03-spaces.md)).

**How parent tokens travel is not yet specified** (§15). The rules above are
the intended check for a chain of any length up to 10.

> **Known defect:** a record carries only its leaf token in `proof`, and the
> reference wires no proof resolver for records — the capability gate and
> `packages/core/src/node/space-runtime.ts` pass `() => null`
> (`packages/core/src/validation/capability-gate.ts`). So a chain deeper than one link never
> validates on a record; only tokens issued directly by the root (`prf: []`)
> do. A fix will define how parents travel and resolve them.
> Tracked in [#17](https://github.com/leifriksheim/weave/issues/17), [#19](https://github.com/leifriksheim/weave/issues/19).

#### Planned: proof chains that travel

Fixes the known defect above; replaces the first line of §15.

A record will carry, besides its leaf token, the intermediate tokens its chain
needs, so any peer can resolve the chain from the record alone, with no lookup
and no service. With that, delegations deeper than root → key work on records:
a session key delegating on to a short-lived key, an app handing a narrower
note to a helper.

What it unblocks:

- Agent notes today are signed **root → agent key** directly, only because
  peers resolve one link (§8, [06](06-nodes-and-sessions.md)). With chains, an
  app could delegate to its agent itself.
- The older idea of **roles as delegations** ("anyone the owner made a
  moderator" as a UCAN from the owner, carried in the record's proof) needed
  this. Roles now live in the space's access history
  ([03 — Spaces](03-spaces.md)) and `can:<p>` rules are built on them
  ([02 — Records](02-records.md) §7.1), so this no longer depends on chains.

Open questions:

- Where parents go: a new optional expression member (for example
  `proofs: [token, …]`, parents in order), or tokens stored once per space and
  referred to by CID. The first is self-contained; the second is smaller when
  one note signs many records.
- Whether the chain depth limit of 10 (§7.5) stays, given the bytes each link
  adds to every record.
- How revocation (by CID, [03](03-spaces.md)) treats an intermediate token.

### 7.6 Capability coverage

A parent capability `P` covers a child capability `C` iff both hold:

- `P.with == "*"` or `P.with == C.with` (exact string match — no other
  wildcards; `space:*` is *not* a pattern);
- `P.can == "*"`, or `P.can == C.can`, or `P.can` ends in `/*` and `C.can`
  starts with `P.can` minus its final `*` (so `expression/*` covers
  `expression/write` and `expression/read`, but not `*`).

### 7.7 Example

Issued by the root key of §3.3 to the did:key spec's example key, with fixed
times and nonce and the agent fact:

Header JSON: `{"alg":"ES256","typ":"JWT","ucv":"0.10.0"}`

Payload JSON:

```json
{"att":[{"can":"expression/*","with":"*"}],"aud":"did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169","exp":1790000000,"fct":[{"weave":"agent"}],"iss":"did:key:zDnaeaA7BcVxAiLdNP15wLvS6SC1vaQc9zpeVxrUpEC48yxkr","nbf":1789996100,"nnc":"0123456789abcdef","prf":[]}
```

Encoded (ECDSA signatures are randomized, so the third part differs every
time):

```
eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsInVjdiI6IjAuMTAuMCJ9.eyJhdHQiOlt7ImNhbiI6ImV4cHJlc3Npb24vKiIsIndpdGgiOiIqIn1dLCJhdWQiOiJkaWQ6a2V5OnpEbmFlckRhVEY1QlhFYXZDcmZSWkVrMzE2ZHBiTHNmUERaM1dKNWhSVFBGVTIxNjkiLCJleHAiOjE3OTAwMDAwMDAsImZjdCI6W3sid2VhdmUiOiJhZ2VudCJ9XSwiaXNzIjoiZGlkOmtleTp6RG5hZWFBN0JjVnhBaUxkTlAxNXdMdlM2U0MxdmFRYzl6cGVWeHJVcEVDNDh5eGtyIiwibmJmIjoxNzg5OTk2MTAwLCJubmMiOiIwMTIzNDU2Nzg5YWJjZGVmIiwicHJmIjpbXX0.rHSTyMWb-ryjlm0LoqyvPnye5o9PFGXL-zVv7bCx6g-6e4ZVPkOibbYtgHOOoMV9uNBQyuaKr20WDdngn638cg
```

Its CID (for this exact string): `bykutxpp5vpapg44f3cvy5vt3wiynyt2odlswcbez6dpt4u5fcera`.

*Source:* `packages/core/src/identity/ucan.ts`, `packages/core/src/validation/capability-gate.ts`, `packages/core/src/node/space-runtime.ts` (`writeCapability`, `noteCid`).
*Tests:* `packages/core/tests/ucan.test.ts`, `packages/core/tests/validation.test.ts`, `packages/core/tests/attacks.test.ts`.

---

## 8. Agent notes

An **agent** is not an identity. It writes for an account under a UCAN from
that account, like an app. What marks the key as an agent's is one fact the
account signs into the note:

```json
{ "weave": "agent" }
```

- A note is an **agent note** iff its payload's `fct` is an array containing an
  object whose `weave` member is the string `"agent"`. Anything unparseable is
  not an agent note.
- The fact is only meaningful in a note whose signature and chain verify
  (§7); `isAgentNote` itself only parses.
- The fact is set by the account (the root signer) when it issues the note.
  Nothing about the key itself says "agent".

What agents may not do (change collections, roles, membership) and how peers
enforce it is specified in [02 — Records](02-records.md),
[03 — Spaces](03-spaces.md) and [06](06-nodes-and-sessions.md).

> **Planned (open question): naming the agent.** Records show as "via agent",
> without saying which. The note could carry a name (say
> `{ "weave": "agent", "name": "Claude in Chrome" }`), but that is the
> agent's own word, signed by the account on its say-so, not a proof. Not
> decided whether that is worth showing.

*Source:* `packages/core/src/identity/agent-note.ts`, `packages/core/src/session/auth.ts` (issuing with `AGENT_FACT`).
*Tests:* `packages/core/tests/agents.test.ts`.

---

## 9. Contact keys, member keys and sealing

### 9.1 Contact key

A P-256 **key-agreement** key that lets anyone seal a message only the account
can open, while the account is offline.

```
d_contact = ScalarFrom(HKDF(seed, "weave/p256-contact-key/v1", 48))
```

- It is not the root key (one key should not both sign and decrypt) and not a
  session key (those rotate hourly; a request read next week must still open).
- The public half, as published, is `base64url(compressed point)` — 44
  characters. A valid public contact key is a string of at most 64 characters
  that decodes to a point on P-256.
- The public half is published in the account's profile record in each space
  it writes in (`sys.profile`, field `contactKey`; [03 — Spaces](03-spaces.md)).
  The private scalar stays with the account home, and is handed only to apps
  granted contacts ([06](06-nodes-and-sessions.md)).

Example (seed of §3.3): scalar
`c030558f2c355efdec2c21246e4d422143cad65af9c28532ba1a3fc34f2e0b83`, public
`AuK878OMKr6if2UO2L9nhzisStKD5W8tYM7ldyetTMdr`.

### 9.2 Member keys

One key-agreement key per account per space, to which a private space's new
keys are sealed ([03 — Spaces](03-spaces.md), `sys.box`).

```
accountKey = HKDF(seed, "weave-vault-key-v1", 32)          // §10.1
d_member   = ScalarFrom(HKDF(accountKey, "weave/p256-member-key/v1|" ‖ spaceId, 48))
```

The public half has the same encoding as the contact key. Being per space, an
account home can give an app the member keys for exactly the spaces it grants.

Example: seed of §3.3, `spaceId = "bexample"` → scalar
`c15cb915bd682b5c785ccf9c131acbad01c31906139a73f82fa58d4516c5553a`.

### 9.3 Door keys

One key-agreement key per **door** (an address the account hands out so that
strangers can ask to become a contact; [07 — Doors](07-doors.md)):

```
d_door = ScalarFrom(HKDF(d_contact_bytes, "weave/p256-door-key/v1|" ‖ doorId, 48))
```

where `d_contact_bytes` is the contact key's 32-byte big-endian private scalar
(§9.1). Beside it, each door has a **signing key**, used only for ECDSA:

```
d_door_sign = ScalarFrom(HKDF(d_contact_bytes, "weave/p256-door-sign-key/v1|" ‖ doorId, 48))
```

Every device and app holding the contact key derives the same door keys.
Their public halves (same encoding as the contact key) say nothing about the
account behind them.

### 9.4 Sealing (`sealFor` / `openSealed`)

To seal a JSON value `v` to public key `R` (base64url compressed point) under
a context string `ctx`:

1. Generate an ephemeral P-256 key pair `(e, E)`; `E65` = its uncompressed
   point (65 bytes).
2. `z` = ECDH(e, R), the 32-byte x-coordinate.
3. `k` = HKDF(`z ‖ E65`, `"weave/contact-seal/v1"`, 32), an AES-256-GCM key.
4. `iv` = 12 random bytes.
5. `ct` = AES-256-GCM(k, iv, plaintext = UTF-8(`JSON.stringify(v)`),
   additional data = UTF-8(`ctx`)); `ct` includes the 16-byte tag.
6. Output `base64url(E65 ‖ iv ‖ ct)`.

Opening reverses this. A sealed value shorter than 78 bytes, or one that fails
to authenticate (wrong key, wrong context, altered), MUST be treated as not
openable (the implementation returns `null`). The context binds a sealed value
to where it belongs; contexts in use are listed in §5.

Example size: `{"hi":1}` seals to 65 + 12 + 8 + 16 = 101 bytes.

*Source:* `packages/core/src/identity/contact-key.ts`.
*Tests:* `packages/core/tests/contacts.test.ts` ("the contact key"), `packages/core/tests/key-change.test.ts`, `packages/core/tests/doors.test.ts`.

---

## 10. The account vault

The seed is never stored in the clear. What is stored is an **account vault**:
the account's DID and a list of **wraps**, each an encrypted copy of the seed
openable one way. The recovery code needs no wrap.

### 10.1 The vault key

```
vaultKey = HKDF(seed, "weave-vault-key-v1", 32)      // AES-256-GCM
```

The vault key encrypts space keys and space records at rest
([05 — Sync and storage](05-sync-and-storage.md)). Its raw 32 bytes are also
the **account key**: input for member keys (§9.2) and the account's own spaces
([03 — Spaces](03-spaces.md)). A page SHOULD hold it as a non-extractable
`CryptoKey`; only a node that must derive from it gets the bytes.

Example (seed of §3.3): `f505285e87582af18ea47617b97d6b408f3032c3fd1dabf87b39ef8885d77e3a`.

### 10.2 Vault format (version 2)

```json
{
  "version": 2,
  "label": "Ada",
  "did": "did:key:zDnaeaA7BcVxAiLdNP15wLvS6SC1vaQc9zpeVxrUpEC48yxkr",
  "createdAt": "2026-09-26T11:47:11.062Z",
  "wraps": [
    {
      "kind": "device",
      "id": "8eWLsZlFIm0",
      "label": "app.example",
      "rpId": "app.example",
      "deviceKeyId": "q1w2e3r4t5y6u7i8",
      "credentialId": "AbCdEf",
      "userHandle": "Zz9",
      "addedAt": "2026-09-26T11:47:10.987Z",
      "salt": "",
      "iv": "jbEkOwndo3stlbr-",
      "ciphertext": "Kq_wfmoEi5jOrz7669nTPHIEUbK1noZLb9VfVZLCiUs"
    },
    {
      "kind": "passphrase",
      "id": "69sTGwYXr5c",
      "label": "Passphrase",
      "addedAt": "2026-09-26T11:47:11.062Z",
      "salt": "7_RXoBGzjVoqZ-sEuPGk1A",
      "iterations": 600000,
      "iv": "eiU7IOMbBVWebPLN",
      "ciphertext": "UGEZbMoL_wEUYxT680bQrlsSNX4_ZzgqDXg3PRPiSMM"
    }
  ]
}
```

(The passphrase wrap above opens with `hunter2 hunter2` to the seed of §3.3.)

| Field | Type | Meaning |
|---|---|---|
| `version` | `2` | Format version |
| `label` | string | Display name; never part of any key |
| `did` | string | The DID the seed derives. Public; lets a store recognise the account without unlocking it |
| `createdAt` | ISO 8601 string | |
| `wraps` | array of wrap | May be empty: a new account has none, and is opened by its recovery code |

Every wrap:

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"device"` \| `"passphrase"` | How it opens |
| `id` | string | base64url of 8 random bytes (11 chars); distinguishes wraps |
| `label` | string | Shown when choosing |
| `addedAt` | ISO 8601 string | |
| `salt` | string | base64url; `""` for device wraps |
| `iv` | string | base64url of the 12-byte AES-GCM nonce |
| `ciphertext` | string | base64url of AES-256-GCM(seed) with 16-byte tag, no additional data (32 bytes for a 16-byte seed) |

`device` wraps add:

| Field | Type | Meaning |
|---|---|---|
| `rpId` | string | Origin (WebAuthn relying-party id, normally the hostname) whose storage holds the key |
| `deviceKeyId` | string | Id of the device key (§11) that opens it |
| `credentialId` | string, optional | base64url id of the passkey gating it |
| `userHandle` | string, optional | base64url user handle of that passkey |

`passphrase` wraps add:

| Field | Type | Meaning |
|---|---|---|
| `iterations` | integer | PBKDF2 rounds; new wraps use 600 000 |

### 10.3 Wrapping and unwrapping

- **Device wrap:** `ciphertext = AES-256-GCM(deviceKey, iv, seed)`.
- **Passphrase wrap:**
  `wrappingKey = PBKDF2-HMAC-SHA256(UTF-8(NFKC(passphrase)), salt(16 random bytes), iterations, 256 bits)`;
  `ciphertext = AES-256-GCM(wrappingKey, iv, seed)`. Unwrapping MUST use the
  wrap's own `salt` and `iterations`.
- A fresh `iv` MUST be used for every wrap.
- A decryption failure means the wrong key or passphrase (AES-GCM
  authenticates); it is reported as `VAULT_UNLOCK_FAILED`.
- After unwrapping, a client SHOULD derive the DID and compare it with the
  vault's `did`.

> **Planned: wraps bound to their account.** Today a wrap's ciphertext has no
> additional data, and nothing stops a vault file being edited to a lower
> `iterations`. The plan: (1) after every unwrap the client MUST derive the DID
> and refuse a seed whose DID is not the vault's `did`; (2) new wraps use
> UTF-8(`did ‖ "|" ‖ wrap id`) as AES-GCM additional data, so a wrap moved
> between vaults or re-labelled fails to open; (3) a reader refuses a
> passphrase wrap whose `iterations` is below a minimum (the current 600 000
> is the natural floor). Pre-release, so old wraps need not stay openable.

### 10.4 Managing wraps

- A vault holds at most one device wrap per `rpId`: adding one replaces any
  existing device wrap for the same `rpId`, and the replaced wraps' device keys
  SHOULD be deleted.
- A client offers only device wraps whose `rpId` is its own (another origin's
  device key is unreachable from here).
- Removing wraps, including the last, is allowed; the account remains openable
  by its recovery code.
- When two copies of a vault are merged, wraps are unioned by `id`, subject to
  the one-device-wrap-per-`rpId` rule.

- The web flow keeps one passphrase wrap as the account's password: setting
  one replaces any other, except the CLI's (label `CLI passphrase`), which is
  for unattended unlocking and kept. A client opening by passphrase tries
  every passphrase wrap.

A passphrase wrap is the account's **password**. The web sign-in flow asks for
it, or a passkey, right after showing a new account's recovery code, and the
CLI account home (`packages/cli/src/home.ts`) creates them too. Unlike a device
wrap it is not tied to an origin: any origin that can read the vault — every
app pointed at a pod — can open it. That is also its weakness: a copy of the
vault can be attacked offline, so clients SHOULD require a minimum length (the
web flow requires 10 characters).

*Source:* `packages/core/src/identity/account-vault.ts`, `packages/core/src/identity/folder-account.ts` (`createVault`), `packages/core/src/session/auth.ts`.
*Tests:* `packages/core/tests/account-vault.test.ts`, `packages/core/tests/auth.test.ts`.

---

## 11. Device keys

A **device key** is a random AES-256-GCM key, generated **non-extractable**,
kept in the origin's IndexedDB. It opens the device wrap that names it.

| | |
|---|---|
| Algorithm | AES-GCM, 256 bits, usages `encrypt`, `decrypt`, `extractable: false` |
| Id | base64url of 12 random bytes (16 characters) |
| Storage (*implementation detail*) | IndexedDB database `weave-device-keys`, object store `keys`, key = id, value = the `CryptoKey` |

- A missing device key is a normal state (other browser, cleared storage): the
  wrap is unopenable here and the account falls back to its recovery code or a
  passphrase.
- Deleting the device key makes its wrap permanently unopenable.

**What it protects, and what it does not.** Someone holding a copy of the
folder or of the vault gets ciphertext and no key. Anything that can run script
in the origin can use the key in place without the passkey: the passkey in
front of it (§12) is enforced by this code, not by cryptography. Because the
key is non-extractable, it cannot be carried off and used elsewhere.

### 11.1 Staying signed in (*implementation detail*)

"Stay signed in" is a device wrap with a fresh device key and label
`stay signed in`, kept in `localStorage` (not in any vault), under
`weave.remembered-session` as
`{ accountId, place: "browser"|"folder", wrap, expiresAt }` (`expiresAt` in
Unix ms). The chosen duration (`never`, `1d`, `7d` (default), `30d`) is
under `weave.stay-signed-in`. Each use pushes `expiresAt` forward; expiry or
signing out deletes the record and its device key.

*Source:* `packages/core/src/identity/device-key.ts`, `packages/core/src/session/stay-signed-in.ts`.
*Tests:* `packages/core/tests/account-vault.test.ts` ("wrapping a seed"), `packages/core/tests/auth.test.ts`.

---

## 12. Passkeys and other ways to a root key

### 12.1 Passkeys are a gate

In the account model, a passkey does **not** yield key material. A WebAuthn
ceremony is required before the client reaches for a device key (§11); the
seed comes from the device wrap.

> Rationale: a passkey can return a secret only through the PRF extension,
> which several major credential providers do not implement or report
> inconsistently, and a passkey is bound to one relying party, so a derived
> identity would differ per origin.

There is no server, so the assertion's challenge and signature are not
verified by anyone; the gate is that the browser completed a
user-verified ceremony for the recorded credential.

### 12.2 WebAuthn parameters

Registration (`navigator.credentials.create`):

| Option | Value |
|---|---|
| `rp` | `{ id: rpId, name: appName }` (default name `Weave`) |
| `user.id` | 32 random bytes (kept, base64url, as the wrap's `userHandle`) |
| `user.name`, `user.displayName` | The account's name |
| `challenge` | 32 random bytes |
| `pubKeyCredParams` | ES256 (−7), RS256 (−257) |
| `authenticatorSelection` | `residentKey: "required"`, `requireResidentKey: true`, `userVerification: "required"`; `authenticatorAttachment: "platform"` when a platform authenticator exists |
| `hints` | `["client-device"]` when preferring the platform authenticator |
| `extensions.prf.eval.first` | UTF-8 `weave-protocol-key-v1` |

Assertion (`navigator.credentials.get`): random 32-byte challenge,
`userVerification: "required"`, `allowCredentials` = the wrap's `credentialId`
when known, and the same PRF request.

Renaming an account asks the provider to relabel the passkey through the
WebAuthn Signal API (`PublicKeyCredential.signalCurrentUserDetails` with the
`userHandle`); best effort.

### 12.3 PRF-derived identities (optional)

`IdentityManager.register` / `authenticate` derive a root key from a passkey:
`P256KeyFrom(prfOutput)`, where `prfOutput` is the 32-byte `prf.results.first`
for salt `weave-protocol-key-v1` (from the creation ceremony if the
authenticator returns it, otherwise from an immediate assertion). If no PRF
output comes back, this fails with `PRF_UNSUPPORTED`.

Such an identity is **not** seed-based: it has no recovery code and differs
per relying party. It is not used by the sign-in flow, and is not part of the
interoperable account model. `inspectPasskeyPrf` reports what a provider does
with PRF, for diagnosis (*implementation detail*).

### 12.4 Password-derived identities (testing)

`IdentityManager.fromPassword(password, salt?)`:
`P256KeyFrom(PBKDF2-HMAC-SHA256(UTF-8(password), salt, 100 000, 256 bits))`,
default salt UTF-8 `default-weave-salt`. No normalization. This exists for
tests and examples; clients SHOULD NOT use it for real accounts (a low-entropy
root key with a fixed salt).

> **Planned: removal.** Only tests call `fromPassword` and the password
> helper in `packages/core/src/identity/keys.ts` (100 000 PBKDF2 rounds, fixed salt). Both
> will be removed from the public API, with this section and the
> `default-weave-salt` row in §5.

*Source:* `packages/core/src/identity/webauthn.ts`, `packages/core/src/identity/identity-manager.ts`, `packages/core/src/identity/keys.ts`, `packages/core/src/identity/passkey-diagnostics.ts`, `packages/core/src/session/auth.ts` (`passkeyGate`).
*Tests:* `packages/core/tests/identity.test.ts` ("identity manager"). WebAuthn itself is not exercised by tests.

---

## 13. Account stores and folder accounts

Where vaults are kept. These are local storage formats; a folder's format
matters for interoperability between apps (and origins) that open the same
folder.

### 13.1 Folder layout (current)

```
<folder>/
  accounts.json                 list of accounts, readable without unlocking
  accounts/<id>/account.json    that account's vault (§10.2)
  accounts/<id>/stores/…        that account's spaces (05)
```

`accounts.json`:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "k3j9x0q2mz7a",
      "name": "Ada",
      "did": "did:key:zDnae…",
      "createdAt": "2026-09-26T11:47:11.062Z",
      "dataPath": "accounts/k3j9x0q2mz7a/stores",
      "lastUsedAt": "2026-09-26T12:00:00.000Z"
    }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string matching `^[a-z0-9]{1,12}$` | Account id and directory name. New ids: base64url of 8 random bytes, non-alphanumerics removed, lowercased, first 12 characters |
| `name` | string | Display name |
| `did` | string | Account DID |
| `createdAt` | ISO 8601 | |
| `dataPath` | string | Where the spaces live, relative to the folder: `accounts/<id>/stores` for an account's own subtree, or `stores` for a pre-list folder (§13.3) |
| `lastUsedAt` | ISO 8601, optional | |

Rules:

- Readers MUST skip rows whose `id` fails the pattern, or whose `dataPath` is
  neither `stores` nor `accounts/<valid id>/stores` exactly (the list is a
  plain file in a folder that may be shared; a path like `../..` is an
  attack).
- The list is shown most recently used first (`lastUsedAt`, else
  `createdAt`), with at most one row per DID (the most recent wins).
- Writing an account replaces any row with the same `id` or the same `did`.
- Removing an account removes its row and its `accounts/<id>` directory.
- Files are written as pretty-printed JSON (2-space indent) plus a trailing
  newline (*implementation detail*).

The list reveals how many accounts a folder holds, their names and DIDs; not
their seeds.

### 13.2 Browser store (*implementation detail*)

With no folder, the same shape lives in IndexedDB database `weave-accounts`,
object store `accounts`: key `__list` → array of summaries, key `<id>` → vault.

### 13.3 Legacy single-account folder

Before the list, a folder held one account at its root:

```
<folder>/
  weave-account.json     the vault (§10.2), or the version-1 form below
  README.txt             explanation for humans, rewritten on each save
  stores/…               the spaces
```

- If `weave-account.json` has `version: 2` and a `wraps` array, it is a vault.
  A reader that finds one not yet in `accounts.json` adopts it: new id, name =
  its `label` (default `My data`), `dataPath: "stores"`. Data is not moved.
- **Version 1** stored the seed in the clear as `{ "recoveryCode": "…",
  "label"?: …, "did"?: … }`. A reader MAY accept it to migrate, and MUST NOT
  write it; it is not adopted silently — the user is asked to lock it.
- Anything else is `FOLDER_ACCOUNT_UNREADABLE`.

*Source:* `packages/core/src/identity/account-store.ts`, `packages/core/src/identity/folder-account.ts`.
*Tests:* `packages/core/tests/account-store.test.ts`, `packages/core/tests/account-vault.test.ts` ("the account file"), `packages/cli/tests/path-safety.test.ts`.

---

## 14. Pairing

Pairing gives a second device (typically a phone, which cannot open a folder)
the account and the list of its spaces. Afterwards the phone is a full,
independent peer; the first device is not needed again.

### 14.1 The ticket

```json
{ "v": 1, "code": "008J-4CT4-ANK7-F24S-NAXW-SQFE-ZW", "relay": "wss://relay.example" }
```

| Field | Type | Meaning |
|---|---|---|
| `v` | `1` | Version |
| `code` | string | The account's recovery code (§2) |
| `relay` | string | A relay URL the offering device is connected to and the phone can reach |

Encoding: `base64url(UTF-8(JSON))`, placed in a URL fragment as
`<page>#pair=<ticket>` and shown as a QR code. Readers find it with
`/[#&]pair=([^&]+)/` on the fragment. A decoder MUST reject a ticket that is
not base64url JSON, whose `v` is not `1`, or whose `code` or `relay` is not a
string (`PAIRING_TICKET_UNREADABLE`). The page SHOULD remove the fragment from
the address bar once read.

Example (the ticket above):
`eyJ2IjoxLCJjb2RlIjoiMDA4Si00Q1Q0LUFOSzctRjI0Uy1OQVhXLVNRRkUtWlciLCJyZWxheSI6IndzczovL3JlbGF5LmV4YW1wbGUifQ`

The ticket carries the seed. It is placed in a fragment so the page's host
never receives it; anyone who sees the QR code can take the account.

### 14.2 Room and key

Both devices derive, from the seed, without sending them:

```
room = CID(UTF-8("weave-pairing-room-v1") ‖ seed)        // raw concatenation
key  = HKDF(seed, "weave-pairing-key-v1", 32)            // AES-256-GCM
```

Example (seed of §3.3): room `b57vwq7bthxai3s57aovb3xym47ipcu6iile33vyuknclzg45giaq`.

> Rationale: the room is derived from the seed, not the DID, because a DID is
> public (it is in every record); only a holder of the seed can find the room.

A sealed payload is `iv (12 random bytes) ‖ AES-256-GCM(key, iv, plaintext)`
(ciphertext including the 16-byte tag; no additional data). A payload of 12
bytes or fewer, or one that does not authenticate, MUST be rejected.

### 14.3 The exchange

Both devices join mesh room `room` ([04 — Network](04-network.md)) as their
session DIDs. The offering device joins with its configured relays; the phone
joins with exactly `[ticket.relay]`.

```
Offering device                                     Phone
  shows QR: <link>#pair=<ticket>
  joins room                                          reads ticket, signs in with ticket.code
                                                      joins room via ticket.relay
            ◀────────────── peer connected ──────────────▶
  builds { "spaces": [invite, …] }  (one invite per space it holds)
  sends NetworkMessage
    { type: "pair", from: <session DID>,
      payload: [<sealed bytes as integers 0–255>] }  ──▶
                                                      opens, joins each invite, leaves the room
```

- **Plaintext:** UTF-8 JSON `{ "spaces": [<invite>, …] }`, where each invite
  is the space's invite as produced by `spaces.invite(spaceId)` with default
  options — it carries whatever a peer needs to open the space, including a
  private space's key ([03 — Spaces](03-spaces.md)).
- **Offering device:** on every peer that connects, sends the handover to that
  peer. It keeps listening until the user stops the offer; stopping
  disconnects it.
- **Phone:** ignores messages whose `type` is not `pair` or whose `payload` is
  not an array. On the first `pair` message it opens the payload, joins every
  invite in order, and finishes. If opening or parsing fails it finishes with
  a failure. If nothing arrives within 30 seconds it finishes with zero spaces;
  the identity is already correct, only the spaces are missing.
- There is no reply message and no authentication of the phone beyond knowing
  the room and key, which require the seed.

### 14.4 Planned: pairing without showing the account

**Why.** The QR carries the recovery code, so a photo of the screen, a screen
share or a recording *is* the account, for good. The room is a hash of the
seed, so a relay gets a tag that follows the account across pairings. The
pairing key never changes, so a sealed handover can be replayed.

**Design.**

- The ticket carries a **one-time secret** (random, at least 16 bytes) and the
  relay URL. Nothing about the account.
- The room is a hash of the secret, under a new label. `weave-pairing-room-v1`
  and `weave-pairing-key-v1` (§5) go away.
- The two devices run a key exchange authenticated by the secret: ephemeral
  ECDH, with each side proving it knows the secret (for example, an HMAC under
  a key derived from the secret over both ephemeral public keys).
- Both screens show a **short code** derived from the exchange. The offering
  device sends the seed and the space invites over that channel only after the
  person confirms the codes match.
- The secret expires after a couple of minutes and after one use. The
  offering device serves one phone per offer, not every peer that connects.
- A page opened with a `#pair=` link while another account is already signed
  in SHOULD warn clearly before switching. Today a link someone sends you can
  sign you in to their account in one tap.

**Open questions.** Whether to use a standard PAKE (for example CPace or
SPAKE2) instead of an HMAC-authenticated ECDH, since the secret is
high-entropy and a PAKE's main benefit is for low-entropy ones; how long the
short code is; whether the phone sends anything back (an acknowledgement, so
the offer can close itself).

*Source:* `packages/core/src/identity/pairing.ts`, `packages/core/src/session/pairing.ts`, `packages/core/src/session/auth.ts` (`acceptPairing`).
*Tests:* `packages/core/tests/pairing.test.ts`.

---

## 15. Not yet specified

- Transport of parent tokens for multi-link delegation chains: planned in
  §7.5 ("Proof chains that travel").
- A checksum or version marker for recovery codes: planned in §2.3.
- Rotation of a compromised seed. Today an account *is* its seed; a new seed
  is a new identity. A proposal (KERI-style pre-rotation: the identifier is
  the hash of an inception event committing to the next key, with a signed
  key event log synced like records) is issue
  [#9](https://github.com/leifriksheim/weave/issues/9). It would change
  the DID format everywhere a root appears.
- Account-level revocation of a root delegation is by CID (`noteCid`); its
  record format belongs to [03 — Spaces](03-spaces.md) and
  [06](06-nodes-and-sessions.md).
