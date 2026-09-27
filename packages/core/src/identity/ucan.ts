import type { CryptoProvider } from '../types.js';
import { base64UrlEncode, base64UrlDecode, utf8Encode, utf8Decode } from '../utils/encoding.js';
import { cidFromBytes } from '../utils/hash.js';
import { canonicalize } from '../schema/expression.js';
import { didToPublicKey } from './did.js';

/** UCAN header */
export interface UCANHeader {
  readonly alg: string;      // 'ES256' for P-256
  readonly typ: 'JWT';
  readonly ucv: '0.10.0';    // UCAN spec version
}

/** A capability (attenuation) */
export interface Capability {
  readonly with: string;     // Resource URI, e.g. 'space:*' or 'space:did:key:z...'
  readonly can: string;      // Action namespace, e.g. 'space/write', 'expression/create', '*'
}

/** Optional fact attached to UCAN */
export interface Fact {
  readonly [key: string]: unknown;
}

/** UCAN payload */
export interface UCANPayload {
  readonly iss: string;        // Issuer DID
  readonly aud: string;        // Audience DID (delegatee)
  readonly exp: number;        // Expiration (Unix seconds)
  readonly nbf?: number;       // Not before (Unix seconds)
  readonly nnc?: string;       // Nonce for replay prevention
  readonly att: ReadonlyArray<Capability>;  // Capabilities granted
  readonly prf: ReadonlyArray<string>;      // Proof chain (CIDs of parent UCANs)
  readonly fct?: ReadonlyArray<Fact>;       // Optional facts
}

/** A complete encoded UCAN token */
export interface UCANToken {
  readonly header: UCANHeader;
  readonly payload: UCANPayload;
  readonly signature: string;  // Base64URL encoded
  readonly encoded: string;    // Full JWT string: header.payload.signature
  readonly cid: string;        // Content ID of the token for proof chains
}

/** Options for issuing a UCAN */
export interface IssueUCANOptions {
  readonly issuer: { readonly did: string; readonly privateKey: CryptoKey };
  readonly audience: string;   // Audience DID
  readonly capabilities: ReadonlyArray<Capability>;
  readonly expiration?: number;  // Unix seconds, default 1 hour from now
  readonly notBefore?: number;
  readonly nonce?: string;
  readonly proofs?: ReadonlyArray<string>;  // CIDs of parent UCANs in the delegation chain
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
  readonly parent: UCANToken;       // Parent UCAN to delegate from
  readonly issuer: { readonly did: string; readonly privateKey: CryptoKey };
  readonly audience: string;
  readonly capabilities: ReadonlyArray<Capability>;  // Must be subset of parent
  readonly expiration?: number;      // Must be <= parent expiration
}

/** How far a token's start is set back for clocks that disagree — the allowance peers give a record's date. */
export const UCAN_CLOCK_SKEW_SECONDS = 300;

/**
 * Creates and signs a UCAN token.
 * 
 * @param {IssueUCANOptions} options Options for issuing the token
 * @param {CryptoProvider} provider Crypto provider for signing
 * @returns {Promise<UCANToken>} The created UCAN token
 */
export async function issueUCAN(options: IssueUCANOptions, provider: CryptoProvider): Promise<UCANToken> {
  const header: UCANHeader = { alg: 'ES256', typ: 'JWT', ucv: '0.10.0' };
  
  const now = Math.floor(Date.now() / 1000);
  const exp = options.expiration ?? (now + 3600);
  // Records are judged at the time they claim to have been signed, so a token
  // with no start would let a leaked key write "last year" for as long as the
  // token lives. Set back by the clock skew peers already allow for.
  const nbf = options.notBefore ?? now - UCAN_CLOCK_SKEW_SECONDS;
  
  let nnc = options.nonce;
  if (!nnc) {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    nnc = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  
  const payload: UCANPayload = {
    iss: options.issuer.did,
    aud: options.audience,
    exp,
    nbf,
    nnc,
    att: options.capabilities,
    prf: options.proofs ?? [],
    fct: options.facts
  };
  
  // Clean up undefined properties for deterministic encoding
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
    cid
  });
}

/**
 * Parses an encoded UCAN string without verifying its signature.
 * 
 * @param {string} encoded The JWT string to parse
 * @returns {{ header: UCANHeader, payload: UCANPayload, signature: string }} The parsed UCAN parts
 */
export function parseUCAN(encoded: string): { readonly header: UCANHeader; readonly payload: UCANPayload; readonly signature: string } {
  const parts = encoded.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid UCAN token format');
  }
  
  const headerStr = utf8Decode(base64UrlDecode(parts[0]!));
  const payloadStr = utf8Decode(base64UrlDecode(parts[1]!));
  
  const header = JSON.parse(headerStr) as UCANHeader;
  const payload = JSON.parse(payloadStr) as UCANPayload;
  
  return {
    header,
    payload,
    signature: parts[2]!
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

/**
 * Verifies a UCAN token's signature and time bounds.
 * 
 * @param {string} encoded The encoded UCAN token
 * @param {CryptoProvider} provider Crypto provider for verifying
 * @param {VerifyOptions} options When to judge expiry
 * @returns {Promise<UCANValidation>} The validation result
 */
export async function verifyUCAN(encoded: string, provider: CryptoProvider, options: VerifyOptions = {}): Promise<UCANValidation> {
  try {
    const parts = encoded.split('.');
    if (parts.length !== 3) {
      return { valid: false, issuer: '', audience: '', capabilities: [], reason: 'Invalid UCAN token format' };
    }
    
    const { header: _header, payload, signature } = parseUCAN(encoded);
    
    const now = options.at ?? Math.floor(Date.now() / 1000);
    
    // Both bounds are required: a token without `exp` would never expire
    // (`undefined <= now` is false), and one without `nbf` could vouch for
    // records dated any time before it was issued.
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf)) {
      return { valid: false, issuer: payload.iss, audience: payload.aud, capabilities: payload.att, reason: 'Token must say when it starts and ends' };
    }

    if (payload.exp <= now) {
      return { valid: false, issuer: payload.iss, audience: payload.aud, capabilities: payload.att, reason: 'Token has expired' };
    }
    
    if (payload.nbf > now) {
      return { valid: false, issuer: payload.iss, audience: payload.aud, capabilities: payload.att, reason: 'Token not yet valid' };
    }
    
    const { publicKeyBytes } = didToPublicKey(payload.iss);
    const publicKey = await provider.importPublicKey(publicKeyBytes);
    
    const dataToVerify = `${parts[0]}.${parts[1]}`;
    const signatureBytes = base64UrlDecode(signature);
    
    const isValid = await provider.verify(publicKey, signatureBytes, utf8Encode(dataToVerify));
    
    if (!isValid) {
      return { valid: false, issuer: payload.iss, audience: payload.aud, capabilities: payload.att, reason: 'Invalid signature' };
    }
    
    return {
      valid: true,
      issuer: payload.iss,
      audience: payload.aud,
      capabilities: payload.att
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown verification error';
    return { valid: false, issuer: '', audience: '', capabilities: [], reason };
  }
}

/**
 * Checks if a child capability is a valid subset of a parent capability.
 * 
 * @param {Capability} parent The parent capability
 * @param {Capability} child The child capability
 * @returns {boolean} True if child is a valid subset of parent
 */
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
 * Validates a complete delegation chain of UCAN tokens.
 * 
 * @param {string} token The leaf UCAN token to validate
 * @param {ReadonlyArray<string>} proofTokens Array of encoded parent UCANs forming the proof chain
 * @param {CryptoProvider} provider Crypto provider for verifying
 * @returns {Promise<UCANValidation>} The chain validation result
 */
export async function validateDelegationChain(
  token: string,
  proofTokens: ReadonlyArray<string>,
  provider: CryptoProvider,
  options: VerifyOptions = {}
): Promise<UCANValidation> {
  const leafValidation = await verifyUCAN(token, provider, options);
  if (!leafValidation.valid) {
    return leafValidation;
  }
  
  const parsedLeaf = parseUCAN(token);
  
  // Base case: No proofs required if the token has no parent references
  if (parsedLeaf.payload.prf.length === 0) {
    return leafValidation;
  }
  
  // Parse all proof tokens
  const proofs = await Promise.all(proofTokens.map(async (encoded) => {
    const validation = await verifyUCAN(encoded, provider, options);
    const parsed = parseUCAN(encoded);
    const cid = await cidFromBytes(utf8Encode(encoded));
    return { validation, parsed, encoded, cid };
  }));
  
  // Ensure all required proofs by CID are provided and valid
  for (const requiredCid of parsedLeaf.payload.prf) {
    const proof = proofs.find(p => p.cid === requiredCid);
    if (!proof) {
      return { ...leafValidation, valid: false, reason: `Missing proof token with CID: ${requiredCid}` };
    }
    
    if (!proof.validation.valid) {
      return { ...leafValidation, valid: false, reason: `Invalid proof token in chain: ${proof.validation.reason}` };
    }
    
    // Check delegation linkage (parent audience must equal child issuer)
    if (proof.parsed.payload.aud !== parsedLeaf.payload.iss) {
      return { ...leafValidation, valid: false, reason: 'Delegation chain broken: audience/issuer mismatch' };
    }
    
    // Check capabilities attenuation
    for (const childCap of parsedLeaf.payload.att) {
      const isSubset = proof.parsed.payload.att.some(parentCap => isCapabilitySubset(parentCap, childCap));
      if (!isSubset) {
        return { ...leafValidation, valid: false, reason: 'Delegated capability is not a subset of parent capability' };
      }
    }
  }
  
  // All checks passed
  return leafValidation;
}

/**
 * Helper to delegate capabilities from a parent UCAN token.
 * 
 * @param {DelegateOptions} options Delegation options
 * @param {CryptoProvider} provider Crypto provider for signing
 * @returns {Promise<UCANToken>} The delegated UCAN token
 */
export async function delegateCapabilities(options: DelegateOptions, provider: CryptoProvider): Promise<UCANToken> {
  // The delegator must be the audience of the parent token
  if (options.parent.payload.aud !== options.issuer.did) {
    throw new Error('Delegation chain broken: issuer must be the audience of the parent UCAN');
  }
  
  // Validate capabilities attenuation
  for (const childCap of options.capabilities) {
    const isSubset = options.parent.payload.att.some(parentCap => isCapabilitySubset(parentCap, childCap));
    if (!isSubset) {
      throw new Error(`Capability ${JSON.stringify(childCap)} is not a subset of parent capabilities`);
    }
  }
  
  // Validate expiration
  if (options.expiration !== undefined && options.expiration > options.parent.payload.exp) {
    throw new Error('Delegated expiration cannot exceed parent expiration');
  }
  
  return await issueUCAN({
    issuer: options.issuer,
    audience: options.audience,
    capabilities: options.capabilities,
    expiration: options.expiration ?? options.parent.payload.exp,
    proofs: [options.parent.cid]
  }, provider);
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
 *
 * @param encoded The leaf UCAN
 * @param resolveProof Looks up a parent token by CID (from local storage, a peer, …)
 * @param provider Crypto provider for signature verification
 * @param options When to judge expiry — for a record, when it was signed
 * @returns What the chain grants, and the root DID behind it
 */
export async function resolveDelegationRoot(
  encoded: string,
  resolveProof: ProofResolver,
  provider: CryptoProvider,
  options: VerifyOptions = {}
): Promise<ChainResolution> {
  const leafValidation = await verifyUCAN(encoded, provider, options);
  if (!leafValidation.valid) {
    return { valid: false, rootDid: null, capabilities: [], audience: null, reason: leafValidation.reason ?? 'Invalid token' };
  }

  const leaf = parseUCAN(encoded);
  let current = { encoded, payload: leaf.payload };

  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    const parentCid = current.payload.prf[0];

    // No proof left to follow: this issuer is the root of the chain.
    if (parentCid === undefined) {
      return {
        valid: true,
        rootDid: current.payload.iss,
        capabilities: leaf.payload.att,
        audience: leaf.payload.aud
      };
    }

    const parentEncoded = await resolveProof(parentCid);
    if (!parentEncoded) {
      return { valid: false, rootDid: null, capabilities: [], audience: null, reason: `Missing proof token with CID: ${parentCid}` };
    }

    // validateDelegationChain checks this single link: parent signature,
    // audience → issuer linkage, and capability attenuation.
    const link = await validateDelegationChain(current.encoded, [parentEncoded], provider, options);
    if (!link.valid) {
      return { valid: false, rootDid: null, capabilities: [], audience: null, reason: link.reason ?? 'Broken delegation chain' };
    }

    current = { encoded: parentEncoded, payload: parseUCAN(parentEncoded).payload };
  }

  return { valid: false, rootDid: null, capabilities: [], audience: null, reason: `Delegation chain deeper than ${MAX_CHAIN_DEPTH} links` };
}
