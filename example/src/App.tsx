import { useEffect, useState } from 'react';
import type { SpaceSummary } from 'weave-protocol';
import { WeaveAuth, useSpaces, useWeave } from 'weave-protocol/react';
import { AccountMenu } from './components/AccountMenu';
import { AccountNotices } from './components/AccountNotices';
import { HowItWorks } from './components/HowItWorks';
import { InviteBanner } from './components/InviteBanner';
import { PairPhone } from './components/PairPhone';
import { SecuritySettings } from './components/SecuritySettings';
import { SpaceList } from './components/SpaceList';
import { SpaceRail, RAIL_WIDTH } from './components/SpaceRail';
import { SpaceView } from './components/SpaceView';
import { Wordmark } from './components/Wordmark';
import { inviteFrom } from './spaces';
import { styles } from './styles';

/**
 * The app: sign in, then your spaces.
 *
 * Sign-in is the protocol's `<WeaveAuth>` — where the data lives, which
 * account, a passkey or the account password. Once someone is in, every
 * component below asks the `WeaveProvider` (main.tsx) for what it needs.
 */
export function App() {
  const { state } = useWeave();

  if (state?.stage !== 'ready') {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <WeaveAuth />
        </div>
      </div>
    );
  }

  return <Workspace />;
}

/** Signed in: the list of spaces, one space opened, or the security page. */
function Workspace() {
  const { spaces, loading, error, create, join, leave } = useSpaces();
  const [open, setOpen] = useState<SpaceSummary | null>(null);
  const [page, setPage] = useState<'spaces' | 'security'>('spaces');
  const joinLink = (link: string) => join(inviteFrom(link));

  // Keep the opened space in step with the list, so a join that adds a
  // member does not leave a stale copy on screen.
  useEffect(() => {
    const fresh = open && spaces.find((space) => space.id === open.id);
    if (fresh && fresh.members.length !== open.members.length) setOpen(fresh);
  }, [spaces, open]);

  const inSpace = open !== null && page === 'spaces';

  return (
    <div style={inSpace ? { ...styles.container, paddingLeft: RAIL_WIDTH + 20 } : styles.container}>
      {inSpace && (
        <SpaceRail
          spaces={spaces}
          current={open.id}
          onOpen={setOpen}
          onHome={() => setOpen(null)}
          onCreate={(params) => void create(params).then((space) => space && setOpen(space))}
          onJoin={(link) => void joinLink(link).then((space) => space && setOpen(space))}
        />
      )}
      <div style={inSpace ? { ...styles.app, maxWidth: 1120 } : styles.app}>
        {inSpace && error && (
          <div style={{ ...styles.errorBox, marginTop: 0, marginBottom: 16 }}>
            <p style={styles.error}>{error}</p>
          </div>
        )}
        <InviteBanner onJoin={(link) => joinLink(link).then((space) => (space && setOpen(space), space))} />
        <AccountNotices />

        {page === 'security' ? (
          <SecuritySettings onBack={() => setPage('spaces')} />
        ) : open ? (
          <SpaceView key={open.id} space={open} />
        ) : (
          <>
            <header style={styles.headerRow}>
              <Wordmark compact />
              <AccountMenu onSecurity={() => setPage('security')} />
            </header>
            <h1 style={{ ...styles.appTitle, marginBottom: 20 }}>Spaces</h1>
            <SpaceList
              spaces={spaces}
              loading={loading}
              error={error}
              onOpen={setOpen}
              onCreate={(params) => void create(params)}
              onJoin={(link) => void joinLink(link)}
              onRemove={(id) => void leave(id)}
            />
            <PairPhone />
            <HowItWorks />
          </>
        )}
      </div>
    </div>
  );
}
