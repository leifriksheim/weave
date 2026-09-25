import { useEffect, useState } from 'react';
import type { SpaceSummary } from '@weaveprotocol/core';
import { CallsProvider, useConnection, useSpaces } from '@weaveprotocol/core/react';
import { AccountMenu } from './components/AccountMenu';
import { ConnectScreen } from './components/ConnectScreen';
import { RelayNotice } from './components/RelayNotice';
import { HowItWorks } from './components/HowItWorks';
import { InviteBanner } from './components/InviteBanner';
import { SpaceList } from './components/SpaceList';
import { SpaceRail } from './components/SpaceRail';
import { SpaceView } from './components/SpaceView';
import { CallLayer } from './components/calls/Calls';
import { Wordmark } from './components/Wordmark';
import { inviteFrom } from './spaces';
import { styles } from './styles';

/**
 * The app: connect to your account home, then your spaces.
 *
 * This app never signs anyone in. "Connect with Weave" opens the account home
 * in a popup; the person approves there, and the home hands this app a signed
 * note for its own key. Every component below asks the `WeaveProvider`
 * (main.tsx) for what it needs.
 */
export function App() {
  const { state } = useConnection();
  // Calls sit above the workspace, so moving between spaces never touches one.
  return state.status === 'ready' ? (
    <CallsProvider>
      <Workspace />
    </CallsProvider>
  ) : (
    <ConnectScreen />
  );
}

/** Connected: the list of spaces, or one space opened. */
function Workspace() {
  const { spaces, loading, error, create, join, leave } = useSpaces();
  const [open, setOpen] = useState<SpaceSummary | null>(null);
  const joinLink = (link: string) => join(inviteFrom(link));

  // Keep the opened space in step with the list, so a join that finishes, or
  // a role that changes, does not leave a stale copy on screen.
  useEffect(() => {
    const fresh = open && spaces.find((space) => space.id === open.id);
    if (fresh && (fresh.role !== open.role || fresh.writable !== open.writable || fresh.joining !== open.joining)) setOpen(fresh);
  }, [spaces, open]);

  const inSpace = open !== null;

  return (
    <div className="page" data-rail={inSpace || undefined}>
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
        <RelayNotice />

        {open ? (
          <SpaceView key={open.id} space={open} />
        ) : (
          <>
            <header style={styles.headerRow}>
              <Wordmark compact />
              <AccountMenu />
            </header>
            <h1 style={{ ...styles.appTitle, marginBottom: 20 }}>Spaces</h1>
            <SpaceList
              spaces={spaces}
              loading={loading}
              error={error}
              onOpen={setOpen}
              onCreate={(params) => void create(params).then((space) => space && setOpen(space))}
              onJoin={(link) => void joinLink(link).then((space) => space && setOpen(space))}
              onRemove={(id) => void leave(id)}
            />
            <HowItWorks />
          </>
        )}
      </div>
      <CallLayer spaces={spaces} onGoTo={setOpen} />
    </div>
  );
}
