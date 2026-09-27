import { CryptoProvider } from '../types.js';
import { createP256Provider } from './crypto-p256.js';
import { registerPasskey, authenticatePasskey } from './webauthn.js';
import { deriveKeyPair, deriveKeyFromPassword } from './keys.js';
import { publicKeyToDid, P256_MULTICODEC } from './did.js';
import { protocolError } from '../utils/errors.js';
import { recoveryCodeToSeed } from './recovery-code.js';

export interface IdentityConfig {
  readonly provider?: CryptoProvider;
  readonly rpId?: string;
  readonly rpName?: string;
}

export interface Identity {
  readonly did: string;
  readonly credentialId?: string;
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  readonly publicKeyBytes: Uint8Array;
}

/** How a passkey ceremony should be steered */
export interface CeremonyPreferences {
  /** Favour the platform passkey over an installed credential manager */
  readonly preferPlatform?: boolean;
}

export interface IdentityManager {
  register(userName: string, preferences?: CeremonyPreferences): Promise<Identity>;
  /** Signs in with a known passkey, or any discoverable one when no id is given. */
  authenticate(credentialId?: string, preferences?: CeremonyPreferences): Promise<Identity>;
  fromPassword(password: string, salt?: Uint8Array): Promise<Identity>;
  /** Derives the root identity from a written-down recovery code (no passkey needed) */
  fromRecoveryCode(code: string): Promise<Identity>;
  /** Derives the root identity straight from seed bytes */
  fromSeed(seed: Uint8Array): Promise<Identity>;
  getProvider(): CryptoProvider;
}

/**
 * The error raised when a passkey yields no PRF secret, with the remedies that
 * actually help — a passkey only carries PRF if it was requested when the
 * credential was created, so an older passkey cannot be upgraded in place.
 * @returns A tagged PRF_UNSUPPORTED error
 */
function prfUnsupported() {
  return protocolError(
    'PRF_UNSUPPORTED',
    'This passkey returned no PRF secret, so no identity key can be derived from it.',
    'PRF has to be requested when a passkey is created, so one made before your ' +
      'provider supported it will never return a secret — create a new passkey. ' +
      'If it still fails, the authenticator itself lacks PRF (hmac-secret): try a ' +
      'platform passkey (Touch ID, Windows Hello) or an up-to-date password manager.'
  );
}

/**
 * Creates an IdentityManager instance.
 * @param {IdentityConfig} [config] Configuration options.
 * @returns {IdentityManager} The identity manager instance.
 */
export function createIdentityManager(config?: IdentityConfig): IdentityManager {
  const provider = config?.provider || createP256Provider();
  
  // Use globalThis.location if available, fallback to localhost for Node/testing
  const defaultRpId = typeof globalThis.location !== 'undefined' ? globalThis.location.hostname : 'localhost';
  const rpId = config?.rpId || defaultRpId;
  const rpName = config?.rpName || 'Weave';

  return Object.freeze({
    async register(userName: string, preferences?: CeremonyPreferences): Promise<Identity> {
      const platformOnly = preferences?.preferPlatform
        ? { hints: ['client-device'] as const, attachment: 'platform' as const }
        : {};

      const registration = await registerPasskey({
        rpId,
        rpName,
        userName,
        ...platformOnly
      });

      // Some authenticators return the PRF secret from the creation ceremony.
      // The rest need an assertion to produce it — including providers that
      // report nothing (or `enabled: false`) at creation and then evaluate PRF
      // without complaint, so the declaration is never grounds to give up.
      let prfOutput = registration.prfOutput;
      if (!prfOutput) {
        const auth = await authenticatePasskey(registration.credentialId, {
          rpId,
          ...(preferences?.preferPlatform ? { hints: ['client-device'] as const } : {})
        });
        prfOutput = auth.prfOutput;
      }

      if (!prfOutput) {
        throw prfUnsupported();
      }

      const keyPair = await deriveKeyPair(prfOutput, provider);
      const did = publicKeyToDid(keyPair.publicKeyBytes, P256_MULTICODEC);

      return Object.freeze({
        did,
        credentialId: registration.credentialId,
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
        publicKeyBytes: keyPair.publicKeyBytes
      });
    },

    async authenticate(credentialId?: string, preferences?: CeremonyPreferences): Promise<Identity> {
      const auth = await authenticatePasskey(credentialId, {
        rpId,
        ...(preferences?.preferPlatform ? { hints: ['client-device'] as const } : {})
      });

      if (!auth.prfOutput) {
        throw prfUnsupported();
      }

      const keyPair = await deriveKeyPair(auth.prfOutput, provider);
      const did = publicKeyToDid(keyPair.publicKeyBytes, P256_MULTICODEC);

      return Object.freeze({
        did,
        credentialId: auth.credentialId,
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
        publicKeyBytes: keyPair.publicKeyBytes
      });
    },

    async fromPassword(password: string, salt?: Uint8Array): Promise<Identity> {
      const actualSalt = salt || new TextEncoder().encode('default-weave-salt');
      const keyPair = await deriveKeyFromPassword(password, actualSalt, provider);
      const did = publicKeyToDid(keyPair.publicKeyBytes, P256_MULTICODEC);

      return Object.freeze({
        did,
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
        publicKeyBytes: keyPair.publicKeyBytes
      });
    },

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
        publicKeyBytes: keyPair.publicKeyBytes
      });
    },

    getProvider(): CryptoProvider {
      return provider;
    }
  });
}
