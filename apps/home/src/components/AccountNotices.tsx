import { useWeave } from '@weaveprotocol/core/react';
import { relayOnlyLocal, relayProblem } from '../relay';
import { PodChoice } from './PodChoice';
import { styles } from '../styles';

/**
 * What the account has to say, above whatever page is showing: a relay that
 * cannot be reached, a pod move waiting on an answer or just finished, and
 * anything that went wrong.
 */
export function AccountNotices() {
  const { auth, state } = useWeave();
  if (!auth || !state) return null;
  const { podChoice, moved, error, busy } = state;

  return (
    <>
      {/* Without a reachable relay nothing syncs, and the only symptom is a
          peer count that never moves. Better to say it than to look broken. */}
      {relayProblem() && (
        <div style={styles.errorBox}>
          <p style={styles.error}>Peers cannot find each other</p>
          <p style={styles.errorHint}>{relayProblem()}</p>
          <p style={styles.errorHint}>Your spaces still work, and still save. They just will not reach your other devices until this is set.</p>
        </div>
      )}
      {!relayProblem() && relayOnlyLocal() && <p style={{ ...styles.errorHint, marginBottom: 12 }}>{relayOnlyLocal()}</p>}

      {podChoice && (
        <PodChoice
          pod={podChoice.pod}
          contents={podChoice.contents}
          from={podChoice.from}
          loading={busy}
          error={error}
          onConfirm={(how) => void auth.confirmPod(how)}
          onCancel={() => auth.cancelPod()}
        />
      )}

      {!podChoice && error && (
        <div style={{ ...styles.errorBox, marginTop: 0, marginBottom: 16 }}>
          <p style={styles.error}>{error.message}</p>
          {error.hint && <p style={styles.errorHint}>{error.hint}</p>}
        </div>
      )}

      {moved && (
        <div style={{ ...styles.panel, marginTop: 0, marginBottom: 16 }}>
          <div style={{ ...styles.panelBody, paddingTop: 14 }}>
            <p style={{ ...styles.ok, color: '#000' }}>
              {moved.merged
                ? `Combined with the copy in the pod — ${moved.recordsAdded} new records, ${moved.spacesAdded} new spaces.`
                : `Moved into the pod — ${moved.spacesAdded} spaces, ${moved.recordsAdded} records.`}
            </p>
            <p style={styles.errorHint}>
              {moved.from
                ? `“${moved.from}” still has its own copy. Weave won't use it any more — delete the folder yourself once you're sure you don't need it.`
                : "This browser still has its own copy. Nothing uses it now; remove it once you're happy the pod has everything."}
            </p>
            <div style={{ ...styles.linkRow, gap: 8 }}>
              {!moved.from && (
                <button onClick={() => void auth.forgetBrowserCopy()} data-variant="quiet" style={styles.smallButton}>
                  Remove the browser copy
                </button>
              )}
              <button onClick={() => auth.dismissMoved()} data-variant="quiet" style={styles.smallButton}>
                {moved.from ? 'Got it' : 'Keep it'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
