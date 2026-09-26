/**
 * @module node/types
 * The shape of a node: everything an app, a CLI, a daemon or an agent needs to
 * work with spaces, as plain data in and plain data out.
 *
 * Everything a method returns is JSON-serialisable on purpose. The same calls
 * are exposed as actions to a command line, an MCP server and WebMCP, and a
 * value that cannot cross a wire would have to be reshaped at each of them.
 */
import type { BodyOf, Query, ResultOf } from '../query/types.js';
import type { CollectionRules } from '../records/rules.js';
import type { CollectionDef, CryptoProvider, Link, SpaceRole, SpaceVisibility, StandardJSONSchemaV1 } from '../types.js';
import type { LinkDeclaration } from '../records/links.js';
import type { RootSigner } from '../identity/root-signer.js';
import type { Capability, UCANToken } from '../identity/ucan.js';
import type { PeerTransport } from '../network/transport.js';
import type { ServerAuth } from '../network/peer-auth.js';
import type { StoreFactory } from './stores.js';
import type { JsonSchema, SchemaIssue } from '../schema/collection-def.js';
import type { Keeper } from '../space/roles.js';
import type { NotifyWhen } from '../space/notify.js';

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
  /**
   * The account's contact key (`deriveContactKeyBytes(seed)`), for a node
   * allowed to handle contacts: it opens contact requests sent to the account,
   * and its public half goes on the account's profile in every space this
   * node writes in. Without it, a profile keeps the key another device put there.
   */
  readonly contactKey?: Uint8Array;
  /**
   * The id of the account's contacts space, for a node given it without the
   * account key — an app an account home let see the contacts. With the
   * account key it is derived, and this is not needed.
   */
  readonly contactsSpace?: string;
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
  /**
   * Hold only part of a space — the collections this node uses — once the
   * space names a keeper to hold the rest. What's dropped syncs back when a
   * query needs it again. Apps connected to an account home do this by default.
   * Spaces with no keeper are always held whole.
   */
  readonly cache?: CacheConfig;
}

/**
 * How a node holds part of a space. Every number here is the node's own
 * choice: nothing else depends on what a node holding part of a space keeps.
 */
export interface CacheConfig {
  /** Collections this app uses: held from the start, and dropped last */
  readonly collections?: ReadonlyArray<string>;
  /** Drop a collection no query has touched for this many days, unless it holds writes of this node's still waiting. Default 30. */
  readonly unusedAfterDays?: number;
  /**
   * How many keepers a write of this node's must reach before it can be
   * dropped. The space's own number (`copies`) or 2 when it names none, and
   * never more than the keepers it names; this only ever raises it.
   */
  readonly copies?: number;
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
  /**
   * A private space's key: how many times it has changed, and whether this
   * device holds the one in use now — not while a new one is on its way here.
   * Null in a public space.
   */
  readonly key: { readonly changes: number; readonly held: boolean } | null;
  /** Where the space's members meet: the relays it names, or until it names some, the ones its invite did */
  readonly relays: ReadonlyArray<string>;
  /** The nodes that keep the space whole: a host, an extension. Empty until someone who manages it names some. */
  readonly keepers: ReadonlyArray<Keeper>;
  /** How many keepers a write should reach before a node holding part of the space lets go of it; null for the default */
  readonly copies: number | null;
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
  /**
   * Present, and true, when an agent wrote this version for `root`: the note
   * it was signed under says so (`AGENT_FACT`). The account's word, signed —
   * not something the agent can leave out.
   */
  readonly viaAgent?: true;
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
  /** Fields whose values are topics, tagged on the outside of each record so keepers can match them unread */
  readonly topics: ReadonlyArray<string>;
  /** A screen for its records, when its definer gave one: one HTML document, run sealed */
  readonly screen?: string;
  readonly records: number;
}

export interface DefineCollection {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /**
   * A record body's shape: JSON Schema in the supported subset, or a
   * validator that can describe itself as JSON Schema — a Zod object, say
   * (Standard JSON Schema). Either way, JSON Schema is what gets stored.
   */
  readonly schema: JsonSchema | StandardJSONSchemaV1;
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
  /** Fields whose values are topics — `channel`, `mentions` — so a keeper can match them without reading (`StoredCollection.topics`) */
  readonly topics?: ReadonlyArray<string>;
  /** A screen for its records — one HTML document an app may run in a sealed frame (`StoredCollection.screen`) */
  readonly screen?: string;
}

export interface NodeCollections {
  /** What a space holds: every defined collection, and every collection with records */
  list(spaceId: string): Promise<ReadonlyArray<NodeCollection>>;
  /** Publishes a definition into the space, as a signed record that syncs like any other */
  define(spaceId: string, definition: DefineCollection): Promise<NodeCollection>;
  /**
   * Takes a definition out of the space. Refused while the collection still
   * has records; the same people who may change a definition may remove it.
   */
  delete(spaceId: string, name: string): Promise<void>;
  /**
   * The topic tag for one value of a collection's topic field — what a
   * record with that value carries on its outside, and what a subscription
   * hands a keeper to match without reading. In a private space it takes the
   * space's current key, so only its members can work it out.
   */
  tag(spaceId: string, collection: string, field: string, value: string | number | boolean): Promise<string>;
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
  /** Of `peers`, this account's own other devices and apps — the ones following the account registry too */
  readonly own: ReadonlyArray<string>;
  /** Of `peers`, carriers the account uses: nodes that keep its spaces online without reading them */
  readonly carriers: ReadonlyArray<string>;
  /** The account each peer showed it acts for, by the peer's session DID — only peers that showed one */
  readonly accounts: Readonly<Record<string, string>>;
  /** A fingerprint of every version this node keeps here — equal on two nodes means identical data */
  readonly fingerprint: string;
  /** Records peers sent that failed validation */
  readonly rejected: number;
  /** What this node holds of the space: `all`, or the collections it uses (besides the space's own) */
  readonly holds: 'all' | ReadonlyArray<string>;
  /** Writes of this node's that haven't reached enough keepers yet, so are kept whatever else is dropped */
  readonly pending: number;
}

/** A live message as it arrives: what was sent, and who sent it */
export interface LiveMessage {
  /**
   * The account behind the sender — proven by the note its session carries,
   * made out to the very key the connection proved. Null for a peer that
   * showed no note: a carrier, a node serving sockets.
   */
  readonly from: string | null;
  /** The sending device: its session DID, which is also where a reply to that device goes */
  readonly peer: string;
  /** Whether the sender is an agent acting for the account, not the person */
  readonly agent: boolean;
  readonly message: unknown;
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
  /** A live message from a peer in a space (`spaces.send`) */
  | ({ readonly type: 'message'; readonly space: string } & LiveMessage)
  /** The note this node writes under was revoked in a space — an app disconnected from its account home, say */
  | { readonly type: 'revoked'; readonly space: string };

/** Who someone is in a space: the name they gave there, by their identity */
export interface SpaceProfile {
  /** Their identity — what `root` and `createdBy` on a record name */
  readonly did: string;
  readonly name: string;
  readonly updatedAt: string;
  /**
   * The public half of their contact key, when they published one — what a
   * contact request to them is sealed with (`contacts.ask`). It counts only
   * on a profile signed under their own account, like the name.
   */
  readonly contactKey?: string;
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
  /**
   * Joins a space from an invite. `memberKey` is this account's member key
   * for it, for a node without the account key — an app an account home gave
   * the space to — so a new key of the space reaches it too.
   */
  join(invite: string, options?: { readonly memberKey?: Uint8Array }): Promise<SpaceSummary>;
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
   * Gives a private space a new key, sealed to every member and nobody else.
   * Happens by itself when someone is removed or leaves; call it when a
   * device was lost. View-only links made before stop working. Needs `manage`.
   */
  changeKey(spaceId: string): Promise<void>;
  /**
   * Names the relays the space's members meet on — wss:// URLs, at most 8 —
   * so people whose apps use different relays still find each other. Every
   * member joins the space's room there too, and invites carry them. A space
   * names the relays of whoever manages it first by itself. Needs `manage`.
   */
  setRelays(spaceId: string, relays: ReadonlyArray<string>): Promise<void>;
  /**
   * Names the nodes that keep the space whole — a host, an extension — at
   * most 16, and optionally how many of them a write should reach before a
   * node holding only part of the space lets go of it. Nodes that hold part
   * of a space only do so once it names a keeper. Needs `manage`.
   */
  setKeepers(spaceId: string, keepers: ReadonlyArray<Keeper>, copies?: number | null): Promise<void>;
  /**
   * Revokes a note this account signed — an app's, say. Nothing written under
   * it counts from then on, except what this node had already seen.
   */
  revoke(spaceId: string, token: string): Promise<void>;
  /**
   * Keeps a space syncing until you let go: call the function it returns.
   * Anything that needs a space live holds it — a screen showing it, a call
   * in it — and it stops syncing once nothing does. Letting go twice does
   * nothing, and can never let go of someone else's hold.
   *
   * ```ts
   * const release = await node.spaces.hold(spaceId);
   * await release();
   * ```
   *
   * Reading or writing works without a hold: it opens the space too.
   */
  hold(spaceId: string): Promise<() => Promise<void>>;
  /**
   * Sends a live message to the peers connected in a space right now: kept
   * nowhere, signed as nothing, missed by anyone not connected. For presence,
   * typing, call setup. `to` narrows it to one account's devices, or to one
   * device by its session DID. At most 64 KB once encoded as JSON.
   * Receivers get it as a `message` event.
   */
  send(spaceId: string, message: unknown, to?: string): Promise<void>;
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
  /** The same, given the collection's definition: the body is checked against its type as you write it */
  put<C extends { readonly name: string }>(
    spaceId: string,
    collection: C,
    body: BodyOf<C>,
    options?: { key?: string; links?: ReadonlyArray<Link> },
  ): Promise<NodeRecord<BodyOf<C>>>;
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
   * pulled in. The query is plain data. Name a collection by its definition
   * (or a `Typed` name) instead of a string, and the records — and what each
   * `include` finds — come back typed. Only records this device can read are
   * returned.
   * @throws When the query is malformed, saying what to fix
   */
  query<const Q extends Query>(spaceId: string, query: Q): Promise<ResultOf<Q>>;
  /**
   * Runs a query now and again whenever the space's records change, calling
   * back with each result. Returns a function that stops it.
   */
  watch<const Q extends Query>(spaceId: string, query: Q, onResult: (result: ResultOf<Q>) => void, onError?: (error: Error) => void): () => void;
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

/** A carrier the account uses, as the account registry lists it */
export interface CarrierSummary {
  /** The carry space shared with it */
  readonly space: string;
  /** Its key, as peers see it */
  readonly did: string;
  readonly name: string;
  readonly since: string;
}

/**
 * Carriers: nodes that keep the account's spaces online without being able to
 * read them — a browser extension, say (`space/pass.ts`). Needs the account key.
 */
export interface NodeCarriers {
  list(): Promise<ReadonlyArray<CarrierSummary>>;
  /**
   * Starts using a carrier: makes a carry space for it, puts a pass for every
   * space of the account in it, and lists it in the account registry so every
   * device keeps those passes current.
   * @returns The carry space, and the view-only invite the carrier joins it with
   */
  add(carrier: { readonly did: string; readonly name: string }): Promise<{ readonly space: string; readonly invite: string }>;
  /**
   * Stops using a carrier: takes its passes away and tells it to forget what it
   * held. What it already downloaded, it keeps — encrypted, as it always was.
   */
  remove(space: string): Promise<void>;
}

/** A subscription, as the person made it (`space/notify.ts`) */
export interface NotifyView extends NotifyWhen {
  readonly id: string;
}

/**
 * "Let me know when…": new records in a collection, in some of the account's
 * spaces or all of them, perhaps only those with a topic value, perhaps only
 * other people's. The account's carriers — its extension — notice them and
 * say so, without reading anything: they get each subscription with its value
 * replaced by a topic tag. Needs the account key.
 */
export interface NodeNotifications {
  list(): Promise<ReadonlyArray<NotifyView>>;
  /**
   * Starts one. `topic` matches exact values of a topic field the collection
   * names (`topics`): `{ field: 'mentions', value: myDid }`.
   */
  add(when: Omit<NotifyWhen, 'since'> & { readonly since?: string }): Promise<NotifyView>;
  /** Changes its label, pauses or resumes it */
  update(id: string, changes: { readonly label?: string; readonly paused?: boolean }): Promise<NotifyView>;
  remove(id: string): Promise<void>;
}

/** A host the account uses, and what it says now */
export interface HostingView {
  /** The host's address */
  readonly url: string;
  /** The host's own key, as it appears to peers */
  readonly host: string;
  /** Its name, as it describes itself; its address's host name when it doesn't */
  readonly name: string;
  /** The subscription — the key the account made for this host */
  readonly subscription: string;
  readonly since: string;
  /**
   * How the subscription stands, as the host signed it: just now when `live`,
   * otherwise the last it said (kept in the account registry). Null when it
   * never said.
   */
  readonly status: import('../session/hosting.js').HostStatus | null;
  /** Whether `status` is what the host said just now */
  readonly live: boolean;
  /** Why it could not be reached */
  readonly error?: string;
  /** Its price, for people, as it puts it */
  readonly price?: string;
  /** Whether it takes payments, on its own page (`payPage`) */
  readonly pays: boolean;
}

/**
 * Hosts: nodes that never sleep, keeping the account's spaces online and
 * backed up when every device is off — without being able to read them. A
 * host is a carrier (`carriers`) the account pays for; every device of the
 * account hands it the spaces, with nothing to set up.
 *
 * Nothing here knows how a host is paid (BLOCK-23): a host takes payments on
 * its own page, which `payPage` links to, and says how the subscription stands
 * in a status it signs.
 */
export interface NodeHosting {
  /** The hosts the account uses, each asked how it stands. Hands a host the spaces if it was paid since. */
  list(): Promise<ReadonlyArray<HostingView>>;
  /**
   * Starts using a host: makes a subscription key, keeps it in the account
   * registry so every device signs as it, and — once it is paid, or at once
   * for a free host — hands the host the account's spaces.
   */
  use(url: string): Promise<HostingView>;
  /**
   * A link to the host's own pay page, signed with the subscription key: it
   * lets whoever opens it pay for this subscription, at that host, for an
   * hour. Open it in a new tab (`noopener`), and call `list` when the person
   * comes back.
   */
  payPage(url: string): Promise<string>;
  /** Stops using a host: it forgets the spaces, and the subscription is let go. A card that renews is cancelled on the host's pay page. */
  stop(url: string): Promise<void>;
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

/** Someone in the account's contact list */
export interface ContactView {
  /** Their account */
  readonly did: string;
  /** What you call them — yours to change; they never see it */
  readonly name: string;
  /** The id of your space for two, where records wait and live messages reach them. Null when there is none. */
  readonly space: string | null;
  readonly note?: string;
  /** Their contact requests are hidden, in every space */
  readonly blocked: boolean;
  readonly updatedAt: string;
}

/** A contact request sent to this account, opened */
export interface ContactRequest {
  /** The space it was posted in */
  readonly space: string;
  /** Its record there — what `accept` takes */
  readonly key: string;
  /** The account asking */
  readonly from: string;
  /** The name they go by in that space, when they gave one */
  readonly name: string | null;
  readonly note?: string;
  /** The space for two it invites you to */
  readonly pairSpace: string;
  readonly createdAt: string;
}

/**
 * The account's contacts. Each is a private space for two, recorded as a
 * `std.contact` in the account's contacts space — a space derived from the
 * account key, so every device of the account has the same list and nobody
 * else can find it. There is no directory and no inbox: knowing someone's DID
 * reaches nothing. You add someone by asking inside a space you share
 * (`ask`), or by giving them an invite to a space for two some other way, and
 * `put`ting them.
 */
export interface NodeContacts {
  /** The contacts space's id — null for a node not given it */
  space(): Promise<string | null>;
  /** Everyone in the list, blocked people too, by name */
  list(): Promise<ReadonlyArray<ContactView>>;
  get(did: string): Promise<ContactView | null>;
  /** Adds someone, or changes what the list says about them */
  put(contact: { readonly did: string; readonly name: string; readonly space?: string | null; readonly note?: string }): Promise<ContactView>;
  /** Takes them off the list and leaves your space for two. Nobody else's space is touched. */
  remove(did: string): Promise<void>;
  /** Leaves your space for two, and hides their contact requests from now on */
  block(did: string): Promise<void>;
  /**
   * Asks someone in a space you share to add you: makes a private space for
   * the two of you, puts them on your list with it, and posts the space's
   * invite in `spaceId` sealed with their contact key — the other members see
   * that you asked, not what. Needs their profile there to carry a contact key.
   * @returns The space for two, and the request's record key (delete it to take the request back)
   */
  ask(spaceId: string, did: string, options?: { readonly note?: string }): Promise<{ readonly space: string; readonly request: string }>;
  /** Contact requests sent to this account in a space, opened — not from people blocked, and not ones already accepted */
  requests(spaceId: string): Promise<ReadonlyArray<ContactRequest>>;
  /** Joins the space for two a request invites you to, and puts whoever asked on your list */
  accept(spaceId: string, requestKey: string): Promise<ContactView>;
  /**
   * Accounts in your space with someone other than the two of you — someone
   * the invite was passed on to. Opens that space. Empty when there is none.
   */
  others(did: string): Promise<ReadonlyArray<string>>;
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
  /** Nodes that keep the account's spaces online without reading them */
  readonly carriers: NodeCarriers;
  /** Hosts the account pays to keep its spaces online */
  readonly hosting: NodeHosting;
  /** "Let me know when…" — noticed by the account's carriers, which can't read what they notice */
  readonly notifications: NodeNotifications;
  /** People: the account's contact list, and asking to be added */
  readonly contacts: NodeContacts;
  /** The delegation the session key currently writes under (root → session) */
  delegation(): UCANToken;
  /**
   * ICE servers for a WebRTC connection of the app's own, like a call's: the
   * configured ones, plus TURN servers a relay offers, with short-lived
   * passwords (fetched fresh when the ones held are about to run out).
   */
  iceServers(): Promise<ReadonlyArray<RTCIceServer>>;
  /** Passes a narrower delegation from the session key on to another key */
  delegate(params: DelegateParams): Promise<Delegated>;
  /**
   * The same node, acting as an agent: what it writes is signed by the
   * agent's key under the agent's note (one carrying `AGENT_FACT`), so it
   * shows as "via agent" everywhere. It reads and writes only the spaces that
   * note names, and refuses everything that needs a person — defining
   * collections, roles, invites, joining or leaving, the account itself.
   * Closing it leaves this node running.
   *
   * @param agent.note The agent's note from the account home (`Grant.token` of an agent grant)
   * @throws When the note is not an agent's, has run out, or is not made out to `keys`
   */
  asAgent(agent: { readonly keys: CryptoKeyPair; readonly note: string }): Promise<P2PNode>;
  subscribe(listener: (event: NodeEvent) => void): () => void;
  close(): Promise<void>;
}
