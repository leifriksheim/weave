/**
 * @module errors
 * Typed errors, so callers can branch on what went wrong instead of matching
 * on message text.
 */

export type ProtocolErrorCode =
  /** The authenticator produced no PRF secret, so no key can be derived from it */
  | 'PRF_UNSUPPORTED'
  /** The user dismissed or cancelled a passkey ceremony */
  | 'PASSKEY_CANCELLED'
  /** WebAuthn is not available in this environment at all */
  | 'WEBAUTHN_UNAVAILABLE'
  /** This browser has no File System Access API, so no folder can be opened */
  | 'FOLDER_UNAVAILABLE'
  /** The chosen folder holds an account file this version cannot read */
  | 'FOLDER_ACCOUNT_UNREADABLE'
  /** The passkey, passphrase or code offered did not open the folder */
  | 'VAULT_UNLOCK_FAILED'
  /** Removing that wrap would leave no way into the folder */
  | 'VAULT_LAST_WRAP'
  /** A pairing link or handover payload could not be read */
  | 'PAIRING_TICKET_UNREADABLE';

export interface ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  /** What the caller can suggest doing about it */
  readonly hint?: string;
}

/**
 * Creates a tagged protocol error.
 * @param code Machine-readable cause
 * @param message Human-readable description
 * @param hint Optional remedy to surface in a UI
 * @returns The error, ready to throw
 */
export function protocolError(code: ProtocolErrorCode, message: string, hint?: string): ProtocolError {
  return Object.assign(new Error(message), { code, ...(hint ? { hint } : {}) });
}

/**
 * Narrows an unknown thrown value to a protocol error.
 * @param error The caught value
 * @param code Optionally require a specific code
 * @returns Whether it is a protocol error (of that code)
 */
export function isProtocolError(error: unknown, code?: ProtocolErrorCode): error is ProtocolError {
  if (!(error instanceof Error) || typeof (error as ProtocolError).code !== 'string') {
    return false;
  }
  return code === undefined || (error as ProtocolError).code === code;
}
