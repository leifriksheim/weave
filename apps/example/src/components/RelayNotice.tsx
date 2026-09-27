import { relayOnlyLocal, relayProblem } from '../relay';
import { styles } from '../styles';

/**
 * Without a reachable relay nothing syncs, and the only symptom is a peer
 * count that never moves. Better to say it than to look broken.
 */
export function RelayNotice() {
  const problem = relayProblem();
  if (problem) {
    return (
      <div style={styles.errorBox}>
        <p style={styles.error}>Peers cannot find each other</p>
        <p style={styles.errorHint}>{problem}</p>
        <p style={styles.errorHint}>Your spaces still work, and still save. They just will not reach your other devices until this is set.</p>
      </div>
    );
  }
  const local = relayOnlyLocal();
  return local ? <p style={{ ...styles.errorHint, marginBottom: 12 }}>{local}</p> : null;
}
