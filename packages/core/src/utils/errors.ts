/**
 * @module errors
 * Typed errors, so callers can branch on what went wrong instead of matching
 * on message text.
 */

export type ProtocolErrorCode =
  /** The user dismissed or cancelled a passkey ceremony */
  | 'PASSKEY_CANCELLED'
  /** WebAuthn is not available in this environment at all */
  | 'WEBAUTHN_UNAVAILABLE'
  /** This browser has no File System Access API, so no folder can be opened */
  | 'FOLDER_UNAVAILABLE'
  /** The folder chosen before is gone: moved, renamed or deleted */
  | 'FOLDER_GONE'
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

/** Creates a tagged protocol error. */
export function protocolError(code: ProtocolErrorCode, message: string, hint?: string): ProtocolError {
  return Object.assign(new Error(message), { code, ...(hint ? { hint } : {}) });
}

/** The message of a caught value, for a result that reports it. */
export function messageOf(error: unknown, fallback: string): string {
  return typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message
    ? error.message
    : fallback;
}

/** Narrows an unknown thrown value to a protocol error. */
export function isProtocolError(error: unknown, code?: ProtocolErrorCode): error is ProtocolError {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') {
    return false;
  }
  return code === undefined || error.code === code;
}
