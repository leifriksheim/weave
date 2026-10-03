import type { CryptoProvider } from '../types.js';
import { base64UrlEncode, base64UrlDecode, utf8Encode, utf8Decode } from '../utils/encoding.js';
import { cidFromBytes } from '../utils/hash.js';
import { canonicalize } from '../schema/expression.js';
import { didToPublicKey } from './did.js';

/** UCAN header */
export interface UCANHeader {
  readonly alg: string; // 'ES256' for P-256
  readonly typ: 'JWT';
  readonly ucv: '0.10.0'; // UCAN spec version
}

/** A capability (attenuation) */
export interface Capability {
  readonly with: string; // Resource URI, e.g. 'space:*' or 'space:did:key:z...'
  readonly can: string; // Action namespace, e.g. 'space/write', 'expression/create', '*'
}

/** Optional fact attached to UCAN */
export interface Fact {
  readonly [key: string]: unknown;
}

/** UCAN payload */
export interface UCANPayload {
  readonly iss: string; // Issuer DID
  readonly aud: string; // Audience DID (delegatee)
  readonly exp: number; // Expiration (Unix seconds)
  readonly nbf?: number; // Not before (Unix seconds)
  readonly nnc?: string; // Nonce for replay prevention
  readonly att: ReadonlyArray<Capability>; // Capabilities granted
  readonly prf: ReadonlyArray<string>; // Proof chain (CIDs of parent UCANs)
  readonly fct?: ReadonlyArray<Fact>; // Optional facts
}

/** A complete encoded UCAN token */
export interface UCANToken {
  readonly header: UCANHeader;
  readonly payload: UCANPayload;
  readonly signature: string; // Base64URL encoded
  readonly encoded: string; // Full JWT string: header.payload.signature
  readonly cid: string; // Content ID of the token for proof chains
}

/** Options for issuing a UCAN */
export interface IssueUCANOptions {
  readonly issuer: { readonly did: string; readonly privateKey: CryptoKey };
  readonly audience: string; // Audience DID
  readonly capabilities: ReadonlyArray<Capability>;
  readonly expiration?: number; // Unix seconds, default 1 hour from now
  readonly notBefore?: number;
  readonly nonce?: string;
  readonly proofs?: ReadonlyArray<string>; // CIDs of parent UCANs in the delegation chain
  readonly facts?: ReadonlyArray<Fact>;
}

/** Result of UCAN validation */
export interface UCANValidation {
  readonly valid: boolean;
  readonly issuer: string;
  readonly audience: string;
  readonly capabilities: ReadonlyArray<Capability>;
  readonly reason?: string;
}

/** Options for delegating capabilities */
export interface DelegateOptions {
  readonly parent: UCANToken; // Parent UCAN to delegate from
  readonly issuer: { readonly did: string; readonly privateKey: CryptoKey };
  readonly audience: string;
  readonly capabilities: ReadonlyArray<Capability>; // Must be subset of parent
  readonly expiration?: number; // Must be <= parent expiration
}

/** How far a token's start is set back for clocks that disagree — the allowance peers give a record's date. */
export const UCAN_CLOCK_SKEW_SECONDS = 300;

/** Creates and signs a UCAN token. */
export async function issueUCAN(options: IssueUCANOptions, provider: CryptoProvider): Promise<UCANToken> {
  const header: UCANHeader = { alg: 'ES256', typ: 'JWT', ucv: '0.10.0' };

  const now = Math.floor(Date.now() / 1000);
  const exp = options.expiration ?? now + 3600;
  // Records are judged at the time they claim to have been signed, so a token
  // with no start would let a leaked key write "last year" for as long as the
  // token lives. Set back by the clock skew peers already allow for.
  const nbf = options.notBefore ?? now - UCAN_CLOCK_SKEW_SECONDS;

  let nnc = options.nonce;
  if (!nnc) {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    nnc = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  const payload: UCANPayload = {
    iss: options.issuer.did,
    aud: options.audience,
    exp,
    nbf,
    nnc,
    att: options.capabilities,
    prf: options.proofs ?? [],
    fct: options.facts,
  };

  // A JSON round trip drops undefined fields, so what is signed is what a reader parses.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the round trip keeps the shape it was given
  const cleanPayload = JSON.parse(JSON.stringify(payload)) as UCANPayload;

  const encodedHeader = base64UrlEncode(utf8Encode(canonicalize(header)));
  const encodedPayload = base64UrlEncode(utf8Encode(canonicalize(cleanPayload)));

  const dataToSign = `${encodedHeader}.${encodedPayload}`;
  const signatureBytes = await provider.sign(options.issuer.privateKey, utf8Encode(dataToSign));
  const signature = base64UrlEncode(signatureBytes);

  const encoded = `${dataToSign}.${signature}`;
  const cid = await cidFromBytes(utf8Encode(encoded));

  return Object.freeze({
    header: Object.freeze(header),
    payload: Object.freeze(cleanPayload),
    signature,
    encoded,
    cid,
  });
}

/** Parses an encoded UCAN string without verifying its signature. */
export function parseUCAN(encoded: string): {
  readonly header: UCANHeader;
  readonly payload: UCANPayload;
  readonly signature: string;
} {
  const parts = encoded.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid UCAN token format');
  }

  const headerStr = utf8Decode(base64UrlDecode(parts[0]!));
  const payloadStr = utf8Decode(base64UrlDecode(parts[1]!));

  // Unverified by design: verifyUCAN checks the fields it relies on, and a
  // stricter parse here would change which tokens peers accept.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- wire input, checked by verifyUCAN
  const header = JSON.parse(headerStr) as UCANHeader;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- wire input, checked by verifyUCAN
  const payload = JSON.parse(payloadStr) as UCANPayload;

  return {
    header,
    payload,
    signature: parts[2]!,
  };
}

/** When to judge a token's time bounds */
export interface VerifyOptions {
  /**
   * Unix seconds to check `exp` and `nbf` against. Default: now.
   *
   * A record is judged at the moment it was signed, not the moment someone
   * reads it. Checking against now would make every record stop verifying
   * the hour its session's delegation ran out — and a peer arriving later
   * would refuse all of it.
   */
  readonly at?: number;
}

/** Tokens whose signature checked out, the oldest let go first */
const signedTokens = new Set<string>();
const MAX_SIGNED_TOKENS = 1000;

function invalid(reason: string, payload?: UCANPayload): UCANValidation {
  return {
    valid: false,
    issuer: payload?.iss ?? '',
    audience: payload?.aud ?? '',
    capabilities: payload?.att ?? [],
    reason,
  };
}

/** Verifies a UCAN token's signature and time bounds */
export async function verifyUCAN(
  encoded: string,
  provider: CryptoProvider,
  options: VerifyOptions = {},
): Promise<UCANValidation> {
  try {
    const parts = encoded.split('.');
    if (parts.length !== 3) return invalid('Invalid UCAN token format');

    const { payload, signature } = parseUCAN(encoded);
    const now = options.at ?? Math.floor(Date.now() / 1000);

    // Both bounds are required: a token without `exp` would never expire
    // (`undefined <= now` is false), and one without `nbf` could vouch for
    // records dated any time before it was issued.
    if (
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp) ||
      typeof payload.nbf !== 'number' ||
      !Number.isFinite(payload.nbf)
    ) {
      return invalid('Token must say when it starts and ends', payload);
    }
    if (payload.exp <= now) return invalid('Token has expired', payload);
    if (payload.nbf > now) return invalid('Token not yet valid', payload);

    // The signature is part of the token, so a token that checked out once
    // always does; only its time bounds, above, depend on when.
    if (!signedTokens.has(encoded)) {
      const { publicKeyBytes } = didToPublicKey(payload.iss);
      const publicKey = await provider.importPublicKey(publicKeyBytes);
      const signed = await provider.verify(
        publicKey,
        base64UrlDecode(signature),
        utf8Encode(`${parts[0]}.${parts[1]}`),
      );
      if (!signed) return invalid('Invalid signature', payload);
      signedTokens.add(encoded);
      if (signedTokens.size > MAX_SIGNED_TOKENS) signedTokens.delete(signedTokens.values().next().value!);
    }

    return { valid: true, issuer: payload.iss, audience: payload.aud, capabilities: payload.att };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'Unknown verification error');
  }
}

/** Checks if a child capability is a valid subset of a parent capability. */
export function isCapabilitySubset(parent: Capability, child: Capability): boolean {
  const withMatch = parent.with === '*' || parent.with === child.with;
  if (!withMatch) {
    return false;
  }

  if (parent.can === '*' || parent.can === child.can) {
    return true;
  }

  if (parent.can.endsWith('/*')) {
    const prefix = parent.can.slice(0, -1);
    return child.can.startsWith(prefix);
  }

  return false;
}

/**
 * What is wrong with one link of a chain, or null: every proof the child
 * names must be this parent, which must check out, be made out to the child's
 * issuer, and grant at least what the child does.
 */
async function linkIssue(
  child: UCANPayload,
  parentEncoded: string,
  provider: CryptoProvider,
  options: VerifyOptions,
): Promise<string | null> {
  const cid = await cidFromBytes(utf8Encode(parentEncoded));
  const missing = child.prf.find((required) => required !== cid);
  if (missing !== undefined) return `Missing proof token with CID: ${missing}`;
  const checked = await verifyUCAN(parentEncoded, provider, options);
  if (!checked.valid) return `Invalid proof token in chain: ${checked.reason}`;
  const parent = parseUCAN(parentEncoded).payload;
  if (parent.aud !== child.iss) return 'Delegation chain broken: audience/issuer mismatch';
  if (!child.att.every((cap) => parent.att.some((held) => isCapabilitySubset(held, cap)))) {
    return 'Delegated capability is not a subset of parent capability';
  }
  return null;
}

/** Helper to delegate capabilities from a parent UCAN token. */
export async function delegateCapabilities(
  options: DelegateOptions,
  provider: CryptoProvider,
): Promise<UCANToken> {
  // The delegator must be the audience of the parent token
  if (options.parent.payload.aud !== options.issuer.did) {
    throw new Error('Delegation chain broken: issuer must be the audience of the parent UCAN');
  }

  // Validate capabilities attenuation
  for (const childCap of options.capabilities) {
    const isSubset = options.parent.payload.att.some((parentCap) => isCapabilitySubset(parentCap, childCap));
    if (!isSubset) {
      throw new Error(`Capability ${JSON.stringify(childCap)} is not a subset of parent capabilities`);
    }
  }

  // Validate expiration
  if (options.expiration !== undefined && options.expiration > options.parent.payload.exp) {
    throw new Error('Delegated expiration cannot exceed parent expiration');
  }

  return await issueUCAN(
    {
      issuer: options.issuer,
      audience: options.audience,
      capabilities: options.capabilities,
      expiration: options.expiration ?? options.parent.payload.exp,
      proofs: [options.parent.cid],
    },
    provider,
  );
}

/** Resolves a proof token by its CID, returning null when it cannot be found. */
export type ProofResolver = (cid: string) => Promise<string | null> | string | null;

/** The outcome of walking a delegation chain back to its root */
export interface ChainResolution {
  readonly valid: boolean;
  /** The DID at the root of the chain — the identity ultimately being acted for */
  readonly rootDid: string | null;
  /** Capabilities the leaf token holds, once the chain is known to be sound */
  readonly capabilities: ReadonlyArray<Capability>;
  /** Audience of the leaf: the key allowed to use these capabilities */
  readonly audience: string | null;
  readonly reason?: string;
}

/** Guards against a cyclic or absurdly deep proof chain. */
const MAX_CHAIN_DEPTH = 10;

/**
 * Walks a delegation chain from a leaf token back to its root, verifying every
 * link: each token's signature, each parent's audience matching its child's
 * issuer, and attenuation at every step.
 *
 * Each token is followed through the first entry of its `prf` array, so this
 * resolves single-parent chains — the shape delegation takes in practice.
 */
export async function resolveDelegationRoot(
  encoded: string,
  resolveProof: ProofResolver,
  provider: CryptoProvider,
  options: VerifyOptions = {},
): Promise<ChainResolution> {
  const fail = (reason: string): ChainResolution => ({
    valid: false,
    rootDid: null,
    capabilities: [],
    audience: null,
    reason,
  });
  const leafValidation = await verifyUCAN(encoded, provider, options);
  if (!leafValidation.valid) return fail(leafValidation.reason ?? 'Invalid token');

  const leaf = parseUCAN(encoded).payload;
  let current = leaf;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    const parentCid = current.prf[0];
    // No proof left to follow: this issuer is the root of the chain.
    if (parentCid === undefined) {
      return { valid: true, rootDid: current.iss, capabilities: leaf.att, audience: leaf.aud };
    }
    const parentEncoded = await resolveProof(parentCid);
    if (!parentEncoded) return fail(`Missing proof token with CID: ${parentCid}`);
    const issue = await linkIssue(current, parentEncoded, provider, options);
    if (issue) return fail(issue);
    current = parseUCAN(parentEncoded).payload;
  }
  return fail(`Delegation chain deeper than ${MAX_CHAIN_DEPTH} links`);
}
