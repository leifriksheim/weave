import { useState } from 'react';
import type { NewSpace, SpaceSummary } from '@weaveprotocol/core';
import {
  CallsProvider,
  inviteFromLink,
  useAccount,
  useConnection,
  useNode,
  useSpaces,
} from '@weaveprotocol/core/react';
import { AccountMenu } from './components/AccountMenu';
import { AgentCard } from './components/AgentCard';
import { useShowNotifications } from './notifications';
import { Bell } from './components/Bell';
import { useRunRules } from './rules';
import { ConnectScreen } from './components/ConnectScreen';
import { ContactsView } from './components/ContactsView';
import { RelayDown, RelayNotice } from './components/RelayNotice';
import { DocsNote } from './components/DocsNote';
import { InviteBanner } from './components/InviteBanner';
import { SpaceList } from './components/SpaceList';
import { SpaceRail } from './components/SpaceRail';
import { SpaceView } from './components/SpaceView';
import { CallLayer } from './components/calls/Calls';
import { Wordmark } from '@weave/app-shared/Wordmark';

import { readDoorFromUrl, takeBack } from './contacts';
import { styles, palette } from './styles';

/** The app: connect to your account home, then your spaces */
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
  const joinLink = (link: string) => mine.join(inviteFromLink(link));
  useShowNotifications(openById);
  useRunRules();

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

  const create = (params: NewSpace) => void mine.create(params).then((space) => space && setOpen(space));
  const join = (link: string) => void joinLink(link).then((space) => space && setOpen(space));
  const notices = (
    <>
      {inSpace && error && (
        <div style={{ ...styles.errorBox, marginTop: 0, marginBottom: 16 }}>
          <p style={styles.error}>{error}</p>
        </div>
      )}
      <InviteBanner onJoin={(link) => joinLink(link).then((space) => (space && setOpen(space), space))} />
      <RelayNotice />
    </>
  );

  // In a space, the space takes the whole window beside the rail, the way chat apps are laid out.
  if (open) {
    return (
      <div className="shell">
        <SpaceRail
          spaces={spaces}
          current={open.id}
          onOpen={setOpen}
          onHome={() => setOpen(null)}
          onCreate={create}
          onJoin={join}
        />
        <SpaceView
          key={open.id}
          space={open}
          notices={notices}
          onOpenSpace={openById}
          onHome={() => setOpen(null)}
        />
        <CallLayer spaces={spaces} onGoTo={setOpen} />
      </div>
    );
  }

  return (
    <div className="page">
      <div style={styles.app}>
        {notices}
        <RelayDown />
        <>
          <header style={styles.headerRow}>
            <Wordmark compact />
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Bell spaces={spaces} onOpenSpace={openById} />
              <AccountMenu />
            </span>
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
                onCreate={create}
                onJoin={join}
                onRemove={(id) => void forget(id)}
              />
              <AgentCard />
              <DocsNote path="packages/core/docs/spaces.md" style={{ marginTop: 16 }}>
                Each space keeps its own store and sync, and an invite carries its key in the link.
              </DocsNote>
            </>
          ) : (
            <ContactsView spaces={spaces} onOpen={openById} />
          )}
        </>
      </div>
      <CallLayer spaces={spaces} onGoTo={setOpen} />
    </div>
  );
}
