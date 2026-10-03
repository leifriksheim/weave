/**
 * @module node/types
 * The shape of a node. Everything a method returns is JSON-serialisable on
 * purpose: the same calls cross a port, and are actions for a CLI, MCP and WebMCP.
 */
import type { MailboxClient } from '../network/mailbox.js';
import type { BodyOf, Query, ResultOf } from '../query/types.js';
import type { CollectionRules } from '../records/rules.js';
import type {
  CollectionDef,
  CryptoProvider,
  Expression,
  Link,
  SpaceRole,
  SpaceVisibility,
  StandardJSONSchemaV1,
} from '../types.js';
import type { LinkDeclaration } from '../records/links.js';
import type { RootSigner } from '../identity/root-signer.js';
import type { Capability, UCANToken } from '../identity/ucan.js';
import type { PeerTransport, SignalledTransport } from '../network/transport.js';
import type { MeshStatus } from '../network/mesh.js';
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
  /** Hosts to look for the account registry at, `https://host`: how a new device with only the recovery code finds its spaces */
  readonly hosts?: ReadonlyArray<string>;
  readonly iceServers?: ReadonlyArray<RTCIceServer>;
  /** How WebRTC connections are made; a node in a worker passes `remoteTransport`, so the page makes them */
  readonly createTransport?: (iceServers: () => ReadonlyArray<RTCIceServer>) => SignalledTransport;
  /** Extra transports per space, given this node's session DID — how a node serving sockets, or a test, plugs in */
  readonly transports?: (spaceId: string, sessionDid: string) => ReadonlyArray<PeerTransport>;
}

export interface NodeConfig {
  /** Who this node acts for. The root key only ever signs session delegations. */
  readonly signer: RootSigner;
  /** The account's vault key bytes (`deriveVaultKeyBytes(seed)`): with it, the node follows the account registry, so spaces are joined and left on every device */
  readonly accountKey?: Uint8Array;
  /** The account's contact key (`deriveContactKeyBytes(seed)`), for a node allowed to open contact requests and knocks */
  readonly contactKey?: Uint8Array;
  /** The account's contacts space, for a node given it without the account key */
  readonly contactsSpace?: string;
  /** How doors reach relays' mailboxes. Default: a WebSocket to each (`createMailboxClient`). */
  readonly mailbox?: MailboxClient;
  /** Where the registry and each space's store live */
  readonly stores: StoreFactory;
  readonly provider?: CryptoProvider;
  /** Collections this node knows the shape of, where a space does not describe them: checked on write, flagged (`conforms`) on read, never refused on arrival */
  readonly collections?: ReadonlyArray<CollectionDef>;
  /** Omit to stay offline */
  readonly network?: NodeNetworkConfig;
  /** How long each session delegation lasts. Renewed before it runs out. Default 3600. */
  readonly sessionTtlSeconds?: number;
  /** The key this node signs with, when the signer already named it (an app an account home delegated to). Default: a fresh one */
  readonly sessionKey?: CryptoKeyPair;
  /** How often to look for writes another process made to a folder store. 0 disables. Default 2000. */
  readonly watchIntervalMs?: number;
  /** Hold only the collections this node uses, once a space names a keeper to hold the rest */
  readonly cache?: CacheConfig;
}

/** How a node holds part of a space: its own choice, which nothing else depends on */
export interface CacheConfig {
  /** Collections this app uses: held from the start, and dropped last */
  readonly collections?: ReadonlyArray<string>;
  /** Drop a collection no query has touched for this many days, unless it holds writes of this node's still waiting. Default 30. */
  readonly unusedAfterDays?: number;
  /** How many keepers a write must reach before it can be dropped; only ever raises the space's own `copies` (default 2) */
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
  /** Whether this account holds a role here, and so may write, as far as this node last heard */
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
  /** The roles it starts with (`rolePresets` has some). Default: the creator alone, holding everything */
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
  /** The role whoever uses it will hold. Default: the lowest below yours, or view-only when there is none */
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
  /** A private space's key: how often it changed, and whether this device holds the current one. Null when public */
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
  /** True when an agent wrote this version for `root`, as the note it was signed under says (`AGENT_FACT`) */
  readonly viaAgent?: true;
  readonly reason?: string;
  /** Present, and true, when this version deletes the record (listed only with `includeDeleted`) */
  readonly deleted?: true;
  /**
   * Whether the body fits its collection's schema; null when there is none or
   * it could not be opened. A misfit is still kept and synced: refusing it
   * would leave peers that saw different definitions disagreeing forever.
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
  /** Where that screen may connect, when its definer allowed any (`StoredCollection.network`) */
  readonly network?: ReadonlyArray<string>;
  readonly records: number;
}

export interface DefineCollection {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** JSON Schema in the supported subset, or a validator that describes itself as one (Standard JSON Schema) */
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
  /** Exact origins that screen may connect to, each named in the app review (`StoredCollection.network`) */
  readonly network?: ReadonlyArray<string>;
}

export interface NodeCollections {
  /** What a space holds: every defined collection, and every collection with records */
  list(spaceId: string): Promise<ReadonlyArray<NodeCollection>>;
  /** Publishes a definition into the space, as a signed record that syncs like any other */
  define(spaceId: string, definition: DefineCollection): Promise<NodeCollection>;
  /** Takes a definition out of the space; refused while the collection still has records */
  delete(spaceId: string, name: string): Promise<void>;
  /** The topic tag a record with this value carries on its outside, keyed in a private space so only members can work it out */
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

/** How a space reaches its peers. `refused`: another node with the same session key holds every relay, until it stops */
export type ConnectionState = 'offline' | 'connecting' | 'connected' | 'error' | 'refused';

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
  /** The account behind the sender, proven by its session's note; null for a peer that showed none */
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
  | { readonly type: 'revoked'; readonly space: string }
  /** A relay or a connection changed (`network.status()`) */
  | { readonly type: 'network' };

/** The node's own connections, across every space: its relays, and the peers it reaches or is reaching */
export interface NodeNetwork {
  /** Where each relay and connection stands. No relays when none are configured. */
  status(): MeshStatus;
  /** Tries every relay that is waiting to reconnect, now, rather than at its next turn */
  reconnect(): void;
}

/** Who someone is in a space: the name they gave there, by their identity */
export interface SpaceProfile {
  /** Their identity — what `root` and `createdBy` on a record name */
  readonly did: string;
  readonly name: string;
  readonly updatedAt: string;
  /** The public half of their contact key, which a contact request to them is sealed with (`contacts.ask`) */
  readonly contactKey?: string;
}

export interface NodeSpaces {
  list(): Promise<ReadonlyArray<SpaceSummary>>;
  get(spaceId: string): Promise<SpaceSummary | null>;
  create(params: NewSpace): Promise<SpaceSummary>;
  /** An invite string, shown once. For a private space it carries the key, so treat it as a secret */
  invite(spaceId: string, options?: InviteOptions): Promise<string>;
  preview(invite: string): InvitePreview;
  /** Joins a space from an invite. `memberKey`, for a node without the account key, lets a new key of the space reach it */
  join(invite: string, options?: { readonly memberKey?: Uint8Array }): Promise<SpaceSummary>;
  /** Forgets a space on this node, with its key. Your role stays: `setMember` yourself to null to give it up */
  leave(spaceId: string): Promise<void>;
  /** Roles, members and invites, as the space's access history says now */
  access(spaceId: string): Promise<SpaceAccess>;
  /** Gives someone ranked below you a role, changes it, or with null takes it away */
  setMember(spaceId: string, did: string, role: string | null): Promise<void>;
  /** Adds or changes a role ranked below yours */
  putRole(spaceId: string, role: SpaceRole): Promise<void>;
  /** Removes a role ranked below yours; whoever held it holds nothing */
  removeRole(spaceId: string, name: string): Promise<void>;
  /** Closes an invite — by the link itself, or by its key from `access().invites`. Who joined with it before stays. */
  closeInvite(spaceId: string, keyOrLink: string): Promise<void>;
  /** Gives a private space a new key, as happens when someone is removed: for a lost device. Needs `manage` */
  changeKey(spaceId: string): Promise<void>;
  /** Names the relays (wss://, at most 8) the space's members meet on, whatever relays their apps use. Needs `manage` */
  setRelays(spaceId: string, relays: ReadonlyArray<string>): Promise<void>;
  /** Names the nodes that keep the space whole (at most 16), and how many a write should reach. Needs `manage` */
  setKeepers(spaceId: string, keepers: ReadonlyArray<Keeper>, copies?: number | null): Promise<void>;
  /** Revokes a note this account signed: nothing written under it counts from then on, except what was seen */
  revoke(spaceId: string, token: string): Promise<void>;
  /** Keeps a space syncing until the function it returns is called; it stops once nothing holds it */
  hold(spaceId: string): Promise<() => Promise<void>>;
  /** A live message to the peers connected now, kept nowhere, at most 64 KB; `to` an account or a session DID. Arrives as a `message` event */
  send(spaceId: string, message: unknown, to?: string): Promise<void>;
  status(spaceId: string): Promise<SpaceStatus>;
  /** How a node serving this space checks connecting peers and signs its welcome; null for a space it does not hold */
  authenticator(spaceId: string): Promise<ServerAuth | null>;
  /** The name each person gave in this space, by identity; yours is published from the account's name */
  profiles(spaceId: string): Promise<ReadonlyArray<SpaceProfile>>;
}

export interface NodeRecords {
  /** Current versions, oldest record first; deleted records only with `includeDeleted` */
  list<T = unknown>(spaceId: string, options?: ListOptions): Promise<ReadonlyArray<NodeRecord<T>>>;
  /** A record's current version, or null when there is none or it was deleted */
  get<T = unknown>(spaceId: string, key: string): Promise<NodeRecord<T> | null>;
  /** Creates a record, under a random key unless given. Writing a deleted key brings it back */
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
  update<T = unknown>(
    spaceId: string,
    key: string,
    body: T,
    options?: { links?: ReadonlyArray<Link> },
  ): Promise<NodeRecord<T>>;
  /** The records whose current version points at this one — optionally in one role, or one collection */
  linked<T = unknown>(
    spaceId: string,
    key: string,
    options?: { rel?: string; collection?: string },
  ): Promise<ReadonlyArray<NodeRecord<T>>>;
  /** Deletes a record everywhere, by writing a version marked deleted */
  delete(spaceId: string, key: string): Promise<void>;
  /** The versions of a record kept here, newest first: current and first, and every other with `history: 'all'` */
  history<T = unknown>(spaceId: string, key: string): Promise<ReadonlyArray<NodeRecord<T>>>;
  /** Whether this account may `create` in a collection (`target` its name), or `edit` / `delete` a record (`target` its key) */
  can(spaceId: string, action: 'create' | 'edit' | 'delete', target: string): Promise<boolean>;
  /**
   * Records matching a query, typed when it names a collection by its definition.
   * @throws When the query is malformed, saying what to fix
   */
  query<const Q extends Query>(spaceId: string, query: Q): Promise<ResultOf<Q>>;
  /** Runs a query now and whenever the space's records change; returns a function that stops it */
  watch<const Q extends Query>(
    spaceId: string,
    query: Q,
    onResult: (result: ResultOf<Q>) => void,
    onError?: (error: Error) => void,
  ): () => void;
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

/** Nodes that keep the account's spaces online without reading them (`space/pass.ts`). Needs the account key */
export interface NodeCarriers {
  list(): Promise<ReadonlyArray<CarrierSummary>>;
  /** Starts using a carrier: a carry space with a pass for every space, kept current by every device. Its invite is the carrier's */
  add(carrier: {
    readonly did: string;
    readonly name: string;
  }): Promise<{ readonly space: string; readonly invite: string }>;
  /** Stops using a carrier: its passes go, and it is told to forget what it held */
  remove(space: string): Promise<void>;
}

/** A subscription, as the person made it (`space/notify.ts`) */
export interface NotifyView extends NotifyWhen {
  readonly id: string;
}

/** "Let me know when…": noticed by the account's carriers, which get each value as a topic tag. Needs the account key */
export interface NodeNotifications {
  list(): Promise<ReadonlyArray<NotifyView>>;
  /** Starts one; `topic` matches exact values of a topic field: `{ field: 'mentions', value: myDid }` */
  add(when: Omit<NotifyWhen, 'since'> & { readonly since?: string }): Promise<NotifyView>;
  /** Changes its label, pauses or resumes it */
  update(id: string, changes: { readonly label?: string; readonly paused?: boolean }): Promise<NotifyView>;
  remove(id: string): Promise<void>;
  /** Every version of these subscriptions, signed, for another device of the account to `take` */
  versions(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Expression>>;
  /** Takes in subscriptions handed over outside sync, checked as a peer's. How many were new */
  take(versions: ReadonlyArray<Expression>): Promise<number>;
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
  /** How the subscription stands, as the host signed it: now when `live`, else the last it said */
  readonly status: import('../session/hosting.js').HostStatus | null;
  /** Whether `status` is what the host said just now */
  readonly live: boolean;
  /** Why it could not be reached */
  readonly error?: string;
  /** Its plans an account may pay with, from its description; none when it takes no payments or can't be reached */
  readonly plans: ReadonlyArray<import('../session/hosting.js').HostPlan>;
  /** Whether it sends reminders by email (`remind`) */
  readonly reminds: boolean;
}

/**
 * Hosts: carriers the account pays for, online when every device is off. A
 * device never handles a payment (spec/06-nodes-and-sessions.md, Hosts).
 */
export interface NodeHosting {
  /** The hosts the account uses, each asked how it stands. Hands a host the spaces if it was paid since. */
  list(): Promise<ReadonlyArray<HostingView>>;
  /** Starts using a host: a subscription key every device signs as, and the spaces once it is paid */
  use(url: string): Promise<HostingView>;
  /** Starts paying a host with one of its plans: a `checkout` page to open (`noopener`), or a `request` for a wallet */
  pay(url: string, plan: string): Promise<import('../session/hosting.js').PayAnswer>;
  /** The payment provider's page for changing a card or cancelling it, as a `checkout` answer */
  manage(url: string): Promise<import('../session/hosting.js').PayAnswer>;
  /** Asks a host for reminders by email before paid time runs out; it mails a link to confirm first */
  remind(url: string, email: string): Promise<void>;
  /** Stops using a host: it forgets the spaces, and the subscription is let go. Cancel a card that renews first (`manage`). */
  stop(url: string): Promise<void>;
  /** The hosts a space pays (`std.host`), each asked how its subscription stands; hands one the pass once paid */
  space(spaceId: string): Promise<ReadonlyArray<SpaceHostingView>>;
  /** Starts adding to a space's fund at one of the hosts it names: an amount, once or monthly. Anyone in it may. */
  payForSpace(
    spaceId: string,
    url: string,
    payment: import('../session/hosting.js').FundPayment,
  ): Promise<import('../session/hosting.js').PayAnswer>;
  /** Asks a host a space names for reminders by email before the space's paid time runs out */
  remindForSpace(spaceId: string, url: string, email: string): Promise<void>;
  /**
   * Stops a space using a host: its `std.host` record goes, and with `manage`
   * its bots are removed and a private space gets a new key. Nothing is asked
   * of the host.
   */
  stopForSpace(
    spaceId: string,
    url: string,
  ): Promise<{
    /** The bots removed from the space, by DID */
    readonly bots: ReadonlyArray<string>;
    /** Whether the space's key changes because of it */
    readonly newKey: boolean;
  }>;
  /** Asks a host the space names to run a bot there, joining with an invite for `role`; removing the bot stops it */
  startBot(
    spaceId: string,
    url: string,
    bot: { readonly name: string; readonly role?: string },
  ): Promise<{ readonly bot: string; readonly status: import('../session/hosting.js').HostStatus }>;
}

/** A host a space pays for itself, as `hosting.space` sees it */
export interface SpaceHostingView {
  readonly url: string;
  /** Its name, as the space or the host gives it */
  readonly name: string;
  /** The host's key; null when it could not be reached */
  readonly host: string | null;
  /** How the space's subscription stands there, signed by the host; null when it could not be asked */
  readonly status: import('../session/hosting.js').HostStatus | null;
  /** Whether it keeps spaces for nothing: every subscription counts as paid there */
  readonly free: boolean;
  /** How the space's fund is added to there, by anyone in it; null on a free host, and on one that takes no communities */
  readonly fund: import('../session/hosting.js').FundOffer | null;
  /** Whether it sends reminders by email (`remindForSpace`) */
  readonly reminds: boolean;
  /** Whether it runs bots for the spaces it carries (`startBot`) */
  readonly runsBots: boolean;
  /** The bots it runs in this space, and whether each is running, as its signed status says */
  readonly bots: ReadonlyArray<import('../session/hosting.js').HostedBot>;
  /** Why it could not be asked, when it couldn't */
  readonly error?: string;
}

export interface NodeAccount {
  /** The account's profile as its devices last set it. Null without an account key, or before any is set. */
  profile(): Promise<AccountProfileView | null>;
  /** Renames the account on every device and app that opens it. Needs an account key. */
  setName(name: string): Promise<AccountProfileView>;
  /** Revokes a note this account signed in the account registry. Needs an account key */
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

/** The account's contacts: each a private space for two, listed in the account's contacts space. Knowing a DID reaches nothing */
export interface NodeContacts {
  /** The contacts space's id — null for a node not given it */
  space(): Promise<string | null>;
  /** Everyone in the list, blocked people too, by name */
  list(): Promise<ReadonlyArray<ContactView>>;
  get(did: string): Promise<ContactView | null>;
  /** Adds someone, or changes what the list says about them */
  put(contact: {
    readonly did: string;
    readonly name: string;
    readonly space?: string | null;
    readonly note?: string;
  }): Promise<ContactView>;
  /** Takes them off the list and leaves your space for two. Nobody else's space is touched. */
  remove(did: string): Promise<void>;
  /** Leaves your space for two, and hides their contact requests from now on */
  block(did: string): Promise<void>;
  /** Asks someone in a space you share to add you: a space for two, its invite sealed to their contact key and posted there */
  ask(
    spaceId: string,
    did: string,
    options?: { readonly note?: string },
  ): Promise<{ readonly space: string; readonly request: string }>;
  /** Contact requests sent to this account in a space, opened — not from people blocked, and not ones already accepted */
  requests(spaceId: string): Promise<ReadonlyArray<ContactRequest>>;
  /** Joins the space for two a request invites you to, and puts whoever asked on your list */
  accept(spaceId: string, requestKey: string): Promise<ContactView>;
  /** Accounts in your space for two besides the two of you: whoever the invite was passed on to */
  others(did: string): Promise<ReadonlyArray<string>>;
}

/** A direct message, opened (`node.direct`) */
export interface DirectMessage {
  /** The record's key: delete it to take the message back */
  readonly key: string;
  /** Who wrote it */
  readonly from: string;
  /** Who it is for, sorted, not counting `from` */
  readonly to: ReadonlyArray<string>;
  /** Null when this node can't open it: its member key here isn't the one it was sealed to */
  readonly text: string | null;
  readonly createdAt: string;
  readonly viaAgent?: true;
}

/** Direct messages: text sealed to some members' member keys, in a private space (`docs/direct-messages.md`) */
export interface NodeDirect {
  /** Who in the space can be written to: members who have published a member key, not you */
  reachable(spaceId: string): Promise<ReadonlyArray<string>>;
  /** Seals text for these members and you, and writes it. Defines `std.direct` first when the space lacks it and you may. */
  send(spaceId: string, to: ReadonlyArray<string>, text: string): Promise<DirectMessage>;
  /** Every direct message in the space written by or to this account, oldest first */
  list(spaceId: string): Promise<ReadonlyArray<DirectMessage>>;
}

/** A door of this account's, as `node.doors` shows it */
export interface DoorView {
  readonly id: string;
  /** What you call it — only you see it */
  readonly label?: string;
  /** The name its code gives whoever knocks */
  readonly name?: string;
  /** The door key's public half: knocks are sealed to it */
  readonly key: string;
  /** The door's signing key's public half: its hash is the door's mailbox topic */
  readonly sign: string;
  readonly relays: ReadonlyArray<string>;
  /** The door code to hand out: put it in a link (`#door=…`) or a QR code */
  readonly code: string;
  readonly createdAt: string;
}

/** Someone knocking on one of your doors, checked and opened */
export interface KnockView {
  /** The knock's id, the same on every relay: what `accept` takes */
  readonly id: string;
  /** Which of your doors */
  readonly door: string;
  /** Their account — proven by their signature and note, not by what they say */
  readonly from: string;
  /** The name they give; nothing vouches for it */
  readonly name: string;
  readonly note?: string;
  /** The space for two it invites you to */
  readonly pairSpace: string;
  /** When they knocked, ISO */
  readonly at: string;
}

/** A knock you left, waiting for them to open it */
export interface SentKnockView {
  /** The space for two you made */
  readonly space: string;
  /** The name their door code gave */
  readonly name: string;
  readonly at: string;
}

/** Doors: how people you share no space with ask to become your contact, without your DID becoming an address (`spec/07-doors.md`) */
export interface NodeDoors {
  /** Your open doors */
  list(): Promise<ReadonlyArray<DoorView>>;
  /** Opens a new door: `relays` hold its knocks (1–3), `name` its code gives (default: the account's) */
  open(options?: {
    readonly relays?: ReadonlyArray<string>;
    readonly name?: string;
    readonly label?: string;
  }): Promise<DoorView>;
  /** Closes a door: its knocks are no longer read, and its code leads nowhere */
  close(id: string): Promise<void>;
  /** Clears every knock waiting at a door — one someone flooded — without closing it */
  clear(id: string): Promise<void>;
  /** Knocks on a door (a code or a link): a space for two, its invite left in their mailboxes until they answer or two weeks pass */
  knock(code: string, options?: { readonly note?: string }): Promise<{ readonly space: string }>;
  /** Knocks waiting at your doors, checked; also turns your answered knocks into contacts */
  knocks(): Promise<ReadonlyArray<KnockView>>;
  /** Knocks you left that nobody has answered yet */
  sent(): Promise<ReadonlyArray<SentKnockView>>;
  /** Joins the space for two a knock invites you to; your answer, signed with the door's key, is written once you are in */
  accept(id: string): Promise<ContactView>;
  /** Lets a knock go without blocking whoever knocked: cleared from the door's relays, on every device */
  dismiss(id: string): Promise<void>;
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
  /** Direct messages: text only some members of a space can read */
  readonly direct: NodeDirect;
  /** Doors: how people you share no space with can ask to become your contact */
  readonly doors: NodeDoors;
  /** The delegation the session key currently writes under (root → session) */
  delegation(): UCANToken;
  /** ICE servers for the app's own WebRTC, like a call's: the configured ones, and a relay's TURN servers */
  iceServers(): Promise<ReadonlyArray<RTCIceServer>>;
  /** Relays and connections, for showing why a peer is or is not there */
  readonly network: NodeNetwork;
  /** Passes a narrower delegation from the session key on to another key */
  delegate(params: DelegateParams): Promise<Delegated>;
  /**
   * The same node acting as an agent: signed "via agent", only in the spaces
   * its note names, refusing what needs a person (`node/api.ts`).
   * @throws When the note is not an agent's, has run out, or is not made out to `keys`
   */
  asAgent(agent: { readonly keys: CryptoKeyPair; readonly note: string }): Promise<P2PNode>;
  subscribe(listener: (event: NodeEvent) => void): () => void;
  close(): Promise<void>;
}
