import { useEffect, useState, type ReactNode } from 'react';
import { DEFINE, roleHolds } from '@weaveprotocol/core';
import type { NodeRecord, SpaceSummary } from '@weaveprotocol/core';
import {
  useAccess,
  useCollections,
  useHoldSpace,
  useProfiles,
  useAccount,
  useSpaceStatus,
} from '@weaveprotocol/core/react';
import { RecordPanel } from './RecordPanel';
import { GraphView } from './GraphView';
import { QueryPlayground } from './QueryPlayground';
import { RolesView } from './RolesView';
import { AppsView } from './apps/AppsView';
import { AppIcon, Count } from './apps/AppIcon';
import { CreateApp } from './apps/CreateApp';
import { MadeAppScreen } from './apps/MadeApps';
import { NotifyButton } from './apps/NotifyButton';
import { fills, useSpaceApps, type AppEntry } from './apps/entries';
import { DataView, NEW, type Place } from './DataView';
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
import { markSeen, seenAt, useSeen, useUnread } from '../seen';

/**
 * How it works, under the hood: the records apps write, how they point at
 * each other, asking of them, and how they reach other devices. Nothing is
 * hidden, only put after the apps and the people, so someone curious is one
 * click from all of it.
 */
const HOOD = [
  {
    id: 'data',
    label: 'Data',
    icon: 'table',
    about: 'Every record in this space, collection by collection: what the apps read and write.',
  },
  { id: 'explore', label: 'Explore', icon: 'compass' },
  { id: 'query', label: 'Query', icon: 'search' },
  {
    id: 'network',
    label: 'Network',
    icon: 'network',
    about: 'Which devices this one syncs with, and how records travel between them.',
  },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: IconName; about?: string }>;
type Hood = (typeof HOOD)[number]['id'];

/** What the main area shows: the apps, one of them open, the people, or a view under the hood */
type View =
  | { readonly kind: 'apps' }
  | { readonly kind: 'app'; readonly id: string; readonly since: string }
  | { readonly kind: 'people' }
  | { readonly kind: 'hood'; readonly hood: Hood };

/**
 * One space, laid out the way chat apps do it: its apps down a sidebar with
 * what is new in each, and whichever is open taking the rest of the window.
 * People and the views under the hood sit below the apps. A record opens in
 * a panel beside whatever is on screen. On a phone the sidebar gives way to
 * the app grid and a tab bar, and an open app takes the whole screen.
 */
export function SpaceView({
  space,
  notices,
  onOpenSpace,
  onHome,
}: {
  space: SpaceSummary;
  /** Banners about the connection and invites, above whatever is open */
  notices?: ReactNode;
  onOpenSpace?: (id: string) => void;
  /** Back to every space; on a phone the tab bar carries it */
  onHome: () => void;
}) {
  const account = useAccount();
  const [view, setView] = useState<View>({ kind: 'apps' });
  const [place, setPlace] = useState<Place>({ collection: null, key: null });
  const [creating, setCreating] = useState(false);

  // Syncing while it is on screen. Opening writes nothing: standard schemas
  // are added only when someone picks them from the library.
  useHoldSpace(space.id);
  const collections = useCollections(space.id);
  const people = peopleFrom(useProfiles(space.id));
  const status = useSpaceStatus(space.id);
  const access = useAccess(space.id);
  const mayDefine = space.writable && roleHolds(access?.role, DEFINE);
  const roleOf = new Map(
    (access?.members ?? []).map((m) => [
      m.did,
      access?.roles.find((r) => r.name === m.role)?.title ?? m.role,
    ]),
  );

  const apps = useSpaceApps(space, collections);
  const unread = useUnread(space.id, apps.ready);
  const seen = useSeen();
  const open = view.kind === 'app' ? apps.ready.find((app) => app.id === view.id) : undefined;
  const openApp = (id: string) => setView({ kind: 'app', id, since: seenAt(seen, space.id, id) });
  const goHood = (hood: Hood) => setView({ kind: 'hood', hood });
  const openRecord = (r: NodeRecord) =>
    setPlace((was) => ({ collection: view.kind === 'hood' ? r.collection : was.collection, key: r.key }));

  // An open app is looked at, as long as the page is: what arrives while it is counts as seen.
  const openId = open?.id;
  const newInOpen = openId ? (unread.get(openId) ?? 0) : 0;
  useEffect(() => {
    if (!openId) return;
    const look = () => {
      if (globalThis.document.visibilityState === 'visible') markSeen(account.did, space.id, openId);
    };
    look();
    globalThis.document.addEventListener('visibilitychange', look);
    return () => globalThis.document.removeEventListener('visibilitychange', look);
  }, [account.did, space.id, openId, newInOpen]);

  const fill = open ? fills(open, collections) : false;
  const title =
    open?.title ??
    (view.kind === 'people'
      ? 'People'
      : view.kind === 'hood'
        ? HOOD.find((h) => h.id === view.hood)!.label
        : space.name);

  return (
    <PersonScopeProvider
      space={space}
      people={people}
      roles={roleOf}
      me={account.did}
      {...(onOpenSpace ? { openSpace: onOpenSpace } : {})}
    >
      <div className="space-shell" data-app-open={open ? '' : undefined}>
        <aside className="space-sidebar" aria-label={space.name}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px 12px' }}>
            <SpaceMark space={space} size={32} />
            <div style={{ minWidth: 0 }}>
              <strong style={{ ...ellipsis, display: 'block', fontSize: 15, color: palette.ink.strong }}>
                {space.name}
              </strong>
              <Privacy space={space} />
            </div>
          </div>
          {status && (
            <div style={{ padding: '0 8px 12px' }}>
              <WhoIsHere status={status} people={people} onOpen={() => goHood('network')} />
            </div>
          )}

          <nav aria-label="This space" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <SideItem
              icon={<Icon name="apps" size={16} />}
              label="All apps"
              on={view.kind === 'apps'}
              onClick={() => setView({ kind: 'apps' })}
            />
            <SideHeading>Apps</SideHeading>
            {apps.ready.map((app) => (
              <SideItem
                key={app.id}
                icon={<AppIcon icon={app.icon} hue={app.hue} size={20} />}
                label={app.title}
                count={unread.get(app.id) ?? 0}
                on={open?.id === app.id}
                onClick={() => openApp(app.id)}
              />
            ))}
            {space.writable && (
              <SideItem
                icon={<Icon name="plus" size={16} />}
                label="Create an app"
                quiet
                onClick={() => setCreating(true)}
              />
            )}
            <SideHeading>Space</SideHeading>
            <SideItem
              icon={<Icon name="people" size={16} />}
              label="People"
              on={view.kind === 'people'}
              onClick={() => setView({ kind: 'people' })}
            />
            <SideHeading>Under the hood</SideHeading>
            {HOOD.map((h) => (
              <SideItem
                key={h.id}
                icon={<Icon name={h.icon} size={16} />}
                label={h.label}
                on={view.kind === 'hood' && view.hood === h.id}
                onClick={() => goHood(h.id)}
              />
            ))}
          </nav>
        </aside>

        <main className="space-main">
          <header className="space-bar">
            {view.kind === 'app' ? (
              <button
                onClick={() => setView({ kind: 'apps' })}
                aria-label="All apps"
                data-variant="quiet"
                className="phone-only"
                style={{ ...styles.smallButton, width: 36, padding: 0 }}
              >
                <Icon name="back" size={16} />
              </button>
            ) : (
              <span className="phone-only" style={{ display: 'contents' }}>
                <SpaceMark space={space} size={30} />
              </span>
            )}
            {open && <AppIcon icon={open.icon} hue={open.hue} size={28} />}
            <h1 style={{ ...styles.appTitle, ...ellipsis, fontSize: 18, flex: 1, minWidth: 0 }}>{title}</h1>
            {open && <NotifyButton space={space} app={open} />}
            <CallButton space={space} />
            <AccountMenu />
          </header>

          <div className="space-content" data-fill={fill || undefined}>
            <div className="space-inner" data-wide={view.kind === 'hood' || undefined}>
              {notices}
              {view.kind !== 'hood' && <RelayDown />}
              {view.kind === 'apps' && (
                <div className="phone-only" style={{ marginBottom: 16 }}>
                  <Privacy space={space} />
                  {status && (
                    <div style={{ marginTop: 6 }}>
                      <WhoIsHere status={status} people={people} onOpen={() => goHood('network')} />
                    </div>
                  )}
                </div>
              )}
              {!space.writable && (
                <p style={{ ...styles.errorHint, marginTop: 0, marginBottom: 16 }}>
                  {space.joining
                    ? 'Joining — waiting for your invite to arrive from someone in the space. It will, once one of them is online.'
                    : "You're following this space: you can see it but not change it. Someone who runs it can give you a role."}
                </p>
              )}
              {status && status.rejected > 0 && view.kind !== 'app' && (
                <button
                  onClick={() => goHood('network')}
                  style={{
                    ...styles.badge,
                    color: palette.accent.danger,
                    border: 'none',
                    cursor: 'pointer',
                    marginBottom: 16,
                  }}
                  title="Records peers sent that failed validation"
                >
                  {status.rejected} rejected
                </button>
              )}

              {view.kind === 'hood' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                  <div role="tablist" aria-label="Under the hood" className="segmented phone-only scroll-x">
                    {HOOD.map((h) => (
                      <button
                        key={h.id}
                        role="tab"
                        aria-selected={view.hood === h.id}
                        onClick={() => goHood(h.id)}
                      >
                        <Icon name={h.icon} size={14} />
                        {h.label}
                      </button>
                    ))}
                  </div>
                  {HOOD.map(
                    (h) =>
                      h.id === view.hood &&
                      'about' in h && (
                        <p key={h.id} style={{ fontSize: 13, color: palette.ink.muted }}>
                          {h.about}
                        </p>
                      ),
                  )}
                </div>
              )}

              {view.kind === 'apps' && (
                <AppsView
                  space={space}
                  collections={collections}
                  apps={apps}
                  unread={unread}
                  mayDefine={mayDefine}
                  onOpenApp={openApp}
                  onCreate={() => setCreating(true)}
                />
              )}
              {open && view.kind === 'app' && (
                <OpenApp
                  key={open.id}
                  space={space}
                  app={open}
                  collections={collections}
                  since={view.since}
                  onOpen={openRecord}
                />
              )}
              {view.kind === 'app' && !open && (
                <p style={styles.emptyState}>This app isn't in the space any more.</p>
              )}
              {view.kind === 'people' && <RolesView space={space} collections={collections} />}
              {view.kind === 'hood' && view.hood === 'data' && (
                <DataView
                  space={space}
                  collections={collections}
                  place={place}
                  onPlace={setPlace}
                  onOpen={openRecord}
                />
              )}
              {view.kind === 'hood' && view.hood === 'explore' && (
                <GraphView space={space} collections={collections} onOpen={openRecord} />
              )}
              {view.kind === 'hood' && view.hood === 'query' && (
                <QueryPlayground space={space} collections={collections} onOpen={openRecord} />
              )}
              {view.kind === 'hood' && view.hood === 'network' && (
                <NetworkView space={space} status={status} />
              )}
            </div>
          </div>
        </main>

        {/* On a phone the sections move under the thumb, with the way home. */}
        <nav aria-label="This space" className="tabbar">
          <button onClick={onHome}>
            <Icon name="home" size={20} />
            Spaces
          </button>
          <button
            onClick={() => setView({ kind: 'apps' })}
            aria-current={view.kind === 'apps' || view.kind === 'app' ? 'page' : undefined}
          >
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <Icon name="apps" size={20} />
              <span className="tab-count">
                <Count n={[...unread.values()].reduce((a, b) => a + b, 0)} />
              </span>
            </span>
            Apps
          </button>
          <button
            onClick={() => setView({ kind: 'people' })}
            aria-current={view.kind === 'people' ? 'page' : undefined}
          >
            <Icon name="people" size={20} />
            People
          </button>
          <button
            onClick={() => goHood(view.kind === 'hood' ? view.hood : 'data')}
            aria-current={view.kind === 'hood' ? 'page' : undefined}
          >
            <Icon name="layers" size={20} />
            Under the hood
          </button>
        </nav>
      </div>

      {place.key && (
        <RecordPanel
          space={space}
          recordKey={place.key}
          collections={collections}
          onOpen={openRecord}
          onClose={() => setPlace((was) => ({ ...was, key: null }))}
        />
      )}

      {creating && (
        <CreateApp
          space={space}
          mayDefine={mayDefine}
          onClose={() => setCreating(false)}
          onBuildByHand={() => {
            goHood('data');
            setPlace({ collection: NEW, key: null });
          }}
        />
      )}
    </PersonScopeProvider>
  );
}

/** An open app: a built-in one's own view, or one made for the space */
function OpenApp({
  space,
  app,
  collections,
  since,
  onOpen,
}: {
  space: SpaceSummary;
  app: AppEntry;
  collections: Parameters<typeof MadeAppScreen>[0]['collections'];
  since: string;
  onOpen: (record: NodeRecord) => void;
}) {
  if (app.made)
    return <MadeAppScreen space={space} record={app.made} collections={collections} onOpen={onOpen} />;
  if (!app.builtIn) return null;
  const View = app.builtIn.View;
  return <View space={space} collections={collections} onOpen={onOpen} since={since} />;
}

/** Who can read the space, in a word */
function Privacy({ space }: { space: SpaceSummary }) {
  return (
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
      {space.role ? ` · ${space.role}` : ''}
    </span>
  );
}

function SideHeading({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        padding: '16px 8px 4px',
        fontSize: 11.5,
        fontWeight: 600,
        color: palette.ink.faint,
        textTransform: 'uppercase',
        letterSpacing: '.05em',
      }}
    >
      {children}
    </span>
  );
}

/** A row in the sidebar; bold while something in it is new, the way unread channels are */
function SideItem({
  icon,
  label,
  count = 0,
  on,
  quiet,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  on?: boolean;
  quiet?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={on ? 'page' : undefined}
      data-nav
      className="side-item"
      style={{
        color: on || count > 0 ? palette.ink.strong : quiet ? palette.ink.muted : palette.ink.body,
        fontWeight: on || count > 0 ? 600 : 400,
      }}
    >
      <span style={{ width: 20, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{ ...ellipsis, flex: 1, minWidth: 0 }}>{label}</span>
      <Count n={count} />
    </button>
  );
}

const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
