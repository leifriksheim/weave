import { useRef, useState, type FormEvent } from 'react';
import type { AccountSummary } from 'weave-protocol';
import type { AuthError } from '../hooks/useProtocol';
import { accountCredentialName, deviceCredentialName, type AccountEntry, type Home } from '../accounts';

import { Avatar } from './Avatar';
import { Wordmark } from './ChooseStorage';
import { Info } from './Info';
import { offScreen } from '../credentials';
import { styles } from '../styles';


/**
 * Choosing an account, and getting into it.
 *
 * One screen rather than two, because "which account" and "prove it" are one
 * thought. The account this browser used last is expanded already; the others
 * are a click away.
 *
 * Which ways in appear depends on what the account has *on this domain*. A
 * passkey belongs to one origin and cannot be reached from another, so an
 * account made in a different app shows only the code — and once that is used
 * once here, a password or a passkey can be added and it never asks again.
 */
export function SignIn({
  home,
  accounts,
  entry,
  selectedId,
  loading,
  error,
  onSelect,
  onWithCode,
  onWithPassword,
  onWithPasskey,
  onCreate,
  onChangeFolder,
  onUseBrowser,
}: {
  home: Home;
  accounts: ReadonlyArray<AccountSummary>;
  /** Ways into the selected account, once it has been looked at */
  entry: AccountEntry | null;
  selectedId: string | null;
  loading: boolean;
  error: AuthError | null;
  onSelect: (id: string) => void;
  onWithCode: (code: string) => void;
  onWithPassword: (password: string) => void;
  onWithPasskey: () => void;
  onCreate: () => void;
  onChangeFolder: () => void;
  onUseBrowser: () => void;
}) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [showCode, setShowCode] = useState(false);
  // What a password manager last filled, which is not necessarily the account
  // whose row is open. Read from the DOM after a fill rather than tracked as
  // state, since autofill bypasses React's change handling.
  const filled = useRef<HTMLInputElement>(null);
  const [filledAs, setFilledAs] = useState('');

  const selected = accounts.find((account) => account.id === selectedId) ?? null;

  // An account with wraps, none of them usable here, has been used in another
  // app — a passkey belongs to one domain and cannot be reached from another.
  // An account with no wraps at all is simply new, and saying it is a stranger
  // would be confusing on the very app that made it.
  const seenElsewhere = (entry?.vault.wraps.length ?? 0) > 0;
  const submit = (event: FormEvent, action: () => void) => {
    event.preventDefault();
    action();
  };

  const codeForm = (
    <form onSubmit={(event) => submit(event, () => code.trim() && onWithCode(code.trim()))} style={styles.form}>
      {/* Off-screen, but deliberately not `display: none` — a field taken out
          of the layout is not counted as a username, while one merely moved
          out of view is filled normally.

          And writable: a manager fills the whole credential at once, so a
          read-only username keeps showing the account that was clicked while
          the password quietly belongs to another. Letting it be overwritten is
          what makes the mismatch detectable without putting a field on screen
          that says what the row above already says.

          Uncontrolled, because autofill sets the DOM value directly and React
          does not always see that as a change. */}
      <input
        key={selected?.id ?? 'none'}
        ref={filled}
        type="text"
        name="username"
        autoComplete="username"
        defaultValue={accountCredentialName(selected?.name ?? 'My account')}
        style={offScreen}
        tabIndex={-1}
        aria-hidden
      />
      <input
        type="password"
        name="password"
        value={code}
        onChange={(event) => {
          setCode(event.target.value);
          setFilledAs(filled.current?.value ?? '');
        }}
        placeholder="Your account password"
        disabled={loading}
        style={styles.input}
        autoComplete="current-password"
        spellCheck={false}
        aria-label="Account password"
      />
      <button type="submit" disabled={loading || !code.trim()} data-variant="primary" style={styles.button}>
        {loading ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );

  return (
    <div style={styles.container}>
      <div data-card style={styles.card}>
        <Wordmark />
        <h1 style={styles.title}>{accounts.length > 0 ? 'Welcome back' : 'Sign in'}</h1>
        <p style={styles.subtitle}>
          {accounts.length > 0 ? 'Choose your account.' : 'Paste the account password you saved when you made it.'}
        </p>

        {accounts.map((account) => {
          const isSelected = account.id === selectedId;
          return (
            <div key={account.id} style={styles.panelSection}>
              <button
                onClick={() => {
                  // Clicking the row already open must not wipe what is in it.
                  // The reset below belongs to *switching* accounts — running
                  // it again throws away a password the manager just filled,
                  // and closes the form it filled into.
                  if (isSelected) return;

                  setShowCode(false);
                  setPassword('');
                  setCode('');
                  setFilledAs('');
                  onSelect(account.id);
                }}
                aria-expanded={isSelected}
                disabled={loading}
                style={{
                  ...styles.spaceButton,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                }}
              >
                <Avatar did={account.did} />
                <span style={{ textAlign: 'left', flex: 1 }}>
                  <strong>{account.name}</strong>
                  <br />
                  <span style={styles.todoMeta}>
                    {account.did.slice(0, 18)}…{account.did.slice(-4)}
                  </span>
                </span>
              </button>

              {isSelected && entry && (
                <div style={{ marginTop: 10 }}>
                  {entry.shortcuts.length > 0 && !showCode && (
                    <button
                      onClick={onWithPasskey}
                      disabled={loading}
                      data-variant="primary"
                      style={styles.button}
                    >
                      {loading ? 'Waiting…' : 'Unlock with passkey'}
                    </button>
                  )}

                  {entry.hasPassword && !showCode && (
                    <form
                      onSubmit={(event) => submit(event, () => password && onWithPassword(password))}
                      style={{ ...styles.form, marginTop: entry.shortcuts.length > 0 ? 10 : 0 }}
                    >
                      <input
                        type="text"
                        name="username"
                        autoComplete="username"
                        value={deviceCredentialName(account.name)}
                        readOnly
                        style={offScreen}
                        tabIndex={-1}
                        aria-hidden
                      />
                      <input
                        type="password"
                        name="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="Password on this device"
                        disabled={loading}
                        style={styles.input}
                        autoComplete="current-password"
                        aria-label="Device password"
                        autoFocus={entry.shortcuts.length === 0}
                      />
                      <button type="submit" disabled={loading || !password} data-variant="primary" style={styles.button}>
                        Unlock
                      </button>
                    </form>
                  )}

                  {(showCode ||
                    (entry.shortcuts.length === 0 && !entry.hasPassword)) && (
                    <>
                      {entry.shortcuts.length === 0 && !entry.hasPassword && (
                        <p style={styles.errorHint}>
                          {seenElsewhere ? 'New to this app.' : 'No shortcut set up here yet.'}
                          <Info label="Why it is asking for the password">
                            {seenElsewhere
                              ? 'This account\u2019s shortcuts belong to the app that made them — a passkey works on one web address only. Sign in once with your account password and this app can add its own.'
                              : 'Once you are in, you can add a passkey so this app stops asking.'}
                          </Info>
                        </p>
                      )}
                      {codeForm}
                    </>
                  )}

                  {!showCode && (entry.shortcuts.length > 0 || entry.hasPassword) && (
                    <div style={styles.linkRow}>
                      <button
                        onClick={() => {
                          setFilledAs('');
                          setShowCode(true);
                        }}
                        disabled={loading}
                        data-variant="ghost"
                        style={styles.linkButton}
                      >
                        Use my account password instead
                      </button>
                    </div>
                  )}

                  {showCode &&
                    filledAs.trim() !== '' &&
                    filledAs.trim() !== accountCredentialName(account.name) && (
                      <p style={styles.error}>
                        Your password manager filled <strong>{filledAs}</strong>, not{' '}
                        <strong>{account.name}</strong>. Pick the entry named{' '}
                        <strong>{account.name}</strong>, or open that account instead.
                      </p>
                    )}
                </div>
              )}
            </div>
          );
        })}

        {accounts.length === 0 && (
          <>
            <p style={styles.hint}>
              {home.kind === 'folder' ? 'This pod has no accounts yet.' : 'No accounts in this browser yet.'}
              <Info label="Why this works with nothing stored">
                The password is your key written out, not a hint to look something up with — so it
                opens the account in an app that has never seen you. If your account is in a pod,
                opening the pod below brings it back without the password.
              </Info>
            </p>
            {codeForm}
          </>
        )}

        {error && (
          <div style={styles.errorBox}>
            <p style={styles.error}>{error.message}</p>
            {error.hint && <p style={styles.errorHint}>{error.hint}</p>}
          </div>
        )}

        <div style={styles.linkRow}>
          <button onClick={onCreate} disabled={loading} data-variant="ghost" style={styles.linkButton}>
            Create a new account
          </button>
        </div>

        <p style={styles.errorHint}>
          {home.kind === 'folder' ? `Pod: ${home.directory?.name ?? 'your folder'}` : 'Accounts kept in this browser'}
        </p>
        <div style={styles.linkRow}>
          <button onClick={onChangeFolder} disabled={loading} data-variant="ghost" style={styles.linkButton}>
            {home.kind === 'folder' ? 'Open a different pod' : 'Open a pod'}
          </button>
          {home.kind === 'folder' && (
            <button onClick={onUseBrowser} disabled={loading} data-variant="ghost" style={styles.linkButton}>
              Use this browser instead
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
