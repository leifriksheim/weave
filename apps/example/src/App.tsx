import { useState } from 'react';
import type { SpaceSummary } from '@weaveprotocol/core';
import { CallsProvider, useAccount, useConnection, useNode, useSpaces } from '@weaveprotocol/core/react';
import { AccountMenu } from './components/AccountMenu';
import { ConnectScreen } from './components/ConnectScreen';
import { ContactsView } from './components/ContactsView';
import { RelayNotice } from './components/RelayNotice';
import { HowItWorks } from './components/HowItWorks';
import { InviteBanner } from './components/InviteBanner';
import { SpaceList } from './components/SpaceList';
import { SpaceRail } from './components/SpaceRail';
import { SpaceView } from './components/SpaceView';
import { CallLayer } from './components/calls/Calls';
import { Wordmark } from '@weave/app-shared/Wordmark';
import { inviteFrom } from './spaces';
import { readDoorFromUrl, takeBack } from './contacts';
import { styles, palette } from './styles';

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

/** The two lists on the home screen */
type Home = 'spaces' | 'contacts';

/** Connected: your spaces or your contacts, or one space opened. */
function Workspace() {
  const mine = useSpaces();
  const { spaces, loading, error } = mine;
  const [open, setOpen] = useState<SpaceSummary | null>(null);
  // A door link is someone asking you to knock, which happens among your contacts.
  const [home, setHome] = useState<Home>(() => (readDoorFromUrl() ? 'contacts' : 'spaces'));
  const openById = (id: string) => {
    const space = spaces.find((found) => found.id === id);
    if (space) setOpen(space);
  };
  const joinLink = (link: string) => mine.join(inviteFrom(link));

  /**
   * Leaving a space, after saying what it costs. A space for two goes through
   * the contact list instead, so the list never names a space you left, and a
   * request still waiting is taken back from the spaces you share.
   */
  const node = useNode();
  const account = useAccount();
  const forget = async (id: string) => {
    const space = spaces.find((found) => found.id === id);
    if (!space) return;
    const pair = (await node.contacts.list().catch(() => [])).find(
      (contact) => contact.space === id && !contact.blocked,
    );
    if (pair) {
      if (
        !globalThis.confirm(
          `${space.name} is your space for two with ${pair.name}. Leaving it removes ${pair.name} from your contacts, and takes back your request if they haven't accepted. They keep their copy.`,
        )
      )
        return;
      const shared = spaces
        .filter((other) => other.id !== id && other.writable && !other.joining)
        .map((other) => other.id);
      await takeBack(node, shared, account.did, pair.did);
      return;
    }
    if (
      !globalThis.confirm(
        `Leave ${space.name}? It goes from all your devices. Others in it keep it, and you need a new invite to come back. If no one else is in it, what's in it is gone.`,
      )
    )
      return;
    await mine.leave(id);
  };

  // Keep the opened space in step with the list, so a join that finishes, or
  // a role that changes, does not leave a stale copy on screen.
  // Adjusted while rendering rather than in an effect, so the stale copy is
  // never painted.
  const fresh = open && spaces.find((space) => space.id === open.id);
  if (
    fresh &&
    (fresh.role !== open.role || fresh.writable !== open.writable || fresh.joining !== open.joining)
  )
    setOpen(fresh);

  const inSpace = open !== null;

  return (
    <div className="page" data-rail={inSpace || undefined}>
      {inSpace && (
        <SpaceRail
          spaces={spaces}
          current={open.id}
          onOpen={setOpen}
          onHome={() => setOpen(null)}
          onCreate={(params) => void mine.create(params).then((space) => space && setOpen(space))}
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
          <SpaceView key={open.id} space={open} onOpenSpace={openById} />
        ) : (
          <>
            <header style={styles.headerRow}>
              <Wordmark compact />
              <AccountMenu />
            </header>
            <nav role="tablist" aria-label="Home" style={{ display: 'flex', gap: 20, marginBottom: 20 }}>
              {(['spaces', 'contacts'] as const).map((id) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={home === id}
                  onClick={() => setHome(id)}
                  style={{
                    ...styles.appTitle,
                    border: 'none',
                    background: 'none',
                    padding: 0,
                    color: home === id ? palette.ink.strong : palette.ink.faint,
                  }}
                >
                  {id === 'spaces' ? 'Spaces' : 'Contacts'}
                </button>
              ))}
            </nav>
            {home === 'spaces' ? (
              <>
                <SpaceList
                  spaces={spaces}
                  loading={loading}
                  error={error}
                  onOpen={setOpen}
                  onCreate={(params) => void mine.create(params).then((space) => space && setOpen(space))}
                  onJoin={(link) => void joinLink(link).then((space) => space && setOpen(space))}
                  onRemove={(id) => void forget(id)}
                />
                <HowItWorks />
              </>
            ) : (
              <ContactsView spaces={spaces} onOpen={openById} />
            )}
          </>
        )}
      </div>
      <CallLayer spaces={spaces} onGoTo={setOpen} />
    </div>
  );
}
