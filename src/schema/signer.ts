import type { CryptoProvider, Expression, UnsignedExpression } from '../types.js';
import { canonicalize, getExpressionId } from './expression.js';
import { utf8Encode, base64UrlEncode, base64UrlDecode } from '../utils/encoding.js';

/**
 * JWS-style signing and verification for expressions.
 */
export interface Signer {
  /**
   * Signs an unsigned payload, returning a complete Expression.
   * @param payload The unsigned expression to sign
   * @param privateKey The private CryptoKey for signing
   * @returns Promise resolving to the signed Expression
   */
  sign<T>(payload: UnsignedExpression<T>, privateKey: CryptoKey): Promise<Expression<T>>;
  
  /**
   * Verifies the signature and ID of an Expression.
   * @param expression The expression to verify
   * @param publicKey The public CryptoKey for verification
   * @returns Promise resolving to true if valid, false otherwise
   */
  verify<T>(expression: Expression<T>, publicKey: CryptoKey): Promise<boolean>;
}

/**
 * Creates a Signer instance using the provided CryptoProvider.
 * @param provider The CryptoProvider for cryptographic operations
 * @returns A Signer instance
 */
export function createSigner(provider: CryptoProvider): Signer {
  return Object.freeze({
    async sign<T>(payload: UnsignedExpression<T>, privateKey: CryptoKey): Promise<Expression<T>> {
      const canonicalStr = canonicalize(payload);
      const payloadBytes = utf8Encode(canonicalStr);
      
      const signatureBytes = await provider.sign(privateKey, payloadBytes);
      const signature = base64UrlEncode(signatureBytes);
      
      const id = await getExpressionId(payload);
      
      return Object.freeze({
        id,
        author: payload.author,
        collection: payload.collection,
        ...(payload.space ? { space: payload.space } : {}),
        createdAt: payload.createdAt,
        body: payload.body,
        ...(payload.proof ? { proof: payload.proof } : {}),
        signature,
      });
    },
    
    async verify<T>(expression: Expression<T>, publicKey: CryptoKey): Promise<boolean> {
      const { id, signature, ...unsignedPayload } = expression;
      
      // Verify ID
      const expectedId = await getExpressionId(unsignedPayload as UnsignedExpression<T>);
      if (id !== expectedId) {
        return false;
      }
      
      // Verify Signature
      const canonicalStr = canonicalize(unsignedPayload);
      const payloadBytes = utf8Encode(canonicalStr);
      const signatureBytes = base64UrlDecode(signature);
      
      return await provider.verify(publicKey, signatureBytes, payloadBytes);
    }
  });
}
