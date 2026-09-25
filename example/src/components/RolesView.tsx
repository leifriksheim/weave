import { useState, type CSSProperties } from 'react';
import { permissionMatches, roleHolds } from '@weaveprotocol/core';
import type { NodeCollection, SpaceRole, SpaceSummary } from '@weaveprotocol/core';
import { useAccess, useAccount, useNode, useProfiles } from '@weaveprotocol/core/react';
import {
  abilitiesOf,
  assignableRoles,
  canGrant,
  memberChangeRefusal,
  permissionLabel,
  permissionOptions,
  roleChangeRefusal,
  WILDCARD_OPTIONS,
  type PermissionOption,
} from '../derive/abilities';
import { nameOf, peopleFrom, type People } from '../derive/people';
import { Avatar } from './Avatar';
import { createInviteLink } from '../spaces';
import { styles, palette, variants } from '../styles';

/** Who holds what in the space, as the node reports it */
type SpaceAccess = NonNullable<ReturnType<typeof useAccess>>;

/**
 * Who may do what in a space: what you can do yourself, the roles, and who
 * holds them. Everything is worked out from the roles and each collection's
 * rules — and anything you cannot do is shown switched off, with why.
 */
export function RolesView({ space, collections, inviting = false }: { space: SpaceSummary; collections: ReadonlyArray<NodeCollection>; inviting?: boolean }) {
  const access = useAccess(space.id);
  const account = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  if (!access) return <p style={{ fontSize: 13, color: palette.ink.faint }}>Loading who's who…</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
      <Members space={space} access={access} me={account.did} people={people} collections={collections} inviting={inviting} />
      <Roles space={space} access={access} collections={collections} />
      <WhatYouCanDo access={access} collections={collections} />
    </div>
  );
}

/** Node errors are written about "its author" — this is about you */
function plainError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text
    .replace(/^Its author/, 'You')
    .replace(/\btheir own\b/g, 'your own')
    .replace(/\bbelow them\b/g, 'below you')
    .replace(/\bthey do not hold\b/g, "you don't hold");
}

const titleOf = (role: SpaceRole) => role.title ?? role.name;

// ─── What you can do ──────────────────────────────────────────────────

function WhatYouCanDo({ access, collections }: { access: SpaceAccess; collections: ReadonlyArray<NodeCollection> }) {
  const { summary, can, cannot } = abilitiesOf(access.role, access.roles, collections);
  return (
    <section style={section} aria-label="What you can do">
      <h2 style={{ ...styles.appTitle, fontSize: 20 }}>What you can do</h2>
      <p style={{ fontSize: 14, color: palette.ink.body }}>{summary}</p>
      {can.length > 0 && (
        <div>
          <p style={styles.fieldLabel}>You can</p>
          <ul style={list}>
            {can.map((a) => (
              <li key={a.key} style={item}>
                <span style={{ color: palette.accent.good }}>✓</span> <span style={{ color: palette.ink.strong }}>{capital(a.text)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {cannot.length > 0 && (
        <div>
          <p style={styles.fieldLabel}>You can't</p>
          <ul style={list}>
            {cannot.map((a) => (
              <li key={a.key} style={item}>
                <span style={{ color: palette.ink.faint }}>–</span> <span style={{ color: palette.ink.body }}>{capital(a.text)}</span>
                {a.reason && <span style={{ color: palette.ink.faint }}> · {a.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// ─── Roles ────────────────────────────────────────────────────────────

/** Where a role being edited sits: one being made, or the name of one being changed */
type Editing = { readonly kind: 'new' } | { readonly kind: 'edit'; readonly name: string } | null;

function Roles({ space, access, collections }: { space: SpaceSummary; access: SpaceAccess; collections: ReadonlyArray<NodeCollection> }) {
  const node = useNode();
  const me = access.role;
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const roles = [...access.roles].sort((a, b) => b.rank - a.rank);
  const holders = (name: string) => access.members.filter((m) => m.role === name).length;
  const cannotManage = roleChangeRefusal(me, null, null);

  const remove = async (role: SpaceRole) => {
    const count = holders(role.name);
    const who = count === 0 ? 'Nobody holds it now.' : `The ${count === 1 ? 'person' : `${count} people`} holding it will have no role — they can still see the space, but not change anything, until someone gives them another.`;
    if (!globalThis.confirm(`Remove the ${titleOf(role)} role? ${who}`)) return;
    setError(null);
    try {
      await node.spaces.removeRole(space.id, role.name);
    } catch (e) {
      setError(plainError(e));
    }
  };

  return (
    <section style={section} aria-label="Roles">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ ...styles.appTitle, fontSize: 20 }}>Roles</h2>
        <button
          onClick={() => setEditing({ kind: 'new' })}
          disabled={!!cannotManage || editing?.kind === 'new'}
          title={cannotManage ?? undefined}
          data-variant="quiet"
          style={styles.smallButton}
        >
          New role
        </button>
      </div>
      <p style={{ fontSize: 13, color: palette.ink.muted, lineHeight: 1.5 }}>
        Higher ranks can change lower ones. {cannotManage ? `${cannotManage}, so you can look but not change.` : `You can change roles ranked below ${me ? titleOf(me) : 'yours'}.`}
      </p>
      {error && <p style={styles.error}>{error}</p>}

      {editing?.kind === 'new' && me && (
        <RoleEditor space={space} me={me} existing={null} roles={roles} collections={collections} onDone={() => setEditing(null)} />
      )}

      <ul style={{ ...list, gap: 8 }}>
        {roles.map((role) => {
          const why = roleChangeRefusal(me, role, null);
          const count = holders(role.name);
          const open = editing?.kind === 'edit' && editing.name === role.name;
          return (
            <li key={role.name} style={card}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ color: palette.ink.strong, fontSize: 15 }}>{titleOf(role)}</strong>
                    {me?.name === role.name && <span style={styles.badge}>yours</span>}
                    <span style={{ fontSize: 12, color: palette.ink.faint }}>
                      <code>{role.name}</code> · rank {role.rank} · {count} {count === 1 ? 'person' : 'people'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {role.permissions.length === 0 ? (
                      <span style={{ fontSize: 12, color: palette.ink.faint }}>Only what every role can do</span>
                    ) : (
                      role.permissions.map((p) => (
                        <span key={p} title={p} style={chip}>
                          {permissionLabel(p, collections)}
                        </span>
                      ))
                    )}
                  </div>
                  {why && <span style={{ fontSize: 12, color: palette.ink.faint }}>{why}</span>}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => setEditing(open ? null : { kind: 'edit', name: role.name })} disabled={!!why} title={why ?? undefined} data-variant="quiet" style={styles.smallButton}>
                    {open ? 'Close' : 'Edit'}
                  </button>
                  <button onClick={() => void remove(role)} disabled={!!why} title={why ?? undefined} data-variant="danger" style={{ ...styles.smallButton, color: palette.accent.danger }}>
                    Remove
                  </button>
                </div>
              </div>
              {open && me && <RoleEditor space={space} me={me} existing={role} roles={roles} collections={collections} onDone={() => setEditing(null)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Content writer" → "content-writer": a role's key, from its title */
const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 40);

/** A rank strictly between two, whole when there is room */
const between = (upper: number, lower: number) => (upper - lower >= 2 ? Math.floor((upper + lower) / 2) : (upper + lower) / 2);

/** Making a role, or changing one: its title, where it ranks, and what it may do */
function RoleEditor({
  space,
  me,
  existing,
  roles,
  collections,
  onDone,
}: {
  space: SpaceSummary;
  me: SpaceRole;
  existing: SpaceRole | null;
  roles: ReadonlyArray<SpaceRole>;
  collections: ReadonlyArray<NodeCollection>;
  onDone: () => void;
}) {
  const node = useNode();
  const others = roles.filter((r) => r.name !== existing?.name);
  const lowest = others.at(-1);
  const [title, setTitle] = useState(existing?.title ?? existing?.name ?? '');
  // A new role lands just below the lowest one you may place it under.
  const [rank, setRank] = useState(String(existing?.rank ?? (lowest && lowest.rank < me.rank ? lowest.rank - 10 : me.rank - 10)));
  const [permissions, setPermissions] = useState<ReadonlySet<string>>(new Set(existing?.permissions ?? []));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const name = existing?.name ?? slug(title);
  const draft: SpaceRole = { name, title: title.trim() || undefined, rank: Number(rank), permissions: [...permissions] };
  const problem =
    !title.trim()
      ? 'Give it a title'
      : !name
        ? 'The title needs at least one letter or number'
        : !existing && roles.some((r) => r.name === name)
          ? `There's already a role called “${name}”`
          : rank.trim() === '' || !Number.isFinite(draft.rank)
            ? 'Its rank has to be a number'
            : roleChangeRefusal(me, existing, draft, collections);

  const toggle = (permission: string, on: boolean) => {
    const next = new Set(permissions);
    if (on) next.add(permission);
    else next.delete(permission);
    setPermissions(next);
  };

  // Places it could go: just below each role at or under yours.
  const places = others
    .filter((r) => r.rank <= me.rank)
    .map((r) => {
      const next = others.find((o) => o.rank < r.rank);
      return { label: `Just below ${titleOf(r)}`, rank: next ? between(r.rank, next.rank) : r.rank - 10 };
    });

  const options = permissionOptions(collections);
  const groups = [...new Set(options.map((o) => o.group))].map((group) => ({ group, options: options.filter((o) => o.group === group) }));
  const known = new Set([...WILDCARD_OPTIONS, ...options].map((o) => o.permission));
  const extras: ReadonlyArray<PermissionOption> = [...permissions]
    .filter((p) => !known.has(p))
    .map((p) => ({ permission: p, label: permissionLabel(p, collections), description: p, group: 'Other', collection: null }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await node.spaces.putRole(space.id, draft);
      onDone();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: existing ? 14 : 0, padding: 16, borderRadius: palette.radius.md, background: palette.surface.sunken, border: `1px solid ${palette.surface.line}` }}>
      {!existing && <strong style={{ color: palette.ink.strong }}>New role</strong>}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ flex: '2 1 200px' }}>
          <p style={styles.fieldLabel}>Title</p>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Reviewer" maxLength={80} style={styles.input} autoFocus={!existing} />
          <p style={{ fontSize: 12, color: palette.ink.faint, marginTop: 4 }}>
            {existing ? 'Its key stays ' : 'Its key will be '}
            <code>{name || '…'}</code>
          </p>
        </label>
        <label style={{ flex: '1 1 110px' }}>
          <p style={styles.fieldLabel}>Rank</p>
          <input type="number" value={rank} onChange={(e) => setRank(e.target.value)} style={styles.input} />
          <p style={{ fontSize: 12, color: palette.ink.faint, marginTop: 4 }}>Below yours ({me.rank})</p>
        </label>
        {places.length > 0 && (
          <label style={{ flex: '2 1 180px' }}>
            <p style={styles.fieldLabel}>Or place it</p>
            <select value="" onChange={(e) => e.target.value !== '' && setRank(e.target.value)} style={styles.input}>
              <option value="">Choose a place…</option>
              {places.map((p) => (
                <option key={p.label} value={String(p.rank)}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ ...styles.fieldLabel, marginBottom: 0 }}>What it can do, besides what every role can</p>
        {[{ group: 'Shortcuts', options: WILDCARD_OPTIONS }, ...groups, ...(extras.length ? [{ group: 'Other', options: extras }] : [])].map(({ group, options: shown }) => (
          <fieldset key={group} style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <legend style={{ fontSize: 13, fontWeight: 600, color: palette.ink.strong, marginBottom: 4, padding: 0 }}>{group}</legend>
            {shown.map((o) => {
              const checked = permissions.has(o.permission);
              // Held already through a broader one, like Everything.
              const coveredBy = [...permissions].find((p) => p !== o.permission && permissionMatches(p, o.permission));
              const mayGive = canGrant(me, o.permission);
              const disabled = !!coveredBy || (!checked && !mayGive);
              const note = coveredBy
                ? `Included in ${permissionLabel(coveredBy, collections)}`
                : !mayGive
                  ? checked
                    ? "You don't have this yourself — untick it to save"
                    : "You can't give this — you don't have it yourself"
                  : null;
              return (
                <label key={o.permission} style={{ ...styles.checkboxRow, alignItems: 'flex-start', opacity: disabled ? 0.55 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
                  <input type="checkbox" checked={checked || !!coveredBy} disabled={disabled} onChange={(e) => toggle(o.permission, e.target.checked)} style={styles.checkbox} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span style={{ color: palette.ink.strong, fontSize: 13, fontWeight: 500 }}>{o.label}</span>
                    <span style={{ color: palette.ink.muted, fontSize: 12, lineHeight: 1.5 }}>{o.description}</span>
                    {note && <span style={{ color: palette.ink.faint, fontSize: 12 }}>{note}</span>}
                  </span>
                </label>
              );
            })}
          </fieldset>
        ))}
      </div>

      {existing && existing.rank > draft.rank && holdersNote}
      {problem && <p style={{ fontSize: 13, color: palette.ink.muted }}>{problem}</p>}
      {error && <p style={styles.error}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => void save()} disabled={!!problem || saving} data-variant="primary" style={{ ...styles.addButton, height: 34 }}>
          {saving ? 'Saving…' : existing ? 'Save role' : 'Create role'}
        </button>
        <button onClick={onDone} data-variant="quiet" style={{ ...variants.quiet, width: 'auto', height: 34 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const holdersNote = (
  <p style={{ fontSize: 12, color: palette.ink.faint }}>Lowering a role keeps what its holders already wrote; it only changes what they can do from now on.</p>
);

// ─── Members ──────────────────────────────────────────────────────────

function Members({
  space,
  access,
  me,
  people,
  collections,
  inviting,
}: {
  space: SpaceSummary;
  access: SpaceAccess;
  me: string;
  people: People;
  collections: ReadonlyArray<NodeCollection>;
  inviting: boolean;
}) {
  const node = useNode();
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(inviting);
  const mine = access.role;
  const roleNamed = (name: string) => access.roles.find((r) => r.name === name) ?? null;
  const giveable = assignableRoles(mine, access.roles);
  const members = new Set(access.members.map((m) => m.did));
  // People who said who they are here but hold no role: they follow along.
  const followers = [...people.keys()].filter((did) => !members.has(did));

  const change = async (did: string, role: string | null, ask?: string) => {
    if (ask && !globalThis.confirm(ask)) return;
    setError(null);
    try {
      await node.spaces.setMember(space.id, did, role);
    } catch (e) {
      setError(plainError(e));
    }
  };
  const closeInvite = async (key: string) => {
    if (!globalThis.confirm('Close this invite link? Nobody new can join with it. People who already joined keep their role.')) return;
    setError(null);
    try {
      await node.spaces.closeInvite(space.id, key);
    } catch (e) {
      setError(plainError(e));
    }
  };

  const row = (did: string, current: SpaceRole | null) => {
    const self = did === me;
    const name = nameOf(did, people);
    const cannotChange = memberChangeRefusal(mine, self, current, current);
    const cannotRemove = memberChangeRefusal(mine, self, current, null);
    const choices = current && !giveable.some((r) => r.name === current.name) ? [current, ...giveable] : giveable;
    return (
      <li key={did} style={{ ...styles.row, padding: '8px 4px' }}>
        <Avatar did={did} size={28} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{ color: palette.ink.strong, fontSize: 14 }}>
            {name} {self && <span style={{ color: palette.ink.faint, fontWeight: 400 }}>· you</span>}
          </span>
          {cannotChange && !self && mine && roleHolds(mine, 'manage') && <span style={{ fontSize: 12, color: palette.ink.faint }}>{cannotChange}</span>}
        </div>
        {cannotChange ? (
          <span style={{ fontSize: 13, color: palette.ink.muted }} title={cannotChange}>
            {current ? titleOf(current) : 'Following'}
          </span>
        ) : (
          <select
            aria-label={`Role for ${name}`}
            value={current?.name ?? ''}
            onChange={(e) => void change(did, e.target.value)}
            style={{ ...styles.input, width: 'auto', height: 32, fontSize: 13 }}
          >
            {!current && (
              <option value="" disabled>
                Following — give a role…
              </option>
            )}
            {choices.map((r) => (
              <option key={r.name} value={r.name}>
                {titleOf(r)}
              </option>
            ))}
          </select>
        )}
        {current && (
          <button
            onClick={() =>
              void change(
                did,
                null,
                self
                  ? `Give up your ${titleOf(current)} role? You'll still see the space, but you won't be able to change anything until someone gives you a role again.`
                  : `Remove ${name} from the space? They lose the ${titleOf(current)} role: they can still see what's here, but not change anything. What they already wrote stays.`,
              )
            }
            disabled={!!cannotRemove}
            title={cannotRemove ?? undefined}
            data-variant="danger"
            style={{ ...styles.smallButton, color: palette.accent.danger }}
          >
            {self ? 'Give up role' : 'Remove'}
          </button>
        )}
      </li>
    );
  };

  const invites = access.invites.filter((i) => i.open);
  return (
    <section style={section} aria-label="Members">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ ...styles.appTitle, fontSize: 20 }}>People ({access.members.length})</h2>
        <button onClick={() => setInviteOpen(!inviteOpen)} data-variant={inviteOpen ? 'quiet' : 'primary'} style={styles.smallButton}>
          {inviteOpen ? 'Close' : 'Invite people'}
        </button>
      </div>
      {inviteOpen && <Invite space={space} access={access} collections={collections} />}
      {error && <p style={styles.error}>{error}</p>}
      <ul style={{ ...list, gap: 0 }}>{access.members.map((m) => row(m.did, roleNamed(m.role)))}</ul>

      {followers.length > 0 && (
        <div>
          <p style={styles.fieldLabel}>Following, with no role</p>
          <ul style={{ ...list, gap: 0 }}>{followers.map((did) => row(did, null))}</ul>
        </div>
      )}

      {invites.length > 0 && (
        <div>
          <p style={styles.fieldLabel}>Open invite links</p>
          <ul style={{ ...list, gap: 0 }}>
            {invites.map((invite) => {
              const role = roleNamed(invite.role);
              const why = !roleHolds(mine, 'invite')
                ? 'Closing invites takes “Invite people”'
                : role && mine && role.rank > mine.rank
                  ? 'It gives a role ranked above yours'
                  : null;
              return (
                <li key={invite.key} style={{ ...styles.row, padding: '8px 4px' }}>
                  <span style={{ flex: 1, fontSize: 13, color: palette.ink.body }}>
                    Joins as <strong>{role ? titleOf(role) : invite.role}</strong>
                    {!role && <span style={{ color: palette.ink.faint }}> — that role is gone, so the link no longer works</span>}
                    <span style={{ color: palette.ink.faint }}> · …{invite.key.slice(-6)}</span>
                  </span>
                  <button onClick={() => void closeInvite(invite.key)} disabled={!!why} title={why ?? undefined} data-variant="quiet" style={styles.smallButton}>
                    Close link
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

/** What an invite gives, as the link-maker picks it: a role, or only a view */
const VIEW_ONLY = '';

/**
 * Making an invite link: pick what the person joins as, and get a link to send.
 *
 * Anyone in the space can hand out a link to view it. Joining with a role takes
 * “Invite people”, and only for roles up to your own — it lands on the lowest
 * one below yours, so the easy choice never gives away more than it should.
 */
function Invite({ space, access, collections }: { space: SpaceSummary; access: SpaceAccess; collections: ReadonlyArray<NodeCollection> }) {
  const node = useNode();
  const mine = access.role;
  const offered = mine && roleHolds(mine, 'invite') ? [...access.roles].filter((r) => r.rank <= mine.rank).sort((a, b) => b.rank - a.rank) : [];
  const fallback = [...offered].reverse().find((r) => mine && r.rank < mine.rank)?.name ?? VIEW_ONLY;
  const [choice, setChoice] = useState(fallback);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const role = offered.find((r) => r.name === choice) ?? null;

  const gives = role
    ? (() => {
        const { can } = abilitiesOf(role, access.roles, collections);
        const shown = can.slice(0, 3).map((a) => a.text);
        return can.length === 0
          ? 'They can see everything, and do only what every role can.'
          : `They can ${shown.join(', ')}${can.length > shown.length ? `, and ${can.length - shown.length} more` : ''}.`;
      })()
    : 'They can see everything, but change nothing.';

  const make = async () => {
    setError(null);
    try {
      const next = await createInviteLink(node, space.id, role?.name ?? null);
      setLink(next);
      setCopied(await globalThis.navigator.clipboard?.writeText(next).then(() => true, () => false) ?? false);
    } catch (e) {
      setError(plainError(e));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, borderRadius: palette.radius.md, background: palette.surface.sunken, border: `1px solid ${palette.surface.line}` }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, color: palette.ink.strong }}>People with the link join as</span>
        <select
          value={choice}
          onChange={(e) => {
            setChoice(e.target.value);
            setLink(null); // a link made for the other choice would say the wrong thing
          }}
          style={{ ...styles.input, width: 'auto', height: 32, fontSize: 13 }}
        >
          {offered.map((r) => (
            <option key={r.name} value={r.name}>
              {titleOf(r)}
            </option>
          ))}
          <option value={VIEW_ONLY}>Viewer — can't change anything</option>
        </select>
      </label>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: palette.ink.muted }}>
        {gives}
        {role && mine && role.rank >= mine.rank && ' That is as much as you have — only pick it for someone you trust to run the space.'}
        {space.visibility === 'private' && ' The space is encrypted, and the link carries its key, so send it only to the people it is for.'}
        {role && ' You can close it later.'}
      </p>
      {offered.length === 0 && mine && (
        <p style={{ fontSize: 12, color: palette.ink.faint }}>Inviting with a role takes “Invite people”, so you can only share it to view.</p>
      )}
      {error && <p style={styles.error}>{error}</p>}
      <button onClick={() => void make()} data-variant="primary" style={{ ...styles.addButton, height: 34, alignSelf: 'flex-start' }}>
        {link ? 'Make another link' : 'Create link'}
      </button>
      {link && (
        <div>
          <p style={{ fontSize: 12, color: palette.ink.muted }}>{copied ? 'Copied. Send it to them however you like.' : 'Copy this and send it to them however you like.'}</p>
          <code style={styles.token}>{link}</code>
        </div>
      )}
    </div>
  );
}

const section: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
const list: CSSProperties = { listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 };
const item: CSSProperties = { fontSize: 13, lineHeight: 1.6 };
const card: CSSProperties = { padding: 14, border: `1px solid ${palette.surface.line}`, borderRadius: palette.radius.md, background: palette.surface.card };
const chip: CSSProperties = { ...styles.badge, color: palette.ink.body, background: palette.surface.sunken };
