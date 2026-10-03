/**
 * Who may do what in a space: its roles, its members, its invites, and the
 * history of changes to them — replayed the same way on every peer.
 *
 * This module knows people and permissions. It knows nothing about polls or
 * todos: a collection's rules name a permission (`can:moderate`), and this
 * module answers one question about it — *does this account hold that
 * permission here, as of this point in the space's history?*
 *
 * **Roles.** A role is a name, a rank and a list of permissions. Permissions
 * are plain strings: three the protocol checks itself (`manage`, `invite`,
 * `define`) and whatever the collections in the space declare
 * (`app.poll/moderate`). A `*` in a role's permission matches any run of
 * characters, so `*` alone is every permission.
 *
 * **Rank.** You may change people and roles ranked below you, and give out
 * roles up to your own rank. Two people at the same rank can never remove each
 * other — only themselves.
 *
 * **The access history.** Every change to a role, a member, an invite, a
 * revoked note or a collection definition is a record whose `seen` names the
 * latest changes its author knew of. That makes a small graph. Replaying it:
 *
 * 1. A change comes after everything it saw.
 * 2. Changes that did not see each other go in this order: ones that take
 *    something away first — counting everything on the way to one, so a
 *    removal that also saw something else still comes first — then the
 *    author with the higher rank, then the lower id.
 * 3. A change counts only if its author had the power — both as of what they
 *    had seen, and at its turn in the replay. Of two changes to the same thing
 *    that did not see each other, the first in the replay wins.
 *
 * Everything here is pure and synchronous: the runtime checks signatures,
 * opens bodies and verifies invite signatures, and hands over plain events.
 */

import type { SpaceRole } from '../types.js';
import { isObject } from '../utils/guards.js';

/** A role, as a space defines it */
export type Role = SpaceRole;

/** The permissions the protocol checks itself. Every other one belongs to a collection. */
export const MANAGE = 'manage';
export const INVITE = 'invite';
export const DEFINE = 'define';

export const ROLE_COLLECTION = 'sys.role';
export const MEMBER_COLLECTION = 'sys.member';
export const INVITE_COLLECTION = 'sys.invite';
export const REVOKE_COLLECTION = 'sys.revoke';
/** Collection definitions are part of the access history too: they decide what a rule asks for */
export const DEFINITION_COLLECTION = 'sys.collection';
/**
 * A private space's key changes: the new key's id and public read key. The
 * key itself travels sealed to each member (`sys.box`); this record only says
 * which key is current, so a peer without any key can still check readers.
 */
export const KEY_COLLECTION = 'sys.key';
/**
 * Where the space's members meet: the relays it names, so two people whose
 * apps use different relays still find each other. Like a Nostr relay list,
 * but the space's, and changed only by someone who manages it.
 */
export const RELAYS_COLLECTION = 'sys.relays';
/**
 * Who keeps the space whole: nodes that hold every record of it — a host, an
 * extension — and how many copies a write should reach before a node that
 * holds only part of the space lets go of it. Changed only by someone who
 * manages the space, like its relays.
 */
export const KEEPERS_COLLECTION = 'sys.keepers';

/** Every collection whose records are part of the access history */
export const ACCESS_COLLECTIONS: ReadonlySet<string> = new Set([
  ROLE_COLLECTION,
  MEMBER_COLLECTION,
  INVITE_COLLECTION,
  REVOKE_COLLECTION,
  DEFINITION_COLLECTION,
  KEY_COLLECTION,
  RELAYS_COLLECTION,
  KEEPERS_COLLECTION,
]);

const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Why a role is malformed, or null */
export function checkRole(role: unknown): string | null {
  if (!isObject(role)) return 'A role must be an object';
  const r = role;
  if (typeof r.name !== 'string' || !ROLE_NAME_PATTERN.test(r.name))
    return 'A role name is 1–40 characters of a–z, 0–9 and . _ -';
  if (r.title !== undefined && (typeof r.title !== 'string' || r.title.length > 80))
    return 'A role title is text of at most 80 characters';
  if (typeof r.rank !== 'number' || !Number.isFinite(r.rank)) return 'A role rank must be a number';
  if (
    !Array.isArray(r.permissions) ||
    !r.permissions.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 200)
  ) {
    return "A role's permissions must be a list of names";
  }
  return null;
}

/** Whether a role's permission (which may hold `*`) matches a permission */
export function permissionMatches(pattern: string, permission: string): boolean {
  if (pattern === permission || pattern === '*') return true;
  if (!pattern.includes('*')) return false;
  const regex = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
      .join('.*')}$`,
  );
  return regex.test(permission);
}

/** Whether a role holds a permission */
export function roleHolds(role: Role | null | undefined, permission: string): boolean {
  return !!role && role.permissions.some((pattern) => permissionMatches(pattern, permission));
}

/**
 * Whether someone holding `granted` may hand out `permission`: one of theirs
 * must cover it. A `*` in theirs matches anything, including a `*`.
 */
function covers(granted: ReadonlyArray<string>, permission: string): boolean {
  return granted.some((pattern) => permissionMatches(pattern, permission));
}

// ─── Events ───────────────────────────────────────────────────────────

interface EventBase {
  readonly id: string;
  /** The record key it changes: `role:moderator`, `member:…`, `invite:…`, `revoke:…`, `collection:…` */
  readonly key: string;
  /** The account behind the key that signed it */
  readonly root: string;
  /** The latest access changes its author knew of */
  readonly seen: ReadonlyArray<string>;
  /** Records by the people this takes power from, that the author had seen and that stay */
  readonly keep: ReadonlyArray<string>;
}

export type AccessEvent = EventBase &
  (
    | {
        readonly kind: 'role';
        readonly name: string;
        /** Null: the role is removed */ readonly role: Role | null;
      }
    | {
        readonly kind: 'member';
        readonly did: string;
        /** Null: they are no longer a member */
        readonly role: string | null;
        /** The invite's public key, when the runtime checked the invite's signature on this record */
        readonly viaInvite?: string;
      }
    | { readonly kind: 'invite'; readonly inviteKey: string; readonly role: string; readonly open: boolean }
    | {
        readonly kind: 'revoke';
        /** The note's CID */ readonly note: string;
        /** Who signed the note */ readonly issuer: string;
      }
    | { readonly kind: 'definition'; readonly name: string; readonly deleted: boolean }
    | {
        readonly kind: 'key';
        /** The new key's id: the hash of its bytes, as encrypted bodies name it */
        readonly keyId: string;
        /** The public half of the read key derived from it, which readers prove they hold */
        readonly readKey: string;
      }
    | {
        readonly kind: 'relays';
        /** WebSocket URLs, at most `MAX_RELAYS` */ readonly relays: ReadonlyArray<string>;
      }
    | {
        readonly kind: 'keepers';
        /** Nodes that keep the space whole, at most `MAX_KEEPERS` */
        readonly keepers: ReadonlyArray<Keeper>;
        /** How many keepers a write should reach before a partial node lets go of it; null for the default */
        readonly copies: number | null;
      }
  );

/** A node that keeps a space whole: its key, as it appears to peers, and a name for people */
export interface Keeper {
  readonly did: string;
  readonly name: string;
}

/** How many keepers a space may name */
export const MAX_KEEPERS = 16;

/** Why a list of keepers can't be a space's, or null */
export function checkKeepers(keepers: unknown, copies: unknown = null): string | null {
  if (!Array.isArray(keepers) || keepers.length > MAX_KEEPERS)
    return `A space names at most ${MAX_KEEPERS} keepers`;
  const list: unknown[] = keepers;
  const dids = new Set<string>();
  for (const keeper of list) {
    if (
      !isObject(keeper) ||
      typeof keeper.did !== 'string' ||
      !keeper.did.startsWith('did:key:') ||
      keeper.did.length > 200
    )
      return 'A keeper is named by its did:key';
    if (typeof keeper.name !== 'string' || keeper.name.length > 80)
      return 'A keeper has a name of at most 80 characters';
    dids.add(keeper.did);
  }
  if (dids.size !== list.length) return 'A keeper is named twice';
  if (
    copies !== null &&
    !(typeof copies === 'number' && Number.isSafeInteger(copies) && copies >= 1 && copies <= MAX_KEEPERS)
  ) {
    return `Copies is a whole number from 1 to ${MAX_KEEPERS}`;
  }
  return null;
}

/** How many relays a space may name */
export const MAX_RELAYS = 8;

/** Why a list of relays can't be a space's, or null */
export function checkRelays(relays: unknown): string | null {
  if (!Array.isArray(relays) || relays.length > MAX_RELAYS)
    return `A space names at most ${MAX_RELAYS} relays`;
  for (const url of relays) {
    if (typeof url !== 'string' || url.length > 200) return 'A relay is a URL of at most 200 characters';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `"${url}" is not a URL`;
    }
    // Plain ws:// only on this machine: anywhere else it would show the room to everyone on the way.
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && local))
      return `"${url}" is not a wss:// relay`;
  }
  return new Set(relays).size === relays.length ? null : 'A relay is named twice';
}

/** One of a private space's keys, as the history names it */
export interface SpaceKeyEpoch {
  readonly keyId: string;
  readonly readKey: string;
  /** The change that made it current; the space id for the key it started with */
  readonly event: string;
}

/** Who holds what, at one point in the history */
export interface AccessState {
  readonly roles: ReadonlyMap<string, Role>;
  /** Account DID → role name */
  readonly members: ReadonlyMap<string, string>;
  /** Invite public key → its role, and whether it is open */
  readonly invites: ReadonlyMap<
    string,
    { readonly role: string; readonly open: boolean; readonly event: string }
  >;
  /** Collection name → the id of the definition in force, and who first defined it */
  readonly definitions: ReadonlyMap<string, { readonly event: string; readonly definedBy: string }>;
  /** A private space's keys, oldest first; the last is current. Empty in a public space. */
  readonly keys: ReadonlyArray<SpaceKeyEpoch>;
  /** Whether someone lost their place in the space since the current key — so a new one is due */
  readonly keyDue: boolean;
  /** The relays the space names — empty until someone who manages it names some */
  readonly relays: ReadonlyArray<string>;
  /** The nodes that keep the space whole — empty until someone who manages it names some */
  readonly keepers: ReadonlyArray<Keeper>;
  /** How many keepers a write should reach; null for whatever each node defaults to */
  readonly copies: number | null;
}

/** What a space starts with, from its genesis */
export interface AccessGenesis {
  /** The space id — also the id every change implicitly comes after */
  readonly id: string;
  readonly creator: string;
  readonly roles: ReadonlyArray<Role>;
  readonly creatorRole: string;
  /** A private space's first key, from its genesis */
  readonly key?: { readonly keyId: string; readonly readKey: string };
}

export type EventStatus =
  | { readonly status: 'applied'; readonly index: number }
  | { readonly status: 'dropped'; readonly reason: string }
  | { readonly status: 'waiting' };

/** How one change took power from one person: their role before and after */
interface Reduction {
  readonly event: string;
  readonly did: string;
  readonly before: Role | null;
  readonly after: Role | null;
}

export type RecordVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly later?: boolean;
      /**
       * Allowed when written, and refused only because a later change took
       * its author's access away or revoked its note. It is kept, so a
       * version that cites it, and had not seen that change, can count it.
       */
      readonly withdrawn?: true;
    };

export interface AccessHistory {
  /** Who holds what once everything held is replayed */
  readonly current: AccessState;
  /** What became of one change */
  status(id: string): EventStatus | null;
  /** The latest changes — what a new record's `seen` names */
  heads(): ReadonlyArray<string>;
  /** The state as of what `seen` names, or null when some of it is not here */
  at(seen: ReadonlyArray<string>): AccessState | null;
  /**
   * Whether a record stands: its author's standing, as of what it saw, must
   * satisfy `needs`; and no later change it had not seen took that away —
   * unless that change kept it.
   * @param record The record's id, its account, what it saw, and the note it was written under
   * @param needs What the record requires of its author's role
   * @param within For a version another cites: what the citing version saw.
   *   Only changes among those, and what they saw, can take it away.
   */
  judge(
    record: {
      readonly id: string;
      readonly root: string;
      readonly seen: ReadonlyArray<string>;
      readonly note?: string;
    },
    needs: (role: Role | null, state: AccessState) => boolean,
    within?: ReadonlyArray<string>,
  ): RecordVerdict;
  /** The applied change that revoked a note, if any */
  revoked(note: string): { readonly event: string; readonly keep: ReadonlySet<string> } | null;
  /**
   * Whether an account appears anywhere in the history — the creator, or
   * named by any member change, whatever became of it. Only grows as changes
   * arrive, so it can decide what to store without two peers ever disagreeing
   * for good.
   */
  named(did: string): boolean;
  /** Whether any change held opens an invite with this key */
  knownInvite(inviteKey: string): boolean;
  /**
   * The history with one more change, made without replaying the rest:
   * exactly what `replayAccess` with every change held and this one gives.
   * Null when only a whole replay can say where it goes — it did not see
   * every change here, or it could change an order already chosen. This
   * history stays as it was.
   */
  extend(event: AccessEvent): AccessHistory | null;
}

/** A role's standing as rank; below everyone when there is none */
const rankOf = (role: Role | null | undefined) => (role ? role.rank : -Infinity);

interface MutableState {
  roles: Map<string, Role>;
  members: Map<string, string>;
  invites: Map<string, { role: string; open: boolean; event: string }>;
  definitions: Map<string, { event: string; definedBy: string }>;
  keys: SpaceKeyEpoch[];
  keyDue: boolean;
  relays: ReadonlyArray<string>;
  keepers: ReadonlyArray<Keeper>;
  copies: number | null;
}

function startState(genesis: AccessGenesis): MutableState {
  return {
    roles: new Map(genesis.roles.map((role) => [role.name, role])),
    members: new Map([[genesis.creator, genesis.creatorRole]]),
    invites: new Map(),
    definitions: new Map(),
    keys: genesis.key ? [{ ...genesis.key, event: genesis.id }] : [],
    keyDue: false,
    relays: [],
    keepers: [],
    copies: null,
  };
}

function cloneState(state: MutableState): MutableState {
  return {
    ...state,
    roles: new Map(state.roles),
    members: new Map(state.members),
    invites: new Map(state.invites),
    definitions: new Map(state.definitions),
    keys: [...state.keys],
  };
}

/** Everyone holding a role that exists — who can read, as far as the history is concerned */
export function readers(state: AccessState): Set<string> {
  return new Set([...state.members].filter(([, role]) => state.roles.has(role)).map(([did]) => did));
}

function roleOf(state: AccessState, did: string): Role | null {
  const name = state.members.get(did);
  return name === undefined ? null : (state.roles.get(name) ?? null);
}

/** Whether an account holds a permission in a state */
export function holds(state: AccessState, did: string, permission: string): boolean {
  return roleHolds(roleOf(state, did), permission);
}

/** The role an account holds in a state, or null */
export function standing(state: AccessState, did: string): Role | null {
  return roleOf(state, did);
}

/** Whether a change takes something away — those go first among changes that did not see each other */
function takesAway(event: AccessEvent, state: AccessState): boolean {
  switch (event.kind) {
    case 'revoke':
      return true;
    case 'invite':
      return !event.open;
    case 'member': {
      if (event.role === null) return true;
      const before = roleOf(state, event.did);
      const after = state.roles.get(event.role) ?? null;
      return !!before && rankOf(after) < before.rank;
    }
    case 'role': {
      const before = state.roles.get(event.name);
      if (!before) return false;
      if (event.role === null) return true;
      return (
        event.role.rank < before.rank || before.permissions.some((p) => !event.role!.permissions.includes(p))
      );
    }
    case 'definition':
    case 'key':
    case 'relays':
    case 'keepers':
      return false;
  }
}

/**
 * Whether a change could take something away, judged from the change alone —
 * for changes not yet placed, whose effect depends on a state not reached yet.
 * Changing someone else's role, or any role, might lower it.
 */
function mayTakeAway(event: AccessEvent): boolean {
  switch (event.kind) {
    case 'revoke':
      return true;
    case 'invite':
      return !event.open;
    case 'member':
      return event.role === null || (event.root !== event.did && event.viaInvite === undefined);
    case 'role':
      return true;
    case 'definition':
    case 'key':
    case 'relays':
    case 'keepers':
      return false;
  }
}

/**
 * Why a change is not allowed in a state, or null when it is. The one place
 * the rank rule lives.
 */
function refusal(event: AccessEvent, state: AccessState): string | null {
  const author = roleOf(state, event.root);
  switch (event.kind) {
    case 'role': {
      if (!roleHolds(author, MANAGE)) return 'Its author may not manage roles';
      const existing = state.roles.get(event.name);
      if (existing && existing.rank >= author!.rank)
        return 'Its author may only change roles ranked below their own';
      if (!event.role) return existing ? null : 'There is no such role to remove';
      if (event.role.rank >= author!.rank) return 'Its author may only make roles ranked below their own';
      const missing = event.role.permissions.find((p) => !covers(author!.permissions, p));
      return missing ? `Its author cannot give a permission they do not hold (${missing})` : null;
    }
    case 'member': {
      const current = roleOf(state, event.did);
      // Joining with an invite: your own record, for the invite's role, while not a member.
      if (event.viaInvite !== undefined) {
        const invite = state.invites.get(event.viaInvite);
        if (event.root !== event.did) return 'Only the person joining can use an invite for themselves';
        if (!invite?.open) return 'The invite is not open';
        if (invite.role !== event.role) return 'The invite is for another role';
        if (current) return 'Already a member';
        return state.roles.has(invite.role) ? null : "The invite's role no longer exists";
      }
      // Leaving: anyone may remove themselves.
      if (event.root === event.did && event.role === null) return current ? null : 'Not a member';
      if (!roleHolds(author, MANAGE)) return 'Its author may not manage members';
      if (current && current.rank >= author!.rank)
        return 'Its author may only change people ranked below them';
      if (event.role === null) return current ? null : 'Not a member';
      const next = state.roles.get(event.role);
      if (!next) return `There is no role "${event.role}"`;
      return next.rank > author!.rank ? 'Its author may only give roles up to their own rank' : null;
    }
    case 'invite': {
      if (!roleHolds(author, INVITE)) return 'Its author may not make invites';
      const existing = state.invites.get(event.inviteKey);
      if (existing) {
        const was = state.roles.get(existing.role);
        if (was && was.rank > author!.rank) return 'Its author may only change invites up to their own rank';
      }
      if (!event.open) return existing ? null : 'There is no such invite to close';
      const role = state.roles.get(event.role);
      if (!role) return `There is no role "${event.role}"`;
      return role.rank > author!.rank ? 'Its author may only invite up to their own rank' : null;
    }
    case 'revoke':
      return event.root === event.issuer ? null : 'Only whoever signed a note may revoke it';
    case 'definition': {
      const existing = state.definitions.get(event.name);
      if (!existing) return roleHolds(author, DEFINE) ? null : 'Its author may not define collections';
      // Changing one: whoever first defined it, while a member, or anyone who manages the space.
      if (roleHolds(author, MANAGE)) return null;
      return author && existing.definedBy === event.root
        ? null
        : 'Only whoever defined it, or someone who manages the space, may change it';
    }
    case 'key': {
      if (state.keys.length === 0) return 'A public space has no key to change';
      if (!roleHolds(author, MANAGE)) return "Its author may not change the space's key";
      // Going back to a key a removed member still holds would undo the point of changing it.
      return state.keys.some((known) => known.keyId === event.keyId || known.readKey === event.readKey)
        ? 'That key was used before'
        : null;
    }
    case 'relays':
      return roleHolds(author, MANAGE)
        ? checkRelays(event.relays)
        : 'Its author may not change where the space meets';
    case 'keepers':
      return roleHolds(author, MANAGE)
        ? checkKeepers(event.keepers, event.copies)
        : 'Its author may not change who keeps the space';
  }
}

/** The people whose standing a change may lower — for keep lists */
function affected(event: AccessEvent, state: AccessState): ReadonlyArray<string> {
  if (event.kind === 'member') return [event.did];
  if (event.kind === 'role')
    return [...state.members].filter(([, role]) => role === event.name).map(([did]) => did);
  return [];
}

function apply(event: AccessEvent, state: MutableState): void {
  const lost = losesReader(event, state);
  change(event, state);
  if (event.kind === 'key') state.keyDue = false;
  else if (state.keys.length > 0 && lost) state.keyDue = true;
}

/**
 * Whether a change, about to be made, leaves someone who could read unable
 * to: the same as comparing `readers` before and after, without building
 * them. Only a member change, for that member, or a removed role, for whoever
 * holds it, can.
 */
function losesReader(event: AccessEvent, state: AccessState): boolean {
  if (event.kind === 'member') {
    const was = state.members.get(event.did);
    if (was === undefined || !state.roles.has(was)) return false;
    return event.role === null || !state.roles.has(event.role);
  }
  if (event.kind === 'role' && event.role === null && state.roles.has(event.name)) {
    for (const role of state.members.values()) if (role === event.name) return true;
  }
  return false;
}

function change(event: AccessEvent, state: MutableState): void {
  switch (event.kind) {
    case 'role':
      if (event.role) state.roles.set(event.name, event.role);
      else state.roles.delete(event.name);
      return;
    case 'member':
      if (event.role === null) state.members.delete(event.did);
      else state.members.set(event.did, event.role);
      return;
    case 'invite':
      state.invites.set(event.inviteKey, { role: event.role, open: event.open, event: event.id });
      return;
    case 'revoke':
      return;
    case 'definition': {
      if (event.deleted) {
        state.definitions.delete(event.name);
        return;
      }
      const definedBy = state.definitions.get(event.name)?.definedBy ?? event.root;
      state.definitions.set(event.name, { event: event.id, definedBy });
      return;
    }
    case 'key':
      state.keys.push({ keyId: event.keyId, readKey: event.readKey, event: event.id });
      return;
    case 'relays':
      state.relays = [...event.relays];
      return;
    case 'keepers':
      state.keepers = event.keepers.map((k) => ({ did: k.did, name: k.name }));
      state.copies = event.copies;
      return;
  }
}

/**
 * The changes one change saw, directly or not, by the place each was given
 * in the replay: every one placed before `prefix`, and those in `extra`.
 * Changes are placed after everything they saw, so in a history without
 * much concurrency `extra` stays empty and this is one number, where a set
 * of ids would grow with the history.
 */
interface Ancestry {
  readonly prefix: number;
  readonly extra: ReadonlySet<number>;
}

const NONE: ReadonlySet<number> = new Set();

/** How the replay orders changes ready at once: lowest first */
type PriorityKey = readonly [number, number, number, string];

const comesFirst = (a: PriorityKey, b: PriorityKey) =>
  a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] !== b[2] ? a[2] < b[2] : a[3] < b[3];

/**
 * A point in the replay where more than one change was ready, and a change
 * that saw them all could still make it choose differently.
 *
 * Such a change leads on from every one of them, so if it may take
 * something away it lowers each one's first key to at most `e`, minus its
 * author's rank then. With `e` above the chosen change's first key the
 * choice stands. With `e` at or below it, every first key becomes `e`, and
 * the rest of the keys decide alone, the same way whatever `e` is. So a
 * choice is kept only when the rest of the keys would choose differently,
 * and `bound` is the chosen change's first key: an author whose `-rank` is
 * at most that, then, could reorder what is placed.
 */
interface Choice {
  /** How many changes had been applied: the state the choice was made in */
  readonly applied: number;
  readonly bound: number;
}

/** Everything a replay knows. Never changed once a history is handed out: `extend` copies it. */
interface Replay {
  readonly genesis: AccessGenesis;
  readonly byId: Map<string, AccessEvent>;
  readonly waiting: Set<string>;
  /** What the waiting changes saw: the arrivals that could let one be placed */
  readonly waitingFor: Set<string>;
  /** Every change placed, applied or dropped, by its place in the replay */
  readonly placed: Map<string, number>;
  readonly ancestry: Map<string, Ancestry>;
  readonly heads: Set<string>;
  readonly state: MutableState;
  readonly statuses: Map<string, EventStatus>;
  readonly order: string[];
  readonly appliedByKey: Map<string, ReadonlyArray<string>>;
  /** How changes took power from people, by whom */
  readonly reductions: Map<string, ReadonlyArray<Reduction>>;
  readonly revokes: Map<string, { readonly event: string; readonly keep: ReadonlySet<string> }>;
  readonly keepOf: Map<string, ReadonlySet<string>>;
  /** Each account's role name as changes were applied, and each role's: to know a rank at a past choice */
  readonly memberLog: Map<string, ReadonlyArray<{ readonly applied: number; readonly role: string | null }>>;
  readonly roleLog: Map<string, ReadonlyArray<{ readonly applied: number; readonly role: Role | null }>>;
  choices: ReadonlyArray<Choice>;
  readonly named: Set<string>;
  readonly invites: Set<string>;
  /** States at cuts. Shared between a history and the ones extended from it: a cut's state never changes. */
  readonly stateAtCache: Map<string, AccessState>;
}

function noteEvent(r: Replay, event: AccessEvent): void {
  r.byId.set(event.id, event);
  if (event.kind === 'member' && event.role !== null) r.named.add(event.did);
  if (event.kind === 'invite') r.invites.add(event.inviteKey);
}

/** The changes these ids name, and every change they saw. Every id must be placed. */
function cutOf(r: Replay, ids: ReadonlyArray<string>): Ancestry {
  let prefix = 0;
  for (const id of ids) if (id !== r.genesis.id) prefix = Math.max(prefix, r.ancestry.get(id)!.prefix);
  let extra: Set<number> | null = null;
  for (const id of ids) {
    if (id === r.genesis.id) continue;
    for (const n of [...r.ancestry.get(id)!.extra, r.placed.get(id)!]) {
      if (n >= prefix) (extra ??= new Set()).add(n);
    }
  }
  if (!extra) return { prefix, extra: NONE };
  while (extra.delete(prefix)) prefix++;
  return { prefix, extra: extra.size > 0 ? extra : NONE };
}

function inCut(r: Replay, cut: Ancestry, id: string): boolean {
  const n = r.placed.get(id);
  return n !== undefined && (n < cut.prefix || cut.extra.has(n));
}

/** Whether a cut holds every change applied so far: then its state is where the replay stands, the usual case */
function holdsAllApplied(r: Replay, cut: Ancestry): boolean {
  for (let i = r.order.length - 1; i >= 0; i--) {
    const n = r.placed.get(r.order[i]!)!;
    if (n < cut.prefix) return true;
    if (!cut.extra.has(n)) return false;
  }
  return true;
}

/** The state as of what `seen` names. Every id must be placed. */
function stateAt(r: Replay, seen: ReadonlyArray<string>): AccessState {
  const cacheKey = [...new Set(seen)].sort().join(',');
  const cached = r.stateAtCache.get(cacheKey);
  if (cached) return cached;
  const cut = cutOf(r, seen);
  let folded: MutableState;
  if (holdsAllApplied(r, cut)) folded = cloneState(r.state);
  else {
    folded = startState(r.genesis);
    for (const id of r.order) if (inCut(r, cut, id)) apply(r.byId.get(id)!, folded);
  }
  r.stateAtCache.set(cacheKey, folded);
  return folded;
}

/** The role an account held when `applied` changes had been applied */
function roleAt(r: Replay, did: string, applied: number): Role | null {
  const lastBefore = <T extends { readonly applied: number }>(log: ReadonlyArray<T> | undefined) => {
    if (!log) return undefined;
    for (let i = log.length - 1; i >= 0; i--) if (log[i]!.applied < applied) return log[i];
    return undefined;
  };
  const name = lastBefore(r.memberLog.get(did))?.role;
  return name == null ? null : (lastBefore(r.roleLog.get(name))?.role ?? null);
}

const appended = <K, V>(map: Map<K, ReadonlyArray<V>>, key: K, value: V) =>
  map.set(key, [...(map.get(key) ?? []), value]);

/** Places one change, whose turn it is: everything it saw is placed already */
function place(r: Replay, event: AccessEvent): void {
  r.ancestry.set(event.id, cutOf(r, event.seen));
  r.placed.set(event.id, r.placed.size);
  for (const parent of event.seen) r.heads.delete(parent);
  r.heads.add(event.id);

  // Of two changes to one thing that did not see each other, the first in the replay stands.
  const saw = r.ancestry.get(event.id)!;
  const rival = (r.appliedByKey.get(event.key) ?? []).find((other) => !inCut(r, saw, other));
  const reason =
    (rival ? 'A change to the same thing that it had not seen came first' : null) ??
    // Its author had to have the power as of what they saw…
    // (read where the replay stands, without a copy, when that is what it saw)
    refusal(event, holdsAllApplied(r, saw) ? r.state : stateAt(r, event.seen)) ??
    // …and still have it at its turn.
    refusal(event, r.state);
  if (reason) {
    r.statuses.set(event.id, { status: 'dropped', reason });
    return;
  }

  const index = r.order.length;
  const who = affected(event, r.state);
  const before = who.map((did) => roleOf(r.state, did));
  apply(event, r.state);
  who.forEach((did, i) =>
    appended(r.reductions, did, { event: event.id, did, before: before[i]!, after: roleOf(r.state, did) }),
  );
  if (event.kind === 'member') appended(r.memberLog, event.did, { applied: index, role: event.role });
  if (event.kind === 'role') appended(r.roleLog, event.name, { applied: index, role: event.role });
  if (event.kind === 'revoke' && !r.revokes.has(event.note))
    r.revokes.set(event.note, { event: event.id, keep: new Set(event.keep) });
  r.keepOf.set(event.id, new Set(event.keep));
  r.statuses.set(event.id, { status: 'applied', index });
  r.order.push(event.id);
  appended(r.appliedByKey, event.key, event.id);
}

/** Replays a space's access history. */
export function replayAccess(genesis: AccessGenesis, events: ReadonlyArray<AccessEvent>): AccessHistory {
  const r: Replay = {
    genesis,
    byId: new Map(),
    waiting: new Set(),
    waitingFor: new Set(),
    placed: new Map(),
    ancestry: new Map(),
    heads: new Set(),
    state: startState(genesis),
    statuses: new Map(),
    order: [],
    appliedByKey: new Map(),
    reductions: new Map(),
    revokes: new Map(),
    keepOf: new Map(),
    memberLog: new Map([[genesis.creator, [{ applied: -1, role: genesis.creatorRole }]]]),
    roleLog: new Map(genesis.roles.map((role) => [role.name, [{ applied: -1, role }]])),
    choices: [],
    named: new Set([genesis.creator]),
    invites: new Set(),
    stateAtCache: new Map(),
  };
  for (const event of events) if (!r.byId.has(event.id)) noteEvent(r, event);
  const { byId, waiting } = r;

  // A change waits until everything it saw is here — and so does anything that saw it.
  const isKnown = (id: string) => id === genesis.id || byId.has(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of byId.values()) {
      if (waiting.has(event.id)) continue;
      if (event.seen.some((parent) => parent === event.id || !isKnown(parent) || waiting.has(parent))) {
        waiting.add(event.id);
        changed = true;
      }
    }
  }
  for (const id of waiting) for (const parent of byId.get(id)!.seen) r.waitingFor.add(parent);
  // A cycle can only be forged — ids are hashes of what they saw — but must not hang the replay.
  const placeable = [...byId.values()].filter((event) => !waiting.has(event.id));

  // Kahn's order, choosing among the ready changes by the tie-break.
  const children = new Map<string, string[]>();
  const pending = new Map<string, number>();
  for (const event of placeable) {
    const parents = [...new Set(event.seen.filter((p) => p !== genesis.id))];
    pending.set(event.id, parents.length);
    for (const parent of parents) children.set(parent, [...(children.get(parent) ?? []), event.id]);
  }
  const ready = new Set(placeable.filter((event) => pending.get(event.id) === 0).map((event) => event.id));

  // What a change leads to: itself and everything that saw it, directly or not.
  const descendantCache = new Map<string, ReadonlyArray<AccessEvent>>();
  const leadsTo = (id: string): ReadonlyArray<AccessEvent> => {
    const cached = descendantCache.get(id);
    if (cached) return cached;
    const found = new Set<string>([id]);
    const stack = [id];
    while (stack.length > 0) {
      for (const child of children.get(stack.pop()!) ?? []) {
        if (!found.has(child)) {
          found.add(child);
          stack.push(child);
        }
      }
    }
    const result = [...found].map((other) => byId.get(other)!);
    descendantCache.set(id, result);
    return result;
  };

  /**
   * The order among changes ready to be placed. What matters is not only the
   * change itself but the strongest taking-away it leads to: a removal that
   * also saw something not yet placed must still come before a change it had
   * not seen — so everything on its way gets its priority. Then: taking away
   * before giving, the higher-ranked author, the lower id.
   */
  const priority = (event: AccessEvent): PriorityKey => {
    const { state } = r;
    let strongest = Infinity;
    for (const step of leadsTo(event.id)) {
      if (step === event ? takesAway(step, state) || mayTakeAway(step) : mayTakeAway(step)) {
        strongest = Math.min(strongest, -rankOf(roleOf(state, step.root)));
      }
    }
    return [strongest, takesAway(event, state) ? 0 : 1, -rankOf(roleOf(state, event.root)), event.id];
  };

  const choices: Choice[] = [];
  while (ready.size > 0) {
    let best: AccessEvent | null = null;
    if (ready.size === 1) best = byId.get(ready.values().next().value!)!;
    else {
      let bestKey: PriorityKey | null = null;
      const keys: PriorityKey[] = [];
      for (const id of ready) {
        const event = byId.get(id)!;
        const key = priority(event);
        keys.push(key);
        if (!bestKey || comesFirst(key, bestKey)) {
          best = event;
          bestKey = key;
        }
      }
      // The same keys with every first one equal: what decides if a later change lowers them all.
      const rest = keys.reduce((a, b) => (comesFirst([0, b[1], b[2], b[3]], [0, a[1], a[2], a[3]]) ? b : a));
      if (rest !== bestKey) choices.push({ applied: r.order.length, bound: bestKey![0] });
    }
    const event = best!;
    ready.delete(event.id);
    for (const child of children.get(event.id) ?? []) {
      const left = pending.get(child)! - 1;
      pending.set(child, left);
      if (left === 0) ready.add(child);
    }
    place(r, event);
  }
  r.choices = choices;
  for (const id of waiting) r.statuses.set(id, { status: 'waiting' });
  return historyOf(r);
}

/**
 * The replay with one more change, or null when only replaying everything
 * again can say where it goes. That is so when it did not see every change
 * placed, when a waiting change saw it, or when it takes something away and,
 * counted among what earlier changes lead to, could have changed the order
 * chosen among changes ready at once. Otherwise it goes last, after the same
 * choices, exactly as a replay would place it.
 */
function extended(r: Replay, event: AccessEvent): Replay | null {
  if (r.byId.has(event.id)) return r;
  if (r.waitingFor.has(event.id)) return null;
  const { genesis } = r;
  const waits = event.seen.some(
    (parent) =>
      parent === event.id || (parent !== genesis.id && !r.byId.has(parent)) || r.waiting.has(parent),
  );
  const parents = new Set(event.seen.filter((parent) => parent !== genesis.id));
  if (!waits && (parents.size !== r.heads.size || [...parents].some((parent) => !r.heads.has(parent))))
    return null;

  // Lowering every first key above a choice's bound leaves it as it was, so the choices kept stay right.
  if (!waits && mayTakeAway(event)) {
    for (const choice of r.choices)
      if (-rankOf(roleAt(r, event.root, choice.applied)) <= choice.bound) return null;
  }

  const copy: Replay = {
    genesis,
    byId: new Map(r.byId),
    waiting: new Set(r.waiting),
    waitingFor: new Set(r.waitingFor),
    placed: new Map(r.placed),
    ancestry: new Map(r.ancestry),
    heads: new Set(r.heads),
    state: cloneState(r.state),
    statuses: new Map(r.statuses),
    order: [...r.order],
    appliedByKey: new Map(r.appliedByKey),
    reductions: new Map(r.reductions),
    revokes: new Map(r.revokes),
    keepOf: new Map(r.keepOf),
    memberLog: new Map(r.memberLog),
    roleLog: new Map(r.roleLog),
    choices: r.choices,
    named: new Set(r.named),
    invites: new Set(r.invites),
    stateAtCache: r.stateAtCache,
  };
  noteEvent(copy, event);
  if (waits) {
    copy.waiting.add(event.id);
    for (const parent of event.seen) copy.waitingFor.add(parent);
    copy.statuses.set(event.id, { status: 'waiting' });
  } else place(copy, event);
  return copy;
}

function historyOf(r: Replay): AccessHistory {
  const { genesis } = r;
  const seen = (ids: ReadonlyArray<string>) =>
    ids.every((id) => id === genesis.id || (r.byId.has(id) && !r.waiting.has(id)));
  let heads: ReadonlyArray<string> | null = null;
  // A write checks its change by extending, then extends again once it is stored: the same answer.
  let last: { readonly id: string; readonly next: AccessHistory | null } | null = null;

  const history: AccessHistory = Object.freeze({
    current: r.state,
    status: (id: string) => r.statuses.get(id) ?? null,
    heads: () => (heads ??= Object.freeze([...r.heads].sort())),
    at(ids: ReadonlyArray<string>) {
      return seen(ids) ? stateAt(r, ids) : null;
    },
    judge(record, needs, within) {
      if (!seen(record.seen) || (within && !seen(within)))
        return { ok: false, reason: 'Access changes it depends on have not arrived yet', later: true };
      // For a cited version, only what the citer had seen can take it away (02 §7.6).
      const known = within ? cutOf(r, within) : null;
      const revoked = record.note ? r.revokes.get(record.note) : undefined;
      if (revoked && !revoked.keep.has(record.id) && (!known || inCut(r, known, revoked.event)))
        return { ok: false, reason: 'The note it was written under was revoked', withdrawn: true };

      const cutState = stateAt(r, record.seen);
      if (!needs(roleOf(cutState, record.root), cutState)) {
        return { ok: false, reason: 'Its author was not allowed to, as of what it had seen' };
      }
      // A change it had not seen, that took this power away, stands unless it kept the record.
      const cut = cutOf(r, record.seen);
      for (const reduction of r.reductions.get(record.root) ?? []) {
        if (inCut(r, cut, reduction.event)) continue;
        if (known && !inCut(r, known, reduction.event)) continue;
        if (r.keepOf.get(reduction.event)?.has(record.id)) continue;
        if (needs(reduction.before, cutState) && !needs(reduction.after, cutState)) {
          return { ok: false, reason: "Its author's access was taken away", withdrawn: true };
        }
      }
      return { ok: true };
    },
    revoked: (note: string) => r.revokes.get(note) ?? null,
    named: (did: string) => r.named.has(did),
    knownInvite: (key: string) => r.invites.has(key),
    extend(event: AccessEvent) {
      if (last?.id !== event.id) {
        const next = extended(r, event);
        last = { id: event.id, next: next === r ? history : next && historyOf(next) };
      }
      return last.next;
    },
  } satisfies AccessHistory);
  return history;
}
