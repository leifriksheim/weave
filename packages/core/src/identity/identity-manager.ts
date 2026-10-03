import type { CryptoProvider } from '../types.js';
import { createP256Provider } from './crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from './did.js';
import { recoveryCodeToSeed } from './recovery-code.js';
import { createLocalRootSigner, type RootSigner } from './root-signer.js';

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

export function createIdentityManager(config?: { readonly provider?: CryptoProvider }): IdentityManager {
  const provider = config?.provider || createP256Provider();

  return Object.freeze({
    async fromRecoveryCode(code: string): Promise<Identity> {
      return this.fromSeed(recoveryCodeToSeed(code));
    },

    async fromSeed(seed: Uint8Array): Promise<Identity> {
      // The seed already carries 128 bits of entropy, so the provider's one KDF
      // step is enough: no password stretching for what is not a password.
      const { publicKey, privateKey } = await provider.deriveKeyPairFromSeed(seed);
      const publicKeyBytes = await provider.exportPublicKey(publicKey);
      return Object.freeze({
        did: publicKeyToDid(publicKeyBytes, P256_MULTICODEC),
        publicKey,
        privateKey,
        publicKeyBytes,
      });
    },

    getProvider(): CryptoProvider {
      return provider;
    },
  });
}

/** The root identity and a signer for it, from the seed */
export async function rootFromSeed(seed: Uint8Array): Promise<{ identity: Identity; signer: RootSigner }> {
  const manager = createIdentityManager();
  const identity = await manager.fromSeed(seed);
  return { identity, signer: createLocalRootSigner(identity, manager.getProvider()) };
}
