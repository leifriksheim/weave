import type { Home } from '../accounts';
import { styles } from '../styles';

/** Where the data is going, in a line, with a way to change it */
export function ChooseStorageSummary({ home, onChange }: { home: Home; onChange: () => void }) {
  return (
    <p style={{ ...styles.errorHint, marginTop: 24, display: 'flex', alignItems: 'center', gap: 4 }}>
      <span>{home.kind === 'folder' ? `Pod: ${home.directory?.name ?? 'your folder'}` : 'Stored in this browser'}</span>
      <span>·</span>
      <button onClick={onChange} data-variant="ghost" style={{ ...styles.linkButton, padding: 0, textDecoration: 'underline' }}>
        Change
      </button>
    </p>
  );
}
