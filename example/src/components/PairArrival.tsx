import type { AuthError } from '../hooks/useProtocol';
import type { PairingStage } from '../pairing';
import { Info } from './Info';
import { styles } from '../styles';

/** What each stage should say on the phone. */
function describe(stage: PairingStage): string {
  switch (stage.kind) {
    case 'waiting':
      return 'Looking for your computer…';
    case 'connected':
      return 'Found it. Collecting your spaces…';
    case 'received':
      return stage.spaces === 1 ? 'Got 1 space.' : `Got ${stage.spaces} spaces.`;
    case 'sent':
      return 'Done.';
    case 'failed':
      return stage.reason;
  }
}

/**
 * What the phone sees after its camera opened the pairing link.
 *
 * One button. Everything needed is already in the address bar, but signing in
 * still takes a tap: the code in the link is a secret, and a page that used it
 * the instant it loaded would sign someone in from a link they had merely
 * opened by accident.
 */
export function PairArrival({
  loading,
  error,
  stage,
  onAccept,
  onDismiss,
}: {
  loading: boolean;
  error: AuthError | null;
  stage: PairingStage | null;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div style={styles.container}>
      <div data-card style={styles.card}>
        <h1 style={styles.title}>Add this phone</h1>
        <p style={styles.subtitle}>You scanned a code from your computer.</p>
        <p style={styles.hint}>
          This phone becomes the same account, with its own copy of your spaces.
          <Info label="What happens next">
            It syncs with your computer when both are around, and keeps working when they are not.
            Your spaces come over the network directly between the two devices — the relay only
            introduces them.
          </Info>
        </p>

        <button onClick={onAccept} disabled={loading} data-variant="primary" style={styles.button}>
          {loading ? 'Setting up…' : 'Set up this phone'}
        </button>

        {stage && (
          <p style={stage.kind === 'failed' ? styles.error : styles.hint}>{describe(stage)}</p>
        )}

        {error && (
          <div style={styles.errorBox}>
            <p style={styles.error}>{error.message}</p>
            {error.hint && <p style={styles.errorHint}>{error.hint}</p>}
          </div>
        )}

        <p style={styles.errorHint}>Keep the code showing until this finishes.</p>

        <div style={styles.linkRow}>
          <button onClick={onDismiss} disabled={loading} data-variant="ghost" style={styles.linkButton}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
