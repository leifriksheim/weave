import type { CryptoProvider, Expression, UnsignedExpression } from '../types.js';
import { bodyProblem, canonicalize, envelopeOf, getExpressionId, signedPart } from './expression.js';
import { utf8Encode, base64UrlEncode, base64UrlDecode } from '../utils/encoding.js';

/** JWS-style signing and verification for expressions. */
export interface Signer {
  /** Signs an unsigned payload, returning a complete Expression. */
  sign<T>(
    payload: UnsignedExpression<T>,
    privateKey: CryptoKey,
  ): Promise<Expression<T> & { readonly body: T }>;

  /** Verifies the signature and ID of an Expression. */
  verify<T>(expression: Expression<T>, publicKey: CryptoKey): Promise<boolean>;
}

export function createSigner(provider: CryptoProvider): Signer {
  return Object.freeze({
    async sign<T>(payload: UnsignedExpression<T>, privateKey: CryptoKey) {
      // The body is signed through its hash, so the envelope checks without it.
      const envelope = await envelopeOf(payload);
      const signature = base64UrlEncode(await provider.sign(privateKey, utf8Encode(canonicalize(envelope))));
      // Everything that was signed, and nothing else: listing fields one by
      // one would silently drop any field added later from the record.
      return Object.freeze({
        id: await getExpressionId(envelope),
        ...envelope,
        body: payload.body,
        signature,
      });
    },

    async verify<T>(expression: Expression<T>, publicKey: CryptoKey): Promise<boolean> {
      const signed = signedPart(expression);
      if ((await bodyProblem(expression)) || expression.id !== (await getExpressionId(signed))) return false;
      const bytes = utf8Encode(canonicalize(signed));
      return provider.verify(publicKey, base64UrlDecode(expression.signature), bytes);
    },
  });
}
