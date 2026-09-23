import { CryptoProvider } from '../types.js';

export interface DerivedKeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  readonly publicKeyBytes: Uint8Array;
}

/**
 * Derives a key pair from seed bytes: an account seed, a PRF output, or a
 * stretched password. One KDF step, owned by the provider, since how many bytes
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
    publicKeyBytes
  });
}

/**
 * Derives a key pair from a password and salt.
 * @param {string} password The password.
 * @param {Uint8Array} salt The salt.
 * @param {CryptoProvider} provider The cryptography provider.
 * @returns {Promise<DerivedKeyPair>} The derived key pair.
 */
export async function deriveKeyFromPassword(password: string, salt: Uint8Array, provider: CryptoProvider): Promise<DerivedKeyPair> {
  const encoder = new TextEncoder();
  const passwordKey = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      iterations: 100000
    },
    passwordKey,
    256
  );

  return deriveKeyPair(new Uint8Array(derivedBits), provider);
}
