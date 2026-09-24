import type { ReactNode } from 'react';
import { WeaveAuth, useWeave } from 'weave-protocol/react';
import { AccountNotices } from './components/AccountNotices';
import { Settings } from './components/Settings';
import { Wordmark } from './components/Wordmark';
import { styles } from './styles';

/** The account home: sign in, then the account and everything about it. */
export function App() {
  const { state } = useWeave();

  if (state?.stage !== 'ready') {
    return (
      <Page>
        <WeaveAuth />
      </Page>
    );
  }

  return (
    <Page wide>
      <header style={{ ...styles.headerRow, marginBottom: 32 }}>
        <Wordmark compact />
        <span style={{ fontSize: 13, color: '#666' }}>Your account home</span>
      </header>
      <AccountNotices />
      <Settings />
    </Page>
  );
}

function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div style={styles.container}>
      <div style={wide ? styles.app : styles.card}>{children}</div>
    </div>
  );
}
