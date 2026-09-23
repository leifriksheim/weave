import type { AuthError } from '../hooks/useProtocol';
import { Info } from './Info';
import { styles } from '../styles';

/**
 * Where a new account's spaces should live.
 *
 * Asked after the account exists rather than before, because "pick a folder" is
 * a strange first thing to say to someone opening an app. By this point
 * they have an account and the question has a reason.
 *
 * Staying in the browser is a real option, not a booby prize — it is a full
 * peer that syncs with your other devices. What it cannot do is let a second
 * app on a different domain read the same data, and that is worth saying
 * plainly rather than discovering later.
 */
export function ChooseStorage({
  folderAvailable,
  loading,
  error,
  onChooseFolder,
  onStayLocal,
}: {
  folderAvailable: boolean;
  loading: boolean;
  error: AuthError | null;
  onChooseFolder: () => void;
  onStayLocal: () => void;
}) {
  return (
    <div style={styles.container}>
      <div data-card style={styles.card}>
        <h1 style={styles.title}>📂 Where should your spaces live?</h1>

        {folderAvailable ? (
          <>
            <p style={styles.hint}>
              In a folder, any app you point at it opens the same spaces.
              <Info label="Why a folder">
                They become yours the way any other file is: copy them to a USB stick, back them up,
                or put the folder in iCloud or Dropbox and your devices stay in step with no server
                involved. It is also the only store a second app on a different address can read.
              </Info>
            </p>
            <button onClick={onChooseFolder} disabled={loading} data-variant="primary" style={styles.button}>
              {loading ? 'Waiting…' : 'Choose a folder'}
            </button>
            <p style={styles.errorHint}>Your browser will ask twice: to see it, and to save into it.</p>

            <div style={styles.linkRow}>
              <button onClick={onStayLocal} disabled={loading} data-variant="ghost" style={styles.linkButton}>
                Just use this browser
              </button>
            </div>
            <p style={styles.errorHint}>
              This browser works too, but only here.
              <Info label="What staying in the browser means">
                Your spaces still sync with your other devices, and nothing is stored on a server.
                What changes is that browser storage belongs to one web address — another app, on
                another address, cannot read it, even if it is the same app.
              </Info>
            </p>
          </>
        ) : (
          <>
            <p style={styles.hint}>
              Your spaces will be kept in this browser, and sync with your other devices.
              <Info label="Why there is no folder option here">
                Keeping spaces in a folder — which is what lets a second app open the same data —
                needs the File System Access API, which today means Chrome, Edge or Opera on a
                desktop.
              </Info>
            </p>
            <button onClick={onStayLocal} disabled={loading} data-variant="primary" style={styles.button}>
              Continue
            </button>
          </>
        )}

        {error && (
          <div style={styles.errorBox}>
            <p style={styles.error}>{error.message}</p>
            {error.hint && <p style={styles.errorHint}>{error.hint}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
