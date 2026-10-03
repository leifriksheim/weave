/**
 * Access replay is consensus: two peers that place changes differently
 * disagree for good about who may write. This generates random access
 * histories — several authors of different ranks, concurrent role changes,
 * removals, revoked notes, key changes, `seen` drawn from causal cuts — and
 * checks that:
 *
 * - every arrival order gives the same history: state, statuses, order,
 *   `at()` and `judge()`;
 * - `replayAccess` gives exactly what `replayAccessReference` does: a frozen
 *   copy of the replay as it was before it was made faster, kept here so any
 *   later change to the real one is checked against it.
 *
 * A failure prints its seed; `ACCESS_SEED=<n>` runs that seed first.
 * `ACCESS_RUNS=<n>` changes how many histories run.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  replayAccess,
  roleHolds,
  permissionMatches,
  checkRelays,
  checkKeepers,
  MANAGE,
  INVITE,
  DEFINE,
  type AccessEvent,
  type AccessGenesis,
  type AccessHistory,
  type AccessState,
  type EventStatus,
  type Keeper,
  type Role,
  type SpaceKeyEpoch,
} from '../src/space/roles.js';

// ─── The reference: replayAccess as it was before it was optimised ─────

/** What the reference answers: everything but `extend`, which came later */
type ReferenceHistory = Omit<AccessHistory, 'extend'>;
//
// Copied verbatim from packages/core/src/space/roles.ts at 4a224d1. Do not
// change it to match a new replay: that defeats the point. If the protocol's
// rules change on purpose, the spec changes, and this copy changes with it in
// the same commit, saying why.

/**
 * Whether someone holding `granted` may hand out `permission`: one of theirs
 * must cover it. A `*` in theirs matches anything, including a `*`.
 */
function covers(granted: ReadonlyArray<string>, permission: string): boolean {
  return granted.some((pattern) => permissionMatches(pattern, permission));
}

/** How one change took power from one person: their role before and after */
interface Reduction {
  readonly event: string;
  readonly did: string;
  readonly before: Role | null;
  readonly after: Role | null;
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

/** Everyone holding a role that exists — who can read, as far as the history is concerned */
function readers(state: AccessState): Set<string> {
  return new Set([...state.members].filter(([, role]) => state.roles.has(role)).map(([did]) => did));
}

function roleOf(state: AccessState, did: string): Role | null {
  const name = state.members.get(did);
  return name === undefined ? null : (state.roles.get(name) ?? null);
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
  const before = event.kind === 'key' ? null : readers(state);
  change(event, state);
  if (event.kind === 'key') state.keyDue = false;
  else if (state.keys.length > 0 && [...before!].some((did) => !readers(state).has(did))) state.keyDue = true;
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
 * Replays a space's access history.
 * @param genesis What the space started with
 * @param events Every change held, in any order; duplicates are ignored
 */
function replayAccessReference(genesis: AccessGenesis, events: ReadonlyArray<AccessEvent>): ReferenceHistory {
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
    who.forEach((did, i) =>
      reductions.push({ event: event.id, did, before: before[i]!, after: roleOf(state, did) }),
    );
    if (event.kind === 'revoke' && !revokes.has(event.note))
      revokes.set(event.note, { event: event.id, keep: new Set(event.keep) });

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
      return seen.every((id) => id === genesis.id || (byId.has(id) && !waiting.has(id)))
        ? stateAt(seen)
        : null;
    },
    judge(record, needs, within) {
      if (!seen(record.seen) || (within && !seen(within)))
        return { ok: false, reason: 'Access changes it depends on have not arrived yet', later: true };
      // For a cited version, only what the citer had seen can take it away (02 §7.6).
      const known = within ? cutOf(within) : null;
      const revoked = record.note ? revokes.get(record.note) : undefined;
      if (revoked && !revoked.keep.has(record.id) && (!known || known.has(revoked.event)))
        return { ok: false, reason: 'The note it was written under was revoked', withdrawn: true };

      const cutState = stateAt(record.seen);
      if (!needs(roleOf(cutState, record.root), cutState)) {
        return { ok: false, reason: 'Its author was not allowed to, as of what it had seen' };
      }
      // A change it had not seen, that took this power away, stands unless it kept the record.
      const cut = cutOf(record.seen);
      for (const reduction of reductions) {
        if (reduction.did !== record.root || cut.has(reduction.event)) continue;
        if (known && !known.has(reduction.event)) continue;
        if (keepOf.get(reduction.event)?.has(record.id)) continue;
        if (needs(reduction.before, cutState) && !needs(reduction.after, cutState)) {
          return { ok: false, reason: "Its author's access was taken away", withdrawn: true };
        }
      }
      return { ok: true };
    },
    revoked: (note: string) => revokes.get(note) ?? null,
    named: (did: string) =>
      did === genesis.creator ||
      [...byId.values()].some((event) => event.kind === 'member' && event.did === did && event.role !== null),
    knownInvite: (key: string) =>
      [...byId.values()].some((event) => event.kind === 'invite' && event.inviteKey === key),
  } satisfies ReferenceHistory);

  /** The changes these ids name, and every change they saw */
  function cutOf(ids: ReadonlyArray<string>): Set<string> {
    const cut = new Set<string>();
    for (const id of ids) {
      cut.add(id);
      for (const ancestor of ancestors(id)) cut.add(ancestor);
    }
    return cut;
  }

  function seen(ids: ReadonlyArray<string>): boolean {
    return ids.every((id) => id === genesis.id || (byId.has(id) && !waiting.has(id)));
  }
}

// ─── Random histories ─────────────────────────────────────────────────

/** mulberry32: small, seeded, the same everywhere */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(list: ReadonlyArray<T>): T => list[int(list.length)]!;
  const chance = (p: number) => next() < p;
  const shuffle = <T>(list: ReadonlyArray<T>): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  return { int, pick, chance, shuffle };
}
type Random = ReturnType<typeof random>;

const ROLES: ReadonlyArray<Role> = [
  { name: 'admin', rank: 100, permissions: ['*'] },
  { name: 'mod', rank: 50, permissions: [MANAGE, INVITE, DEFINE, 'app.x/*'] },
  { name: 'helper', rank: 20, permissions: [INVITE, 'app.x/moderate'] },
  { name: 'member', rank: 0, permissions: [] },
];
const ROLE_NAMES = ['admin', 'mod', 'helper', 'member', 'extra'];
const PEOPLE = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
const PERMISSIONS = [MANAGE, INVITE, DEFINE, 'app.x/moderate', 'app.x/*', '*'];
const NOTES = ['n1', 'n2', 'n3'];
const INVITES = ['i1', 'i2', 'i3'];
const RECORDS = 16;

interface History {
  readonly genesis: AccessGenesis;
  /** In the order they were made: each after everything it saw */
  readonly events: ReadonlyArray<AccessEvent>;
  readonly cuts: ReadonlyArray<ReadonlyArray<string>>;
  readonly records: ReadonlyArray<{
    readonly id: string;
    readonly root: string;
    readonly seen: ReadonlyArray<string>;
    readonly note?: string;
    readonly within?: ReadonlyArray<string>;
  }>;
}

function generate(seed: number): History {
  const r = random(seed);
  const genesis: AccessGenesis = {
    id: 'genesis',
    creator: 'p0',
    roles: ROLES,
    creatorRole: 'admin',
    ...(r.chance(0.8) ? { key: { keyId: 'k0', readKey: 'r0' } } : {}),
  };
  const events: AccessEvent[] = [];
  const ancestors = new Map<string, Set<string>>();
  const ids = new Set<string>();
  const newId = () => {
    let id: string;
    do id = r.int(0xffffffff).toString(16).padStart(8, '0');
    while (ids.has(id));
    ids.add(id);
    return id;
  };
  const heads = () => {
    const parents = new Set(events.flatMap((event) => event.seen));
    return events.map((event) => event.id).filter((id) => !parents.has(id));
  };
  /** What a change made now might have seen: some changes, none of them before another */
  const someSeen = (): string[] => {
    if (events.length === 0 || r.chance(0.05)) return r.chance(0.5) ? [genesis.id] : [];
    if (r.chance(0.4)) return heads();
    const picked = new Set<string>();
    const recent = r.chance(0.6) ? Math.min(events.length, 4) : events.length;
    for (let k = 1 + r.int(3); k > 0; k--) picked.add(events[events.length - 1 - r.int(recent)]!.id);
    const seen = [...picked].filter((id) => ![...picked].some((other) => ancestors.get(other)!.has(id)));
    if (r.chance(0.05)) seen.push(genesis.id);
    return seen;
  };
  const powerful = new Set(['p0']);
  const author = () => (r.chance(0.75) ? r.pick([...powerful]) : r.pick(PEOPLE));
  const someKeep = (): string[] =>
    r.chance(0.25)
      ? [
          ...new Set(
            Array.from({ length: 1 + r.int(3) }, () =>
              r.chance(0.5) && events.length > 0 ? r.pick(events).id : `rec-${r.int(RECORDS)}`,
            ),
          ),
        ]
      : [];

  const length = 5 + r.int(56);
  for (let n = 0; n < length; n++) {
    let seen = someSeen();
    // Now and then a change that saw something that never arrives: it, and all after it, wait.
    if (r.chance(0.03)) seen = [...seen, `missing-${r.int(3)}`];
    const roll = r.int(100);
    // Changes that take power away keep records more often: that is where keep lists matter.
    const keep =
      roll < 55 && r.chance(0.5) ? Array.from({ length: 4 }, () => `rec-${r.int(RECORDS)}`) : someKeep();
    const base = { id: newId(), root: author(), seen, keep: [...new Set(keep)] };
    let event: AccessEvent;
    if (roll < 40) {
      const did = r.pick(PEOPLE);
      const opened = events.filter((e) => e.kind === 'invite' && e.open);
      const viaInvite = opened.length > 0 && r.chance(0.2) ? r.pick(opened) : null;
      if (viaInvite?.kind === 'invite') {
        const role = r.chance(0.85) ? viaInvite.role : r.pick(ROLE_NAMES);
        event = {
          ...base,
          root: did,
          kind: 'member',
          key: `member:${did}`,
          did,
          role,
          viaInvite: viaInvite.inviteKey,
        };
      } else {
        const leaving = r.chance(0.1);
        const role = leaving || r.chance(0.2) ? null : r.pick(ROLE_NAMES);
        event = {
          ...base,
          ...(leaving ? { root: did } : {}),
          kind: 'member',
          key: `member:${did}`,
          did,
          role,
        };
      }
      if (event.role !== null && r.chance(0.7)) powerful.add(event.did);
    } else if (roll < 55) {
      const name = r.pick(['mod', 'helper', 'member', 'extra']);
      const role: Role | null = r.chance(0.25)
        ? null
        : {
            name,
            rank: r.pick([0, 10, 20, 50, 60, 100]),
            permissions: [...new Set(Array.from({ length: r.int(4) }, () => r.pick(PERMISSIONS)))],
          };
      event = { ...base, kind: 'role', key: `role:${name}`, name, role };
    } else if (roll < 67) {
      const inviteKey = r.pick(INVITES);
      const role = r.pick(ROLE_NAMES);
      event = { ...base, kind: 'invite', key: `invite:${inviteKey}`, inviteKey, role, open: r.chance(0.7) };
    } else if (roll < 75) {
      const note = r.pick(NOTES);
      const issuer = r.pick(PEOPLE);
      event = {
        ...base,
        root: r.chance(0.8) ? issuer : base.root,
        kind: 'revoke',
        key: `revoke:${note}`,
        note,
        issuer,
      };
    } else if (roll < 83) {
      const name = r.pick(['app.x', 'app.y']);
      event = { ...base, kind: 'definition', key: `collection:${name}`, name, deleted: r.chance(0.15) };
    } else if (roll < 91) {
      const k = r.int(6);
      event = {
        ...base,
        kind: 'key',
        key: 'key',
        keyId: `k${k}`,
        readKey: `r${r.chance(0.9) ? k : r.int(6)}`,
      };
    } else if (roll < 96) {
      const relays = r.pick([
        ['wss://a.example'],
        ['wss://b.example', 'wss://a.example'],
        ['http://bad'],
        [],
      ]);
      event = { ...base, kind: 'relays', key: 'relays', relays };
    } else {
      const keepers: Keeper[] = r.pick([
        [{ did: 'did:key:zA', name: 'A' }],
        [
          { did: 'did:key:zA', name: 'A' },
          { did: 'did:key:zB', name: 'B' },
        ],
        [{ did: 'not-a-did', name: 'X' }],
      ]);
      event = { ...base, kind: 'keepers', key: 'keepers', keepers, copies: r.pick([null, 1, 2, 99]) };
    }
    const mine = new Set<string>();
    for (const parent of seen) {
      mine.add(parent);
      for (const above of ancestors.get(parent) ?? []) mine.add(above);
    }
    ancestors.set(event.id, mine);
    events.push(event);
  }

  const cuts = [[], [genesis.id], heads(), ['missing-0'], ...Array.from({ length: 10 }, () => someSeen())];
  const records = Array.from({ length: RECORDS }, (_, i) => ({
    id: `rec-${i}`,
    root: r.chance(0.8) ? r.pick([...powerful]) : r.pick(PEOPLE),
    seen: someSeen(),
    ...(r.chance(0.3) ? { note: r.pick(NOTES) } : {}),
    ...(r.chance(0.3) ? { within: someSeen() } : {}),
  }));
  return { genesis, events, cuts, records };
}

// ─── What two replays must agree on ────────────────────────────────────

const NEEDS: ReadonlyArray<(role: Role | null, state: AccessState) => boolean> = [
  (role) => role !== null,
  (role) => roleHolds(role, 'app.x/moderate'),
  (role, state) => roleHolds(role, DEFINE) && state.definitions.has('app.x'),
];

const byKey = <T>(map: ReadonlyMap<string, T>) => [...map].sort((a, b) => (a[0] < b[0] ? -1 : 1));

function stateShape(state: AccessState | null): string {
  if (!state) return 'null';
  return JSON.stringify({
    roles: byKey(state.roles),
    members: byKey(state.members),
    invites: byKey(state.invites),
    definitions: byKey(state.definitions),
    keys: state.keys,
    keyDue: state.keyDue,
    relays: state.relays,
    keepers: state.keepers,
    copies: state.copies,
  });
}

/** Everything a replay answers, as text — one entry per question, so a difference says where it is */
function shape(history: ReferenceHistory, h: History): Record<string, string> {
  const status = (s: EventStatus | null) =>
    !s
      ? 'none'
      : s.status === 'applied'
        ? `applied@${s.index}`
        : s.status === 'dropped'
          ? `dropped: ${s.reason}`
          : s.status;
  const out: Record<string, string> = {
    current: stateShape(history.current),
    heads: JSON.stringify(history.heads()),
  };
  for (const event of h.events) out[`status ${event.id}`] = status(history.status(event.id));
  h.cuts.forEach((cut, i) => (out[`at #${i} [${cut.join(',')}]`] = stateShape(history.at(cut))));
  for (const record of h.records) {
    NEEDS.forEach((needs, i) => {
      out[`judge ${record.id} needs#${i}`] = JSON.stringify(history.judge(record, needs, record.within));
    });
  }
  for (const note of NOTES) {
    const revoked = history.revoked(note);
    out[`revoked ${note}`] = JSON.stringify(
      revoked && { event: revoked.event, keep: [...revoked.keep].sort() },
    );
  }
  for (const did of PEOPLE) out[`named ${did}`] = String(history.named(did));
  for (const key of INVITES) out[`knownInvite ${key}`] = String(history.knownInvite(key));
  return out;
}

function same(actual: Record<string, string>, expected: Record<string, string>, what: string): void {
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key])
      assert.fail(`${what}: ${key}\n  expected ${expected[key]}\n  actual   ${actual[key]}`);
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), what);
}

const RUNS = Number(process.env.ACCESS_RUNS ?? 500);
const first = process.env.ACCESS_SEED ? Number(process.env.ACCESS_SEED) : (Date.now() * 7919) >>> 0;

/** Runs `check` on RUNS histories, naming the seed of the first that fails */
function forHistories(check: (h: History, r: Random) => void): void {
  for (let run = 0; run < RUNS; run++) {
    const seed = (first + run) >>> 0;
    try {
      check(generate(seed), random(seed ^ 0x9e3779b9));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.fail(`seed ${seed} (ACCESS_SEED=${seed} to run it again)\n${message}`);
    }
  }
}

describe('access replay converges', () => {
  test('every arrival order gives the same history', () => {
    forHistories((h, r) => {
      const expected = shape(replayAccess(h.genesis, h.events), h);
      for (let p = 0; p < 3; p++) {
        const order = r.shuffle(h.events);
        // Duplicates are ignored, wherever they fall.
        if (p === 2 && order.length > 0) order.splice(r.int(order.length), 0, r.pick(order));
        same(shape(replayAccess(h.genesis, order), h), expected, `arrival order ${p}`);
      }
    });
  });

  test('the replay gives what the reference replay does', () => {
    forHistories((h, r) => {
      for (const order of [h.events, r.shuffle(h.events)]) {
        same(
          shape(replayAccess(h.genesis, order), h),
          shape(replayAccessReference(h.genesis, order), h),
          'replay against the reference',
        );
      }
    });
  });

  test('extending one change at a time gives what the reference replay does', () => {
    let extended = 0;
    let replayed = 0;
    forHistories((h, r) => {
      // As changes arrive: mostly as they were made, sometimes out of order.
      const arrivals = r.chance(0.7) ? h.events : r.shuffle(h.events);
      let history = replayAccess(h.genesis, []);
      for (let i = 0; i < arrivals.length; i++) {
        const before = stateShape(history.current) + history.heads().join();
        const next = history.extend(arrivals[i]!);
        assert.equal(
          stateShape(history.current) + history.heads().join(),
          before,
          'extending changed the history it came from',
        );
        if (next) extended++;
        else replayed++;
        history = next ?? replayAccess(h.genesis, arrivals.slice(0, i + 1));
        if (i % 5 === 4 || i === arrivals.length - 1) {
          same(
            shape(history, h),
            shape(replayAccessReference(h.genesis, arrivals.slice(0, i + 1)), h),
            `extended to ${i + 1} changes`,
          );
        }
      }
      // A change held already changes nothing.
      if (arrivals.length > 0) assert.equal(history.extend(r.pick(arrivals)), history);
    });
    assert.ok(extended > replayed, `extended ${extended}, replayed ${replayed}`);
  });

  test('the histories are not trivial', () => {
    // A generator that only ever makes dropped changes, or never concurrent ones, would prove nothing.
    let applied = 0;
    let dropped = 0;
    let waiting = 0;
    let concurrent = 0;
    let refused = 0;
    forHistories((h) => {
      const history = replayAccessReference(h.genesis, h.events);
      for (const event of h.events) {
        const status = history.status(event.id)?.status;
        if (status === 'applied') applied++;
        else if (status === 'dropped') dropped++;
        else waiting++;
      }
      const parents = new Set(h.events.flatMap((event) => event.seen));
      if (h.events.filter((event) => !parents.has(event.id)).length > 1) concurrent++;
      for (const record of h.records) if (!history.judge(record, NEEDS[0]!).ok) refused++;
    });
    assert.ok(applied > RUNS * 5, `applied ${applied}`);
    assert.ok(dropped > RUNS, `dropped ${dropped}`);
    assert.ok(waiting > 0, `waiting ${waiting}`);
    assert.ok(concurrent > RUNS / 4, `concurrent ${concurrent}`);
    assert.ok(refused > RUNS, `refused ${refused}`);
  });
});
