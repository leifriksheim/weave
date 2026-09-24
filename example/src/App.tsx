import { useEffect, useState } from 'react';
import type { SpaceSummary } from 'weave-protocol';
import type { AuthState } from 'weave-protocol/session';
import { WeaveAuth, useSpaces, useWeaveAuth } from 'weave-protocol/react';
import { Wordmark } from './components/Wordmark';
import { AccountMenu } from './components/AccountMenu';
import { PairPhone } from './components/PairPhone';
import { SpaceList } from './components/SpaceList';
import { SpaceView } from './components/SpaceView';
import { SpaceRail, RAIL_WIDTH } from './components/SpaceRail';
import { SecuritySettings } from './components/SecuritySettings';
import { PodChoice } from './components/PodChoice';
import { clearInviteFromUrl, inviteFrom, previewInvite, readInviteFromUrl } from './spaces';
import { relayOnlyLocal, relayProblem } from './relay';
import { auth, type Session } from './protocol';
import { styles } from './styles';

export function App() {
  const state = useWeaveAuth(auth);

  // Until someone is in, the protocol's sign-in element owns the screen.
  if (state.stage !== 'ready' || !state.session) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <WeaveAuth auth={auth} />
        </div>
      </div>
    );
  }

  return <Workspace state={state} session={state.session} />;
}


/** Signed in: the spaces, or one of them opened. */
function Workspace({ state, session }: { state: AuthState; session: Session }) {
  const { spaces, loading, error, create, join: joinInvite, leave: remove } = useSpaces(session.node);
  const join = (invite: string) => joinInvite(inviteFrom(invite));
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

  const inSpace = open !== null && page === 'spaces';

  return (
    <div style={inSpace ? { ...styles.container, paddingLeft: RAIL_WIDTH + 20 } : styles.container}>
      {inSpace && (
        <SpaceRail
          spaces={spaces}
          current={open.id}
          onOpen={setOpen}
          onHome={() => setOpen(null)}
          onCreate={(params) => void create(params).then((record) => record && setOpen(record))}
          onJoin={(invite) => void join(invite).then((record) => record && setOpen(record))}
        />
      )}
      <div style={inSpace ? { ...styles.app, maxWidth: 1120 } : styles.app}>
        {inSpace && error && (
          <div style={{ ...styles.errorBox, marginTop: 0, marginBottom: 16 }}>
            <p style={styles.error}>{error}</p>
          </div>
        )}
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
          <p style={{ ...styles.errorHint, marginBottom: 12 }}>{relayOnlyLocal()}</p>
        )}

        {state.podChoice && (
          <PodChoice
            pod={state.podChoice.pod}
            contents={state.podChoice.contents}
            from={state.podChoice.from}
            loading={state.busy}
            error={state.error}
            onConfirm={(how) => void auth.confirmPod(how)}
            onCancel={() => auth.cancelPod()}
          />
        )}

        {!state.podChoice && state.error && (
          <div style={{ ...styles.errorBox, marginTop: 0, marginBottom: 16 }}>
            <p style={styles.error}>{state.error.message}</p>
            {state.error.hint && <p style={styles.errorHint}>{state.error.hint}</p>}
          </div>
        )}

        {state.moved && (
          <div style={{ ...styles.panel, marginTop: 0, marginBottom: 16 }}>
            <div style={{ ...styles.panelBody, paddingTop: 14 }}>
              <p style={{ ...styles.ok, color: '#000' }}>
                {state.moved.merged
                  ? `Combined with the copy in the pod — ${state.moved.recordsAdded} new records, ${state.moved.spacesAdded} new spaces.`
                  : `Moved into the pod — ${state.moved.spacesAdded} spaces, ${state.moved.recordsAdded} records.`}
              </p>
              {state.moved.from ? (
                <p style={styles.errorHint}>
                  “{state.moved.from}” still has its own copy. Weave won't use it any more — delete the folder yourself
                  once you're sure you don't need it.
                </p>
              ) : (
                <p style={styles.errorHint}>
                  This browser still has its own copy. Nothing uses it now; remove it once you're happy the pod has
                  everything.
                </p>
              )}
              <div style={{ ...styles.linkRow, gap: 8 }}>
                {!state.moved.from && (
                  <button onClick={() => void auth.forgetBrowserCopy()} data-variant="quiet" style={styles.smallButton}>
                    Remove the browser copy
                  </button>
                )}
                <button onClick={() => auth.dismissMoved()} data-variant="quiet" style={styles.smallButton}>
                  {state.moved.from ? 'Got it' : 'Keep it'}
                </button>
              </div>
            </div>
          </div>
        )}

        {page === 'security' ? (
          <SecuritySettings state={state} session={session} onBack={() => setPage('spaces')} />
        ) : open ? (
          <SpaceView key={open.id} record={open} session={session} />
        ) : (
          <>
            <header style={styles.headerRow}>
              <Wordmark compact />
              <AccountMenu state={state} session={session} onSecurity={() => setPage('security')} />
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
      preview.space.type === 'shared' ? (preview.carriesWrite ? 'shared' : 'shared, view only') : 'personal'
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
