/**
 * @module session
 * Signing in and staying signed in, with no framework: the flow as state and
 * actions (`createWeaveAuth`), and the pieces it is made of.
 *
 * Browser-only — it reaches for IndexedDB, WebAuthn and the File System Access
 * API when used — so it lives on its own entry point, away from the
 * isomorphic core.
 */
export { createWeaveAuth, MIN_PASSWORD_LENGTH } from './auth.js';
export type {
  WeaveAuth,
  WeaveAuthConfig,
  AuthState,
  AuthStage,
  AuthSetup,
  AuthError,
  AccountEntry,
  WeaveSession,
  MovedToPod,
  Connection,
  GrantChoice,
  ProposeChoice,
} from './auth.js';
export { createWeaveConnection } from './connection.js';
export type {
  WeaveConnection,
  WeaveConnectionConfig,
  WeaveConnectionState,
  ConnectionStatus,
} from './connection.js';
export {
  connectToHome,
  connectCarrier,
  proposeToHome,
  isProposeRequest,
  homeAddress,
  receiveConnectRequest,
  startConnectedNode,
  grantSigner,
  grantStore,
  grantCapabilities,
  appKey,
  forgetAppKey,
  MAX_GRANT_DAYS,
} from './connect.js';
export type {
  ConnectRequest,
  ConnectOptions,
  ProposeRequest,
  Proposed,
  Grant,
  CarryGrant,
  GrantedSpace,
  IncomingRequest,
  AppKey,
} from './connect.js';
export {
  browserPlace,
  pickPod,
  rememberPod,
  recallPod,
  forgetPod,
  listAccounts,
  inspectPod,
  storesFor,
  deleteBrowserData,
} from './places.js';
export type { Place, PodContents } from './places.js';
export { createStaySignedIn, STAY_SIGNED_IN_CHOICES, DEFAULT_STAY_SIGNED_IN } from './stay-signed-in.js';
export type { StaySignedIn, StaySignedInStore, KeyValueStore } from './stay-signed-in.js';
export { offerToPhone, collectFromDesktop, readPairingTicket, clearPairingTicket } from './pairing.js';
export type { PairingStage, PairingOffer } from './pairing.js';
export {
  offerAgentLink,
  acceptAgentLink,
  checkAgentGrant,
  newAgentCode,
  readAgentCode,
} from './agent-link.js';
export type { AgentLinkStage, AgentLinkOffer, AgentAsking } from './agent-link.js';
export { offerToSave, accountCredentialName, recoveryKit } from './credentials.js';
