import { CryptoProvider } from '../types.js';

export interface DerivedKeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  readonly publicKeyBytes: Uint8Array;
}

/**
 * Derives a key pair from seed bytes: an account seed or a derived secret.
 * One KDF step, owned by the provider, since how many bytes
 * a curve needs to reach a key without bias is a property of the curve.
 * @param {Uint8Array} seed At least 16 uniformly random bytes.
 * @param {CryptoProvider} provider The cryptography provider.
 * @returns {Promise<DerivedKeyPair>} The derived key pair.
 */
export async function deriveKeyPair(seed: Uint8Array, provider: CryptoProvider): Promise<DerivedKeyPair> {
  // The provider turns the seed into a key pair whose public key genuinely
  // matches the private one — that correspondence is what makes a DID verifiable.
  const keyPair = await provider.deriveKeyPairFromSeed(seed);
  const publicKeyBytes = await provider.exportPublicKey(keyPair.publicKey);

  return Object.freeze({
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyBytes,
  });
}
