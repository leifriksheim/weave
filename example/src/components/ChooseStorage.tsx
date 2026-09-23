import type { AuthError } from '../hooks/useProtocol';
import { Info } from './Info';
import { styles, variants, palette } from '../styles';

/**
 * The first question: where Weave keeps your data.
 *
 * A **pod** is a folder you choose. It is the only storage a second app on a
 * different address can open, so it is what makes one account work across
 * apps without a server — and it may already hold your account, which is why
 * this comes before signing in.
 *
 * Staying in the browser is a real option, not a booby prize: it is a full
 * peer that syncs with your other devices. It just belongs to this one web
 * address, and that is worth saying plainly rather than discovering later.
 */
export function ChooseStorage({
  loading,
  error,
  onChooseFolder,
  onStayLocal,
}: {
  loading: boolean;
  error: AuthError | null;
  onChooseFolder: () => void;
  onStayLocal: () => void;
}) {
  return (
    <div style={styles.container}>
      <div data-card style={styles.card}>
        <Wordmark />
        <h1 style={styles.title}>Where should your data live?</h1>
        <p style={styles.subtitle}>You can change this later.</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Option
            title="Choose a pod"
            recommended
            description="A folder on your computer that holds your Weave data. Every app you open it in sees the same account and the same spaces."
            onClick={onChooseFolder}
            disabled={loading}
          />
          <Option
            title="Continue in this browser"
            description="Nothing to set up. Your data syncs with your other devices, but other apps on other addresses can't open it."
            onClick={onStayLocal}
            disabled={loading}
          />
        </div>

        <p style={{ ...styles.errorHint, marginTop: 16 }}>
          Your browser will ask to see the folder, then to save into it.
          <Info label="Why a pod">
            Your data becomes yours the way any other file is: copy it, back it up, or put the folder in iCloud or
            Dropbox and your devices stay in step with no server involved. It is also the only storage a second app on
            a different address can read.
          </Info>
        </p>

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

/** One of a small number of choices: a bordered row with a title and a line under it. */
export function Option({
  title,
  description,
  onClick,
  disabled,
  recommended,
}: {
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
  recommended?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} data-variant="quiet" style={{ ...variants.quiet, height: 'auto', padding: 16, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500, color: palette.ink.strong }}>
        {title}
        {recommended && <span style={{ ...styles.badge, fontSize: 11 }}>Recommended</span>}
      </span>
      <span style={{ color: palette.ink.muted, fontSize: 13, fontWeight: 400, lineHeight: 1.5 }}>{description}</span>
    </button>
  );
}

/** The product's name, small, above every onboarding step */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: compact ? 0 : 40 }}>
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
        <path d="M2 5 L7 15 L10 8 L13 15 L18 5" fill="none" stroke="#000" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <span style={{ fontWeight: 600, fontSize: 16, letterSpacing: '-0.03em', color: '#000' }}>Weave</span>
    </div>
  );
}
