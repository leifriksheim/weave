import { base64UrlEncode, base64UrlDecode } from '../utils/encoding.js';
import { protocolError } from '../utils/errors.js';

export interface PasskeyOptions {
  readonly rpId: string;
  readonly rpName: string;
  readonly userName: string;
  readonly userId?: Uint8Array;
  /**
   * WebAuthn L3 hints steering which authenticator the browser offers first.
   * `client-device` favours the platform passkey (Touch ID, Windows Hello) —
   * useful when an installed credential manager handles passkeys by default but
   * does not support PRF.
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
  /**
   * What the client reported about PRF at creation time: true, false, or
   * undefined when it said nothing at all.
   *
   * This is a weak signal. Several credential providers — Bitwarden among them —
   * omit or deny it here and still evaluate PRF perfectly well during an
   * assertion, so it must never be treated as a final answer. The only reliable
   * test is asking for the secret and seeing whether one comes back.
   */
  readonly prfDeclared: boolean | undefined;
  /** PRF output, when the authenticator already evaluates it during creation */
  readonly prfOutput: Uint8Array | null;
}

export interface AuthOptions {
  readonly rpId?: string;
  /** See {@link PasskeyOptions.hints} */
  readonly hints?: ReadonlyArray<'client-device' | 'security-key' | 'hybrid'>;
}

export interface PasskeyAuth {
  readonly credentialId: string;
  readonly prfOutput: Uint8Array | null;
  readonly authenticatorData: Uint8Array;
}

const PRF_SALT = new TextEncoder().encode('p2p-protocol-key-v1');

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
    return (
      (await globalThis.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()) ??
      false
    );
  } catch {
    return false;
  }
}

/**
 * Registers a new passkey with PRF extension.
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
      id: userId as BufferSource,
      name: options.userName,
      displayName: options.userName,
    },
    challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 }, // ES256
      { type: 'public-key', alg: -257 } // RS256
    ],
    authenticatorSelection: {
      // Discoverable ("resident") so the passkey can be found again on a later
      // visit without the app having to remember anything about the user.
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
      ...(options.attachment ? { authenticatorAttachment: options.attachment } : {})
    },
    ...(options.hints ? { hints: options.hints as string[] } : {}),
    extensions: {
      prf: {
        eval: {
          first: PRF_SALT
        }
      }
    } as any // PRF might not be in standard TS types yet
  };

  const credential = (await globalThis.navigator.credentials.create({
    publicKey: createOptions
  })) as PublicKeyCredential;

  if (!credential) {
    throw new Error('Failed to create passkey.');
  }

  const response = credential.response as AuthenticatorAttestationResponse;
  
  const extensions = credential.getClientExtensionResults();
  const prf = (extensions as any).prf;
  const prfDeclared = prf?.results?.first ? true : (prf?.enabled as boolean | undefined);

  // Newer authenticators return the PRF output from the creation ceremony itself,
  // which saves the user a second prompt.
  const prfOutputBuffer = prf?.results?.first;

  const rawId = new Uint8Array(credential.rawId);
  
  return Object.freeze({
    credentialId: base64UrlEncode(rawId),
    userHandle: base64UrlEncode(userId),
    publicKey: new Uint8Array(response.getPublicKey?.() || new ArrayBuffer(0)),
    prfDeclared,
    prfOutput: prfOutputBuffer ? new Uint8Array(prfOutputBuffer) : null
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
export async function renamePasskey(params: { rpId: string; userHandle: string; name: string }): Promise<boolean> {
  const signal = (globalThis.PublicKeyCredential as unknown as {
    signalCurrentUserDetails?: (details: { rpId: string; userId: string; name: string; displayName: string }) => Promise<void>;
  } | undefined)?.signalCurrentUserDetails;
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
 * Authenticates using an existing passkey with PRF extension.
 * @param {string} [credentialId] The credential to use. Omit to let the user pick
 *   any discoverable passkey for this origin.
 * @param {AuthOptions} [options] Authentication options.
 * @returns {Promise<PasskeyAuth>} Authentication result.
 */
export async function authenticatePasskey(credentialId?: string, options?: AuthOptions): Promise<PasskeyAuth> {
  if (!globalThis.navigator?.credentials) {
    throw protocolError('WEBAUTHN_UNAVAILABLE', 'WebAuthn is not supported in this environment.');
  }

  const getOptions: PublicKeyCredentialRequestOptions & { hints?: string[] } = {
    challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    rpId: options?.rpId,
    userVerification: 'required',
    ...(options?.hints ? { hints: options.hints as string[] } : {}),
    // Narrow the ceremony to the known credential; without this the browser
    // would prompt for any passkey on the origin.
    ...(credentialId
      ? { allowCredentials: [{ type: 'public-key' as const, id: base64UrlDecode(credentialId) as BufferSource }] }
      : {}),
    extensions: {
      prf: {
        eval: {
          first: PRF_SALT
        }
      }
    } as any
  };

  const credential = (await globalThis.navigator.credentials.get({
    publicKey: getOptions
  })) as PublicKeyCredential;

  if (!credential) {
    throw new Error('Failed to authenticate passkey.');
  }

  const response = credential.response as AuthenticatorAssertionResponse;
  const extensions = credential.getClientExtensionResults();
  
  const prfOutputBuffer = (extensions as any).prf?.results?.first;
  const prfOutput = prfOutputBuffer ? new Uint8Array(prfOutputBuffer) : null;

  return Object.freeze({
    credentialId: base64UrlEncode(new Uint8Array(credential.rawId)),
    prfOutput,
    authenticatorData: new Uint8Array(response.authenticatorData)
  });
}
