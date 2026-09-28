/**
 * @weaveprotocol/core
 * Self-sovereign, peer-to-peer protocol for the browser.
 *
 * Identity via WebAuthn passkeys, data as signed Expressions,
 * sync by range-based set reconciliation (Negentropy),
 * and end-to-end encryption for private Spaces.
 *
 * @module @weaveprotocol/core
 */

// Core types
export type {
  CryptoProvider,
  CryptoKeyPairResult,
  StandardSchemaV1,
  StandardJSONSchemaV1,
  StandardSchemaResult,
  StandardSchemaIssue,
  Expression,
  UnsignedExpression,
  Link,
  Space,
  SpaceRole,
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
export { createP256Provider } from './identity/crypto-p256.js';
export {
  registerPasskey,
  authenticatePasskey,
  renamePasskey,
  hasPlatformAuthenticator,
} from './identity/webauthn.js';
export type { PasskeyOptions, PasskeyRegistration, PasskeyAuth, AuthOptions } from './identity/webauthn.js';
export { deriveKeyPair } from './identity/keys.js';
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
export { publicKeyToDid, didToPublicKey, P256_MULTICODEC } from './identity/did.js';
export { createIdentityManager } from './identity/identity-manager.js';
export {
  createFolderAccountStore,
  createBrowserAccountStore,
  listFolderAccounts,
  adoptLegacyFolderAccount,
  accountDataPath,
  newAccountId,
} from './identity/account-store.js';
export type { AccountStore, AccountSummary } from './identity/account-store.js';
export { readFolderVault, writeFolderVault, createVault, ACCOUNT_FILE } from './identity/folder-account.js';
export type { FolderState } from './identity/folder-account.js';
export {
  wrapSeedWithDeviceKey,
  unwrapSeedWithDeviceKey,
  wrapSeedWithPassphrase,
  CLI_PASSPHRASE_LABEL,
  unwrapSeedWithPassphrase,
  deriveVaultKey,
  deriveVaultKeyBytes,
  deviceWrapsFor,
  hasPassphraseWrap,
  withWrap,
  withoutWrap,
  PASSPHRASE_ITERATIONS,
} from './identity/account-vault.js';
export {
  deriveContactKeyBytes,
  deriveDoorKeyBytes,
  deriveDoorSignKeyBytes,
  contactKeyPair,
  contactPublicKey,
  isContactPublicKey,
  sealFor,
  openSealed,
} from './identity/contact-key.js';
export type { ContactKeyPair } from './identity/contact-key.js';
export type { AccountVault, SeedWrap, DeviceWrap, PassphraseWrap } from './identity/account-vault.js';
export type { IdentityManager, Identity } from './identity/identity-manager.js';
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
export { AGENT_FACT, isAgentNote } from './identity/agent-note.js';
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
export { createSchemaEngine } from './schema/schema-engine.js';
export type { SchemaEngine, ValidationResult } from './schema/schema-engine.js';
export { createSigner } from './schema/signer.js';
export type { Signer } from './schema/signer.js';
export { createExpression, canonicalize, getExpressionId, signedPart } from './schema/expression.js';

// Phase 3: Local Storage & State
export { createIndexedDBAdapter } from './storage/indexeddb-adapter.js';
export { createStorageProvider } from './storage/storage-provider.js';
export type { StorageProvider } from './storage/storage-provider.js';

// Storage in a folder the user owns — the one store that is not origin-scoped
export { createFolderAdapter, readFolderFile, writeFolderFile } from './storage/folder-adapter.js';
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
export {
  deriveAccountRegistry,
  deriveContactsSpace,
  MEMBERSHIP_COLLECTION,
} from './space/account-registry.js';
export {
  CATALOG_COLLECTION,
  checkStoredCollection,
  checkScreenNetwork,
  MAX_SCREEN_ORIGINS,
  checkPublishableSchema,
  validateJsonSchema,
  asStandardSchema,
  toJsonSchema,
  collection,
} from './schema/collection-def.js';
export type { StoredCollection, JsonSchema, SchemaIssue } from './schema/collection-def.js';
export type { Membership } from './space/account-registry.js';
export type {
  SpaceManager,
  SpaceRecord,
  SpaceInvite,
  InviteLinkOptions,
  CreateSpaceParams,
} from './space/space-manager.js';
export {
  generateInviteSecret,
  deriveInviteKey,
  deriveReadKey,
  spaceGenesis,
  spaceIdOf,
  checkSpace,
  checkStartingRoles,
  memberKey,
  inviteKey,
  revokeKey,
  roleKey,
  signInvite,
  verifyInvite,
} from './space/space-access.js';
export {
  replayAccess,
  permissionMatches,
  roleHolds,
  holds,
  standing,
  checkRole,
  MANAGE,
  INVITE,
  DEFINE,
  ROLE_COLLECTION,
  MEMBER_COLLECTION,
  INVITE_COLLECTION,
  REVOKE_COLLECTION,
  ACCESS_COLLECTIONS,
} from './space/roles.js';
export type {
  Role,
  AccessEvent,
  AccessGenesis,
  AccessHistory,
  AccessState,
  EventStatus,
  RecordVerdict,
} from './space/roles.js';
export { rolePresets, solo, team, community } from './space/presets.js';
export type { RolePreset } from './space/presets.js';
export type { SpaceGenesis, SpaceKeyPair } from './space/space-access.js';

// Phase 4: P2P Networking
export { createSignalingClient, CLOSE_DID_TAKEN } from './network/signaling.js';
export { createMultiSignalingClient } from './network/multi-signaling.js';
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
export { createRTCTransport } from './network/rtc-transport.js';
export { serveTransport, remoteTransport } from './network/remote-transport.js';
export type { MessagePortLike } from './utils/port.js';
export { createWebSocketTransport } from './network/ws-transport.js';
export type { WebSocketTransportConfig } from './network/ws-transport.js';
export { createClientAuth, createServerAuth, createMeshAuth, peerNonce } from './network/peer-auth.js';
export type { ClientAuth, ServerAuth } from './network/peer-auth.js';
export type {
  PeerTransport,
  PeerTransportEvents,
  SignalledTransport,
  CandidateSink,
} from './network/transport.js';
export { createMesh } from './network/mesh.js';
export type { Mesh, MeshConfig, MeshStatus, PendingConnection } from './network/mesh.js';
export { createNetworkManager } from './network/network-manager.js';
export type { NetworkManager, NetworkManagerConfig, NetworkEvents } from './network/network-manager.js';
export type {
  SignalingClient,
  SignalingMessage,
  SignalKind,
  RelayState,
  RelayStatus,
} from './network/signaling.js';

// Phase 5: Gossip/Sync Protocol
export { parseSyncMessage, SYNC_PROTOCOL_VERSION } from './sync/sync-messages.js';
export type { SyncMessage } from './sync/sync-messages.js';
export { createReconciler, ItemSet, fingerprintOf } from './sync/negentropy.js';
export type { Item, Round, Sum } from './sync/negentropy.js';
export { createSyncEngine } from './sync/sync-engine.js';
export type { SyncEngine, SyncEngineConfig, IncomingValidation } from './sync/sync-engine.js';

// Phase 6: Validation
export { createCryptoGate } from './validation/crypto-gate.js';
export { createCapabilityGate } from './validation/capability-gate.js';
export type { CapabilityGate, CapabilityGateConfig } from './validation/capability-gate.js';
export { createVersionCheck } from './validation/check-version.js';

// Phase 7: Encryption & Privacy
export { generateSpaceKey, encryptExpression, decryptExpression } from './privacy/space-encryption.js';
export type { SpaceKey, EncryptedExpression, EncryptedExpressionBody } from './privacy/space-encryption.js';

// Utilities
export {
  base64UrlEncode,
  base64UrlDecode,
  utf8Encode,
  utf8Decode,
  concatBytes,
  bytesToHex,
  hexToBytes,
} from './utils/encoding.js';
export { sha256, cidFromBytes } from './utils/hash.js';
export { protocolError, isProtocolError } from './utils/errors.js';
export type { ProtocolError, ProtocolErrorCode } from './utils/errors.js';
export { createEmitter } from './utils/events.js';
export type { Emitter } from './utils/events.js';

// Node: identity + spaces + sync, behind one API
export {
  createNode,
  serveNode,
  remoteNode,
  serveSigner,
  remoteSigner,
  startNodeInWorker,
  SESSION_CAPABILITY,
  writeCapability,
  relayRoom,
  indexedDBStores,
  folderStores,
  copyAccountData,
  NODE_ACTIONS,
  runAction,
  checkActionInput,
  createCarrierNode,
  createHostNode,
  NotAllowedError,
  watchNotifications,
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
  WorkerNodeConfig,
  WorkerStores,
  WorkerLike,
  NodeNetworkConfig,
  NodeSpaces,
  NodeRecords,
  NodeRecord,
  NodeEvent,
  NodeNetwork,
  SpaceSummary,
  SpaceStatus,
  CarrierSummary,
  SpaceProfile,
  NewSpace,
  InvitePreview,
  ListOptions,
  InviteOptions,
  ConnectionState,
  DelegateParams,
  Delegated,
  NodeCollection,
  NodeCollections,
  DefineCollection,
  NodeAccount,
  AccountProfileView,
  NodeContacts,
  ContactView,
  ContactRequest,
  NodeDoors,
  DoorView,
  KnockView,
  SentKnockView,
  CarrierConfig,
  CarrierNode,
  CarriedSpace,
  CarrierEvent,
  HostConfig,
  HostNode,
  NodeHosting,
  HostingView,
  Subscription,
  SubscriptionState,
  Keeper,
  CacheConfig,
  NodeNotifications,
  NotifyView,
  NotifyWhen,
  NotifyApp,
  NotifyProposal,
  CarriedSubscriptionView,
  NotifyMatch,
  WatchNotificationsOptions,
} from './node/index.js';

// Queries: plain-data filters, sorting, paging and includes over a space
export { runQuery } from './query/engine.js';
export type { QuerySource } from './query/engine.js';
export { matches, checkQuery, fieldValue, MAX_INCLUDE_DEPTH } from './query/filter.js';
export type {
  Query,
  Filter,
  Operators,
  Include,
  SortDirection,
  QueryRecord,
  QueryResult,
  CollectionRef,
  Typed,
  BodyOf,
  IncludedOf,
  ResultOf,
} from './query/types.js';
export { plainQuery } from './query/types.js';

// Rules: who may create, edit and delete a collection's records, what must be unique
export { checkRules, onePerKey } from './records/rules.js';
export { describeCollection } from './records/describe.js';
export type { CollectionRules, Who } from './records/rules.js';

// Hosting: a subscription key, signed requests to a host, and a client for one
export {
  HOSTING_COLLECTION,
  REQUEST_WINDOW_SECONDS,
  newSubscriptionSeed,
  subscriptionKey,
  signRequest,
  verifyRequest,
  createHostClient,
  describeHost,
  signStatus,
  readStatus,
  payLink,
  verifyPayLink,
  HOST_DESCRIPTION_PATH,
  PAY_LINK_SECONDS,
  HostError,
} from './session/hosting.js';
export type {
  Hosting,
  SubscriptionKey,
  HostStatus,
  SignedStatus,
  HostDescription,
  HostClient,
} from './session/hosting.js';

// Mirrors: a space kept in a dumb file store — a bucket, an app folder — synced like a peer
export type { BlobStore } from './storage/blob-store.js';
export { createMemoryBlobStore } from './storage/blob/memory.js';
export { createS3BlobStore } from './storage/blob/s3.js';
export type { S3Config } from './storage/blob/s3.js';
export { createMirror, deleteMirrored } from './storage/mirror.js';
export type { Mirror, MirrorConfig, Taken } from './storage/mirror.js';
