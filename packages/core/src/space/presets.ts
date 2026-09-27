/**
 * @module space/presets
 * Starting roles for a space — plain data, and nothing more.
 *
 * The protocol takes no position on what roles a space should have: it reads
 * whatever roles a space's genesis names, and never looks at a preset's name.
 * These are for app developers who want a sensible start. Pass one when
 * creating a space, change it, or write your own.
 *
 * `*` alone is every permission. `*` + `/` + `*` is every permission a
 * collection declares — so a moderator here can moderate whatever apps the
 * space holds, now and later, without managing the space itself.
 */
import type { SpaceRole } from '../types.js';

export interface RolePreset {
  readonly roles: ReadonlyArray<SpaceRole>;
  /** Which of them the creator starts with */
  readonly creatorRole: string;
}

/** Just the creator. Invites are view-only: there is no role below theirs. */
export const solo: RolePreset = Object.freeze({
  roles: Object.freeze([{ name: 'owner', title: 'Owner', rank: 100, permissions: ['*'] }]),
  creatorRole: 'owner',
});

/** A small group working together: everyone invited can write, invite and add collections. */
export const team: RolePreset = Object.freeze({
  roles: Object.freeze([
    { name: 'owner', title: 'Owner', rank: 100, permissions: ['*'] },
    { name: 'editor', title: 'Editor', rank: 10, permissions: ['invite', 'define'] },
  ]),
  creatorRole: 'owner',
});

/** A community: admins run it, moderators keep order in every app, members take part. */
export const community: RolePreset = Object.freeze({
  roles: Object.freeze([
    { name: 'admin', title: 'Admin', rank: 100, permissions: ['*'] },
    { name: 'moderator', title: 'Moderator', rank: 50, permissions: ['invite', '*/*'] },
    { name: 'member', title: 'Member', rank: 0, permissions: [] },
  ]),
  creatorRole: 'admin',
});

export const rolePresets = Object.freeze({ solo, team, community });
