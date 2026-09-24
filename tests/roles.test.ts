/**
 * The access history, replayed: the rank rule, invites, keep lists, revoked
 * notes — and the conflicts that happen when people change roles while apart.
 * Pure: no nodes, no crypto, just events.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { replayAccess, standing, holds, permissionMatches, type AccessEvent, type AccessGenesis, type Role } from '../src/space/roles.js';

const admin: Role = { name: 'admin', rank: 100, permissions: ['*'] };
const moderator: Role = { name: 'moderator', rank: 50, permissions: ['invite', 'app.poll/moderate'] };
const member: Role = { name: 'member', rank: 0, permissions: [] };

const genesis: AccessGenesis = { id: 'space', creator: 'alice', roles: [admin, moderator, member], creatorRole: 'admin' };

let n = 0;
const id = (label: string) => `${label}-${String(n++).padStart(3, '0')}`;

function setRole(root: string, did: string, role: string | null, seen: string[], extra: Partial<{ keep: string[]; viaInvite: string; id: string }> = {}): AccessEvent {
  return { id: extra.id ?? id('m'), key: `member:${did}`, kind: 'member', root, did, role, seen, keep: extra.keep ?? [], ...(extra.viaInvite ? { viaInvite: extra.viaInvite } : {}) };
}

const roleOf = (history: ReturnType<typeof replayAccess>, did: string) => standing(history.current, did)?.name ?? null;

/** Replays in every order given, and checks every order reaches the same state */
function replayAllOrders(events: AccessEvent[]) {
  const results = [events, [...events].reverse(), [...events].sort((a, b) => b.id.localeCompare(a.id))].map((order) => replayAccess(genesis, order));
  const shape = (h: ReturnType<typeof replayAccess>) => JSON.stringify([...h.current.members].sort());
  for (const result of results) assert.equal(shape(result), shape(results[0]!), 'every arrival order reaches the same state');
  return results[0]!;
}

describe('permissions', () => {
  test('a * matches any run of characters', () => {
    assert.ok(permissionMatches('*', 'manage'));
    assert.ok(permissionMatches('app.forum.*/moderate', 'app.forum.post/moderate'));
    assert.ok(!permissionMatches('app.forum.*/moderate', 'app.poll/moderate'));
    assert.ok(permissionMatches('*/moderate', 'app.poll/moderate'));
    assert.ok(!permissionMatches('invite', 'manage'));
  });
});

describe('the rank rule', () => {
  test('the creator starts at the top', () => {
    const history = replayAccess(genesis, []);
    assert.equal(roleOf(history, 'alice'), 'admin');
    assert.ok(holds(history.current, 'alice', 'manage'));
  });

  test('an admin adds people, up to their own rank', () => {
    const bob = setRole('alice', 'bob', 'moderator', []);
    const carol = setRole('alice', 'carol', 'admin', [bob.id]);
    const history = replayAccess(genesis, [bob, carol]);
    assert.equal(roleOf(history, 'bob'), 'moderator');
    assert.equal(roleOf(history, 'carol'), 'admin');
  });

  test('someone without manage changes nobody', () => {
    const bob = setRole('alice', 'bob', 'moderator', []);
    const bobAddsDave = setRole('bob', 'dave', 'member', [bob.id]);
    const history = replayAccess(genesis, [bob, bobAddsDave]);
    assert.equal(roleOf(history, 'dave'), null);
    assert.equal(history.status(bobAddsDave.id)?.status, 'dropped');
  });

  test('two people at the same rank cannot remove each other — only themselves', () => {
    const carol = setRole('alice', 'carol', 'admin', []);
    const carolRemovesAlice = setRole('carol', 'alice', null, [carol.id]);
    const history = replayAccess(genesis, [carol, carolRemovesAlice]);
    assert.equal(roleOf(history, 'alice'), 'admin');

    const aliceLeaves = setRole('alice', 'alice', null, [carol.id]);
    const after = replayAccess(genesis, [carol, aliceLeaves]);
    assert.equal(roleOf(after, 'alice'), null);
    assert.equal(roleOf(after, 'carol'), 'admin');
  });

  test('handing over: give someone your role, then leave — they keep running the space', () => {
    const carol = setRole('alice', 'carol', 'admin', []);
    const aliceLeaves = setRole('alice', 'alice', null, [carol.id]);
    const carolAddsBob = setRole('carol', 'bob', 'member', [aliceLeaves.id]);
    const history = replayAccess(genesis, [carol, aliceLeaves, carolAddsBob]);
    assert.equal(roleOf(history, 'bob'), 'member');
    assert.equal(roleOf(history, 'alice'), null);
  });

  test('a role cannot be given permissions its maker does not hold', () => {
    const bob = setRole('alice', 'bob', 'moderator', []);
    const bobManages: AccessEvent = { id: id('r'), key: 'role:helper', kind: 'role', root: 'alice', name: 'helper', role: { name: 'helper', rank: 10, permissions: ['manage'] }, seen: [bob.id], keep: [] };
    assert.equal(replayAccess(genesis, [bob, bobManages]).status(bobManages.id)?.status, 'applied', 'an admin may');

    const promote: AccessEvent = { id: id('r'), key: 'role:moderator', kind: 'role', root: 'alice', name: 'moderator', role: { ...moderator, permissions: [...moderator.permissions, 'manage'] }, seen: [bob.id], keep: [] };
    const bobMakes: AccessEvent = { id: id('r'), key: 'role:x', kind: 'role', root: 'bob', name: 'x', role: { name: 'x', rank: 10, permissions: ['define'] }, seen: [promote.id], keep: [] };
    const history = replayAccess(genesis, [bob, promote, bobMakes]);
    assert.equal(history.status(bobMakes.id)?.status, 'dropped', 'a moderator without define cannot hand it out');
  });
});

describe('invites', () => {
  test('an open invite lets someone add themselves, for its role only', () => {
    const invite: AccessEvent = { id: id('i'), key: 'invite:k', kind: 'invite', root: 'alice', inviteKey: 'k', role: 'member', open: true, seen: [], keep: [] };
    const join = setRole('bob', 'bob', 'member', [invite.id], { viaInvite: 'k' });
    const greedy = setRole('carol', 'carol', 'admin', [invite.id], { viaInvite: 'k' });
    const history = replayAccess(genesis, [invite, join, greedy]);
    assert.equal(roleOf(history, 'bob'), 'member');
    assert.equal(roleOf(history, 'carol'), null);
  });

  test('closing an invite, with a keep list: who joined before stays, who claims to have stays out', () => {
    const invite: AccessEvent = { id: id('i'), key: 'invite:k', kind: 'invite', root: 'alice', inviteKey: 'k', role: 'member', open: true, seen: [], keep: [] };
    const bobJoins = setRole('bob', 'bob', 'member', [invite.id], { viaInvite: 'k' });
    const close: AccessEvent = { ...invite, id: id('i'), open: false, seen: [bobJoins.id] };
    // Carol joins "before" the close — she names only the invite — but the closer never saw her.
    const carolJoins = setRole('carol', 'carol', 'member', [invite.id], { viaInvite: 'k' });
    const history = replayAllOrders([invite, bobJoins, close, carolJoins]);
    assert.equal(roleOf(history, 'bob'), 'member');
    assert.equal(roleOf(history, 'carol'), null, 'the close takes away first among changes that did not see each other');
  });

  test('a moderator can invite up to their own rank, not above', () => {
    const bob = setRole('alice', 'bob', 'moderator', []);
    const toAdmin: AccessEvent = { id: id('i'), key: 'invite:a', kind: 'invite', root: 'bob', inviteKey: 'a', role: 'admin', open: true, seen: [bob.id], keep: [] };
    const toMember: AccessEvent = { id: id('i'), key: 'invite:b', kind: 'invite', root: 'bob', inviteKey: 'b', role: 'member', open: true, seen: [bob.id], keep: [] };
    const history = replayAccess(genesis, [bob, toAdmin, toMember]);
    assert.equal(history.status(toAdmin.id)?.status, 'dropped');
    assert.equal(history.status(toMember.id)?.status, 'applied');
  });
});

describe('offline conflicts', () => {
  test('a removal against a concurrent ban: the removal wins, the ban is dropped', () => {
    const bob = setRole('alice', 'bob', 'moderator', []);
    const promote: AccessEvent = { id: id('r'), key: 'role:moderator', kind: 'role', root: 'alice', name: 'moderator', role: { ...moderator, permissions: [...moderator.permissions, 'manage'] }, seen: [bob.id], keep: [] };
    const carol = setRole('alice', 'carol', 'member', [promote.id]);
    // Apart: Alice removes Bob; Bob, not knowing, removes Carol.
    const aliceRemovesBob = setRole('alice', 'bob', null, [carol.id]);
    const bobRemovesCarol = setRole('bob', 'carol', null, [carol.id]);
    const history = replayAllOrders([bob, promote, carol, aliceRemovesBob, bobRemovesCarol]);
    assert.equal(roleOf(history, 'bob'), null);
    assert.equal(roleOf(history, 'carol'), 'member');
    assert.equal(history.status(bobRemovesCarol.id)?.status, 'dropped');
  });

  test('two admins trying to remove each other: impossible, both stay', () => {
    const carol = setRole('alice', 'carol', 'admin', []);
    const a = setRole('alice', 'carol', null, [carol.id]);
    const c = setRole('carol', 'alice', null, [carol.id]);
    const history = replayAllOrders([carol, a, c]);
    assert.equal(roleOf(history, 'alice'), 'admin');
    assert.equal(roleOf(history, 'carol'), 'admin');
  });

  test('the last two admins leaving at once: no admin, the same on every peer', () => {
    const carol = setRole('alice', 'carol', 'admin', []);
    const a = setRole('alice', 'alice', null, [carol.id]);
    const c = setRole('carol', 'carol', null, [carol.id]);
    const history = replayAllOrders([carol, a, c]);
    assert.equal(history.current.members.size, 0);
  });

  test('two admins changing one person at once: the one that takes away wins', () => {
    const carol = setRole('alice', 'carol', 'admin', []);
    const bob = setRole('alice', 'bob', 'member', [carol.id]);
    const aliceRemoves = setRole('alice', 'bob', null, [bob.id]);
    const carolPromotes = setRole('carol', 'bob', 'moderator', [bob.id]);
    const history = replayAllOrders([carol, bob, aliceRemoves, carolPromotes]);
    assert.equal(roleOf(history, 'bob'), null);
  });

  test('a change whose author gained power only from a change they had not seen does not count', () => {
    const bob = setRole('alice', 'bob', 'member', []);
    const promote = setRole('alice', 'bob', 'moderator', [bob.id]);
    // Bob acts as if he were a moderator without having seen the promotion.
    const bobInvites: AccessEvent = { id: id('i'), key: 'invite:x', kind: 'invite', root: 'bob', inviteKey: 'x', role: 'member', open: true, seen: [bob.id], keep: [] };
    const history = replayAllOrders([bob, promote, bobInvites]);
    assert.equal(history.status(bobInvites.id)?.status, 'dropped');
  });

  test('a close whose branch is not placed yet still beats a join it had not seen', () => {
    // Alice opens an invite before hearing that Bob joined; Carol joins with it;
    // Alice, having now heard of Bob, closes it without having seen Carol.
    const first: AccessEvent = { id: 'a-open-1', key: 'invite:1', kind: 'invite', root: 'alice', inviteKey: '1', role: 'member', open: true, seen: [], keep: [] };
    const bobJoins = setRole('bob', 'bob', 'member', [first.id], { viaInvite: '1', id: 'z-bob' });
    const second: AccessEvent = { id: 'b-open-2', key: 'invite:2', kind: 'invite', root: 'alice', inviteKey: '2', role: 'member', open: true, seen: [first.id], keep: [] };
    const carolJoins = setRole('carol', 'carol', 'member', [second.id], { viaInvite: '2', id: 'c-carol' });
    const close: AccessEvent = { ...second, id: 'y-close-2', open: false, seen: [second.id, bobJoins.id] };
    const history = replayAllOrders([first, bobJoins, second, carolJoins, close]);
    assert.equal(roleOf(history, 'carol'), null);
    assert.equal(roleOf(history, 'bob'), 'member');
  });

  test('a removal whose branch is not placed yet still beats a concurrent ban by the one removed', () => {
    const bob = setRole('alice', 'bob', 'moderator', [], { id: 'a-bob' });
    const promote: AccessEvent = { id: 'b-promote', key: 'role:moderator', kind: 'role', root: 'alice', name: 'moderator', role: { ...moderator, permissions: [...moderator.permissions, 'manage'] }, seen: [bob.id], keep: [] };
    const carol = setRole('alice', 'carol', 'member', [promote.id], { id: 'c-carol' });
    const dave = setRole('alice', 'dave', 'member', [carol.id], { id: 'z-dave' });
    // Alice removes Bob having also added Dave; Bob, apart, removes Carol.
    const removeBob = setRole('alice', 'bob', null, [dave.id], { id: 'y-remove-bob' });
    const bobBans = setRole('bob', 'carol', null, [carol.id], { id: 'd-ban' });
    const history = replayAllOrders([bob, promote, carol, dave, removeBob, bobBans]);
    assert.equal(roleOf(history, 'bob'), null);
    assert.equal(roleOf(history, 'carol'), 'member');
  });

  test('a change that saw something not here yet waits', () => {
    const later = setRole('alice', 'bob', 'member', ['not-here']);
    const history = replayAccess(genesis, [later]);
    assert.equal(history.status(later.id)?.status, 'waiting');
    assert.equal(history.at(['not-here']), null);
  });
});

describe('records against the history', () => {
  const isMember = (role: Role | null) => role !== null;
  const canModerate = (role: Role | null) => !!role && role.permissions.some((p) => permissionMatches(p, 'app.poll/moderate'));

  test('a member writes; a stranger does not', () => {
    const bob = setRole('alice', 'bob', 'member', []);
    const history = replayAccess(genesis, [bob]);
    assert.ok(history.judge({ id: 'r1', root: 'bob', seen: [bob.id] }, isMember).ok);
    assert.ok(!history.judge({ id: 'r2', root: 'mallory', seen: [bob.id] }, isMember).ok);
  });

  test('a removed member cannot write by claiming an old point in history', () => {
    const bob = setRole('alice', 'bob', 'member', []);
    const remove = setRole('alice', 'bob', null, [bob.id], { keep: ['honest'] });
    const history = replayAccess(genesis, [bob, remove]);
    assert.ok(history.judge({ id: 'honest', root: 'bob', seen: [bob.id] }, isMember).ok, 'what the remover had seen stays');
    const forged = history.judge({ id: 'forged', root: 'bob', seen: [bob.id] }, isMember);
    assert.ok(!forged.ok && /taken away/.test(forged.reason));
    assert.ok(!history.judge({ id: 'after', root: 'bob', seen: [remove.id] }, isMember).ok, 'nor having seen the removal');
  });

  test('a demoted moderator keeps their past moderation; new moderation with an old point in history is refused', () => {
    const bob = setRole('alice', 'bob', 'moderator', []);
    const demote = setRole('alice', 'bob', 'member', [bob.id], { keep: ['past'] });
    const history = replayAccess(genesis, [bob, demote]);
    assert.ok(history.judge({ id: 'past', root: 'bob', seen: [bob.id] }, canModerate).ok);
    assert.ok(!history.judge({ id: 'new', root: 'bob', seen: [bob.id] }, canModerate).ok);
    assert.ok(history.judge({ id: 'plain', root: 'bob', seen: [bob.id] }, isMember).ok, 'still a member: ordinary writes stand');
  });

  test('a revoked note: records under it stand only if kept', () => {
    const revoke: AccessEvent = { id: id('v'), key: 'revoke:n', kind: 'revoke', root: 'alice', note: 'note-1', issuer: 'alice', seen: [], keep: ['kept'] };
    const history = replayAccess(genesis, [revoke]);
    assert.ok(history.judge({ id: 'kept', root: 'alice', seen: [], note: 'note-1' }, isMember).ok);
    assert.ok(!history.judge({ id: 'other', root: 'alice', seen: [revoke.id], note: 'note-1' }, isMember).ok);
    assert.ok(history.judge({ id: 'own', root: 'alice', seen: [], note: 'note-2' }, isMember).ok, 'other notes are untouched');
  });

  test('only whoever signed a note may revoke it', () => {
    const bob = setRole('alice', 'bob', 'admin', []);
    const revoke: AccessEvent = { id: id('v'), key: 'revoke:n', kind: 'revoke', root: 'bob', note: 'note-1', issuer: 'alice', seen: [bob.id], keep: [] };
    assert.equal(replayAccess(genesis, [bob, revoke]).revoked('note-1'), null);
  });

  test('definitions: define to create, the definer or a manager to change', () => {
    const bob = setRole('alice', 'bob', 'member', []);
    const bobDefines: AccessEvent = { id: id('d'), key: 'collection:app.poll', kind: 'definition', root: 'bob', name: 'app.poll', deleted: false, seen: [bob.id], keep: [] };
    assert.equal(replayAccess(genesis, [bob, bobDefines]).status(bobDefines.id)?.status, 'dropped', 'a member without define');

    const aliceDefines: AccessEvent = { ...bobDefines, id: id('d'), root: 'alice' };
    const bobChanges: AccessEvent = { ...bobDefines, id: id('d'), seen: [aliceDefines.id] };
    const history = replayAccess(genesis, [bob, aliceDefines, bobChanges]);
    assert.equal(history.status(bobChanges.id)?.status, 'dropped');
    assert.equal(history.current.definitions.get('app.poll')?.event, aliceDefines.id);
    assert.equal(history.at([aliceDefines.id])?.definitions.get('app.poll')?.event, aliceDefines.id);
    assert.equal(history.at([])?.definitions.get('app.poll'), undefined, 'a record that saw nothing is judged with no definition');
  });
});
