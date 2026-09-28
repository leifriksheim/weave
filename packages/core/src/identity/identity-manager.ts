import { CryptoProvider } from '../types.js';
import { createP256Provider } from './crypto-p256.js';
import { deriveKeyPair } from './keys.js';
import { publicKeyToDid, P256_MULTICODEC } from './did.js';
import { recoveryCodeToSeed } from './recovery-code.js';

export interface Identity {
  readonly did: string;
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  readonly publicKeyBytes: Uint8Array;
}

export interface IdentityManager {
  /** Derives the root identity from a written-down recovery code (no passkey needed) */
  fromRecoveryCode(code: string): Promise<Identity>;
  /** Derives the root identity straight from seed bytes */
  fromSeed(seed: Uint8Array): Promise<Identity>;
  getProvider(): CryptoProvider;
}

/**
 * Creates an IdentityManager instance.
 * @param {{ provider?: CryptoProvider }} [config] Configuration options.
 * @returns {IdentityManager} The identity manager instance.
 */
export function createIdentityManager(config?: { readonly provider?: CryptoProvider }): IdentityManager {
  const provider = config?.provider || createP256Provider();

  return Object.freeze({
    async fromRecoveryCode(code: string): Promise<Identity> {
      return this.fromSeed(recoveryCodeToSeed(code));
    },

    async fromSeed(seed: Uint8Array): Promise<Identity> {
      // The seed already carries 128 bits of entropy, so it goes straight into
      // HKDF — no password stretching to slow down what is not a password.
      const keyPair = await deriveKeyPair(seed, provider);
      const did = publicKeyToDid(keyPair.publicKeyBytes, P256_MULTICODEC);

      return Object.freeze({
        did,
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
        publicKeyBytes: keyPair.publicKeyBytes,
      });
    },

    getProvider(): CryptoProvider {
      return provider;
    },
  });
}
