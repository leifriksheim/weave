import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { useSession } from '../hooks/useProtocol';
import type { Session } from '../protocol';

import { Avatar } from './Avatar';
import { openAccountPassword } from '../accounts';
import { offerToSave } from '../credentials';
import { styles, palette } from '../styles';

/**
 * The avatar in the corner, and a short menu hanging off it: who you are, a
 * few things you can do to the account, and the way out.
 *
 * Deliberately small: passkeys and staying signed in are on the Security
 * page. The passkey diagnostics and the MetaMask hand-off (parked) used to
 * live here; they belong somewhere a person goes on
 * purpose, not in the menu they open to sign out.
 */
export function AccountMenu({ auth, session, onSecurity }: { auth: ReturnType<typeof useSession>; session: Session; onSecurity: () => void }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(session.account.name);
  const [copied, setCopied] = useState(false);
  // The name a password manager still files this account under, after a rename.
  const [staleAs, setStaleAs] = useState<string | null>(null);
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

  useEffect(() => setName(session.account.name), [session.account.name]);

  const home = auth.home;
  const hasPasskeyHere = (auth.entry?.shortcuts.length ?? 0) > 0;
  const did = session.rootDid;

  const rename = () => {
    const was = session.account.name;
    void auth.rename(name).then((ok) => {
      if (!ok) return;
      setRenaming(false);
      if (was !== name.trim() && openAccountPassword()) setStaleAs(was);
    });
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
        <Avatar did={did} size={28} />
        <span>{session.account.name}</span>
      </button>

      {open && (
        <div role="menu" style={menu}>
          {/* Who */}
          <div style={{ padding: '14px 14px 12px', display: 'flex', gap: 10, alignItems: 'center' }}>
            <Avatar did={did} size={36} />
            <div style={{ minWidth: 0, flex: 1 }}>
              {renaming ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    rename();
                  }}
                  style={{ display: 'flex', gap: 6 }}
                >
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    aria-label="Account name"
                    autoFocus
                    style={{ ...styles.input, height: 30, fontSize: 13, padding: '0 8px' }}
                  />
                  <button type="submit" data-variant="primary" disabled={!name.trim()} style={{ ...styles.smallButton, height: 30, background: '#000', color: '#fff', borderColor: '#000' }}>
                    Save
                  </button>
                </form>
              ) : (
                <div style={{ fontWeight: 600, fontSize: 14, color: palette.ink.strong, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {session.account.name}
                </div>
              )}
              <button
                onClick={() => {
                  void globalThis.navigator.clipboard?.writeText(did).then(() => {
                    setCopied(true);
                    globalThis.setTimeout(() => setCopied(false), 1500);
                  });
                }}
                title={`${did} — click to copy`}
                style={{ border: 'none', background: 'none', padding: 0, marginTop: 2, fontFamily: palette.mono, fontSize: 11.5, color: palette.ink.faint }}
              >
                {copied ? 'Copied' : `${did.slice(8, 16)}…${did.slice(-6)}`}
              </button>
            </div>
          </div>

          {staleAs && (
            <div style={{ ...notice, margin: '0 10px 10px' }}>
              Your password manager still files this account as <strong>{staleAs}</strong>.{' '}
              <button
                onClick={() => {
                  const password = openAccountPassword();
                  if (password) void offerToSave(session.account.name, password, session.account.name).then(() => setStaleAs(null));
                }}
                style={inlineLink}
              >
                Save it under the new name
              </button>
            </div>
          )}

          <Divider />

          <div style={{ padding: 6 }}>
            <Item onClick={() => setRenaming((was) => !was)}>{renaming ? 'Cancel rename' : 'Rename'}</Item>
            <Item
              onClick={() => {
                setOpen(false);
                onSecurity();
              }}
              hint={session.custody === 'local' && !hasPasskeyHere ? 'Passkey, stay signed in' : undefined}
            >
              Security
            </Item>
            <Item
              onClick={() => {
                // Closed first: what follows is a folder picker, then a dialog.
                setOpen(false);
                auth.chooseFolder();
              }}
              disabled={auth.loading}
              hint={home?.kind === 'folder' ? `Pod · ${home.directory?.name ?? 'folder'}` : 'Stored in this browser'}
            >
              {home?.kind === 'folder' ? 'Change pod' : 'Move to a pod'}
            </Item>
          </div>

          <Divider />

          <div style={{ padding: 6 }}>
            <Item onClick={auth.leave}>Sign out</Item>
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

const notice = {
  padding: '10px 12px',
  borderRadius: 8,
  background: palette.surface.sunken,
  border: `1px solid ${palette.surface.line}`,
  fontSize: 12.5,
  lineHeight: 1.5,
  color: palette.ink.muted,
};

const inlineLink = {
  border: 'none',
  background: 'none',
  padding: 0,
  color: palette.ink.strong,
  textDecoration: 'underline',
  fontSize: 12.5,
};
