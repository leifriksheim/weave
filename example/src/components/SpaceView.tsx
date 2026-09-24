import { useState } from 'react';
import type { NodeRecord, SpaceProfile, SpaceSummary } from 'weave-protocol';
import { useAccess, useCollections, useNode, useOpenSpace, useProfiles, useAccount, useSpaceStatus } from 'weave-protocol/react';
import { collectionLabel } from '../derive/schema-ui';
import { CollectionView } from './CollectionView';
import { RecordPanel } from './RecordPanel';
import { Library } from './Library';
import { NewCollection } from './NewCollection';
import { GraphView } from './GraphView';
import { QueryPlayground } from './QueryPlayground';
import { RolesView } from './RolesView';
import { AppsView } from './apps/AppsView';
import { spaceBadges } from './SpaceList';
import { styles, palette } from '../styles';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { WhoIsHere } from './WhoIsHere';
import { nameOf, peopleFrom } from '../derive/people';

/** Where in the space we are: which kind of thing, and which record is open beside it */
export interface Place {
  readonly collection: string | null;
  readonly key: string | null;
}

/** Defining a new kind of thing, in the main area */
const NEW = '__new__';

/** The ways of looking at one space: apps made for its data, the data itself, how it connects, asking of it, and who may do what */
const TABS = [
  { id: 'apps', label: 'Apps' },
  { id: 'data', label: 'Data' },
  { id: 'explore', label: 'Explore' },
  { id: 'query', label: 'Query' },
  { id: 'roles', label: 'People & roles' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/**
 * One space, laid out like an app: its kinds of things down the side, the
 * chosen one in the middle, and a record opening in a panel beside it. All of
 * it drawn from what the space says about itself — nothing here knows what
 * any of the things are.
 */
export function SpaceView({ space }: { space: SpaceSummary }) {
  const account = useAccount();
  const [place, setPlace] = useState<Place>({ collection: null, key: null });
  const [tab, setTab] = useState<Tab>('apps');
  // Set when "Invite people" brought us to People & roles, so the invite is already open there.
  const [inviting, setInviting] = useState(false);

  // Syncing while it is on screen. Opening writes nothing: standard schemas
  // are added only when someone picks them from the library.
  useOpenSpace(space.id);
  const collections = useCollections(space.id);
  const profiles = useProfiles(space.id);
  const people = peopleFrom(profiles);
  const status = useSpaceStatus(space.id);
  const access = useAccess(space.id);
  const roleOf = new Map((access?.members ?? []).map((m) => [m.did, access?.roles.find((r) => r.name === m.role)?.title ?? m.role]));

  // Every collection is a kind of thing; the space's own come before the standard ones.
  const kinds = [...collections].sort((a, b) => Number(a.name.startsWith('std.')) - Number(b.name.startsWith('std.')));
  // Land on the first kind of thing rather than an empty page.
  const selected = place.collection === NEW ? NEW : kinds.some((c) => c.name === place.collection) ? place.collection : (kinds[0]?.name ?? null);
  const current = collections.find((c) => c.name === selected) ?? null;
  const openRecord = (r: NodeRecord) => setPlace({ collection: kinds.some((c) => c.name === r.collection) ? r.collection : selected, key: r.key });

  return (
    <>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ ...styles.appTitle, fontSize: 26 }}>{space.name}</h1>
          <span style={{ ...styles.badge, display: 'inline-flex', alignItems: 'center', gap: 5 }} title={space.visibility === 'private' ? 'Encrypted end to end: only people in the space hold the key' : 'Not encrypted: anyone with the link can read it'}>
            <Icon name={space.visibility === 'private' ? 'lock' : 'globe'} size={12} />
            {spaceBadges(space)}
          </span>
          {status && <WhoIsHere status={status} />}
          {status && status.rejected > 0 && (
            <span style={{ ...styles.badge, color: palette.accent.danger }} title="Records peers sent that failed validation">
              {status.rejected} rejected
            </span>
          )}
        </div>
        {!space.writable && (
          <p style={{ ...styles.errorHint, marginTop: 0 }}>
            {space.joining
              ? 'Joining — waiting for your invite to arrive from someone in the space. It will, once one of them is online.'
              : "You're following this space: you can see it but not change it. Someone who runs it can give you a role."}
          </p>
        )}
        <nav role="tablist" aria-label="Views of this space" className="scroll-x" style={{ display: 'flex', gap: 4, boxShadow: `inset 0 -1px 0 ${palette.surface.line}`, marginTop: 12 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => {
                setTab(t.id);
                setInviting(false);
              }}
              style={{
                flexShrink: 0,
                height: 36,
                padding: '0 12px',
                border: 'none',
                borderBottom: `2px solid ${tab === t.id ? palette.ink.strong : 'transparent'}`,
                background: 'none',
                color: tab === t.id ? palette.ink.strong : palette.ink.muted,
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {tab === 'apps' && <AppsView space={space} collections={collections} onOpen={openRecord} />}
      {tab === 'explore' && <GraphView space={space} collections={collections} onOpen={openRecord} />}
      {tab === 'query' && <QueryPlayground space={space} collections={collections} onOpen={openRecord} />}
      {tab === 'roles' && <RolesView space={space} collections={collections} inviting={inviting} />}

      {tab === 'data' && <div className="space-layout">
        <aside className="space-side">
          <nav aria-label="Kinds of things" className="kinds">
            <span className="kinds-heading" style={sideHeading}>In this space</span>
            {kinds.map((c) => (
              <button
                key={c.name}
                onClick={() => setPlace({ collection: c.name, key: null })}
                aria-current={selected === c.name ? 'page' : undefined}
                data-nav
                style={{ ...navItem, ...(selected === c.name ? navItemOn : {}) }}
              >
                <span>{collectionLabel(c)}</span>
                <span style={{ color: palette.ink.faint, fontSize: 12 }}>{c.records}</span>
              </button>
            ))}
            {kinds.length === 0 && <span style={{ fontSize: 13, color: palette.ink.faint, padding: '6px 10px' }}>Nothing yet</span>}
            {space.writable && (
              <button onClick={() => setPlace({ collection: NEW, key: null })} aria-current={selected === NEW ? 'page' : undefined} data-nav style={{ ...navItem, color: palette.ink.muted, ...(selected === NEW ? navItemOn : {}) }}>
                + New kind of thing
              </button>
            )}
          </nav>
          <People profiles={profiles} me={account.did} roles={roleOf} people={people} />
          <section style={{ ...styles.panelSection, gap: 10 }}>
            <button
              onClick={() => {
                setInviting(true);
                setTab('roles');
              }}
              data-variant="quiet" style={{ ...styles.smallButton, alignSelf: 'flex-start' }}>
              Invite people
            </button>
          </section>
        </aside>

        <main style={{ minWidth: 0 }}>
          {selected === NEW ? (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h2 style={{ ...styles.appTitle, fontSize: 22 }}>New kind of thing</h2>
              <p style={{ fontSize: 13, color: palette.ink.muted }}>Give it a name and some fields. Everything else — forms, lists, boards — is worked out from this.</p>
              <NewCollection space={space} onDone={(name) => setPlace({ collection: name, key: null })} />
              <Library space={space} collections={collections} title="Or add one from the library" onAdded={(name) => setPlace({ collection: name, key: null })} />
            </section>
          ) : selected ? (
            <CollectionView key={selected} space={space} name={selected} collection={current} collections={collections} onOpen={openRecord} />
          ) : (
            <div style={{ ...styles.emptyState, padding: '64px 24px', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
              <strong style={{ color: palette.ink.strong, fontSize: 15 }}>This space is empty</strong>
              <span>Define a kind of thing — or ask an agent: this page offers the space's operations as WebMCP tools.</span>
              {space.writable && (
                <button onClick={() => setPlace({ collection: NEW, key: null })} data-variant="primary" style={{ ...styles.addButton, alignSelf: 'center' }}>
                  New kind of thing
                </button>
              )}
            </div>
          )}
          {!selected && (
            <Library space={space} collections={collections} title="Start with a standard schema" onAdded={(name) => setPlace({ collection: name, key: null })} />
          )}
        </main>
      </div>}

      {place.key && (
        <RecordPanel space={space} recordKey={place.key} collections={collections} onOpen={openRecord} onClose={() => setPlace({ collection: selected, key: null })} />
      )}
    </>
  );
}

const sideHeading = { fontSize: 12, fontWeight: 500, color: palette.ink.faint, textTransform: 'uppercase' as const, letterSpacing: '.05em', padding: '0 10px 6px' };
const navItem = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  height: 34,
  padding: '0 10px',
  border: 'none',
  borderRadius: 6,
  background: 'none',
  color: palette.ink.body,
  fontSize: 14,
  textAlign: 'left' as const,
};
const navItemOn = { background: palette.surface.sunken, color: palette.ink.strong, fontWeight: 500 };

/** Who is here: everyone who has said who they are in this space */
function People({ profiles, me, roles, people }: { profiles: ReadonlyArray<SpaceProfile>; me: string; roles: ReadonlyMap<string, string>; people: ReturnType<typeof peopleFrom> }) {
  if (profiles.length === 0) return null;
  return (
    <section style={styles.panelSection} aria-label="People">
      <h2 style={styles.sectionTitle}>People ({profiles.length})</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {profiles.map((p) => (
          <span key={p.did} title={p.did} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 10px 4px 4px', border: `1px solid ${palette.surface.line}`, borderRadius: 999, fontSize: 13 }}>
            <Avatar did={p.did} size={22} />
            <span style={{ color: palette.ink.strong }}>{nameOf(p.did, people)}</span>
            {p.did === me && <span style={{ color: palette.ink.faint }}>you</span>}
            {roles.has(p.did) && <span style={{ color: palette.ink.faint }}>{roles.get(p.did)?.toLowerCase()}</span>}
          </span>
        ))}
      </div>
    </section>
  );
}
