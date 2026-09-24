import { useConnection } from 'weave-protocol/react';
import { Wordmark } from './Wordmark';
import { styles, palette } from '../styles';

/**
 * Before the app is connected: one button that opens the account home.
 *
 * The home is where the person signs in — with a passkey, or the account
 * password from their password manager — and says what this app may use.
 * Nothing about the account is typed here.
 */
export function ConnectScreen() {
  const { connection, state } = useConnection();
  const expired = state.status === 'expired';
  const waiting = state.status === 'connecting' || state.status === 'starting';
  const home = new URL(connection.home).host;

  return (
    <div style={styles.container}>
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

        <button onClick={() => void connection.connect()} disabled={waiting} data-variant="primary" style={styles.button}>
          {state.status === 'connecting' ? 'Waiting for your account home…' : 'Connect with Weave'}
        </button>

        {state.error && (
          <div style={styles.errorBox}>
            <p style={styles.error}>{state.error}</p>
          </div>
        )}

        <p style={{ ...styles.errorHint, marginTop: 20 }}>
          Opens <strong style={{ color: palette.ink.strong }}>{home}</strong> in a small window. This app gets a note signed by your
          account for its own key — never your password.
        </p>
      </div>
    </div>
  );
}
