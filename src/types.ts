/**
 * Core protocol types used across all modules.
 * @module types
 */

/** Crypto provider interface — abstraction over key algorithms for easy swapping */
export interface CryptoProvider {
  readonly algorithm: string;
  generateKeyPair(): Promise<CryptoKeyPairResult>;
  /**
   * Deterministically derives a key pair from seed bytes (same seed → same keys).
   * Owns the whole KDF: callers pass the raw seed, at least 16 uniform bytes.
   */
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

/**
 * Standard JSON Schema v1 (https://standardschema.dev/json-schema): a schema
 * that can describe itself as JSON Schema — Zod 4.2+, ArkType 2.1.28+, and
 * Valibot through `toStandardJsonSchema`. It is how a validator you already
 * use becomes a definition a space can store.
 */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: Input; readonly output: Output };
    readonly jsonSchema: {
      readonly input: (options: { readonly target: string; readonly libraryOptions?: Record<string, unknown> }) => Record<string, unknown>;
      readonly output: (options: { readonly target: string; readonly libraryOptions?: Record<string, unknown> }) => Record<string, unknown>;
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

/** What a record is about: another record in the same space, in a named role */
export interface Link {
  /** The role: 'about', 'in', 'replyTo' — lower camel case */
  readonly rel: string;
  /** The key of the record it points at */
  readonly to: string;
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
  /** The record's identity, stable across versions. Links point here. */
  readonly key: string;
  /** 0 for a record's first version; each later version is one more than the one it replaces */
  readonly seq: number;
  /** Id of the version this one replaces. Absent on seq 0. */
  readonly prev?: string;
  /** Id of the record's first version — who created it. Absent on seq 0. */
  readonly genesis?: string;
  /** Keep this version once it is superseded — set by the writer, from the collection's `history` */
  readonly retain?: true;
  /**
   * The latest changes to the space's access history — roles, members,
   * invites, revoked notes, collection definitions — its writer knew of. It
   * is judged by who held what, and which definition was in force, as of
   * those (`space/roles.ts`).
   */
  readonly seen?: ReadonlyArray<string>;
  /** This version deletes the record; its body is null */
  readonly deleted?: true;
  /**
   * Links to other records. Signed with the rest. In a private space they are
   * sealed inside the encrypted body instead, and this is absent.
   */
  readonly links?: ReadonlyArray<Link>;
  /**
   * Topic tags: a keyed hash of each value of each field the collection names
   * as a topic (`records/topics.ts`), so a node that can't read the body can
   * still match what it's about. Signed with the rest; checked by any node
   * that can read the body.
   */
  readonly tags?: ReadonlyArray<string>;
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
  /** The record's identity, stable across versions. Links point here. */
  readonly key: string;
  /** 0 for a record's first version; each later version is one more than the one it replaces */
  readonly seq: number;
  /** Id of the version this one replaces. Absent on seq 0. */
  readonly prev?: string;
  /** Id of the record's first version — who created it. Absent on seq 0. */
  readonly genesis?: string;
  /** Keep this version once it is superseded — set by the writer, from the collection's `history` */
  readonly retain?: true;
  /**
   * The latest changes to the space's access history — roles, members,
   * invites, revoked notes, collection definitions — its writer knew of. It
   * is judged by who held what, and which definition was in force, as of
   * those (`space/roles.ts`).
   */
  readonly seen?: ReadonlyArray<string>;
  /** This version deletes the record; its body is null */
  readonly deleted?: true;
  /**
   * Links to other records. Signed with the rest. In a private space they are
   * sealed inside the encrypted body instead, and this is absent.
   */
  readonly links?: ReadonlyArray<Link>;
  /** Topic tags (see `Expression.tags`) */
  readonly tags?: ReadonlyArray<string>;
}

/** Whether a space's contents are readable by anyone who has them */
export type SpaceVisibility = 'public' | 'private';

/** A role, as a space defines it — see `space/roles.ts` */
export interface SpaceRole {
  /** Lower case, used as its key: `moderator` */
  readonly name: string;
  /** What people see: `Moderator` */
  readonly title?: string;
  /** Higher can change lower. Equal ranks are equals. */
  readonly rank: number;
  readonly permissions: ReadonlyArray<string>;
}

/**
 * A space. Its id is the hash of what is fixed at creation — creator,
 * visibility, starting roles, time, nonce and read key (`space/space-access.ts`)
 * — so whoever hands over a space cannot change who started it or with which
 * roles. `name` is a description, not part of that.
 */
export interface Space {
  readonly id: string;          // hash of the space's genesis
  readonly visibility: SpaceVisibility; // 'private' means the bodies are encrypted
  /** The account that made it, holding `creatorRole` at the start */
  readonly creator: string;
  /** The roles it started with — later changed by records in `sys.role` */
  readonly roles: ReadonlyArray<SpaceRole>;
  readonly creatorRole: string;
  readonly name: string;
  readonly createdAt: string;
  /** Random, so two spaces made alike still differ */
  readonly nonce: string;
  /** Private spaces: the public half of the read key, derived from the space key — what a node checks a reader against */
  readonly readKey?: string;
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
