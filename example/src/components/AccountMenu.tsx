import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAccount, useConnection } from 'weave-protocol/react';
import { Avatar } from './Avatar';
import { connectDesktopAgents, desktopAgentsEnabled } from '../webmcp';
import { palette } from '../styles';

/**
 * The avatar in the corner: who this app acts for, and a short menu.
 *
 * Everything about the account itself — its name, passkeys, staying signed
 * in, connected apps — lives in the account home, so "Account settings" opens
 * it. This app only knows how to disconnect itself.
 */
export function AccountMenu() {
  const account = useAccount();
  const { connection, state } = useConnection();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [agents, setAgents] = useState(desktopAgentsEnabled);
  const root = useRef<HTMLDivElement>(null);

  // A menu that stays open after you have clicked past it feels stuck.
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    globalThis.document.addEventListener('mousedown', dismiss);
    globalThis.document.addEventListener('keydown', onKey);
    return () => {
      globalThis.document.removeEventListener('mousedown', dismiss);
      globalThis.document.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
        <span>{account.name}</span>
      </button>

      {open && (
        <div role="menu" style={menu}>
          <div style={{ padding: '14px 14px 12px', display: 'flex', gap: 10, alignItems: 'center' }}>
            <Avatar did={account.did} size={36} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: palette.ink.strong, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {account.name}
              </div>
              <button
                onClick={() => {
                  void globalThis.navigator.clipboard?.writeText(account.did).then(() => {
                    setCopied(true);
                    globalThis.setTimeout(() => setCopied(false), 1500);
                  });
                }}
                title={`${account.did} — click to copy`}
                style={{ border: 'none', background: 'none', padding: 0, marginTop: 2, fontFamily: palette.mono, fontSize: 11.5, color: palette.ink.faint }}
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
                connectDesktopAgents(!agents);
                setAgents(!agents);
              }}
              hint={agents ? 'On' : 'Off'}
            >
              Desktop agents
            </Item>
          </div>

          <Divider />

          <div style={{ padding: 6 }}>
            <Item onClick={() => void connection.disconnect()} hint="Your account is untouched">
              Disconnect this app
            </Item>
          </div>
        </div>
      )}
    </div>
  );
}

/** One row of the menu: a label, and optionally a quieter line on the right */
function Item({ children, hint, onClick, disabled }: { children: ReactNode; hint?: string | undefined; onClick: () => void; disabled?: boolean }) {
  return (
    <button role="menuitem" onClick={onClick} disabled={disabled} data-menu-item style={item}>
      <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{children}</span>
      {hint && <span style={{ color: palette.ink.faint, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hint}</span>}
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
