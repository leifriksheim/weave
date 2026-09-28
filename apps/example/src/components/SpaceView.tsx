import { useState } from 'react';
import type { NodeRecord, SpaceSummary } from '@weaveprotocol/core';
import {
  useAccess,
  useCollections,
  useHoldSpace,
  useProfiles,
  useAccount,
  useSpaceStatus,
} from '@weaveprotocol/core/react';
import { collectionLabel } from '../derive/schema-ui';
import { CollectionView } from './CollectionView';
import { RecordPanel } from './RecordPanel';
import { Library } from './Library';
import { NewCollection } from './NewCollection';
import { GraphView } from './GraphView';
import { QueryPlayground } from './QueryPlayground';
import { CollectionsOverview, namespaceLabel } from './CollectionsOverview';
import { namespaceOf } from '../derive/filters';
import { RolesView } from './RolesView';
import { AppsView } from './apps/AppsView';
import { SpaceMark } from './SpaceList';
import { AccountMenu } from './AccountMenu';
import { styles, palette } from '../styles';
import { Icon, type IconName } from './Icon';
import { WhoIsHere } from './WhoIsHere';
import { NetworkView } from './NetworkView';
import { RelayDown } from './RelayNotice';
import { CallButton } from './calls/Calls';
import { peopleFrom } from '../derive/people';
import { PersonScopeProvider } from './Person';

/** Where in the space we are: which collection, and which record is open beside it */
interface Place {
  readonly collection: string | null;
  readonly key: string | null;
}

/** Defining a new collection, in the main area */
const NEW = '__new__';
/** Every collection at once, in the main area */
const ALL = '__all__';

/**
 * What a space is for, first: its apps and its people. Everything else is
 * how it works, under the hood — the records apps write, how they point at
 * each other, asking of them, and how they reach other devices. Nothing is
 * hidden, only put second, so someone curious is one click from all of it.
 */
const SECTIONS = [
  { id: 'apps', label: 'Apps', icon: 'apps' },
  { id: 'people', label: 'People', icon: 'people' },
  { id: 'hood', label: 'Under the hood', icon: 'layers' },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: IconName }>;
type Section = (typeof SECTIONS)[number]['id'];

const HOOD = [
  {
    id: 'data',
    label: 'Data',
    icon: 'table',
    about: 'Every record in this space, collection by collection: what the apps read and write.',
  },
  {
    id: 'explore',
    label: 'Explore',
    icon: 'compass',
  },
  {
    id: 'query',
    label: 'Query',
    icon: 'search',
  },
  {
    id: 'network',
    label: 'Network',
    icon: 'network',
    about: 'Which devices this one syncs with, and how records travel between them.',
  },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: IconName; about?: string }>;
type Hood = (typeof HOOD)[number]['id'];

/**
 * One space, laid out like an app: its apps first, its people next, and how
 * it works under the hood. A record opens in a panel beside whichever is on
 * screen. All of it drawn from what the space says about itself — nothing
 * here knows what any of the records are.
 */
export function SpaceView({
  space,
  onOpenSpace,
  onHome,
}: {
  space: SpaceSummary;
  onOpenSpace?: (id: string) => void;
  /** Back to every space; on a phone the tab bar carries it */
  onHome: () => void;
}) {
  const account = useAccount();
  const [place, setPlace] = useState<Place>({ collection: null, key: null });
  const [section, setSection] = useState<Section>('apps');
  const [hood, setHood] = useState<Hood>('data');
  const tab = section === 'hood' ? hood : section;
  const goHood = (view: Hood) => {
    setSection('hood');
    setHood(view);
  };
  // Which namespace the Data tab shows; null for all of them.
  const [namespace, setNamespace] = useState<string | null>(null);

  // Syncing while it is on screen. Opening writes nothing: standard schemas
  // are added only when someone picks them from the library.
  useHoldSpace(space.id);
  const collections = useCollections(space.id);
  const profiles = useProfiles(space.id);
  const people = peopleFrom(profiles);
  const status = useSpaceStatus(space.id);
  const access = useAccess(space.id);
  const roleOf = new Map(
    (access?.members ?? []).map((m) => [
      m.did,
      access?.roles.find((r) => r.name === m.role)?.title ?? m.role,
    ]),
  );

  // The space's own collections come before the standard ones.
  const ordered = [...collections].sort(
    (a, b) => Number(a.name.startsWith('std.')) - Number(b.name.startsWith('std.')),
  );
  const namespaces = [...new Set(ordered.map((c) => namespaceOf(c.name)))];
  const shown = namespace === null ? ordered : ordered.filter((c) => namespaceOf(c.name) === namespace);
  // Collections under a heading for their namespace, when there is more than one to tell apart.
  const groups = (namespace === null ? namespaces : [namespace])
    .map((ns) => ({ ns, members: shown.filter((c) => namespaceOf(c.name) === ns) }))
    .filter((g) => g.members.length > 0);
  // Land on every collection at once rather than an empty page.
  const selected =
    place.collection === NEW
      ? NEW
      : ordered.some((c) => c.name === place.collection)
        ? place.collection
        : ordered.length
          ? ALL
          : null;
  const current = collections.find((c) => c.name === selected) ?? null;
  const openRecord = (r: NodeRecord) =>
    setPlace({
      collection: ordered.some((c) => c.name === r.collection) ? r.collection : selected,
      key: r.key,
    });

  return (
    <PersonScopeProvider
      space={space}
      people={people}
      roles={roleOf}
      me={account.did}
      {...(onOpenSpace ? { openSpace: onOpenSpace } : {})}
    >
      {tab !== 'network' && <RelayDown />}
      <header style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <SpaceMark space={space} size={44} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h1
              style={{
                ...styles.appTitle,
                fontSize: 24,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {space.name}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 12.5,
                  color: palette.ink.muted,
                }}
                title={
                  space.visibility === 'private'
                    ? 'Encrypted end to end: only people in the space hold the key'
                    : 'Not encrypted: anyone with the link can read it'
                }
              >
                <Icon name={space.visibility === 'private' ? 'lock' : 'globe'} size={12} />
                {space.visibility === 'private' ? 'Private' : 'Public'}
              </span>
              {status && <WhoIsHere status={status} people={people} onOpen={() => goHood('network')} />}
              {status && status.rejected > 0 && (
                <button
                  onClick={() => goHood('network')}
                  style={{ ...styles.badge, color: palette.accent.danger, border: 'none', cursor: 'pointer' }}
                  title="Records peers sent that failed validation"
                >
                  {status.rejected} rejected
                </button>
              )}
            </div>
          </div>
          <CallButton space={space} />
          <AccountMenu />
        </div>
        {!space.writable && (
          <p style={{ ...styles.errorHint, marginTop: 0 }}>
            {space.joining
              ? 'Joining — waiting for your invite to arrive from someone in the space. It will, once one of them is online.'
              : "You're following this space: you can see it but not change it. Someone who runs it can give you a role."}
          </p>
        )}
        <nav
          role="tablist"
          aria-label="This space"
          className="space-tabs scroll-x"
          style={{
            display: 'flex',
            gap: 4,
            boxShadow: `inset 0 -1px 0 ${palette.surface.line}`,
            marginTop: 8,
          }}
        >
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={section === s.id}
              onClick={() => setSection(s.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                height: 40,
                padding: '0 12px',
                border: 'none',
                borderBottom: `2px solid ${section === s.id ? palette.ink.strong : 'transparent'}`,
                background: 'none',
                color: section === s.id ? palette.ink.strong : palette.ink.muted,
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              <Icon name={s.icon} size={15} />
              {s.label}
            </button>
          ))}
        </nav>
      </header>

      {section === 'hood' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
          <div role="tablist" aria-label="Under the hood" className="segmented scroll-x">
            {HOOD.map((h) => (
              <button key={h.id} role="tab" aria-selected={hood === h.id} onClick={() => setHood(h.id)}>
                <Icon name={h.icon} size={14} />
                {h.label}
              </button>
            ))}
          </div>
          {HOOD.map(
            (h) =>
              h.id === hood &&
              'about' in h && (
                <p key={h.id} style={{ fontSize: 13, color: palette.ink.muted }}>
                  {h.about}
                </p>
              ),
          )}
        </div>
      )}

      {tab === 'apps' && (
        <AppsView
          space={space}
          collections={collections}
          onOpen={openRecord}
          onBuildByHand={() => {
            goHood('data');
            setPlace({ collection: NEW, key: null });
          }}
        />
      )}
      {tab === 'explore' && <GraphView space={space} collections={collections} onOpen={openRecord} />}
      {tab === 'query' && <QueryPlayground space={space} collections={collections} onOpen={openRecord} />}
      {tab === 'people' && <RolesView space={space} collections={collections} />}
      {tab === 'network' && <NetworkView space={space} status={status} />}

      {tab === 'data' && (
        <div className="space-layout">
          <aside className="space-side">
            {namespaces.length > 1 && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="collection-nav-heading" style={sideHeading}>
                  Namespace
                </span>
                <select
                  value={namespace ?? ALL}
                  onChange={(e) => setNamespace(e.target.value === ALL ? null : e.target.value)}
                  aria-label="Namespace"
                  style={{ ...styles.input, height: 34, fontSize: 13 }}
                >
                  <option value={ALL}>All namespaces</option>
                  {namespaces.map((ns) => (
                    <option key={ns} value={ns}>
                      {namespaceLabel(ns)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <nav aria-label="Collections" className="collection-nav">
              <span className="collection-nav-heading" style={sideHeading}>
                In this space
              </span>
              {ordered.length > 0 && (
                <button
                  onClick={() => setPlace({ collection: ALL, key: null })}
                  aria-current={selected === ALL ? 'page' : undefined}
                  data-nav
                  style={{ ...navItem, ...(selected === ALL ? navItemOn : {}) }}
                >
                  <span>All collections</span>
                  <span style={{ color: palette.ink.faint, fontSize: 12 }}>{shown.length}</span>
                </button>
              )}
              {groups.map((g) => (
                <div key={g.ns} style={{ display: 'contents' }}>
                  {groups.length > 1 && (
                    <span className="collection-nav-heading" style={groupHeading}>
                      {namespaceLabel(g.ns)}
                    </span>
                  )}
                  {g.members.map((c) => (
                    <button
                      key={c.name}
                      onClick={() => setPlace({ collection: c.name, key: null })}
                      aria-current={selected === c.name ? 'page' : undefined}
                      title={c.name}
                      data-nav
                      style={{ ...navItem, ...(selected === c.name ? navItemOn : {}) }}
                    >
                      <span>{collectionLabel(c)}</span>
                      <span style={{ color: palette.ink.faint, fontSize: 12 }}>{c.records}</span>
                    </button>
                  ))}
                </div>
              ))}
              {ordered.length === 0 && (
                <span style={{ fontSize: 13, color: palette.ink.faint, padding: '6px 10px' }}>
                  Nothing yet
                </span>
              )}
              {space.writable && (
                <button
                  onClick={() => setPlace({ collection: NEW, key: null })}
                  aria-current={selected === NEW ? 'page' : undefined}
                  data-nav
                  style={{ ...navItem, color: palette.ink.muted, ...(selected === NEW ? navItemOn : {}) }}
                >
                  + New collection
                </button>
              )}
            </nav>
          </aside>

          <main style={{ minWidth: 0 }}>
            {selected === NEW ? (
              <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <h2 style={{ ...styles.appTitle, fontSize: 22 }}>New collection</h2>
                <p style={{ fontSize: 13, color: palette.ink.muted }}>
                  Give it a name and some fields. Everything else — forms, lists, boards — is worked out from
                  this.
                </p>
                <NewCollection space={space} onDone={(name) => setPlace({ collection: name, key: null })} />
                <Library
                  space={space}
                  collections={collections}
                  title="Or add one from the library"
                  onAdded={(name) => setPlace({ collection: name, key: null })}
                />
              </section>
            ) : selected === ALL ? (
              <CollectionsOverview
                collections={shown}
                namespace={namespace}
                onOpen={(name) => setPlace({ collection: name, key: null })}
              />
            ) : selected ? (
              <CollectionView
                key={selected}
                space={space}
                name={selected}
                collection={current}
                collections={collections}
                onOpen={openRecord}
              />
            ) : (
              <div
                style={{
                  ...styles.emptyState,
                  padding: '64px 24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  alignItems: 'center',
                }}
              >
                <strong style={{ color: palette.ink.strong, fontSize: 15 }}>This space is empty</strong>
                <span>
                  Define a collection — or ask an agent: this page offers the space's operations as WebMCP
                  tools.
                </span>
                {space.writable && (
                  <button
                    onClick={() => setPlace({ collection: NEW, key: null })}
                    data-variant="primary"
                    style={{ ...styles.addButton, alignSelf: 'center' }}
                  >
                    New collection
                  </button>
                )}
              </div>
            )}
            {!selected && (
              <Library
                space={space}
                collections={collections}
                title="Start with a standard schema"
                onAdded={(name) => setPlace({ collection: name, key: null })}
              />
            )}
          </main>
        </div>
      )}

      {place.key && (
        <RecordPanel
          space={space}
          recordKey={place.key}
          collections={collections}
          onOpen={openRecord}
          onClose={() => setPlace({ collection: selected, key: null })}
        />
      )}

      {/* On a phone the sections move under the thumb, with the way home. */}
      <nav aria-label="This space" className="tabbar">
        <button onClick={onHome}>
          <Icon name="home" size={20} />
          Spaces
        </button>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            aria-current={section === s.id ? 'page' : undefined}
          >
            <Icon name={s.icon} size={20} />
            {s.label}
          </button>
        ))}
      </nav>
    </PersonScopeProvider>
  );
}

const sideHeading = {
  fontSize: 12,
  fontWeight: 500,
  color: palette.ink.faint,
  textTransform: 'uppercase' as const,
  letterSpacing: '.05em',
  padding: '0 10px 6px',
};
const groupHeading = {
  fontSize: 11,
  color: palette.ink.faint,
  padding: '12px 10px 4px',
  fontFamily: palette.mono,
};
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
