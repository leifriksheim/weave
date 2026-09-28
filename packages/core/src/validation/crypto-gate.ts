import { CryptoProvider, Expression } from '../types.js';
import { utf8Encode, base64UrlDecode } from '../utils/encoding.js';
import { messageOf } from '../utils/errors.js';
import { bodyProblem, canonicalize, getExpressionId, signedPart } from '../schema/expression.js';

export interface GateResult {
  readonly passed: boolean;
  readonly gate: string;
  readonly reason?: string;
}

export interface CryptoGate {
  validate(
    expression: Expression,
    resolvePublicKey: (did: string) => Promise<CryptoKey>,
  ): Promise<GateResult>;
}

/**
 * Creates a gate that performs cryptographic validation of expressions.
 * @param provider The cryptographic provider to use.
 * @returns A CryptoGate instance.
 */
export function createCryptoGate(provider: CryptoProvider): CryptoGate {
  return {
    async validate(
      expression: Expression,
      resolvePublicKey: (did: string) => Promise<CryptoKey>,
    ): Promise<GateResult> {
      try {
        // Only the envelope is signed — the id is a hash of it, the signature
        // is not part of what was hashed, and the body is there as its hash.
        const { id, signature } = expression;
        const unsignedPayload = signedPart(expression);

        const expectedId = await getExpressionId(unsignedPayload);
        if (id !== expectedId) {
          return { passed: false, gate: 'crypto', reason: 'Expression id does not match its content' };
        }

        const data = utf8Encode(canonicalize(unsignedPayload));

        const publicKey = await resolvePublicKey(expression.author);
        const sigBytes = base64UrlDecode(signature);

        const isValid = await provider.verify(publicKey, sigBytes, data);
        if (isValid) {
          const problem = await bodyProblem(expression);
          if (problem) return { passed: false, gate: 'crypto', reason: problem };
          return { passed: true, gate: 'crypto' };
        } else {
          return { passed: false, gate: 'crypto', reason: 'Signature verification failed' };
        }
      } catch (err) {
        return { passed: false, gate: 'crypto', reason: messageOf(err, 'Unknown crypto error') };
      }
    },
  };
}
