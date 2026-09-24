/**
 * @module space/roles
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

/** Every collection whose records are part of the access history */
export const ACCESS_COLLECTIONS: ReadonlySet<string> = new Set([
  ROLE_COLLECTION,
  MEMBER_COLLECTION,
  INVITE_COLLECTION,
  REVOKE_COLLECTION,
  DEFINITION_COLLECTION,
]);

export const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Why a role is malformed, or null */
export function checkRole(role: unknown): string | null {
  const r = role as Role | null;
  if (!r || typeof r !== 'object') return 'A role must be an object';
  if (typeof r.name !== 'string' || !ROLE_NAME_PATTERN.test(r.name)) return 'A role name is 1–40 characters of a–z, 0–9 and . _ -';
  if (r.title !== undefined && (typeof r.title !== 'string' || r.title.length > 80)) return 'A role title is text of at most 80 characters';
  if (typeof r.rank !== 'number' || !Number.isFinite(r.rank)) return 'A role rank must be a number';
  if (!Array.isArray(r.permissions) || !r.permissions.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 200)) {
    return 'A role\'s permissions must be a list of names';
  }
  return null;
}

/** Whether a role's permission (which may hold `*`) matches a permission */
export function permissionMatches(pattern: string, permission: string): boolean {
  if (pattern === permission || pattern === '*') return true;
  if (!pattern.includes('*')) return false;
  const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`);
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
    | { readonly kind: 'role'; readonly name: string; /** Null: the role is removed */ readonly role: Role | null }
    | {
        readonly kind: 'member';
        readonly did: string;
        /** Null: they are no longer a member */
        readonly role: string | null;
        /** The invite's public key, when the runtime checked the invite's signature on this record */
        readonly viaInvite?: string;
      }
    | { readonly kind: 'invite'; readonly inviteKey: string; readonly role: string; readonly open: boolean }
    | { readonly kind: 'revoke'; /** The note's CID */ readonly note: string; /** Who signed the note */ readonly issuer: string }
    | { readonly kind: 'definition'; readonly name: string; readonly deleted: boolean }
  );

/** Who holds what, at one point in the history */
export interface AccessState {
  readonly roles: ReadonlyMap<string, Role>;
  /** Account DID → role name */
  readonly members: ReadonlyMap<string, string>;
  /** Invite public key → its role, and whether it is open */
  readonly invites: ReadonlyMap<string, { readonly role: string; readonly open: boolean; readonly event: string }>;
  /** Collection name → the id of the definition in force, and who first defined it */
  readonly definitions: ReadonlyMap<string, { readonly event: string; readonly definedBy: string }>;
}

/** What a space starts with, from its genesis */
export interface AccessGenesis {
  /** The space id — also the id every change implicitly comes after */
  readonly id: string;
  readonly creator: string;
  readonly roles: ReadonlyArray<Role>;
  readonly creatorRole: string;
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

export type RecordVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly later?: boolean };

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
   */
  judge(
    record: { readonly id: string; readonly root: string; readonly seen: ReadonlyArray<string>; readonly note?: string },
    needs: (role: Role | null, state: AccessState) => boolean,
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
}

/** A role's standing as rank; below everyone when there is none */
const rankOf = (role: Role | null | undefined) => (role ? role.rank : -Infinity);

interface MutableState {
  roles: Map<string, Role>;
  members: Map<string, string>;
  invites: Map<string, { role: string; open: boolean; event: string }>;
  definitions: Map<string, { event: string; definedBy: string }>;
}

function startState(genesis: AccessGenesis): MutableState {
  return {
    roles: new Map(genesis.roles.map((role) => [role.name, role])),
    members: new Map([[genesis.creator, genesis.creatorRole]]),
    invites: new Map(),
    definitions: new Map(),
  };
}

const copyState = (state: MutableState): MutableState => ({
  roles: new Map(state.roles),
  members: new Map(state.members),
  invites: new Map(state.invites),
  definitions: new Map(state.definitions),
});

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
      return event.role.rank < before.rank || before.permissions.some((p) => !event.role!.permissions.includes(p));
    }
    case 'definition':
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
      if (existing && existing.rank >= author!.rank) return 'Its author may only change roles ranked below their own';
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
        return state.roles.has(invite.role) ? null : 'The invite\'s role no longer exists';
      }
      // Leaving: anyone may remove themselves.
      if (event.root === event.did && event.role === null) return current ? null : 'Not a member';
      if (!roleHolds(author, MANAGE)) return 'Its author may not manage members';
      if (current && current.rank >= author!.rank) return 'Its author may only change people ranked below them';
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
      return author && existing.definedBy === event.root ? null : 'Only whoever defined it, or someone who manages the space, may change it';
    }
  }
}

/** The people whose standing a change may lower — for keep lists */
function affected(event: AccessEvent, state: AccessState): ReadonlyArray<string> {
  if (event.kind === 'member') return [event.did];
  if (event.kind === 'role') return [...state.members].filter(([, role]) => role === event.name).map(([did]) => did);
  return [];
}

function apply(event: AccessEvent, state: MutableState): void {
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
  }
}

/**
 * Replays a space's access history.
 * @param genesis What the space started with
 * @param events Every change held, in any order; duplicates are ignored
 */
export function replayAccess(genesis: AccessGenesis, events: ReadonlyArray<AccessEvent>): AccessHistory {
  const byId = new Map<string, AccessEvent>();
  for (const event of events) if (!byId.has(event.id)) byId.set(event.id, event);

  // A change waits until everything it saw is here — and so does anything that saw it.
  const waiting = new Set<string>();
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
  // A cycle can only be forged — ids are hashes of what they saw — but must not hang the replay.
  const placeable = [...byId.values()].filter((event) => !waiting.has(event.id));

  const ancestorCache = new Map<string, ReadonlySet<string>>();
  const ancestors = (id: string): ReadonlySet<string> => {
    const cached = ancestorCache.get(id);
    if (cached) return cached;
    const result = new Set<string>();
    const stack = [...(byId.get(id)?.seen ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (result.has(next) || next === genesis.id) continue;
      result.add(next);
      stack.push(...(byId.get(next)?.seen ?? []));
    }
    ancestorCache.set(id, result);
    return result;
  };

  // Kahn's order, choosing among the ready changes by the tie-break.
  const children = new Map<string, string[]>();
  const pending = new Map<string, number>();
  for (const event of placeable) {
    const parents = [...new Set(event.seen.filter((p) => p !== genesis.id))];
    pending.set(event.id, parents.length);
    for (const parent of parents) children.set(parent, [...(children.get(parent) ?? []), event.id]);
  }
  const ready = new Set(placeable.filter((event) => pending.get(event.id) === 0).map((event) => event.id));

  const state = startState(genesis);
  const statuses = new Map<string, EventStatus>();
  const order: string[] = [];
  const appliedByKey = new Map<string, string[]>();
  const reductions: Reduction[] = [];
  const revokes = new Map<string, { event: string; keep: ReadonlySet<string> }>();

  const stateAtCache = new Map<string, AccessState>();
  const stateAt = (seen: ReadonlyArray<string>): AccessState => {
    const cacheKey = [...new Set(seen)].sort().join(',');
    const cached = stateAtCache.get(cacheKey);
    if (cached) return cached;
    const cut = new Set<string>();
    for (const id of seen) {
      if (id === genesis.id) continue;
      cut.add(id);
      for (const ancestor of ancestors(id)) cut.add(ancestor);
    }
    const folded = startState(genesis);
    for (const id of order) if (cut.has(id)) apply(byId.get(id)!, folded);
    stateAtCache.set(cacheKey, folded);
    return folded;
  };

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
  const priority = (event: AccessEvent): [number, number, number, string] => {
    let strongest = Infinity;
    for (const step of leadsTo(event.id)) {
      if (step === event ? takesAway(step, state) || mayTakeAway(step) : mayTakeAway(step)) {
        strongest = Math.min(strongest, -rankOf(roleOf(state, step.root)));
      }
    }
    return [strongest, takesAway(event, state) ? 0 : 1, -rankOf(roleOf(state, event.root)), event.id];
  };
  const comesFirst = (a: [number, number, number, string], b: [number, number, number, string]) =>
    a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] !== b[2] ? a[2] < b[2] : a[3] < b[3];

  while (ready.size > 0) {
    let best: AccessEvent | null = null;
    let bestKey: [number, number, number, string] | null = null;
    for (const id of ready) {
      const event = byId.get(id)!;
      const key = priority(event);
      if (!bestKey || comesFirst(key, bestKey)) {
        best = event;
        bestKey = key;
      }
    }
    const event = best!;
    ready.delete(event.id);
    for (const child of children.get(event.id) ?? []) {
      const left = pending.get(child)! - 1;
      pending.set(child, left);
      if (left === 0) ready.add(child);
    }

    // Of two changes to one thing that did not see each other, the first in the replay stands.
    const rival = (appliedByKey.get(event.key) ?? []).find((other) => !ancestors(event.id).has(other));
    const reason =
      (rival ? 'A change to the same thing that it had not seen came first' : null) ??
      // Its author had to have the power as of what they saw…
      refusal(event, stateAt(event.seen)) ??
      // …and still have it at its turn.
      refusal(event, state);
    if (reason) {
      statuses.set(event.id, { status: 'dropped', reason });
      continue;
    }

    const who = affected(event, state);
    const before = who.map((did) => roleOf(state, did));
    apply(event, state);
    who.forEach((did, i) => reductions.push({ event: event.id, did, before: before[i]!, after: roleOf(state, did) }));
    if (event.kind === 'revoke' && !revokes.has(event.note)) revokes.set(event.note, { event: event.id, keep: new Set(event.keep) });

    statuses.set(event.id, { status: 'applied', index: order.length });
    order.push(event.id);
    appliedByKey.set(event.key, [...(appliedByKey.get(event.key) ?? []), event.id]);
  }
  for (const id of waiting) statuses.set(id, { status: 'waiting' });

  const keepOf = new Map(order.map((id) => [id, new Set(byId.get(id)!.keep)]));

  const heads = (): ReadonlyArray<string> => {
    const parents = new Set<string>();
    for (const event of placeable) for (const parent of event.seen) parents.add(parent);
    return placeable
      .map((event) => event.id)
      .filter((id) => !parents.has(id))
      .sort();
  };

  return Object.freeze({
    current: state,
    status: (id: string) => statuses.get(id) ?? null,
    heads,
    at(seen: ReadonlyArray<string>) {
      return seen.every((id) => id === genesis.id || (byId.has(id) && !waiting.has(id))) ? stateAt(seen) : null;
    },
    judge(record, needs) {
      if (!seen(record.seen)) return { ok: false, reason: 'Access changes it depends on have not arrived yet', later: true };
      const revoked = record.note ? revokes.get(record.note) : undefined;
      if (revoked && !revoked.keep.has(record.id)) return { ok: false, reason: 'The note it was written under was revoked' };

      const cutState = stateAt(record.seen);
      if (!needs(roleOf(cutState, record.root), cutState)) {
        return { ok: false, reason: 'Its author was not allowed to, as of what it had seen' };
      }
      // A change it had not seen, that took this power away, stands unless it kept the record.
      const cut = new Set<string>();
      for (const id of record.seen) {
        cut.add(id);
        for (const ancestor of ancestors(id)) cut.add(ancestor);
      }
      for (const reduction of reductions) {
        if (reduction.did !== record.root || cut.has(reduction.event)) continue;
        if (keepOf.get(reduction.event)?.has(record.id)) continue;
        if (needs(reduction.before, cutState) && !needs(reduction.after, cutState)) {
          return { ok: false, reason: 'Its author\'s access was taken away' };
        }
      }
      return { ok: true };
    },
    revoked: (note: string) => revokes.get(note) ?? null,
    named: (did: string) => did === genesis.creator || [...byId.values()].some((event) => event.kind === 'member' && event.did === did && event.role !== null),
    knownInvite: (key: string) => [...byId.values()].some((event) => event.kind === 'invite' && event.inviteKey === key),
  } satisfies AccessHistory);

  function seen(ids: ReadonlyArray<string>): boolean {
    return ids.every((id) => id === genesis.id || (byId.has(id) && !waiting.has(id)));
  }
}

/** Freezes a state for handing out */
export function snapshot(state: AccessState): AccessState {
  const copy = copyState(state as MutableState);
  return Object.freeze(copy);
}
