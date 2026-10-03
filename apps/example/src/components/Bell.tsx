import { useCallback, useRef, useState } from 'react';
import type { SpaceSummary } from '@weaveprotocol/core';
import { useAccount } from '@weaveprotocol/core/react';
import { useDismiss } from '@weave/app-shared/useDismiss';
import { markRead, useAlerts, useTabDot } from '../alerts';
import { ago } from '../derive/time';
import { SpaceMark } from './SpaceList';
import { Icon } from './Icon';
import { palette } from '../styles';

/** The latest things your notifications matched: a dot while some are new, and the list on a click */
export function Bell({
  spaces,
  onOpenSpace,
  place = 'below',
}: {
  spaces: ReadonlyArray<SpaceSummary>;
  onOpenSpace: (id: string) => void;
  /** Below the button, in a header; or beside it, on the rail */
  place?: 'below' | 'beside';
}) {
  const { did } = useAccount();
  const { items, unread } = useAlerts(did);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useTabDot(unread > 0);
  useDismiss(
    open,
    root,
    useCallback(() => setOpen(false), []),
  );

  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button
        onClick={() => {
          setOpen((was) => !was);
          markRead(did);
        }}
        aria-expanded={open}
        aria-label={unread ? `Activity, ${unread} new` : 'Activity'}
        title="Activity"
        style={button}
      >
        <Icon name="bell" />
        {unread > 0 && <span style={dot} aria-hidden />}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Activity"
          style={{ ...panel, ...(place === 'below' ? below : beside) }}
        >
          <p style={{ padding: '12px 14px 8px', fontWeight: 600, fontSize: 14, color: palette.ink.strong }}>
            Activity
          </p>
          {items.length === 0 ? (
            <p style={{ padding: '0 14px 14px', fontSize: 13, lineHeight: 1.5, color: palette.ink.muted }}>
              Nothing yet. What your notifications match shows up here, while this app is open.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', maxHeight: 360, overflowY: 'auto', padding: '0 6px 6px' }}>
              {items.map((item) => {
                const space = spaces.find((s) => s.id === item.space);
                return (
                  <li key={item.record}>
                    <button
                      data-menu-item
                      style={row}
                      onClick={() => {
                        setOpen(false);
                        onOpenSpace(item.space);
                      }}
                    >
                      {space ? <SpaceMark space={space} size={28} /> : <span style={{ width: 28 }} />}
                      <span
                        style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 500, color: palette.ink.strong }}>
                          {item.label}
                        </span>
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
          )}
        </div>
      )}
    </div>
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
const dot = {
  position: 'absolute' as const,
  top: 6,
  right: 7,
  width: 8,
  height: 8,
  borderRadius: 4,
  background: palette.accent.danger,
  boxShadow: `0 0 0 2px ${palette.surface.card}`,
};
const panel = {
  position: 'absolute' as const,
  zIndex: 20,
  width: 320,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 12,
  backgroundColor: palette.surface.card,
  boxShadow: '0 4px 12px rgba(0, 0, 0, .06), 0 16px 32px -12px rgba(0, 0, 0, .12)',
  animation: 'weave-fade .1s ease',
  overflow: 'hidden',
};
const below = { right: 0, top: 44 };
const beside = { left: 48, bottom: 0 };
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
