import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useAccount, useConnection } from '@weaveprotocol/core/react';
import { Avatar } from '@weave/app-shared/Avatar';
import { useDismiss } from '@weave/app-shared/useDismiss';
import { useCopy } from '@weave/app-shared/action';
import { ConnectAgent } from './ConnectAgent';
import { useAppNotifications } from '../notifications';
import { palette } from '../styles';

/** The avatar in the corner: who this app acts for; the account itself lives in the account home */
export function AccountMenu() {
  const account = useAccount();
  const { connection, state } = useConnection();
  const [open, setOpen] = useState(false);
  const { copied, copy } = useCopy();
  const [connecting, setConnecting] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const notifications = useAppNotifications();

  useDismiss(
    open,
    root,
    useCallback(() => setOpen(false), []),
  );

  const openHome = () => {
    setOpen(false);
    // The account page sits beside the connect page, at whichever home the person uses.
    globalThis.open(new URL('.', state.home).href, 'weave-account', 'popup,width=720,height=820');
  };

  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-label="Account"
        className="account-button"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 36,
          padding: '0 12px 0 4px',
          border: `1px solid ${palette.surface.line}`,
          borderRadius: 999,
          background: palette.surface.card,
          color: palette.ink.strong,
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        <Avatar did={account.did} size={28} />
        <span className="account-name">{account.name}</span>
      </button>

      {open && (
        <div role="menu" style={menu}>
          <div style={{ padding: '14px 14px 12px', display: 'flex', gap: 10, alignItems: 'center' }}>
            <Avatar did={account.did} size={36} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 14,
                  color: palette.ink.strong,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {account.name}
              </div>
              <button
                onClick={() => copy(account.did)}
                title={`${account.did} — click to copy`}
                style={{
                  border: 'none',
                  background: 'none',
                  padding: 0,
                  marginTop: 2,
                  fontFamily: palette.mono,
                  fontSize: 11.5,
                  color: palette.ink.faint,
                }}
              >
                {copied ? 'Copied' : `${account.did.slice(8, 16)}…${account.did.slice(-6)}`}
              </button>
            </div>
          </div>

          <Divider />

          <div style={{ padding: 6 }}>
            <Item onClick={openHome} hint={new URL(state.home).host}>
              Account settings
            </Item>
            <Item
              onClick={() => {
                setOpen(false);
                setConnecting(true);
              }}
              hint="Claude Code, Desktop, Cursor"
            >
              Connect an agent
            </Item>
            <p style={{ margin: '4px 10px 6px', fontSize: 12, lineHeight: 1.45, color: palette.ink.faint }}>
              An agent in this browser works as you, with nothing to set up. One on your computer connects
              here, and keeps working with this tab closed.
            </p>
          </div>

          <Divider />

          <div style={{ padding: 6 }}>
            {notifications.permission === 'denied' ? (
              <p style={{ margin: '4px 10px 6px', fontSize: 12, lineHeight: 1.45, color: palette.ink.faint }}>
                Notifications are blocked for this site. Allow them from the icon left of the address, then
                come back here.
              </p>
            ) : notifications.permission === 'default' ? (
              // Its own step: a browser prompt opened with the home's window easily goes unseen behind it.
              <Item
                onClick={notifications.allow}
                hint={
                  notifications.on > 0 ? `${notifications.on} on in your account` : 'First, in this browser'
                }
              >
                Allow notifications here
              </Item>
            ) : notifications.on === 0 ? (
              <Item
                onClick={notifications.turnOn}
                disabled={notifications.asking}
                hint={notifications.asking ? 'Answer in your account home' : 'Messages, polls, contacts'}
              >
                {notifications.asking ? 'Asking your account home…' : 'Turn on notifications'}
              </Item>
            ) : (
              <Item
                onClick={() => {
                  setOpen(false);
                  notifications.manage();
                }}
                hint={`${notifications.on} on · manage`}
              >
                Notifications
              </Item>
            )}
            {notifications.error && (
              <p style={{ margin: '4px 10px 6px', fontSize: 12, lineHeight: 1.45, color: palette.ink.faint }}>
                {notifications.error}
              </p>
            )}
          </div>

          <Divider />

          <div style={{ padding: 6 }}>
            <Item onClick={() => void connection.disconnect()} hint="Your account is untouched">
              Disconnect this app
            </Item>
          </div>
        </div>
      )}
      {connecting && <ConnectAgent onClose={() => setConnecting(false)} />}
    </div>
  );
}

/** One row of the menu: a label, and optionally a quieter line on the right */
function Item({
  children,
  hint,
  onClick,
  disabled,
}: {
  children: ReactNode;
  hint?: string | undefined;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button role="menuitem" onClick={onClick} disabled={disabled} data-menu-item style={item}>
      <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{children}</span>
      {hint && (
        <span
          style={{
            color: palette.ink.faint,
            fontSize: 12,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {hint}
        </span>
      )}
    </button>
  );
}

function Divider() {
  return <div style={{ height: 1, background: palette.surface.line }} />;
}

const menu = {
  position: 'absolute' as const,
  right: 0,
  top: 44,
  zIndex: 20,
  width: 280,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 12,
  backgroundColor: palette.surface.card,
  boxShadow: '0 4px 12px rgba(0, 0, 0, .06), 0 16px 32px -12px rgba(0, 0, 0, .12)',
  animation: 'weave-fade .1s ease',
  overflow: 'hidden',
};

const item = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  height: 36,
  padding: '0 10px',
  border: 'none',
  borderRadius: 6,
  background: 'none',
  color: palette.ink.body,
  fontSize: 14,
  textAlign: 'left' as const,
};
