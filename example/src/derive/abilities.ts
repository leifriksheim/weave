/**
 * What someone may do in a space, in plain words — worked out from their role
 * and each collection's rules, never from what the collections are about.
 *
 * Pure, so any screen can use it: to list what you can do, to label a
 * permission, or to say why a button is off instead of letting it fail.
 * The rank rules mirror `space/roles.ts` in the protocol.
 */
import { permissionMatches, roleHolds, DEFINE, INVITE, MANAGE } from 'weave-protocol';
import type { NodeCollection, SpaceRole, Who } from 'weave-protocol';
import { collectionLabel, humanize } from './schema-ui';

/** As much of a collection as these helpers read */
export type RuledCollection = Pick<NodeCollection, 'name' | 'title' | 'permissions' | 'rules'>;
type Rule = Who | ReadonlyArray<Who> | undefined;
export type RecordAction = 'create' | 'edit' | 'delete';

// ─── Permissions ──────────────────────────────────────────────────────

/** Every permission there is, now and later */
export const EVERYTHING = '*';
/** Every permission any collection declares, now and later — not the space's own three */
export const EVERY_COLLECTION_PERMISSION = '*/*';

export interface PermissionOption {
  /** What a role holds: `invite`, `app.poll/moderate`, `*` */
  readonly permission: string;
  /** "Invite people", "Moderate" */
  readonly label: string;
  /** One sentence on what it lets someone do */
  readonly description: string;
  /** What it is grouped under: "Space", or the collection's label */
  readonly group: string;
  /** The collection it belongs to, or null for the space's own */
  readonly collection: string | null;
}

/** The three permissions the protocol checks itself */
export const SPACE_PERMISSIONS: ReadonlyArray<PermissionOption & { readonly does: string }> = [
  {
    permission: MANAGE,
    label: 'Run the space',
    does: 'change roles, and who holds them',
    description: 'Make, change and remove roles, and give people roles or take them away — for anyone ranked below them.',
    group: 'Space',
    collection: null,
  },
  {
    permission: INVITE,
    label: 'Invite people',
    does: 'invite people',
    description: 'Make invite links, for roles up to their own.',
    group: 'Space',
    collection: null,
  },
  {
    permission: DEFINE,
    label: 'Add kinds of things',
    does: 'add new kinds of things',
    description: 'Add new kinds of things to the space, and change the ones they added.',
    group: 'Space',
    collection: null,
  },
];

/** The two shortcuts a role can hold instead of ticking every box */
export const WILDCARD_OPTIONS: ReadonlyArray<PermissionOption> = [
  {
    permission: EVERYTHING,
    label: 'Everything',
    description: 'Every permission there is, now and later — including running the space.',
    group: 'Shortcuts',
    collection: null,
  },
  {
    permission: EVERY_COLLECTION_PERMISSION,
    label: 'Every permission on every kind of thing',
    description: 'Whatever any kind of thing asks for, now and later — but not running the space, inviting, or adding kinds of things.',
    group: 'Shortcuts',
    collection: null,
  },
];

const whoList = (who: Rule): ReadonlyArray<Who> => (who === undefined ? ['member'] : typeof who === 'string' ? [who] : who);
/** The rule for an action; delete falls back to edit, as the protocol does */
const ruleFor = (c: RuledCollection, action: RecordAction): Rule => (action === 'delete' ? (c.rules.delete ?? c.rules.edit) : c.rules[action]);

const joinWith = (word: string) => (items: ReadonlyArray<string>) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`;
export const joinAnd = joinWith('and');
export const joinOr = joinWith('or');

/** Every permission a role could be given, with a label and what it does: the space's three, then each collection's */
export function permissionOptions(collections: ReadonlyArray<RuledCollection>): ReadonlyArray<PermissionOption> {
  const own = collections.flatMap((c) =>
    c.permissions.map((p) => {
      const label = collectionLabel(c);
      const uses = (['create', 'edit', 'delete'] as const).filter((a) => whoList(ruleFor(c, a)).includes(`can:${p}`));
      const parts: string[] = [];
      if (uses.includes('create')) parts.push(`add to ${label}`);
      const changes = uses.filter((a) => a !== 'create');
      if (changes.length) parts.push(`${joinAnd(changes)} anything in ${label}`);
      return {
        permission: `${c.name}/${p}`,
        label: humanize(p),
        description: parts.length ? `Lets them ${joinAnd(parts)}.` : `${label} names it, but none of its rules use it yet.`,
        group: label,
        collection: c.name,
      };
    }),
  );
  return [...SPACE_PERMISSIONS, ...own];
}

/** A permission a role holds, in words: "Invite people", "Moderate on Comments", "Everything" */
export function permissionLabel(permission: string, collections: ReadonlyArray<RuledCollection>): string {
  const known = [...WILDCARD_OPTIONS, ...SPACE_PERMISSIONS].find((o) => o.permission === permission);
  if (known) return known.label;
  const slash = permission.lastIndexOf('/');
  if (slash > 0) {
    const collection = collections.find((c) => c.name === permission.slice(0, slash));
    const name = permission.slice(slash + 1);
    if (collection) return name === '*' ? `Everything on ${collectionLabel(collection)}` : `${humanize(name)} on ${collectionLabel(collection)}`;
  }
  return permission;
}

/** Whether someone with this role may hand out a permission: one of theirs must cover it */
export function canGrant(role: SpaceRole | null | undefined, permission: string): boolean {
  return !!role && role.permissions.some((mine) => permissionMatches(mine, permission));
}

// ─── Rules ────────────────────────────────────────────────────────────

/** A rule in words: "anyone with a role", "whoever added it or those with Moderate on Comments" */
export function describeRule(who: Rule, collection?: Pick<NodeCollection, 'name' | 'title'>): string {
  return joinOr(
    whoList(who).map((w) =>
      w === 'member'
        ? 'anyone with a role'
        : w === 'creator'
          ? 'whoever added it'
          : `those with ${humanize(w.slice(4))}${collection ? ` on ${collectionLabel(collection)}` : ''}`,
    ),
  );
}

/** How far a role reaches for an action: on anything, only on what they added, or not at all */
export type Reach = 'any' | 'own' | 'none';

export function reachOf(role: SpaceRole | null | undefined, collection: RuledCollection, action: RecordAction): Reach {
  // Writing anything at all takes a role in the space.
  if (!role) return 'none';
  const list = whoList(ruleFor(collection, action));
  if (list.some((w) => w === 'member' || (w.startsWith('can:') && roleHolds(role, `${collection.name}/${w.slice(4)}`)))) return 'any';
  return action !== 'create' && list.includes('creator') ? 'own' : 'none';
}

const titleOf = (role: SpaceRole) => role.title ?? humanize(role.name);

/** "needs Moderate on Comments — Admin and Moderator have it" */
function needsReason(permissions: ReadonlyArray<string>, roles: ReadonlyArray<SpaceRole>, collections: ReadonlyArray<RuledCollection>): string {
  const holders = roles.filter((r) => permissions.some((p) => roleHolds(r, p))).map(titleOf);
  const needs = `Needs ${joinOr(permissions.map((p) => permissionLabel(p, collections)))}`;
  if (holders.length === 0) return `${needs} — no role has it yet`;
  return `${needs} — ${joinAnd(holders)} ${holders.length === 1 ? 'has' : 'have'} it`;
}

const FOLLOWING = "You only follow this space — you'd need a role to change anything";

/**
 * Why this role cannot do an action in a collection, or null when it can.
 * @param mine Whether the record was added by them — ignored for `create`
 */
export function whyCannot(
  role: SpaceRole | null | undefined,
  roles: ReadonlyArray<SpaceRole>,
  collection: RuledCollection,
  action: RecordAction,
  mine = false,
): string | null {
  if (!role) return FOLLOWING;
  const reach = reachOf(role, collection, action);
  if (reach === 'any' || (reach === 'own' && mine && action !== 'create')) return null;
  const needs = whoList(ruleFor(collection, action))
    .filter((w) => w.startsWith('can:'))
    .map((w) => `${collection.name}/${w.slice(4)}`);
  if (needs.length) return needsReason(needs, roles, [collection]);
  return 'Only whoever added it can';
}

// ─── What you can do ──────────────────────────────────────────────────

export interface Ability {
  /** Stable across renders: `invite`, `app.todo:edit:own` */
  readonly key: string;
  /** "invite people", "edit only what you added to Comments" */
  readonly text: string;
  /** The collection it is about, or null for the space itself */
  readonly collection: string | null;
  /** Why not, for things you cannot do */
  readonly reason?: string;
}

export interface Abilities {
  /** "You're an Editor." */
  readonly summary: string;
  readonly can: ReadonlyArray<Ability>;
  readonly cannot: ReadonlyArray<Ability>;
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

/**
 * Everything a role lets someone do in a space, and everything it does not
 * with the reason — from the role and every collection's rules.
 * @param role Their role, or null when they only follow the space
 * @param roles Every role in the space, to say who does have what they lack
 */
export function abilitiesOf(role: SpaceRole | null, roles: ReadonlyArray<SpaceRole>, collections: ReadonlyArray<RuledCollection>): Abilities {
  const can: Ability[] = [];
  const cannot: Ability[] = [];

  for (const p of SPACE_PERMISSIONS) {
    if (roleHolds(role, p.permission)) {
      const text = p.permission === MANAGE && role ? `${p.does} — for anyone ranked below ${titleOf(role)}` : p.does;
      can.push({ key: p.permission, text, collection: null });
    } else {
      cannot.push({ key: p.permission, text: p.does, collection: null, reason: role ? needsReason([p.permission], roles, collections) : FOLLOWING });
    }
  }

  for (const c of collections) {
    const label = collectionLabel(c);
    const at = (action: RecordAction) => ({ reach: reachOf(role, c, action), rule: JSON.stringify(whoList(ruleFor(c, action))) });

    const create = at('create');
    if (create.reach === 'any') can.push({ key: `${c.name}:create`, text: `add to ${label}`, collection: c.name });
    else cannot.push({ key: `${c.name}:create`, text: `add to ${label}`, collection: c.name, reason: whyCannot(role, roles, c, 'create') ?? undefined });

    // Edit and delete read as one line when the same rule governs both.
    const edit = at('edit');
    const del = at('delete');
    const groups: ReadonlyArray<{ verbs: string; action: RecordAction; reach: Reach }> =
      edit.reach === del.reach && edit.rule === del.rule
        ? [{ verbs: 'edit and delete', action: 'edit', reach: edit.reach }]
        : [
            { verbs: 'edit', action: 'edit', reach: edit.reach },
            { verbs: 'delete', action: 'delete', reach: del.reach },
          ];
    for (const g of groups) {
      const key = `${c.name}:${g.verbs.replace(/ /g, '-')}`;
      if (g.reach === 'any') {
        can.push({ key: `${key}:any`, text: `${g.verbs} anything in ${label}`, collection: c.name });
        continue;
      }
      const reason = whyCannot(role, roles, c, g.action) ?? undefined;
      if (g.reach === 'own') {
        can.push({ key: `${key}:own`, text: `${g.verbs} only what you added to ${label}`, collection: c.name });
        cannot.push({ key: `${key}:others`, text: `${g.verbs} what others added to ${label}`, collection: c.name, reason });
      } else {
        cannot.push({ key: `${key}:any`, text: `${g.verbs} things in ${label}`, collection: c.name, reason });
      }
    }
  }

  const summary = role
    ? `You're ${article(titleOf(role))} ${titleOf(role)}.`
    : "You're following this space: you can see it, but not change anything.";
  return { summary, can, cannot };
}

// ─── Changing roles and people ────────────────────────────────────────

/**
 * Why `me` may not make, change or remove a role, or null when they may.
 * @param existing The role as it is now, or null for a new one
 * @param next The role as it would be, or null to remove it
 */
export function roleChangeRefusal(
  me: SpaceRole | null | undefined,
  existing: SpaceRole | null,
  next: SpaceRole | null,
  collections: ReadonlyArray<RuledCollection> = [],
): string | null {
  if (!me || !roleHolds(me, MANAGE)) return 'Changing roles takes “Run the space”';
  if (existing && existing.rank >= me.rank) return `You can only change roles ranked below yours (${titleOf(me)}, rank ${me.rank})`;
  if (!next) return null;
  if (next.rank >= me.rank) return `Its rank has to be below yours (${me.rank})`;
  const missing = next.permissions.filter((p) => !canGrant(me, p));
  if (missing.length) return `You can't give what you don't have yourself: ${joinAnd(missing.map((p) => permissionLabel(p, collections)))}`;
  return null;
}

/**
 * Why `me` may not give someone a role, change theirs, or take it away, or
 * null when they may. Anyone may give up their own role.
 * @param self Whether it is their own membership
 * @param current The role the person holds now, or null
 * @param next The role to give them, or null to take theirs away
 */
export function memberChangeRefusal(me: SpaceRole | null | undefined, self: boolean, current: SpaceRole | null, next: SpaceRole | null): string | null {
  if (self && next === null) return current ? null : "You don't hold a role here";
  if (!me || !roleHolds(me, MANAGE)) return "Changing people's roles takes “Run the space”";
  if (self) return "You can't change your own role — only give it up";
  if (current && current.rank >= me.rank) return 'They rank the same as you or higher';
  if (next && next.rank > me.rank) return 'You can only give roles up to your own rank';
  return null;
}

/** The roles `me` may give people: up to their own rank, when they run the space */
export function assignableRoles(me: SpaceRole | null | undefined, roles: ReadonlyArray<SpaceRole>): ReadonlyArray<SpaceRole> {
  return me && roleHolds(me, MANAGE) ? roles.filter((r) => r.rank <= me.rank) : [];
}
