/**
 * weave-protocol
 * Self-sovereign, peer-to-peer protocol for the browser.
 * 
 * Identity via WebAuthn passkeys, data as signed Expressions,
 * storage in a Merkle Search Tree, sync via anti-entropy gossip,
 * and end-to-end encryption for private Spaces.
 * 
 * @module weave-protocol
 */

// Core types
export type {
  CryptoProvider,
  CryptoKeyPairResult,
  StandardSchemaV1,
  StandardSchemaResult,
  StandardSchemaIssue,
  Expression,
  UnsignedExpression,
  Link,
  Space,
  SpaceType,
  SpaceVisibility,
  CollectionDef,
  PeerInfo,
  SyncState,
  StorageAdapter,
  BatchOp,
  NetworkMessage,
  Result,
} from './types.js';
export { ok, err } from './types.js';

// Phase 1: Identity & Key Management
export {
  createP256Provider,
} from './identity/crypto-p256.js';
export {
  registerPasskey,
  authenticatePasskey,
  renamePasskey,
  hasPlatformAuthenticator,
} from './identity/webauthn.js';
export type { PasskeyOptions, PasskeyRegistration, PasskeyAuth, AuthOptions } from './identity/webauthn.js';
export { inspectPasskeyPrf } from './identity/passkey-diagnostics.js';
export type { PasskeyDiagnostics, DiagnosticsOptions, CeremonyReport } from './identity/passkey-diagnostics.js';
export {
  deriveKeyPair,
  deriveKeyFromPassword,
} from './identity/keys.js';
export type { DerivedKeyPair } from './identity/keys.js';
export {
  generateRecoveryCode,
  generateSeed,
  seedToRecoveryCode,
  normalizeRecoveryCode,
  isValidRecoveryCode,
  recoveryCodeToSeed,
  RECOVERY_SEED_BYTES,
} from './identity/recovery-code.js';
export {
  publicKeyToDid,
  didToPublicKey,
  P256_MULTICODEC,
} from './identity/did.js';
export {
  createIdentityManager,
} from './identity/identity-manager.js';
export {
  createFolderAccountStore,
  createBrowserAccountStore,
  listFolderAccounts,
  adoptLegacyFolderAccount,
  accountDataPath,
  newAccountId,
} from './identity/account-store.js';
export type { AccountStore, AccountSummary } from './identity/account-store.js';
export {
  readFolderVault,
  writeFolderVault,
  createVault,
  ACCOUNT_FILE,
} from './identity/folder-account.js';
export type { FolderState } from './identity/folder-account.js';
export {
  wrapSeedWithDeviceKey,
  unwrapSeedWithDeviceKey,
  wrapSeedWithPassphrase,
  unwrapSeedWithPassphrase,
  deriveVaultKey,
  deriveVaultKeyBytes,
  deviceWrapsFor,
  hasPassphraseWrap,
  withWrap,
  withoutWrap,
  PASSPHRASE_ITERATIONS,
} from './identity/account-vault.js';
export type {
  AccountVault,
  SeedWrap,
  DeviceWrap,
  PassphraseWrap,
} from './identity/account-vault.js';
export type { IdentityManager, Identity, IdentityConfig, CeremonyPreferences } from './identity/identity-manager.js';
export { createDeviceKey, getDeviceKey, deleteDeviceKey } from './identity/device-key.js';
export type { DeviceKey } from './identity/device-key.js';
export { createLocalRootSigner } from './identity/root-signer.js';
export type { RootSigner } from './identity/root-signer.js';
export {
  pairingRoomId,
  derivePairingKey,
  encodePairingTicket,
  decodePairingTicket,
  sealPairingPayload,
  openPairingPayload,
} from './identity/pairing.js';
export type { PairingTicket } from './identity/pairing.js';
export {
  issueUCAN,
  parseUCAN,
  verifyUCAN,
  isCapabilitySubset,
  validateDelegationChain,
  delegateCapabilities,
  resolveDelegationRoot,
} from './identity/ucan.js';
export type {
  UCANHeader,
  UCANPayload,
  UCANToken,
  Capability,
  Fact,
  IssueUCANOptions,
  UCANValidation,
  ChainResolution,
  ProofResolver,
  DelegateOptions,
} from './identity/ucan.js';

// Phase 2: Schema & Data Structures
export {
  createSchemaEngine,
} from './schema/schema-engine.js';
export type { SchemaEngine, ValidationResult } from './schema/schema-engine.js';
export {
  createSigner,
} from './schema/signer.js';
export type { Signer } from './schema/signer.js';
export {
  createExpression,
  canonicalize,
  serializeExpression,
  deserializeExpression,
  getExpressionId,
} from './schema/expression.js';

// Phase 3: Local Storage & State
export {
  createIndexedDBAdapter,
} from './storage/indexeddb-adapter.js';
export {
  createEmptyNode,
  insertIntoMST,
  deleteFromMST,
  lookupInMST,
  diffMST,
  listMSTKeys,
  listMSTEntries,
  collectReachableCids,
} from './storage/mst.js';
export type { MSTNode, MSTDiff } from './storage/mst.js';
export {
  createStorageProvider,
} from './storage/storage-provider.js';
export type { StorageProvider } from './storage/storage-provider.js';

// Storage in a folder the user owns — the one store that is not origin-scoped
export {
  createFolderAdapter,
  readFolderFile,
  writeFolderFile,
} from './storage/folder-adapter.js';
export type {
  FolderAdapter,
  FolderReload,
  DirectoryHandleLike,
  FileHandleLike,
  WritableFileLike,
} from './storage/folder-adapter.js';
export { createEncryptedAdapter, DEFAULT_ENCRYPTED_PREFIXES } from './storage/encrypted-adapter.js';
export type { EncryptedAdapterOptions } from './storage/encrypted-adapter.js';
export { reconcileFolder } from './storage/folder-reconcile.js';
export type { FolderReconciliation } from './storage/folder-reconcile.js';
export {
  isFolderStorageAvailable,
  pickDataFolder,
  queryFolderPermission,
  ensureFolderPermission,
  rememberDataFolder,
  recallDataFolder,
  forgetDataFolder,
} from './storage/directory-access.js';
export type { FolderAccessMode } from './storage/directory-access.js';

// Spaces
export { createSpaceManager, parseSpaceInvite } from './space/space-manager.js';
export { deriveAccountRegistry, MEMBERSHIP_COLLECTION } from './space/account-registry.js';
export {
  CATALOG_COLLECTION,
  checkStoredCollection,
  checkPublishableSchema,
  validateJsonSchema,
  asStandardSchema,
} from './schema/collection-def.js';
export type { StoredCollection, JsonSchema, SchemaIssue } from './schema/collection-def.js';
export type { Membership } from './space/account-registry.js';
export type { SpaceManager, SpaceRecord, SpaceInvite, CreateSpaceParams } from './space/space-manager.js';

// Phase 4: P2P Networking
export {
  createSignalingClient,
} from './network/signaling.js';
export {
  createMultiSignalingClient,
} from './network/multi-signaling.js';
export {
  isControlMessage,
  shouldInitiate,
  createSeenSignals,
  signalId,
  MAX_HOPS,
  PEERS_MESSAGE,
  SIGNAL_MESSAGE,
} from './network/introductions.js';
export type { RelayedSignal, SeenSignals } from './network/introductions.js';
export {
  createRTCTransport,
} from './network/rtc-transport.js';
export { createWebSocketTransport } from './network/ws-transport.js';
export type { WebSocketTransportConfig } from './network/ws-transport.js';
export { isSignalledTransport } from './network/transport.js';
export { createPeerAuthenticator, peerNonce } from './network/peer-auth.js';
export type { PeerAuthenticator, PeerRole } from './network/peer-auth.js';
export type { PeerTransport, PeerTransportEvents, SignalledTransport, CandidateSink } from './network/transport.js';
export {
  createPeerDiscovery,
} from './network/peer-discovery.js';
export {
  createNetworkManager,
} from './network/network-manager.js';
export type { NetworkManager, NetworkManagerConfig, NetworkEvents } from './network/network-manager.js';
export type { SignalingClient, SignalingMessage } from './network/signaling.js';

// Phase 5: Gossip/Sync Protocol
export {
  encodeSyncMessage,
  decodeSyncMessage,
  SYNC_PROTOCOL_VERSION,
} from './sync/sync-messages.js';
export type { SyncMessage } from './sync/sync-messages.js';
export {
  compareRoots,
  verifyNode,
  unknownChildren,
  differingEntries,
} from './sync/anti-entropy.js';
export {
  createSyncEngine,
} from './sync/sync-engine.js';
export type { SyncEngine, SyncEngineConfig, IncomingValidation } from './sync/sync-engine.js';

// Phase 6: Validation Engine
export {
  createCryptoGate,
} from './validation/crypto-gate.js';
export {
  createStructuralGate,
} from './validation/structural-gate.js';
export {
  createStatefulGate,
} from './validation/stateful-gate.js';
export {
  createCapabilityGate,
} from './validation/capability-gate.js';
export type { CapabilityGate, CapabilityGateConfig } from './validation/capability-gate.js';
export {
  createValidationEngine,
} from './validation/validation-engine.js';
export type { ValidationEngine, ValidationEngineConfig } from './validation/validation-engine.js';

// Phase 7: Encryption & Privacy
export {
  generateSpaceKey,
  encryptExpression,
  decryptExpression,
} from './privacy/space-encryption.js';
export type { SpaceKey, EncryptedExpression, EncryptedExpressionBody } from './privacy/space-encryption.js';
export {
  wrapSpaceKey,
  unwrapSpaceKey,
  distributeSpaceKey,
} from './privacy/key-distribution.js';
export {
  createPrivacyGuard,
} from './privacy/privacy-guard.js';

// Utilities
export {
  base64UrlEncode,
  base64UrlDecode,
  utf8Encode,
  utf8Decode,
  concatBytes,
  varintEncode,
  varintDecode,
  bytesToHex,
  hexToBytes,
} from './utils/encoding.js';
export { sha256, cidFromBytes } from './utils/hash.js';
export { protocolError, isProtocolError } from './utils/errors.js';
export type { ProtocolError, ProtocolErrorCode } from './utils/errors.js';
export { TypedEventTarget } from './utils/events.js';

// Node: identity + spaces + sync, behind one API
export {
  createNode,
  SESSION_CAPABILITY,
  writeCapability,
  indexedDBStores,
  folderStores,
  copyAccountData,
  NODE_ACTIONS,
  runAction,
  checkActionInput,
} from './node/index.js';
export type {
  StoreFactory,
  StoreOptions,
  CopyAccountParams,
  CopyResult,
  NodeAction,
  ActionSchema,
  P2PNode,
  NodeConfig,
  NodeNetworkConfig,
  NodeSpaces,
  NodeRecords,
  NodeRecord,
  NodeEvent,
  SpaceSummary,
  SpaceStatus,
  NewSpace,
  InvitePreview,
  ListOptions,
  ConnectionState,
  DelegateParams,
  Delegated,
  NodeCollection,
  NodeCollections,
  DefineCollection,
  NodeAccount,
  AccountProfileView,
} from './node/index.js';

// Queries: plain-data filters, sorting, paging and includes over a space
export { runQuery } from './query/engine.js';
export type { QuerySource } from './query/engine.js';
export { matches, checkQuery, fieldValue, MAX_INCLUDE_DEPTH } from './query/filter.js';
export type { Query, Filter, Operators, Include, SortDirection, QueryRecord, QueryResult } from './query/types.js';
