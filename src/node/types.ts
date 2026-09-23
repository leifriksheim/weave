/**
 * @module node/types
 * The shape of a node: everything an app, a CLI, a daemon or an agent needs to
 * work with spaces, as plain data in and plain data out.
 *
 * Everything a method returns is JSON-serialisable on purpose. The same calls
 * are exposed as actions to a command line, an MCP server and WebMCP, and a
 * value that cannot cross a wire would have to be reshaped at each of them.
 */
import type { CollectionDef, CryptoProvider, SpaceType, SpaceVisibility } from '../types.js';
import type { RootSigner } from '../identity/root-signer.js';
import type { Capability, UCANToken } from '../identity/ucan.js';
import type { PeerTransport } from '../network/transport.js';
import type { StoreFactory } from './stores.js';

export interface NodeNetworkConfig {
  /** Relays for WebRTC, browsers only. Each space meets in the room named after its id. */
  readonly relays?: ReadonlyArray<string>;
  /** Always-on nodes to hold a socket to, `ws(s)://host/peer`. The space id is appended. */
  readonly nodes?: ReadonlyArray<string>;
  readonly iceServers?: ReadonlyArray<RTCIceServer>;
  /** Extra transports per space — how a node serving sockets, or a test, plugs in */
  readonly transports?: (spaceId: string) => ReadonlyArray<PeerTransport>;
}

export interface NodeConfig {
  /** Who this node acts for. The root key only ever signs session delegations. */
  readonly signer: RootSigner;
  /** Where the registry and each space's store live */
  readonly stores: StoreFactory;
  readonly provider?: CryptoProvider;
  /**
   * Collections this node knows the shape of. Records in them are checked on
   * write and on arrival; records in any other collection are kept on the
   * strength of their signature and capability alone.
   */
  readonly collections?: ReadonlyArray<CollectionDef>;
  /** Omit to stay offline */
  readonly network?: NodeNetworkConfig;
  /** How long each session delegation lasts. Renewed before it runs out. Default 3600. */
  readonly sessionTtlSeconds?: number;
  /** How often to look for writes another process made to a folder store. 0 disables. Default 2000. */
  readonly watchIntervalMs?: number;
}

/** A space, as the node describes it. Never carries the key. */
export interface SpaceSummary {
  readonly id: string;
  readonly name: string;
  readonly type: SpaceType;
  readonly visibility: SpaceVisibility;
  readonly owner: string;
  readonly members: ReadonlyArray<string>;
  readonly createdAt: string;
  /** Whether this node can read the space: always for public ones, only with the key for private */
  readonly readable: boolean;
}

export interface NewSpace {
  readonly name: string;
  /** `personal` accepts writes from the owner alone; `shared` from anyone invited */
  readonly type: SpaceType;
  /** `private` encrypts every body with the space key */
  readonly visibility: SpaceVisibility;
}

export interface InvitePreview {
  readonly space: Omit<SpaceSummary, 'readable'>;
  readonly invitedBy: string;
  /** Whether the invite carries the key to a private space */
  readonly carriesKey: boolean;
}

/** A record, opened and checked */
export interface NodeRecord<T = unknown> {
  readonly id: string;
  readonly space: string;
  readonly collection: string;
  /** The key that signed it — usually a session key */
  readonly author: string;
  /** The identity that key was acting for, when its delegation checks out */
  readonly root: string | null;
  readonly createdAt: string;
  /** The content, or null when it is encrypted and this node has no key */
  readonly body: T | null;
  readonly encrypted: boolean;
  /** Signature, delegation and shape all check out */
  readonly verified: boolean;
  readonly reason?: string;
}

export interface ListOptions {
  /** Only this collection. Default: every collection except the protocol's own `sys.*` */
  readonly collection?: string;
  /** Newest first when set; oldest first by default */
  readonly newestFirst?: boolean;
  readonly limit?: number;
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
  | { readonly type: 'rejected'; readonly space: string; readonly peer: string; readonly reason: string };

export interface NodeSpaces {
  list(): Promise<ReadonlyArray<SpaceSummary>>;
  get(spaceId: string): Promise<SpaceSummary | null>;
  create(params: NewSpace): Promise<SpaceSummary>;
  /** An invite string; for a private space it carries the key, so treat it as a secret */
  invite(spaceId: string): Promise<string>;
  preview(invite: string): InvitePreview;
  join(invite: string): Promise<SpaceSummary>;
  /** Forgets a space on this node, with its key. Other members keep theirs. */
  leave(spaceId: string): Promise<void>;
  /** Starts syncing a space. Reading or writing opens it anyway; this is for nodes that serve. */
  open(spaceId: string): Promise<void>;
  /** Stops syncing a space until it is next used */
  close(spaceId: string): Promise<void>;
  status(spaceId: string): Promise<SpaceStatus>;
}

export interface NodeRecords {
  list<T = unknown>(spaceId: string, options?: ListOptions): Promise<ReadonlyArray<NodeRecord<T>>>;
  get<T = unknown>(spaceId: string, id: string): Promise<NodeRecord<T> | null>;
  put<T = unknown>(spaceId: string, collection: string, body: T): Promise<NodeRecord<T>>;
  /**
   * Replaces a record: writes the new body and deletes the old one. The new
   * record has a new id — ids are content hashes.
   */
  update<T = unknown>(spaceId: string, id: string, body: T): Promise<NodeRecord<T>>;
  /** Deletes a record everywhere, by writing a signed tombstone that syncs like any record */
  delete(spaceId: string, id: string): Promise<void>;
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

export interface P2PNode {
  /** The identity this node acts for */
  readonly did: string;
  /** The session key that signs and connects; stable for the node's lifetime */
  readonly sessionDid: string;
  readonly spaces: NodeSpaces;
  readonly records: NodeRecords;
  /** The delegation the session key currently writes under (root → session) */
  delegation(): UCANToken;
  /** Passes a narrower delegation from the session key on to another key */
  delegate(params: DelegateParams): Promise<Delegated>;
  subscribe(listener: (event: NodeEvent) => void): () => void;
  close(): Promise<void>;
}
