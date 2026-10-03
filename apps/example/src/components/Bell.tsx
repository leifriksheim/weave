import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { SpaceSummary } from '@weaveprotocol/core';
import { useAccount, useCollections } from '@weaveprotocol/core/react';
import { useDismiss } from '@weave/app-shared/useDismiss';
import { markRead, useAlerts, useTabDot } from '../alerts';
import { useAppNotifications, useSubscriptions } from '../notifications';
import { ago } from '../derive/time';
import { SpaceMark } from './SpaceList';
import { Icon } from './Icon';
import { WatchBuilder } from './automations/WatchBuilder';
import { palette } from '../styles';

type Tab = 'activity' | 'settings';

/**
 * Notifications, for the whole account in one place: what they matched lately, with a dot while
 * some are new, and what you asked to hear about, turned on or added to from here.
 */
export function Bell({
  spaces,
  here,
  onOpenSpace,
  place = 'below',
}: {
  spaces: ReadonlyArray<SpaceSummary>;
  /** The space on screen, where something more specific can be picked */
  here?: SpaceSummary | undefined;
  onOpenSpace: (id: string) => void;
  /** Below the button, in a header; or above the bar it sits in, at the foot of a space's sidebar */
  place?: 'below' | 'above';
}) {
  const { did } = useAccount();
  const { items, unread } = useAlerts(did);
  const setup = useAppNotifications();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('activity');
  const [building, setBuilding] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useTabDot(unread > 0);
  useDismiss(
    open,
    root,
    useCallback(() => setOpen(false), []),
  );

  // Nothing is on yet: what there is to see is how to turn them on.
  const off = setup.on === 0;

  return (
    // Above, the panel hangs from the whole bar rather than the button, as the account's menu does.
    <div ref={root} style={{ position: place === 'below' ? 'relative' : 'static' }}>
      <button
        onClick={() => {
          if (!open) setTab(off && items.length === 0 ? 'settings' : 'activity');
          setOpen((was) => !was);
          markRead(did);
        }}
        aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}
        title="Notifications"
        style={button}
      >
        <Icon name={off ? 'bell' : 'bellOn'} />
        {unread > 0 && (
          <span style={badge} aria-hidden>
            <span className="count">{unread > 99 ? '99+' : unread}</span>
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          style={{ ...panel, ...(place === 'below' ? below : above) }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '10px 10px 6px 14px' }}>
            <p style={{ flex: 1, fontWeight: 600, fontSize: 14, color: palette.ink.strong }}>Notifications</p>
            <div role="tablist" aria-label="Notifications" style={{ display: 'flex', gap: 2 }}>
              <TabButton on={tab === 'activity'} onClick={() => setTab('activity')}>
                Activity
              </TabButton>
              <TabButton on={tab === 'settings'} onClick={() => setTab('settings')}>
                Settings
              </TabButton>
            </div>
          </div>

          {tab === 'activity' ? (
            <Activity
              items={items}
              spaces={spaces}
              off={off}
              onSettings={() => setTab('settings')}
              onOpenSpace={(id) => {
                setOpen(false);
                onOpenSpace(id);
              }}
            />
          ) : (
            <Settings
              spaces={spaces}
              here={here}
              setup={setup}
              onBuild={() => {
                setOpen(false);
                setBuilding(true);
              }}
            />
          )}
        </div>
      )}
      {building && here && <Builder space={here} onClose={() => setBuilding(false)} />}
    </div>
  );
}

/** What notifications matched lately, newest first */
function Activity({
  items,
  spaces,
  off,
  onSettings,
  onOpenSpace,
}: {
  items: ReturnType<typeof useAlerts>['items'];
  spaces: ReadonlyArray<SpaceSummary>;
  off: boolean;
  onSettings: () => void;
  onOpenSpace: (id: string) => void;
}) {
  if (items.length === 0)
    return (
      <div style={{ padding: '4px 14px 14px', fontSize: 13, lineHeight: 1.5, color: palette.ink.muted }}>
        <p>Nothing yet. What your notifications match shows up here, while this app is open.</p>
        {off && (
          <button onClick={onSettings} style={{ ...link, marginTop: 8 }}>
            Turn notifications on →
          </button>
        )}
      </div>
    );
  return (
    <ul style={{ listStyle: 'none', maxHeight: 360, overflowY: 'auto', padding: '0 6px 6px' }}>
      {items.map((item) => {
        const space = spaces.find((s) => s.id === item.space);
        return (
          <li key={item.record}>
            <button data-menu-item style={row} onClick={() => onOpenSpace(item.space)}>
              {space ? <SpaceMark space={space} size={28} /> : <span style={{ width: 28 }} />}
              <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: palette.ink.strong }}>{item.label}</span>
                <span style={{ fontSize: 12, color: palette.ink.faint }}>
                  {space ? `${space.name} · ` : ''}
                  {ago(item.at)}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Whether this browser may show them, and what you asked to hear about, in every space */
function Settings({
  spaces,
  here,
  setup,
  onBuild,
}: {
  spaces: ReadonlyArray<SpaceSummary>;
  here: SpaceSummary | undefined;
  setup: ReturnType<typeof useAppNotifications>;
  onBuild: () => void;
}) {
  const watches = useSubscriptions();
  const where = (spaceIds: 'all' | ReadonlyArray<string>) =>
    spaceIds === 'all'
      ? 'All your spaces'
      : spaceIds.map((id) => spaces.find((s) => s.id === id)?.name ?? 'A space you left').join(', ');

  return (
    <div style={{ padding: '0 6px 6px' }}>
      {setup.permission === 'denied' ? (
        <p style={note}>
          Notifications are blocked for this site. Allow them from the icon left of the address, then come
          back here.
        </p>
      ) : setup.permission === 'default' ? (
        // Its own step: a browser prompt opened with the home's window easily goes unseen behind it.
        <Action
          onClick={setup.allow}
          title="Allow notifications in this browser"
          hint={
            setup.on > 0
              ? `${setup.on} on in your account`
              : `First, let ${globalThis.location.host} show them`
          }
          strong
        />
      ) : (
        setup.on === 0 && (
          <Action
            onClick={setup.turnOn}
            disabled={setup.asking}
            title={setup.asking ? 'Asking your account home…' : 'Turn on notifications'}
            hint={
              setup.asking ? 'Answer in your account home' : 'Messages, polls and contacts, in every space'
            }
            strong
          />
        )
      )}
      {setup.error && <p style={{ ...note, color: palette.accent.danger }}>{setup.error}</p>}

      {watches.length > 0 && (
        <>
          <p style={heading}>You hear about</p>
          <ul style={{ listStyle: 'none', maxHeight: 260, overflowY: 'auto' }}>
            {watches.map((sub) => (
              <li key={sub.id} style={{ ...row, cursor: 'default', opacity: sub.paused ? 0.55 : 1 }}>
                <span style={{ color: palette.ink.muted, display: 'inline-flex' }}>
                  <Icon name={sub.paused ? 'bell' : 'bellOn'} size={14} />
                </span>
                <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: palette.ink.strong }}>
                    {sub.label}
                  </span>
                  <span style={{ fontSize: 12, color: palette.ink.faint }}>
                    {where(sub.spaces)}
                    {sub.where !== undefined ? ' · with conditions' : ''}
                    {sub.paused ? ' · paused' : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div style={{ height: 1, background: palette.surface.line, margin: '6px 4px' }} />
      {here ? (
        <Action onClick={onBuild} title="Something specific…" hint={`Pick what, and when, in ${here.name}`} />
      ) : (
        <p style={note}>To pick something specific, open a space; an app's own bell offers its choices.</p>
      )}
      <Action onClick={setup.manage} title="Pause or remove, in your account ↗" quiet />
    </div>
  );
}

/** The builder needs the space's collections, which only a space on screen has synced */
function Builder({ space, onClose }: { space: SpaceSummary; onClose: () => void }) {
  const collections = useCollections(space.id);
  return <WatchBuilder space={space} collections={collections} onClose={onClose} />;
}

function TabButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={on}
      onClick={onClick}
      style={{
        height: 26,
        padding: '0 9px',
        border: 'none',
        borderRadius: 6,
        background: on ? palette.surface.sunken : 'none',
        color: on ? palette.ink.strong : palette.ink.muted,
        fontSize: 12.5,
        fontWeight: 500,
      }}
    >
      {children}
    </button>
  );
}

function Action({
  onClick,
  title,
  hint,
  disabled,
  strong,
  quiet,
}: {
  onClick: () => void;
  title: string;
  hint?: string;
  disabled?: boolean;
  strong?: boolean;
  quiet?: boolean;
}) {
  return (
    <button data-menu-item onClick={onClick} disabled={disabled} style={row}>
      <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span
          style={{
            fontSize: 13,
            fontWeight: strong ? 600 : 500,
            color: quiet ? palette.ink.muted : palette.ink.strong,
          }}
        >
          {title}
        </span>
        {hint && <span style={{ fontSize: 12, color: palette.ink.faint }}>{hint}</span>}
      </span>
    </button>
  );
}

const button = {
  position: 'relative' as const,
  width: 36,
  height: 36,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 999,
  background: palette.surface.card,
  color: palette.ink.strong,
};
const badge = {
  position: 'absolute' as const,
  top: -5,
  right: -6,
  pointerEvents: 'none' as const,
  borderRadius: 9,
  boxShadow: `0 0 0 2px ${palette.surface.card}`,
};
const panel = {
  position: 'absolute' as const,
  zIndex: 20,
  width: 340,
  maxWidth: 'calc(100vw - 24px)',
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 12,
  backgroundColor: palette.surface.card,
  boxShadow: '0 4px 12px rgba(0, 0, 0, .06), 0 16px 32px -12px rgba(0, 0, 0, .12)',
  animation: 'weave-fade .1s ease',
  overflow: 'hidden',
};
const below = { right: 0, top: 44 };
const above = { left: 0, bottom: 'calc(100% + 8px)' };
const row = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px',
  border: 'none',
  borderRadius: 8,
  background: 'none',
  textAlign: 'left' as const,
};
const heading = {
  padding: '8px 8px 2px',
  fontSize: 11.5,
  fontWeight: 600,
  letterSpacing: '.02em',
  textTransform: 'uppercase' as const,
  color: palette.ink.faint,
};
const note = { padding: '6px 8px', fontSize: 12.5, lineHeight: 1.45, color: palette.ink.muted };
const link = {
  border: 'none',
  background: 'none',
  padding: 0,
  fontSize: 13,
  fontWeight: 500,
  color: palette.ink.strong,
};
