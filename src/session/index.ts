/**
 * @module session
 * Signing in and staying signed in, with no framework: the flow as state and
 * actions (`createWeaveAuth`), and the pieces it is made of.
 *
 * Browser-only — it reaches for IndexedDB, WebAuthn and the File System Access
 * API when used — so it lives on its own entry point, away from the
 * isomorphic core.
 */
export { createWeaveAuth } from './auth.js';
export type {
  WeaveAuth,
  WeaveAuthConfig,
  AuthState,
  AuthStage,
  AuthError,
  AccountEntry,
  WeaveSession,
  MovedToPod,
} from './auth.js';
export {
  browserPlace,
  folderPlace,
  pickPod,
  rememberPod,
  recallPod,
  forgetPod,
  listAccounts,
  inspectPod,
  storesFor,
} from './places.js';
export type { Place, PodContents } from './places.js';
export { createStaySignedIn, STAY_SIGNED_IN_CHOICES, DEFAULT_STAY_SIGNED_IN } from './stay-signed-in.js';
export type { StaySignedIn, StaySignedInStore, KeyValueStore } from './stay-signed-in.js';
export { offerToPhone, collectFromDesktop, readPairingTicket, clearPairingTicket } from './pairing.js';
export type { PairingStage, PairingOffer } from './pairing.js';
export { offerToSave, accountCredentialName, deviceCredentialName } from './credentials.js';
