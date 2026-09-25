import { useState } from 'react';
import { useConnection } from '@weaveprotocol/core/react';
import { Wordmark } from './Wordmark';
import { styles, palette } from '../styles';

/**
 * Before the app is connected: one button that opens the account home.
 *
 * The home is where the person signs in — with a passkey, or the account
 * password from their password manager — and says what this app may use.
 * Nothing about the account is typed here. The home is theirs to choose: this
 * app suggests one, and anyone running their own types its address.
 */
export function ConnectScreen() {
  const { connection, state } = useConnection();
  const [own, setOwn] = useState<string | null>(null);
  const expired = state.status === 'expired';
  const waiting = state.status === 'connecting' || state.status === 'starting';
  const home = new URL(state.home).host;

  return (
    <div className="page">
      <div style={styles.card}>
        <div style={{ marginBottom: 40 }}>
          <Wordmark compact />
        </div>
        <h1 style={styles.title}>{expired ? 'Connect again' : 'Your spaces, in this app'}</h1>
        <p style={styles.subtitle}>
          {expired
            ? `This app's access to ${state.grant?.name ?? 'your account'} ran out. Your account home will ask you to allow it again.`
            : 'Connect your Weave account. You sign in at your account home, and choose what this app may use.'}
        </p>

        {own === null ? (
          <>
            <button onClick={() => void connection.connect()} disabled={waiting} data-variant="primary" style={styles.button}>
              {state.status === 'connecting' ? 'Waiting for your account home…' : 'Connect with Weave'}
            </button>
            <p style={{ ...styles.errorHint, marginTop: 16 }}>
              Opens <strong style={{ color: palette.ink.strong }}>{home}</strong> in a small window. This app gets a note signed by
              your account for its own key — never your password.
            </p>
            <div style={styles.linkRow}>
              <button onClick={() => setOwn('')} data-variant="ghost" style={{ ...styles.linkButton, paddingLeft: 0 }}>
                Use your own home
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              // Straight from the submit, so the browser lets the window open.
              void connection.connect(own);
            }}
            style={styles.form}
          >
            <input
              value={own}
              onChange={(event) => setOwn(event.target.value)}
              placeholder="home.example.com"
              aria-label="Your account home's address"
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              style={styles.input}
            />
            <button type="submit" disabled={waiting || !own.trim()} data-variant="primary" style={styles.button}>
              {state.status === 'connecting' ? 'Waiting for your account home…' : 'Connect'}
            </button>
            <p style={{ ...styles.errorHint, marginTop: 8 }}>
              The address of the Weave home you run yourself. This app remembers it.
            </p>
            <div style={styles.linkRow}>
              <button type="button" onClick={() => setOwn(null)} data-variant="ghost" style={{ ...styles.linkButton, paddingLeft: 0 }}>
                Use {home} instead
              </button>
            </div>
          </form>
        )}

        {state.error && (
          <div style={styles.errorBox}>
            <p style={styles.error}>{state.error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
