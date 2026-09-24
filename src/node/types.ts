/**
 * @module node/types
 * The shape of a node: everything an app, a CLI, a daemon or an agent needs to
 * work with spaces, as plain data in and plain data out.
 *
 * Everything a method returns is JSON-serialisable on purpose. The same calls
 * are exposed as actions to a command line, an MCP server and WebMCP, and a
 * value that cannot cross a wire would have to be reshaped at each of them.
 */
import type { Query, QueryResult } from '../query/types.js';
import type { CollectionRules } from '../records/rules.js';
import type { CollectionDef, CryptoProvider, Link, SpaceRole, SpaceVisibility } from '../types.js';
import type { LinkDeclaration } from '../records/links.js';
import type { RootSigner } from '../identity/root-signer.js';
import type { Capability, UCANToken } from '../identity/ucan.js';
import type { PeerTransport } from '../network/transport.js';
import type { ServerAuth } from '../network/peer-auth.js';
import type { StoreFactory } from './stores.js';
import type { JsonSchema, SchemaIssue } from '../schema/collection-def.js';

export interface NodeNetworkConfig {
  /** Relays for WebRTC, browsers only. Each space meets in the room named after its id. */
  readonly relays?: ReadonlyArray<string>;
  /** Always-on nodes to hold a socket to, `ws(s)://host/peer`. The space id is appended. */
  readonly nodes?: ReadonlyArray<string>;
  readonly iceServers?: ReadonlyArray<RTCIceServer>;
  /**
   * Extra transports per space — how a node serving sockets, or a test, plugs
   * in. Given the space and this node's session DID, which is its identity on
   * the wire.
   */
  readonly transports?: (spaceId: string, sessionDid: string) => ReadonlyArray<PeerTransport>;
}

export interface NodeConfig {
  /** Who this node acts for. The root key only ever signs session delegations. */
  readonly signer: RootSigner;
  /**
   * The account's vault key bytes (`deriveVaultKeyBytes(seed)`). With it, the node keeps the account's space list in the
   * account registry space: spaces joined on any device or node of the account
   * are joined here too, and leaving one leaves it everywhere. Without it,
   * spaces are this node's alone.
   */
  readonly accountKey?: Uint8Array;
  /** Where the registry and each space's store live */
  readonly stores: StoreFactory;
  readonly provider?: CryptoProvider;
  /**
   * Collections this node knows the shape of, for when a space does not
   * describe them itself. Records are checked against them when written here
   * and flagged (`conforms`) when read. Nothing is refused on arrival for its
   * shape: sync accepts whatever is signed and authorized, so nodes with
   * different schemas still converge.
   */
  readonly collections?: ReadonlyArray<CollectionDef>;
  /** Omit to stay offline */
  readonly network?: NodeNetworkConfig;
  /** How long each session delegation lasts. Renewed before it runs out. Default 3600. */
  readonly sessionTtlSeconds?: number;
  /**
   * The key this node signs with, when it must be one the signer already
   * knows — an app given a delegation by an account home, which named the
   * app's key. By default the node makes a fresh one each time it starts.
   */
  readonly sessionKey?: CryptoKeyPair;
  /** How often to look for writes another process made to a folder store. 0 disables. Default 2000. */
  readonly watchIntervalMs?: number;
}

/** A space, as the node describes it. Never carries the key. */
export interface SpaceSummary {
  readonly id: string;
  readonly name: string;
  readonly visibility: SpaceVisibility;
  /** The account that made it */
  readonly creator: string;
  readonly createdAt: string;
  /** Whether this node can read the space: always for public ones, only with the key for private */
  readonly readable: boolean;
  /**
   * Whether this node's account holds a role here, and so may write — as far
   * as this node last heard. A view-only invite, or being removed, means it
   * follows the space and reads.
   */
  readonly writable: boolean;
  /** The role this account holds here, by name — null when it holds none */
  readonly role: string | null;
  /** Whether an invite is waiting to be used — its record has not reached this device yet */
  readonly joining: boolean;
}

export interface NewSpace {
  readonly name: string;
  /** `private` encrypts every body with the space key */
  readonly visibility: SpaceVisibility;
  /**
   * The roles it starts with. Default: the creator alone, holding everything.
   * `rolePresets` has some to start from — or write your own.
   */
  readonly roles?: ReadonlyArray<SpaceRole>;
  /** Which of them the creator holds. Default: the highest-ranked. */
  readonly creatorRole?: string;
}

export interface InvitePreview {
  readonly space: Pick<SpaceSummary, 'id' | 'name' | 'visibility' | 'creator' | 'createdAt'>;
  readonly invitedBy: string;
  /** Whether the invite carries the key to a private space */
  readonly carriesKey: boolean;
  /** Whether the invite lets you join with a role — false for a view-only one */
  readonly carriesWrite: boolean;
  /** The role it is for, as the link says. The space's own invite record is what counts. */
  readonly role: string | null;
}

export interface InviteOptions {
  /**
   * The role whoever uses it will hold. Default: the lowest role below your
   * own — or, when there is none, a view-only invite.
   */
  readonly role?: string;
  /** False for a view-only invite: the key to read a private space, and no role */
  readonly write?: boolean;
}

/** Who holds what in a space, now */
export interface SpaceAccess {
  /** Highest rank first */
  readonly roles: ReadonlyArray<SpaceRole>;
  readonly members: ReadonlyArray<{ readonly did: string; readonly role: string }>;
  /** Open and closed invites, by their public key */
  readonly invites: ReadonlyArray<{ readonly key: string; readonly role: string; readonly open: boolean }>;
  /** This account's own role — null when it holds none */
  readonly role: SpaceRole | null;
  /** The latest access changes held — what a record written now names as `seen` */
  readonly heads: ReadonlyArray<string>;
}

/** A record, opened and checked — its current version, unless listed as history */
export interface NodeRecord<T = unknown> {
  /** The record's identity. Stays the same across edits; links point here. */
  readonly key: string;
  /** This version's id — a content hash, different for every edit */
  readonly version: string;
  /** 0 for the first version, one more for each edit */
  readonly seq: number;
  readonly space: string;
  readonly collection: string;
  /** The key that signed this version — usually a session key */
  readonly author: string;
  /** The identity that key was acting for, when its delegation checks out */
  readonly root: string | null;
  /** The identity that created the record, when its first version is held */
  readonly createdBy: string | null;
  /** When the record was created, as its creator's clock said — for display; it decides nothing */
  readonly createdAt: string;
  /** When this version was written, likewise for display only */
  readonly updatedAt: string;
  /** The content, or null when it is encrypted and this node has no key */
  readonly body: T | null;
  /** What this record points at — empty when it points at nothing, or cannot be opened */
  readonly links: ReadonlyArray<Link>;
  readonly encrypted: boolean;
  /** Signature, delegation and shape all check out */
  readonly verified: boolean;
  readonly reason?: string;
  /** Present, and true, when this version deletes the record (listed only with `includeDeleted`) */
  readonly deleted?: true;
  /**
   * Whether the body fits its collection's schema — the one the space
   * describes, else one this node was given. Null when there is none, or the
   * body could not be opened. A record that does not fit is still kept and
   * synced: whether it fits can depend on which definition a peer has seen yet,
   * and rejecting it would leave peers that disagree forever.
   */
  readonly conforms: boolean | null;
  readonly issues?: ReadonlyArray<SchemaIssue>;
}

/** A collection as a space describes it, and how many records it holds */
export interface NodeCollection {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** Null when records exist but the space has no definition for them */
  readonly schema: JsonSchema | null;
  readonly version: number | null;
  /** Whether edits keep old versions: `all` for an audit trail, `latest` (the default) for current state only */
  readonly history: 'latest' | 'all';
  /** The link roles its records carry, and what each may point at — how the space's things connect */
  readonly links: Readonly<Record<string, LinkDeclaration>>;
  /** The identity that first defined it — it, and anyone who can manage the space, may change it */
  readonly definedBy: string | null;
  /** The permissions its rules name — a role holds each as `<collection>/<permission>` */
  readonly permissions: ReadonlyArray<string>;
  /** Who may create, edit and delete, what must be unique — for records created from now on */
  readonly rules: CollectionRules;
  readonly records: number;
}

export interface DefineCollection {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** JSON Schema for a record's body, in the supported subset */
  readonly schema: JsonSchema;
  /** Default: one past the current version, or 1 */
  readonly version?: number;
  /** Keep every version of every record in it (`all`), or only the current one (`latest`, the default) */
  readonly history?: 'latest' | 'all';
  /** The link roles its records may carry, and what each may point at */
  readonly links?: Readonly<Record<string, LinkDeclaration>>;
  /** The permissions its rules may name, like `moderate` */
  readonly permissions?: ReadonlyArray<string>;
  /** Who may create, edit and delete, what must be unique, which fields are fixed */
  readonly rules?: CollectionRules;
}

export interface NodeCollections {
  /** What a space holds: every defined collection, and every collection with records */
  list(spaceId: string): Promise<ReadonlyArray<NodeCollection>>;
  /** Publishes a definition into the space, as a signed record that syncs like any other */
  define(spaceId: string, definition: DefineCollection): Promise<NodeCollection>;
}

export interface ListOptions {
  /** Only this collection. Default: every collection except the protocol's own `sys.*` */
  readonly collection?: string;
  /** Newest first when set; oldest first by default */
  readonly newestFirst?: boolean;
  readonly limit?: number;
  /** Also return deleted records, marked `deleted` */
  readonly includeDeleted?: boolean;
}

export type ConnectionState = 'offline' | 'connecting' | 'connected' | 'error';

export interface SpaceStatus {
  readonly space: string;
  readonly connection: ConnectionState;
  /** Peers currently connected in this space */
  readonly peers: ReadonlyArray<string>;
  /** Root of this space's Merkle tree — equal on two nodes means identical data */
  readonly root: string | null;
  /** Records peers sent that failed validation */
  readonly rejected: number;
}

export type NodeEvent =
  /** Records were added, changed or deleted, locally or by sync */
  | { readonly type: 'records'; readonly space: string }
  /** Connection or peers changed */
  | { readonly type: 'status'; readonly space: string }
  /** The registry changed: a space was created, joined or left */
  | { readonly type: 'spaces' }
  /** The account's profile may have changed, here or on another device */
  | { readonly type: 'account' }
  | { readonly type: 'rejected'; readonly space: string; readonly peer: string; readonly reason: string }
  /** The note this node writes under was revoked in a space — an app disconnected from its account home, say */
  | { readonly type: 'revoked'; readonly space: string };

/** Who someone is in a space: the name they gave there, by their identity */
export interface SpaceProfile {
  /** Their identity — what `root` and `createdBy` on a record name */
  readonly did: string;
  readonly name: string;
  readonly updatedAt: string;
}

export interface NodeSpaces {
  list(): Promise<ReadonlyArray<SpaceSummary>>;
  get(spaceId: string): Promise<SpaceSummary | null>;
  create(params: NewSpace): Promise<SpaceSummary>;
  /**
   * An invite string. For a private space it carries the key, and unless it is
   * view-only, the secret of an invite opened for a role — so treat it as a
   * secret. It is shown once: nothing keeps it. Closing the invite (`closeInvite`)
   * stops it working.
   */
  invite(spaceId: string, options?: InviteOptions): Promise<string>;
  preview(invite: string): InvitePreview;
  join(invite: string): Promise<SpaceSummary>;
  /**
   * Forgets a space on this node, with its key. Other members keep theirs.
   * Your role stays too — to give it up, `setMember` yourself to null first.
   */
  leave(spaceId: string): Promise<void>;
  /** Roles, members and invites, as the space's access history says now */
  access(spaceId: string): Promise<SpaceAccess>;
  /** Gives someone a role, changes it, or with null takes it away. You may change people ranked below you, and yourself to null. */
  setMember(spaceId: string, did: string, role: string | null): Promise<void>;
  /** Adds or changes a role ranked below yours */
  putRole(spaceId: string, role: SpaceRole): Promise<void>;
  /** Removes a role ranked below yours; whoever held it holds nothing */
  removeRole(spaceId: string, name: string): Promise<void>;
  /** Closes an invite — by the link itself, or by its key from `access().invites`. Who joined with it before stays. */
  closeInvite(spaceId: string, keyOrLink: string): Promise<void>;
  /**
   * Revokes a note this account signed — an app's, say. Nothing written under
   * it counts from then on, except what this node had already seen.
   */
  revoke(spaceId: string, token: string): Promise<void>;
  /** Starts syncing a space. Reading or writing opens it anyway; this is for nodes that serve. */
  open(spaceId: string): Promise<void>;
  /** Stops syncing a space until it is next used */
  close(spaceId: string): Promise<void>;
  status(spaceId: string): Promise<SpaceStatus>;
  /**
   * What a node serving this space uses to check a connecting peer is who it
   * says — and, in a private space, may read it — and to sign its welcome.
   * Needs no key of the space's. Null for a space this node does not hold.
   */
  authenticator(spaceId: string): Promise<ServerAuth | null>;
  /**
   * The name each person gave in this space, by identity. Your own is
   * published for you, from the account's name, into every space you can
   * write in — and kept up to date when you rename. Only you can change yours.
   */
  profiles(spaceId: string): Promise<ReadonlyArray<SpaceProfile>>;
}

export interface NodeRecords {
  /** Current versions, oldest record first; deleted records only with `includeDeleted` */
  list<T = unknown>(spaceId: string, options?: ListOptions): Promise<ReadonlyArray<NodeRecord<T>>>;
  /** A record's current version, or null when there is none or it was deleted */
  get<T = unknown>(spaceId: string, key: string): Promise<NodeRecord<T> | null>;
  /**
   * Creates a record. Its key is random unless given — a chosen key suits a
   * record there is one of by nature. Writing a key that was deleted brings it back.
   */
  put<T = unknown>(
    spaceId: string,
    collection: string,
    body: T,
    options?: { key?: string; links?: ReadonlyArray<Link> },
  ): Promise<NodeRecord<T>>;
  /** Writes the record's next version. Same key; `seq` one higher. Links carry over unless given. */
  update<T = unknown>(spaceId: string, key: string, body: T, options?: { links?: ReadonlyArray<Link> }): Promise<NodeRecord<T>>;
  /** The records whose current version points at this one — optionally in one role, or one collection */
  linked<T = unknown>(spaceId: string, key: string, options?: { rel?: string; collection?: string }): Promise<ReadonlyArray<NodeRecord<T>>>;
  /**
   * Deletes a record everywhere, by writing a version marked deleted that syncs
   * like any other. Anyone who may write in the space may delete in it.
   */
  delete(spaceId: string, key: string): Promise<void>;
  /**
   * The versions of a record this node keeps, newest first: the current one,
   * the first one, and — in a collection with `history: 'all'` — every other.
   */
  history<T = unknown>(spaceId: string, key: string): Promise<ReadonlyArray<NodeRecord<T>>>;
  /**
   * Whether this account may `create` in a collection (`target` = its name),
   * or `edit` / `delete` a record (`target` = its key) — by the collection's
   * rules and the space's. For hiding a button rather than showing an error.
   */
  can(spaceId: string, action: 'create' | 'edit' | 'delete', target: string): Promise<boolean>;
  /**
   * Records matching a query — filtered, sorted, paged, with linked records
   * pulled in. The query is plain data.
   * @throws When the query is malformed, saying what to fix
   */
  query<T = unknown>(spaceId: string, query: Query): Promise<QueryResult<T>>;
  /**
   * Runs a query now and again whenever the space's records change, calling
   * back with each result. Returns a function that stops it.
   */
  watch<T = unknown>(spaceId: string, query: Query, onResult: (result: QueryResult<T>) => void, onError?: (error: Error) => void): () => void;
}

export interface DelegateParams {
  /** The key being given permission — an agent's, a guest's */
  readonly audience: string;
  /** Must be no broader than the node's own */
  readonly capabilities: ReadonlyArray<Capability>;
  /** Unix seconds; capped at the node's own delegation. Default: the same. */
  readonly expiration?: number;
}

export interface Delegated {
  readonly token: UCANToken;
  /** The chain above it, root first, for anyone verifying it */
  readonly proofs: ReadonlyArray<string>;
}

export interface AccountProfileView {
  readonly name: string;
  /** When it was set, on whichever device set it */
  readonly updatedAt: string;
}

export interface NodeAccount {
  /** The account's profile as its devices last set it. Null without an account key, or before any is set. */
  profile(): Promise<AccountProfileView | null>;
  /** Renames the account on every device and app that opens it. Needs an account key. */
  setName(name: string): Promise<AccountProfileView>;
  /**
   * Revokes a note this account signed in the account registry, so a
   * whole-account app can no longer add spaces or rename it. Needs an account key.
   */
  revoke(token: string): Promise<void>;
}

export interface P2PNode {
  /** The identity this node acts for */
  readonly did: string;
  /** The session key that signs and connects; stable for the node's lifetime */
  readonly sessionDid: string;
  readonly spaces: NodeSpaces;
  readonly records: NodeRecords;
  readonly collections: NodeCollections;
  /** The account itself — its name, synced through the account registry */
  readonly account: NodeAccount;
  /** The delegation the session key currently writes under (root → session) */
  delegation(): UCANToken;
  /** Passes a narrower delegation from the session key on to another key */
  delegate(params: DelegateParams): Promise<Delegated>;
  subscribe(listener: (event: NodeEvent) => void): () => void;
  close(): Promise<void>;
}
