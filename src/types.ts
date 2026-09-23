/**
 * Core protocol types used across all modules.
 * @module types
 */

/** Crypto provider interface — abstraction over key algorithms for easy swapping */
export interface CryptoProvider {
  readonly algorithm: string;
  generateKeyPair(): Promise<CryptoKeyPairResult>;
  /** Deterministically derives a key pair from seed bytes (same seed → same keys) */
  deriveKeyPairFromSeed(seed: Uint8Array): Promise<CryptoKeyPairResult>;
  sign(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
  exportPublicKey(key: CryptoKey): Promise<Uint8Array>;
  importPublicKey(bytes: Uint8Array): Promise<CryptoKey>;
  importPrivateKey(bytes: Uint8Array): Promise<CryptoKey>;
}

export interface CryptoKeyPairResult {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
}

/** Standard Schema v1 interface (https://standardschema.dev/) */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly value?: undefined; readonly issues: ReadonlyArray<StandardSchemaIssue> };

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey>;
}

/** Expression — the atomic data unit */
export interface Expression<T = unknown> {
  readonly id: string;          // CID of the expression
  readonly author: string;      // DID of the author
  readonly collection: string;  // Collection name (e.g., 'app.bsky.feed.post')
  readonly space?: string;      // Space this belongs to; omitted for unscoped data
  readonly createdAt: string;   // ISO 8601 timestamp
  readonly body: T;             // Typed payload
  readonly proof?: string;      // Encoded UCAN authorizing the author, if delegated
  readonly signature: string;   // Base64URL encoded signature
}

export interface UnsignedExpression<T = unknown> {
  readonly author: string;
  readonly collection: string;
  /** Space this belongs to — signed, so it cannot be replayed into another space */
  readonly space?: string;
  readonly createdAt: string;
  readonly body: T;
  /** Encoded UCAN proving the author may write this — signed along with the rest */
  readonly proof?: string;
}

/** Space types */
export type SpaceType = 'personal' | 'shared';

/** Whether a space's contents are readable by anyone who has them */
export type SpaceVisibility = 'public' | 'private';

export interface Space {
  readonly id: string;          // CID of the space
  readonly type: SpaceType;     // 'personal' (just the owner) or 'shared'
  readonly visibility: SpaceVisibility; // 'private' means the bodies are encrypted
  readonly owner: string;       // DID of the creator
  readonly name: string;
  readonly members: ReadonlyArray<string>; // DIDs
  readonly createdAt: string;
  readonly encryptionKeyId?: string; // For private spaces
}

/** Collection definition */
export interface CollectionDef {
  readonly name: string;        // e.g., 'app.example.post'
  readonly schema: StandardSchemaV1; // Standard Schema compliant validator
}

/** Peer info */
export interface PeerInfo {
  readonly did: string;
  readonly connectionId: string;
  readonly connectedAt: string;
}

/** Sync state */
export interface SyncState {
  readonly peerId: string;
  readonly lastSyncedAt: string;
  readonly remoteRoot: string;  // MST root hash
}

/** Storage adapter interface */
export interface StorageAdapter {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  list(prefix?: string): Promise<string[]>;
  /** Query expressions by collection */
  queryExpressions(collection: string, limit?: number, cursor?: string): Promise<Expression[]>;
  /** Store an expression */
  putExpression(expression: Expression): Promise<void>;
  /** Get an expression by ID */
  getExpression(id: string): Promise<Expression | null>;
  /** Delete an expression by ID */
  deleteExpression(id: string): Promise<void>;
  /** Batch operations */
  batch(ops: ReadonlyArray<BatchOp>): Promise<void>;
  close(): Promise<void>;
}

export type BatchOp =
  | { readonly type: 'put'; readonly key: string; readonly value: Uint8Array }
  | { readonly type: 'delete'; readonly key: string };

/** Network message envelope */
export interface NetworkMessage {
  readonly type: string;
  readonly from: string;   // sender DID
  readonly payload: unknown;
}

/** Result type for operations that can fail */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
