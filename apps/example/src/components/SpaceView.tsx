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
import { CommunitySetup } from '@weave/app-shared/CommunitySetup';
import { AppsView } from './apps/AppsView';
import { AppIcon, Count } from './apps/AppIcon';
import { CreateApp } from './apps/CreateApp';
import { MadeAppScreen } from './apps/MadeApps';
import { NotifyButton } from './apps/NotifyButton';
import { AutomationsView } from './automations/AutomationsView';
import { Bell } from './Bell';
import { HostingView } from './HostingView';
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
import { useBots } from '../bots';
import { PersonScopeProvider } from './Person';
import { markSeen, seenAt, totalOf, unreadOf, useSeen, useUnread, type Unread } from '../seen';

/** Under the hood: the views for the curious, folded at the foot of the sidebar */
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

/** How many apps the sidebar lists before the rest fold behind one row, so the space's own sections stay in view */
const SIDEBAR_APPS = 10;

/** Whether Under the hood was left open in the sidebar, in this browser */
const HOOD_OPEN_KEY = 'weave:hood-open';
const hoodWasOpen = (): boolean => {
  try {
    return globalThis.localStorage.getItem(HOOD_OPEN_KEY) === '1';
  } catch {
    return false;
  }
};

/** What belongs to the space rather than to one app, in sidebar order */
const SECTIONS = [
  { kind: 'people', label: 'People', icon: 'people' },
  { kind: 'hosting', label: 'Hosting', icon: 'cloud' },
  { kind: 'automations', label: 'Automations', icon: 'bolt' },
] as const satisfies ReadonlyArray<{ kind: string; label: string; icon: IconName }>;

/** What the main area shows: the apps, one of them open, the people, or a view under the hood */
type View =
  | { readonly kind: 'apps' }
  | { readonly kind: 'app'; readonly id: string; readonly since: string }
  | { readonly kind: 'people' }
  | { readonly kind: 'hosting' }
  | { readonly kind: 'automations' }
  /** A phone's list of the sections that have no tab of their own */
  | { readonly kind: 'more' }
  | { readonly kind: 'hood'; readonly hood: Hood };

/** One space, laid out like a chat app: its apps down a sidebar, the open one beside them */
export function SpaceView({
  space,
  spaces,
  notices,
  onOpenSpace,
  onHome,
}: {
  space: SpaceSummary;
  /** Every space, for the bell */
  spaces: ReadonlyArray<SpaceSummary>;
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
  const [everyApp, setEveryApp] = useState(false);
  const [hoodOpen, setHoodOpen] = useState(hoodWasOpen);
  const openHood = (open: boolean) => {
    setHoodOpen(open);
    try {
      globalThis.localStorage.setItem(HOOD_OPEN_KEY, open ? '1' : '0');
    } catch {
      // Only remembering it is lost.
    }
  };

  // Syncing while it is on screen. Opening writes nothing: standard schemas
  // are added only when someone picks them from the library.
  useHoldSpace(space.id);
  const collections = useCollections(space.id);
  const people = peopleFrom(useProfiles(space.id), useBots(space.id));
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
  // Wherever a view under the hood is opened from, the sidebar unfolds to show where one is.
  const goHood = (hood: Hood) => {
    setView({ kind: 'hood', hood });
    setHoodOpen(true);
  };
  const openRecord = (r: NodeRecord) =>
    setPlace((was) => ({ collection: view.kind === 'hood' ? r.collection : was.collection, key: r.key }));

  // An open app is looked at, as long as the page is: what arrives while it is counts as seen.
  const openId = open?.id;
  const newInOpen = openId ? unreadOf(unread, openId).count : 0;
  useEffect(() => {
    if (!openId) return;
    const look = () => {
      if (globalThis.document.visibilityState === 'visible') markSeen(account.did, space.id, openId);
    };
    look();
    globalThis.document.addEventListener('visibilitychange', look);
    return () => globalThis.document.removeEventListener('visibilitychange', look);
  }, [account.did, space.id, openId, newInOpen]);

  // The sidebar's apps: the first few, and the open one wherever it sits; the rest behind "more", with what is new in them.
  const folds = apps.ready.length > SIDEBAR_APPS;
  const listed =
    folds && !everyApp
      ? apps.ready.filter((app, at) => at < SIDEBAR_APPS || app.id === open?.id)
      : apps.ready;
  const folded = apps.ready.filter((app) => !listed.includes(app));
  const newInFolded = folded.reduce<Unread>(
    (sum, app) => {
      const one = unreadOf(unread, app.id);
      return { count: sum.count + one.count, forMe: sum.forMe + one.forMe };
    },
    { count: 0, forMe: 0 },
  );

  const fill = open ? fills(open, collections) : false;
  const title =
    open?.title ??
    (view.kind === 'people'
      ? 'People'
      : view.kind === 'automations'
        ? 'Automations'
        : view.kind === 'more'
          ? 'More'
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
          <div className="space-sidebar-scroll">
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
              {listed.map((app) => (
                <SideItem
                  key={app.id}
                  icon={<AppIcon icon={app.icon} hue={app.hue} size={20} />}
                  label={app.title}
                  unread={unreadOf(unread, app.id)}
                  on={open?.id === app.id}
                  onClick={() => openApp(app.id)}
                />
              ))}
              {folds && (
                <SideItem
                  icon={
                    <span
                      style={{
                        display: 'inline-flex',
                        transform: everyApp ? 'rotate(-90deg)' : 'rotate(90deg)',
                      }}
                    >
                      <Icon name="chevron" size={12} />
                    </span>
                  }
                  label={everyApp ? 'Show fewer' : `${folded.length} more`}
                  unread={newInFolded}
                  quiet
                  expanded={everyApp}
                  onClick={() => setEveryApp(!everyApp)}
                />
              )}
              {space.writable && (
                <SideItem
                  icon={<Icon name="plus" size={16} />}
                  label="Create an app"
                  quiet
                  onClick={() => setCreating(true)}
                />
              )}
              <SideHeading>Space</SideHeading>
              {SECTIONS.map((section) => (
                <SideItem
                  key={section.kind}
                  icon={<Icon name={section.icon} size={16} />}
                  label={section.label}
                  on={view.kind === section.kind}
                  onClick={() => setView({ kind: section.kind })}
                />
              ))}
            </nav>

            <nav
              aria-label="Under the hood"
              style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 'auto', paddingTop: 24 }}
            >
              <button
                onClick={() => openHood(!hoodOpen)}
                aria-expanded={hoodOpen}
                aria-current={!hoodOpen && view.kind === 'hood' ? 'page' : undefined}
                data-nav
                className="side-item"
                style={{ color: palette.ink.faint, fontSize: 13 }}
              >
                <span style={{ width: 20, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name="layers" size={14} />
                </span>
                <span style={{ ...ellipsis, flex: 1, minWidth: 0 }}>Under the hood</span>
                <span
                  style={{
                    display: 'inline-flex',
                    transform: hoodOpen ? 'rotate(90deg)' : 'none',
                    transition: 'transform .12s ease',
                  }}
                >
                  <Icon name="chevron" size={12} />
                </span>
              </button>
              {hoodOpen &&
                HOOD.map((h) => (
                  <SideItem
                    key={h.id}
                    icon={<Icon name={h.icon} size={16} />}
                    label={h.label}
                    quiet
                    on={view.kind === 'hood' && view.hood === h.id}
                    onClick={() => goHood(h.id)}
                  />
                ))}
            </nav>
          </div>

          {/* You, the way chat apps put you: at the foot of the sidebar, with what's new for you. */}
          <div className="you-bar">
            <AccountMenu place="sidebar" />
            <Bell spaces={spaces} here={space} place="above" onOpenSpace={onOpenSpace ?? (() => {})} />
          </div>
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
            {open && <NotifyButton space={space} app={open} collections={collections} />}
            <CallButton space={space} />
            {/* A phone has no sidebar, so you are in its top bar instead. */}
            <span className="phone-only">
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Bell spaces={spaces} here={space} onOpenSpace={onOpenSpace ?? (() => {})} />
                <AccountMenu />
              </span>
            </span>
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
                <CommunitySetup
                  spaceId={space.id}
                  writable={space.writable}
                  onAutomations={() => setView({ kind: 'automations' })}
                />
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
              {view.kind === 'more' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {SECTIONS.filter((section) => section.kind !== 'people').map((section) => (
                    <MoreRow
                      key={section.kind}
                      icon={section.icon}
                      label={section.label}
                      onClick={() => setView({ kind: section.kind })}
                    />
                  ))}
                  <SideHeading>Under the hood</SideHeading>
                  {HOOD.map((h) => (
                    <MoreRow key={h.id} icon={h.icon} label={h.label} quiet onClick={() => goHood(h.id)} />
                  ))}
                </div>
              )}
              {view.kind === 'people' && <RolesView space={space} collections={collections} />}
              {view.kind === 'hosting' && (
                <HostingView space={space} onAutomations={() => setView({ kind: 'automations' })} />
              )}
              {view.kind === 'automations' && <AutomationsView space={space} collections={collections} />}
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
                <GraphView space={space} collections={collections} />
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
                <Count unread={totalOf(unread)} />
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
            onClick={() => setView({ kind: 'more' })}
            aria-current={
              view.kind !== 'apps' && view.kind !== 'app' && view.kind !== 'people' ? 'page' : undefined
            }
          >
            <Icon name="menu" size={20} />
            More
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
          onReview={() => setView({ kind: 'apps' })}
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

/** A row of a phone's More: a section to open, tall enough for a thumb */
function MoreRow({
  icon,
  label,
  quiet,
  onClick,
}: {
  icon: IconName;
  label: string;
  quiet?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      data-nav
      className="side-item"
      style={{ height: 48, fontSize: 15, color: quiet ? palette.ink.muted : palette.ink.strong }}
    >
      <span style={{ width: 24, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
        <Icon name={icon} size={18} />
      </span>
      <span style={{ ...ellipsis, flex: 1, minWidth: 0 }}>{label}</span>
      <span style={{ display: 'inline-flex', color: palette.ink.faint }}>
        <Icon name="chevron" size={14} />
      </span>
    </button>
  );
}

/** A row in the sidebar; bold while something in it is new, the way unread channels are */
function SideItem({
  icon,
  label,
  unread,
  on,
  quiet,
  expanded,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  unread?: Unread;
  on?: boolean;
  quiet?: boolean;
  /** For a row that folds others away: whether they show now */
  expanded?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={on ? 'page' : undefined}
      aria-expanded={expanded}
      data-nav
      className="side-item"
      style={{
        color:
          on || (unread?.count ?? 0) > 0 ? palette.ink.strong : quiet ? palette.ink.muted : palette.ink.body,
        fontWeight: on || (unread?.count ?? 0) > 0 ? 600 : 400,
      }}
    >
      <span style={{ width: 20, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{ ...ellipsis, flex: 1, minWidth: 0 }}>{label}</span>
      {unread && <Count unread={unread} />}
    </button>
  );
}

const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
