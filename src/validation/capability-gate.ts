import type { CryptoProvider, Expression } from '../types.js';
import type { GateResult } from './crypto-gate.js';
import {
  isCapabilitySubset,
  resolveDelegationRoot,
  type Capability,
  type ProofResolver,
} from '../identity/ucan.js';

export interface CapabilityGateConfig {
  /** Crypto provider used to verify the UCANs in the chain */
  readonly provider: CryptoProvider;
  /** The capability an author must hold to write this expression */
  readonly requiredCapability: (expression: Expression) => Capability;
  /**
   * Looks up a parent UCAN by CID when a proof chain is longer than one link.
   * Expressions usually carry a single delegation, which needs no resolver.
   */
  readonly resolveProof?: ProofResolver;
  /**
   * Decides whether a root identity may write this expression at all — space
   * membership, an allow-list, or whatever the application's policy is.
   * Defaults to accepting any root: the signature still proves who wrote it.
   */
  readonly isTrustedRoot?: (rootDid: string, expression: Expression) => boolean | Promise<boolean>;
}

export interface CapabilityGate {
  validate(expression: Expression): Promise<GateResult>;
}

const fail = (reason: string): GateResult => ({ passed: false, gate: 'capability', reason });

/**
 * Creates a gate that checks an author was *authorized* to write an expression.
 *
 * The crypto gate proves an expression came from the key it claims. This one
 * answers the next question: may that key write here? An expression signed by a
 * delegated key carries a UCAN in `proof`, and the gate walks it back to a root
 * identity, refusing anything that is expired, misaddressed, over-broad, or
 * rooted in an identity the application does not trust.
 *
 * @param config Gate configuration
 * @returns A CapabilityGate instance
 */
export function createCapabilityGate(config: CapabilityGateConfig): CapabilityGate {
  const { provider, requiredCapability, resolveProof = () => null, isTrustedRoot } = config;

  return {
    async validate(expression: Expression): Promise<GateResult> {
      try {
        const required = requiredCapability(expression);

        // No proof: the author is acting for itself, not on anyone's behalf.
        if (!expression.proof) {
          if (isTrustedRoot && !(await isTrustedRoot(expression.author, expression))) {
            return fail(`Author ${expression.author} is not authorized here`);
          }
          return { passed: true, gate: 'capability' };
        }

        const chain = await resolveDelegationRoot(expression.proof, resolveProof, provider);
        if (!chain.valid || chain.rootDid === null) {
          return fail(chain.reason ?? 'Invalid delegation chain');
        }

        // The delegation has to name this author as its audience, or anyone
        // could attach someone else's valid UCAN to their own expression.
        if (chain.audience !== expression.author) {
          return fail('Proof was issued to a different key than the author');
        }

        if (!chain.capabilities.some((granted) => isCapabilitySubset(granted, required))) {
          return fail(`Proof does not grant ${required.can} on ${required.with}`);
        }

        if (isTrustedRoot && !(await isTrustedRoot(chain.rootDid, expression))) {
          return fail(`Root identity ${chain.rootDid} is not authorized here`);
        }

        return { passed: true, gate: 'capability' };
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Capability check failed');
      }
    },
  };
}
