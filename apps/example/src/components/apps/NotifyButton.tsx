import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { NodeCollection, SpaceSummary } from '@weaveprotocol/core';
import { useDismiss } from '@weave/app-shared/useDismiss';
import { useNotifyFor } from '../../notifications';
import { Icon } from '../Icon';
import { styles, palette } from '../../styles';
import type { AppEntry } from './entries';
import { WatchBuilder } from '../automations/WatchBuilder';

/**
 * The bell on an open app. It offers what the app says is worth hearing
 * about, in this space, at two levels when the app has both: everything new,
 * or only what names you ("Mentions me", "Replies to me"), and anything more
 * particular built from the app's collections ("a task whose priority is at
 * least 3"). Turning one off, or pausing it, happens in the account home,
 * which the menu opens.
 */
export function NotifyButton({
  space,
  app,
  collections,
}: {
  space: SpaceSummary;
  app: AppEntry;
  collections: ReadonlyArray<NodeCollection>;
}) {
  const { everything, forMe, on, permission, error, asking, turnOn, allow, manage } = useNotifyFor(
    space.id,
    app.notify,
  );
  const [open, setOpen] = useState(false);
  const [building, setBuilding] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    root,
    useCallback(() => setOpen(false), []),
  );
  const own = [...new Set(app.notify.map((n) => n.collection))];
  if (everything.length === 0 && forMe.length === 0 && own.length === 0) return null;

  const any = on.everything || on.forMe;
  // Asked in a step of its own: a browser prompt opened with the home's window easily goes unseen behind it.
  const blocked = permission === 'denied';
  const unasked = permission === 'default';
  const labels = (list: typeof everything) => list.map((n) => n.label).join(', ');
  const choose = (list: typeof everything) => {
    setOpen(false);
    turnOn(list);
  };

  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((was) => !was)}
        disabled={asking}
        data-variant="quiet"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={
          asking
            ? 'Asking your account home'
            : blocked
              ? 'Notifications blocked'
              : any
                ? 'Notifications on'
                : 'Notify me'
        }
        title={error ?? (asking ? 'Answer in the account home window' : undefined)}
        style={{
          ...styles.smallButton,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: error || blocked ? palette.accent.danger : any ? palette.ink.strong : palette.ink.body,
        }}
      >
        <Icon name={any ? 'bellOn' : 'bell'} size={14} />
        <span className="bar-label">
          {asking
            ? 'Asking…'
            : blocked
              ? 'Blocked'
              : on.everything
                ? 'Everything'
                : on.forMe
                  ? 'For me'
                  : 'Notify me'}
        </span>
      </button>

      {open && (
        <div role="menu" className="popover" style={menu}>
          {blocked && (
            <p style={{ padding: '10px 12px', fontSize: 13, lineHeight: 1.5, color: palette.ink.body }}>
              Notifications are blocked for this site. To allow them, click the icon left of the address, set
              Notifications to Allow, then come back here.
            </p>
          )}
          {unasked && (
            <>
              <p
                style={{ padding: '10px 12px 6px', fontSize: 12, lineHeight: 1.45, color: palette.ink.faint }}
              >
                First, let this browser show notifications from {globalThis.location.host}.
              </p>
              <button role="menuitem" data-menu-item onClick={allow} style={row}>
                Allow notifications in this browser
              </button>
            </>
          )}
          {!blocked && !unasked && (
            <p style={{ padding: '10px 12px 6px', fontSize: 12, color: palette.ink.faint }}>
              Notify me in {space.name} about
            </p>
          )}
          {!blocked && !unasked && everything.length > 0 && (
            <Choice
              on={on.everything}
              title="Everything new"
              hint={labels(everything)}
              onClick={() => (on.everything ? setOpen(false) : choose(everything))}
            />
          )}
          {!blocked && !unasked && forMe.length > 0 && (
            <Choice
              on={on.forMe && !on.everything}
              title="Only what's for me"
              hint={labels(forMe)}
              onClick={() => (on.forMe ? setOpen(false) : choose(forMe))}
            />
          )}
          {on.everything && forMe.length > 0 && (
            <p style={{ padding: '4px 12px', fontSize: 12, lineHeight: 1.45, color: palette.ink.muted }}>
              To hear only what's for you, turn off “{labels(everything)}” in your account.
            </p>
          )}
          {!blocked && !unasked && (
            <button
              role="menuitem"
              data-menu-item
              onClick={() => {
                setOpen(false);
                setBuilding(true);
              }}
              style={row}
            >
              <span aria-hidden style={{ width: 16, flexShrink: 0, color: palette.ink.muted }}>
                +
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <span style={{ color: palette.ink.strong, fontWeight: 500 }}>Something more specific…</span>
                <span style={{ fontSize: 12, color: palette.ink.muted }}>Pick what, and only when</span>
              </span>
            </button>
          )}
          <div style={{ height: 1, background: palette.surface.line, margin: '6px 0' }} />
          <button
            role="menuitem"
            data-menu-item
            onClick={() => {
              setOpen(false);
              manage();
            }}
            style={{ ...row, color: palette.ink.muted }}
          >
            Pause or turn off, in your account
          </button>
          {error && (
            <p style={{ padding: '4px 12px 8px', fontSize: 12, color: palette.accent.danger }}>{error}</p>
          )}
        </div>
      )}
      {building && (
        <WatchBuilder
          space={space}
          collections={collections}
          prefer={own}
          onClose={() => setBuilding(false)}
        />
      )}
    </div>
  );
}

function Choice({
  on,
  title,
  hint,
  onClick,
}: {
  on: boolean;
  title: string;
  hint: string;
  onClick: () => void;
}): ReactNode {
  return (
    <button role="menuitemradio" aria-checked={on} data-menu-item onClick={onClick} style={row}>
      <span
        aria-hidden
        style={{
          width: 16,
          flexShrink: 0,
          color: palette.accent.good,
          fontWeight: 700,
          visibility: on ? 'visible' : 'hidden',
        }}
      >
        ✓
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span style={{ color: palette.ink.strong, fontWeight: 500 }}>{title}</span>
        <span style={{ fontSize: 12, color: palette.ink.muted }}>{hint}</span>
      </span>
    </button>
  );
}

const menu = {
  position: 'absolute',
  right: 0,
  top: 40,
  zIndex: 20,
  width: 280,
  padding: '0 0 6px',
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 12,
  background: palette.surface.card,
  boxShadow: '0 4px 12px rgba(0, 0, 0, .06), 0 16px 32px -12px rgba(0, 0, 0, .12)',
} as const;

const row = {
  width: '100%',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '8px 12px',
  border: 'none',
  background: 'none',
  fontSize: 14,
  textAlign: 'left',
} as const;
