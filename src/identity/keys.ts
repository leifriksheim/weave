import { CryptoProvider } from '../types.js';

export interface DerivedKeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  readonly publicKeyBytes: Uint8Array;
}

const HKDF_INFO = new TextEncoder().encode('p2p-protocol-keypair-v1');

/**
 * Derives a key pair from PRF output.
 * @param {Uint8Array} prfOutput The PRF output bytes.
 * @param {CryptoProvider} provider The cryptography provider.
 * @returns {Promise<DerivedKeyPair>} The derived key pair.
 */
export async function deriveKeyPair(prfOutput: Uint8Array, provider: CryptoProvider): Promise<DerivedKeyPair> {
  const hkdfKey = await globalThis.crypto.subtle.importKey(
    'raw',
    prfOutput as BufferSource,
    { name: 'HKDF' },
    false,
    ['deriveBits']
  );

  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: HKDF_INFO
    },
    hkdfKey,
    256
  );

  // The provider turns the seed into a key pair whose public key genuinely
  // matches the private one — that correspondence is what makes a DID verifiable.
  const keyPair = await provider.deriveKeyPairFromSeed(new Uint8Array(derivedBits));
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
