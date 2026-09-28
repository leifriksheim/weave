import { base64UrlEncode, base64UrlDecode } from '../utils/encoding.js';
import { protocolError } from '../utils/errors.js';
import { bufferSource, isPublicKeyCredential } from '../utils/guards.js';

export interface PasskeyOptions {
  readonly rpId: string;
  readonly rpName: string;
  readonly userName: string;
  readonly userId?: Uint8Array;
  /**
   * WebAuthn L3 hints steering which authenticator the browser offers first.
   * `client-device` favours the platform passkey (Touch ID, Windows Hello).
   */
  readonly hints?: ReadonlyArray<'client-device' | 'security-key' | 'hybrid'>;
  /** Restrict to platform or roaming authenticators */
  readonly attachment?: AuthenticatorAttachment;
}

export interface PasskeyRegistration {
  readonly credentialId: string;
  /**
   * The user handle the passkey was made for, base64url. Keep it: it is the
   * only way to ask the provider to relabel the passkey later
   * ({@link renamePasskey}).
   */
  readonly userHandle: string;
  readonly publicKey: Uint8Array;
}

export interface AuthOptions {
  readonly rpId?: string;
  /** See {@link PasskeyOptions.hints} */
  readonly hints?: ReadonlyArray<'client-device' | 'security-key' | 'hybrid'>;
}

export interface PasskeyAuth {
  readonly credentialId: string;
  readonly authenticatorData: Uint8Array;
}

// Asked for, though nothing reads it yet: PRF can only be requested when a
// passkey is made, so asking keeps these passkeys able to carry a secret later.
const PRF_SALT = new TextEncoder().encode('weave-protocol-key-v1');

/**
 * Whether this device has a built-in authenticator — Touch ID, Windows Hello.
 *
 * Worth knowing before asking for one: `attachment: 'platform'` is a filter
 * rather than a preference, so requesting it on a machine that has none fails
 * outright instead of falling back.
 *
 * @returns Whether a platform authenticator can be used here
 */
export async function hasPlatformAuthenticator(): Promise<boolean> {
  try {
    return (await globalThis.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Registers a new passkey.
 * @param {PasskeyOptions} options Registration options.
 * @returns {Promise<PasskeyRegistration>} Registration result.
 */
export async function registerPasskey(options: PasskeyOptions): Promise<PasskeyRegistration> {
  if (!globalThis.navigator?.credentials) {
    throw protocolError('WEBAUTHN_UNAVAILABLE', 'WebAuthn is not supported in this environment.');
  }

  const userId = options.userId || globalThis.crypto.getRandomValues(new Uint8Array(32));

  const createOptions: PublicKeyCredentialCreationOptions & { hints?: string[] } = {
    rp: { id: options.rpId, name: options.rpName },
    user: {
      id: bufferSource(userId),
      name: options.userName,
      displayName: options.userName,
    },
    challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 }, // ES256
      { type: 'public-key', alg: -257 }, // RS256
    ],
    authenticatorSelection: {
      // Discoverable ("resident") so the passkey can be found again on a later
      // visit without the app having to remember anything about the user.
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
      ...(options.attachment ? { authenticatorAttachment: options.attachment } : {}),
    },
    ...(options.hints ? { hints: [...options.hints] } : {}),
    extensions: {
      prf: {
        eval: {
          first: PRF_SALT,
        },
      },
    },
  };

  const credential = await globalThis.navigator.credentials.create({
    publicKey: createOptions,
  });

  if (!isPublicKeyCredential(credential)) {
    throw new Error('Failed to create passkey.');
  }

  const response: AuthenticatorResponse & Partial<Pick<AuthenticatorAttestationResponse, 'getPublicKey'>> =
    credential.response;

  const rawId = new Uint8Array(credential.rawId);

  return Object.freeze({
    credentialId: base64UrlEncode(rawId),
    userHandle: base64UrlEncode(userId),
    publicKey: new Uint8Array(response.getPublicKey?.() || new ArrayBuffer(0)),
  });
}

/**
 * Asks the passkey provider to show a passkey under a new name.
 *
 * A site cannot edit a password manager, so after an account is renamed its
 * passkey would keep the old label and look like a different account. The
 * WebAuthn Signal API lets a site *ask*; the provider decides. Where the
 * browser does not have it, this does nothing.
 *
 * @returns Whether the browser accepted the request — not whether the provider acted on it
 */
export async function renamePasskey(params: {
  rpId: string;
  userHandle: string;
  name: string;
}): Promise<boolean> {
  // Not in TypeScript's DOM types yet.
  const api:
    | (typeof PublicKeyCredential & {
        signalCurrentUserDetails?: (details: {
          rpId: string;
          userId: string;
          name: string;
          displayName: string;
        }) => Promise<void>;
      })
    | undefined = globalThis.PublicKeyCredential;
  const signal = api?.signalCurrentUserDetails;
  if (typeof signal !== 'function') return false;
  try {
    await signal.call(globalThis.PublicKeyCredential, {
      rpId: params.rpId,
      userId: params.userHandle,
      name: params.name,
      displayName: params.name,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Authenticates using an existing passkey.
 * @param {string} [credentialId] The credential to use. Omit to let the user pick
 *   any discoverable passkey for this origin.
 * @param {AuthOptions} [options] Authentication options.
 * @returns {Promise<PasskeyAuth>} Authentication result.
 */
export async function authenticatePasskey(
  credentialId?: string,
  options?: AuthOptions,
): Promise<PasskeyAuth> {
  if (!globalThis.navigator?.credentials) {
    throw protocolError('WEBAUTHN_UNAVAILABLE', 'WebAuthn is not supported in this environment.');
  }

  const getOptions: PublicKeyCredentialRequestOptions & { hints?: string[] } = {
    challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    rpId: options?.rpId,
    userVerification: 'required',
    ...(options?.hints ? { hints: [...options.hints] } : {}),
    // Narrow the ceremony to the known credential; without this the browser
    // would prompt for any passkey on the origin.
    ...(credentialId
      ? {
          allowCredentials: [
            { type: 'public-key' as const, id: bufferSource(base64UrlDecode(credentialId)) },
          ],
        }
      : {}),
    extensions: {
      prf: {
        eval: {
          first: PRF_SALT,
        },
      },
    },
  };

  const credential = await globalThis.navigator.credentials.get({
    publicKey: getOptions,
  });

  if (!isPublicKeyCredential(credential)) {
    throw new Error('Failed to authenticate passkey.');
  }

  const response: AuthenticatorResponse & Partial<Pick<AuthenticatorAssertionResponse, 'authenticatorData'>> =
    credential.response;

  return Object.freeze({
    credentialId: base64UrlEncode(new Uint8Array(credential.rawId)),
    authenticatorData: new Uint8Array(response.authenticatorData ?? new ArrayBuffer(0)),
  });
}
