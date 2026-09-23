import { useEffect, useState } from 'react';
import type { SpaceSummary } from 'weave-protocol';
import { useSession } from './hooks/useProtocol';
import { useSpaces } from './hooks/useSpaces';
import { CreateAccount } from './components/CreateAccount';
import { SignIn } from './components/SignIn';
import { ChooseStorage } from './components/ChooseStorage';
import { Welcome } from './components/Welcome';
import { Wordmark } from './components/ChooseStorage';
import { AccountMenu } from './components/AccountMenu';
import { PairArrival } from './components/PairArrival';
import { PairPhone } from './components/PairPhone';
import { SpaceList } from './components/SpaceList';
import { SpaceView } from './components/SpaceView';
import { SecuritySettings } from './components/SecuritySettings';
import { clearInviteFromUrl, previewInvite, readInviteFromUrl } from './spaces';
import { relayOnlyLocal, relayProblem } from './relay';
import type { Session } from './protocol';
import { styles } from './styles';

export function App() {
  const auth = useSession();

  // Opened from a QR code on another device, and not signed in yet. This owns
  // the screen: everything needed is in the address bar.
  if (auth.pairing && !auth.session) {
    return (
      <PairArrival
        loading={auth.loading}
        error={auth.error}
        stage={auth.pairingStage}
        onAccept={() => void auth.acceptPairing()}
        onDismiss={auth.dismissPairing}
      />
    );
  }

  if (auth.stage === 'starting') {
    return (
      <div style={styles.container}>
        <div data-card style={styles.card}>
          <p style={styles.hint}>Looking for your accounts…</p>
        </div>
      </div>
    );
  }

  if (auth.stage === 'create') {
    return (
      <CreateAccount
        code={auth.freshCode}
        loading={auth.loading}
        error={auth.error}
        onCreate={auth.create}
        onSaved={auth.codeSaved}
        walletHere={auth.walletHere}
        onWallet={auth.withWallet}
        // Always available. An account password works with nothing stored —
        // that is the whole reason it is the credential — so a browser with
        // cleared storage must never be a dead end.
        onBack={auth.backToSignIn}
      />
    );
  }

  if (auth.stage === 'where') {
    return (
      <ChooseStorage
        loading={auth.loading}
        error={auth.error}
        onChooseFolder={auth.chooseFolder}
        onStayLocal={auth.stayLocal}
      />
    );
  }

  if (!auth.home) {
    return (
      <div style={styles.container}>
        <div data-card style={styles.card}>
          <p style={styles.error}>No account store could be opened in this browser.</p>
          <p style={styles.errorHint}>
            Private browsing, or blocked site data, can do this. Allow storage for this site and
            reload.
          </p>
        </div>
      </div>
    );
  }

  if (auth.stage === 'welcome' && auth.home) {
    return (
      <Welcome
        home={auth.home}
        loading={auth.loading}
        onCreate={auth.startCreating}
        onHaveAccount={auth.backToSignIn}
        onChangeStorage={auth.changeStorage}
      />
    );
  }

  if (auth.stage === 'signIn' || !auth.session) {
    return (
      <SignIn
        home={auth.home}
        accounts={auth.accounts}
        entry={auth.entry}
        selectedId={auth.selectedId}
        loading={auth.loading}
        error={auth.error}
        onSelect={auth.select}
        onWithCode={auth.withCode}
        onWithPassword={auth.withPassword}
        onWithPasskey={auth.withPasskey}
        walletHere={auth.walletHere}
        onWithWallet={auth.withWallet}
        onCreate={auth.startCreating}
        onChangeFolder={auth.chooseFolder}
        onUseBrowser={auth.useBrowserAccounts}
      />
    );
  }

  return <Workspace auth={auth} session={auth.session} />;
}

type Auth = ReturnType<typeof useSession>;

/** Signed in: the spaces, or one of them opened. */
function Workspace({ auth, session }: { auth: Auth; session: Session }) {
  const { spaces, loading, error, create, join, remove } = useSpaces(session);
  const [open, setOpen] = useState<SpaceSummary | null>(null);
  const [page, setPage] = useState<'spaces' | 'security'>('spaces');
  const [pendingInvite, setPendingInvite] = useState<string | null>(() => readInviteFromUrl());

  // Keep the opened record in step with the registry, so a join that adds a
  // member does not leave a stale copy on screen.
  useEffect(() => {
    if (!open) return;
    const fresh = spaces.find((space) => space.id === open.id);
    if (fresh && fresh.members.length !== open.members.length) setOpen(fresh);
  }, [spaces, open]);

  const acceptInvite = async () => {
    if (!pendingInvite) return;
    const record = await join(pendingInvite);
    setPendingInvite(null);
    clearInviteFromUrl();
    if (record) setOpen(record);
  };

  const declineInvite = () => {
    setPendingInvite(null);
    clearInviteFromUrl();
  };

  return (
    <div style={styles.container}>
      <div style={styles.app}>
        {pendingInvite && (
          <InviteBanner invite={pendingInvite} onAccept={acceptInvite} onDecline={declineInvite} />
        )}

        {/* Without a reachable relay nothing syncs, and the only symptom is a
            peer count that never moves. Better to say it than to look broken. */}
        {relayProblem() && (
          <div style={styles.errorBox}>
            <p style={styles.error}>Peers cannot find each other</p>
            <p style={styles.errorHint}>{relayProblem()}</p>
            <p style={styles.errorHint}>
              Your spaces still work, and still save. They just will not reach your other devices
              until this is set.
            </p>
          </div>
        )}
        {!relayProblem() && relayOnlyLocal() && (
          <p style={{ ...styles.errorHint, marginBottom: 12 }}>ℹ️ {relayOnlyLocal()}</p>
        )}

        {auth.moved && (
          <div style={styles.panel}>
            <div style={styles.panelBody}>
              <p style={styles.ok}>
                {auth.moved.merged
                  ? `Combined with the copy already in this folder — ${auth.moved.recordsAdded} new records, ${auth.moved.spacesAdded} new spaces.`
                  : `Moved into the folder — ${auth.moved.spacesAdded} spaces, ${auth.moved.recordsAdded} records.`}
              </p>
              <p style={styles.errorHint}>
                This browser still has its own copy. Nothing uses it now; remove it once you are happy the
                folder has everything.
              </p>
              <div style={styles.linkRow}>
                <button onClick={() => void auth.forgetBrowser()} data-variant="quiet" style={styles.linkButton}>
                  Remove it from this browser
                </button>
                <button onClick={auth.dismissMoved} data-variant="ghost" style={styles.linkButton}>
                  Keep it
                </button>
              </div>
            </div>
          </div>
        )}

        {page === 'security' ? (
          <SecuritySettings auth={auth} session={session} onBack={() => setPage('spaces')} />
        ) : open ? (
          <SpaceView record={open} session={session} onBack={() => setOpen(null)} />
        ) : (
          <>
            <header style={styles.headerRow}>
              <Wordmark compact />
              <AccountMenu auth={auth} session={session} onSecurity={() => setPage('security')} />
            </header>
            <h1 style={{ ...styles.appTitle, marginBottom: 20 }}>Spaces</h1>

            <SpaceList
              spaces={spaces}
              loading={loading}
              error={error}
              onOpen={setOpen}
              onCreate={(params) => void create(params)}
              onJoin={(invite) => void join(invite)}
              onRemove={(id) => void remove(id)}
            />

            <PairPhone />

            <details style={styles.panel}>
              <summary data-variant="ghost" style={styles.panelSummary}>How it works</summary>
              <ul style={styles.infoList}>
                <li>Each <strong>space</strong> has its own Merkle Search Tree, its own store, its own gossip room</li>
                <li>Private spaces encrypt every body with an AES key <em>before</em> signing, so peers relay what they cannot read</li>
                <li>Personal spaces reject writes not rooted in your DID; shared ones accept anyone holding an invite</li>
                <li>Invites carry the space — and its key — in the URL fragment, which never reaches a server</li>
                <li>Peers meet through a relay only for the <em>first</em> connection; after that they introduce each other</li>
                <li>A phone cannot open a folder, so it takes its own copy — the QR hands over the identity, and the spaces follow over the peer connection</li>
                <li>A <strong>data folder</strong> is the only store that is not scoped to this origin — point a second app at it and you get the same account and the same spaces</li>
                <li>Screens are worked out from what a space says about itself — its kinds of things, their fields and how they point at each other — so this app shows data it has never seen before</li>
                <li>“verified” on a record means its signature and delegation chain both check out here</li>
              </ul>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

/** Offered when the page was opened from a share link. */
function InviteBanner({
  invite,
  onAccept,
  onDecline,
}: {
  invite: string;
  onAccept: () => void;
  onDecline: () => void;
}) {
  let description = 'a space';
  let detail = '';
  try {
    const preview = previewInvite(invite);
    description = `“${preview.space.name}”`;
    detail = `${preview.space.visibility === 'private' ? 'private' : 'public'} · ${
      preview.space.type === 'shared' ? 'shared' : 'personal'
    } · invited by ${preview.invitedBy.slice(-6)}`;
  } catch {
    detail = 'This invite could not be read.';
  }

  return (
    <div style={styles.inviteBanner}>
      <p style={styles.todoText}>You were invited to {description}</p>
      <p style={styles.todoMeta}>{detail}</p>
      <div style={styles.linkRow}>
        <button onClick={onAccept} data-variant="primary" style={styles.addButton}>
          Join this space
        </button>
        <button onClick={onDecline} data-variant="ghost" style={styles.linkButton}>
          Not now
        </button>
      </div>
    </div>
  );
}
