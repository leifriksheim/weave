import { CryptoProvider, Expression, UnsignedExpression } from '../types.js';
import { utf8Encode, base64UrlDecode } from '../utils/encoding.js';
import { canonicalize, getExpressionId } from '../schema/expression.js';

export interface GateResult {
  readonly passed: boolean;
  readonly gate: string;
  readonly reason?: string;
}

export interface CryptoGate {
  validate(expression: Expression, resolvePublicKey: (did: string) => Promise<CryptoKey>): Promise<GateResult>;
}

/**
 * Creates a gate that performs cryptographic validation of expressions.
 * @param provider The cryptographic provider to use.
 * @returns A CryptoGate instance.
 */
export function createCryptoGate(provider: CryptoProvider): CryptoGate {
  return {
    async validate(expression: Expression, resolvePublicKey: (did: string) => Promise<CryptoKey>): Promise<GateResult> {
      try {
        // Only the unsigned payload is signed — the id is a hash of it, and the
        // signature is not part of what was hashed.
        const { id, signature, ...unsignedPayload } = expression;

        const expectedId = await getExpressionId(unsignedPayload as UnsignedExpression);
        if (id !== expectedId) {
          return { passed: false, gate: 'crypto', reason: 'Expression id does not match its content' };
        }

        const data = utf8Encode(canonicalize(unsignedPayload));
        
        const publicKey = await resolvePublicKey(expression.author);
        const sigBytes = base64UrlDecode(signature!);
        
        const isValid = await provider.verify(publicKey, sigBytes, data);
        if (isValid) {
          return { passed: true, gate: 'crypto' };
        } else {
          return { passed: false, gate: 'crypto', reason: 'Signature verification failed' };
        }
      } catch (err: any) {
        return { passed: false, gate: 'crypto', reason: err.message || 'Unknown crypto error' };
      }
    }
  };
}
