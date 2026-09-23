import { useEffect, useRef, useState } from 'react';
import type { useSession } from '../hooks/useProtocol';
import type { Session } from '../protocol';
import type { PasskeyDiagnostics } from 'weave-protocol';

import { Avatar } from './Avatar';
import { DiagnosticsReport } from './DiagnosticsReport';
import { Info } from './Info';
import { openAccountPassword } from '../accounts';
import { offerToSave } from '../credentials';
import { styles, variants, palette } from '../styles';

const quiet = variants.quiet;

/**
 * The avatar in the corner, and what hangs off it.
 *
 * Where the account lives, the shortcuts this device could have, and the way
 * out. Everything here is about the account rather than the spaces, which is why
 * it is not in the page itself.
 */
export function AccountMenu({
  auth,
  session,
}: {
  auth: ReturnType<typeof useSession>;
  session: Session;
}) {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState(false);
  const [name, setName] = useState(session.account.name);
  // The name a password manager still has for this account, once it is no
  // longer the name the app shows.
  const [staleAs, setStaleAs] = useState<string | null>(null);
  const [resaved, setResaved] = useState(false);
  const [linked, setLinked] = useState(false);
  const [report, setReport] = useState<PasskeyDiagnostics | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);

  const runDiagnostics = async () => {
    setDiagnosing(true);
    try {
      setReport(await auth.diagnose());
    } finally {
      setDiagnosing(false);
    }
  };
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

  const home = auth.home;
  const hasPasskeyHere = (auth.entry?.shortcuts.length ?? 0) > 0 || added;

  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((was) => !was)}
        title={session.rootDid}
        aria-expanded={open}
        data-variant="quiet"
        style={{
          ...styles.linkButton,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 10px 5px 6px',
          border: `1px solid ${palette.surface.line}`,
          borderRadius: 999,
          color: palette.ink.strong,
        }}
      >
        <Avatar did={session.rootDid} size={28} />
        <span>{session.account.name}</span>
      </button>

      {open && (
        <div style={styles.menu}>
          <div style={styles.panelBody}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const was = session.account.name;
                void auth.rename(name).then((ok) => {
                  if (!ok || was === name.trim()) return;
                  setStaleAs(was);
                  setResaved(false);
                });
              }}
              style={styles.form}
            >
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Name this account"
                style={styles.input}
                aria-label="Account name"
              />
              {name.trim() !== session.account.name && (
                <button type="submit" data-variant="quiet" style={quiet}>
                  Rename
                </button>
              )}
            </form>
            {staleAs && (
              <div style={styles.errorBox}>
                <p style={styles.errorHint}>
                  Your password manager still lists this account as{' '}
                  <strong>{staleAs}</strong>. The password works either way — it is matched on the
                  site, not the name — but the label will be wrong.
                </p>
                {openAccountPassword() && !resaved && (
                  <button
                    onClick={() => {
                      const password = openAccountPassword();
                      if (!password) return;
                      void offerToSave(session.account.name, password, session.account.name).then(
                        () => setResaved(true),
                      );
                    }}
                    data-variant="quiet"
                    style={quiet}
                  >
                    Save it under the new name
                  </button>
                )}
                <p style={styles.errorHint}>
                  {resaved
                    ? `Saved as ${session.account.name}. The old ${staleAs} entry is still there — there is no way for a site to remove one, so delete it yourself if you want it gone.`
                    : 'This adds an entry rather than renaming one: a site can save a password but cannot rename or delete what is already saved.'}
                </p>
              </div>
            )}

            <p style={styles.todoMeta} title={session.rootDid}>
              {session.rootDid.slice(0, 22)}…{session.rootDid.slice(-6)}
            </p>

            <p style={styles.errorHint}>
              {home?.kind === 'folder' ? `📂 ${home.directory?.name ?? 'folder'}` : '🗄️ This browser'}
              <Info label="Where your spaces live">
                {home?.kind === 'folder'
                  ? 'Any app you point at this folder opens the same spaces. Copy it, back it up, or sync it and your devices follow.'
                  : 'Browser storage belongs to one web address, so another app cannot read these spaces — even the same app on a different address.'}
              </Info>
            </p>

            {session.custody === 'local' && !hasPasskeyHere && (
              <section style={styles.panelSection}>
                <p style={styles.sectionTitle}>Unlock faster here</p>
                <p style={styles.errorHint}>
                  So this app stops asking for your account password.
                  <Info label="How a passkey works here">
                    Any provider works — Touch ID, Windows Hello, Bitwarden, 1Password, iCloud. The
                    passkey confirms it is you; the key that opens the account stays in this
                    browser. So the shortcut is only good here, and your other apps each add their
                    own. Clearing site data removes it, and your account password brings you back.
                  </Info>
                </p>
                <button
                  onClick={() => void auth.addPasskey().then(setAdded)}
                  disabled={auth.loading}
                  data-variant="primary"
                  style={styles.addButton}
                >
                  {auth.loading ? 'Waiting…' : '🔑 Set up a passkey'}
                </button>


              </section>
            )}

            {added && (
              <p style={styles.ok}>
                A passkey will open this app now.
              </p>
            )}

            {session.custody === 'local' && auth.walletHere && !linked && (
              <section style={styles.panelSection}>
                <p style={styles.sectionTitle}>Take this account anywhere</p>
                <p style={styles.errorHint}>
                  So it opens on apps that have never seen it.
                  <Info label="Keeping an account in MetaMask">
                    No password to paste, and it follows your recovery phrase onto new devices.
                    MetaMask asks before taking it, and your account password keeps working either
                    way — the wallet is a convenience, not a dependency.
                  </Info>
                </p>
                <button
                  onClick={() => void auth.linkToWallet().then((ok) => setLinked(ok))}
                  disabled={auth.loading}
                  data-variant="quiet"
                  style={quiet}
                >
                  {auth.loading ? 'Waiting for MetaMask…' : '🦊 Keep this account in MetaMask'}
                </button>
              </section>
            )}

            {(linked || session.custody === 'remote') && (
              <p style={styles.ok}>🦊 This account is held in your wallet.</p>
            )}

            <details style={{ ...styles.panel, marginTop: 4 }}>
              <summary style={styles.panelSummary}>Passkey support on this browser</summary>
              <div style={styles.panelBody}>
                <p style={styles.errorHint}>
                  Creates a throwaway passkey and reports what your browser and provider actually
                  did with it.
                </p>
                <DiagnosticsReport report={report} onRun={runDiagnostics} running={diagnosing} />
              </div>
            </details>

            <div style={styles.linkRow}>
              <button onClick={auth.leave} data-variant="ghost" style={styles.linkButton}>
                Switch account
              </button>
              <button onClick={auth.chooseFolder} disabled={auth.loading} data-variant="ghost" style={styles.linkButton}>
                {home?.kind === 'folder' ? 'Change folder' : 'Open a folder'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
