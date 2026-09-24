import { useState, type ReactNode } from 'react';
import { STAY_SIGNED_IN_CHOICES, type Connection, type StaySignedIn } from 'weave-protocol/session';
import { useAuth, useSession } from 'weave-protocol/react';
import { Avatar } from './Avatar';
import { PairPhone } from './PairPhone';
import { styles, palette } from '../styles';

/**
 * The account, as its home shows it: who you are, which apps may use it, how
 * this device gets in, where the data lives, and adding a phone. Apps link
 * here for "account settings" — they never hold the seed, so they have none of
 * their own.
 */
export function Settings() {
  const { auth, state } = useAuth();
  const session = useSession();
  const [stay, setStay] = useState<StaySignedIn>(auth.staySignedIn.choice);
  const [until, setUntil] = useState<Date | null>(auth.staySignedIn.until);
  const hasPasskey = (state.entry?.shortcuts.length ?? 0) > 0;
  const connections = auth.connections();
  const place = state.place;
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const disconnect = async (origin: string) => {
    setDisconnecting(origin);
    try {
      await auth.disconnect(origin);
    } finally {
      setDisconnecting(null);
    }
  };

  const choose = async (choice: StaySignedIn) => {
    setStay(choice);
    await auth.staySignedIn.setChoice(choice);
    setUntil(auth.staySignedIn.until());
  };

  return (
    <>
      <AccountHeader name={session.account.name} did={session.did} onRename={(name) => auth.rename(name)} />

      <Section
        title="Connected apps"
        description="Apps that you let use your account. Each got a note, signed by your account, saying what it may use and until when. None of them has your password."
      >
        {connections.length === 0 && <Row label="No apps yet.">{null}</Row>}
        {connections.map((app) => (
          <Row key={app.origin} label={describeConnection(app)}>
            <button onClick={() => void disconnect(app.origin)} disabled={disconnecting !== null} data-variant="quiet" style={styles.smallButton}>
              {disconnecting === app.origin ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </Row>
        ))}
        {connections.length > 0 && (
          <p style={styles.errorHint}>
            Disconnecting stops the app for good the next time it comes online: it signs itself out, and nothing it changes after that
            counts. What it already wrote stays. It keeps what it could already read, since a space's key cannot be changed yet.
          </p>
        )}
      </Section>

      <Section
        title="Passkey"
        description="Unlock with Touch ID, Windows Hello or your password manager instead of typing your account password. On this device."
      >
        {hasPasskey ? (
          <Row label="A passkey unlocks this account here.">
            <button onClick={() => void auth.removeShortcut('passkey')} disabled={state.busy} data-variant="quiet" style={{ ...styles.smallButton, color: palette.accent.danger }}>
              Remove
            </button>
          </Row>
        ) : (
          <Row label="No passkey on this device.">
            <button onClick={() => void auth.addPasskey()} disabled={state.busy} data-variant="primary" style={{ ...styles.smallButton, background: '#000', color: '#fff', borderColor: '#000' }}>
              {state.busy ? 'Waiting…' : 'Set up a passkey'}
            </button>
          </Row>
        )}
      </Section>

      <Section title="Stay signed in" description="Skip unlocking when you come back. After this long without using it, you'll be asked again.">
        <div role="radiogroup" aria-label="Stay signed in" style={segmented}>
          {STAY_SIGNED_IN_CHOICES.map((choice) => (
            <button
              key={choice.value}
              role="radio"
              aria-checked={stay === choice.value}
              onClick={() => void choose(choice.value)}
              style={stay === choice.value ? { ...segment, ...segmentOn } : segment}
            >
              {choice.label}
            </button>
          ))}
        </div>
        <p style={styles.errorHint}>
          {stay === 'never'
            ? 'This device asks to unlock every time.'
            : until
              ? `Signed in on this device until ${until.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}, or longer if you keep using it.`
              : 'Applies from your next unlock.'}{' '}
          Anyone who can use this browser can open your account while you're signed in.
        </p>
      </Section>

      {state.folderAvailable && (
        <Section
          title="Where your data lives"
          description="A pod is a folder on your computer that holds your account and spaces. Copy it, back it up, or put it in iCloud or Dropbox."
        >
          <Row label={place?.kind === 'folder' ? `Pod: ${place.directory?.name ?? 'folder'}` : 'In this browser'}>
            <button onClick={() => void auth.choosePod()} disabled={state.busy} data-variant="quiet" style={styles.smallButton}>
              {place?.kind === 'folder' ? 'Change pod' : 'Move to a pod'}
            </button>
          </Row>
        </Section>
      )}

      <div style={{ marginBottom: 16 }}>
        <PairPhone />
      </div>

      <Section title="Sign out of this device" description="Signs this account home out on this device. Apps you connected stay connected — disconnect them under Connected apps. Your account and your data stay where they are.">
        <div>
          <button onClick={() => void auth.signOut()} data-variant="quiet" style={styles.smallButton}>
            Sign out
          </button>
        </div>
      </Section>
    </>
  );
}

/** Who this is, with the name editable in place */
function AccountHeader({ name, did, onRename }: { name: string; did: string; onRename: (name: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
      <Avatar did={did} size={48} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void onRename(draft).then((ok) => ok && setEditing(false));
            }}
            style={{ display: 'flex', gap: 6 }}
          >
            <input value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus aria-label="Account name" style={{ ...styles.input, height: 34 }} />
            <button type="submit" disabled={!draft.trim()} data-variant="primary" style={{ ...styles.smallButton, height: 34, background: '#000', color: '#fff', borderColor: '#000' }}>
              Save
            </button>
          </form>
        ) : (
          <h1 style={{ ...styles.appTitle, display: 'flex', alignItems: 'baseline', gap: 10 }}>
            {name}
            <button onClick={() => { setDraft(name); setEditing(true); }} data-variant="ghost" style={{ ...styles.linkButton, fontSize: 13 }}>
              Rename
            </button>
          </h1>
        )}
        <code style={{ fontSize: 12, color: palette.ink.faint }}>{did.slice(0, 16)}…{did.slice(-6)}</code>
      </div>
    </header>
  );
}

/** "Todo (todo.example) · read and change Groceries · until 3 October" */
function describeConnection(app: Connection): string {
  const host = new URL(app.origin).host;
  const who = app.name ? `${app.name} (${host})` : host;
  const what = app.scope === 'account' ? 'your whole account' : app.spaces.length ? app.spaces.map((space) => space.name).join(', ') : 'no spaces';
  const until = new Date(app.expiresAt * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  const expired = app.expiresAt * 1000 < Date.now();
  return `${who} · ${app.access === 'write' ? 'read and change' : 'read'} ${what} · ${expired ? 'ran out' : `until ${until}`}`;
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section style={{ border: `1px solid ${palette.surface.line}`, borderRadius: 12, padding: 20, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <h2 style={{ ...styles.sectionTitle, fontSize: 16, marginBottom: 4 }}>{title}</h2>
        <p style={{ color: palette.ink.muted, fontSize: 14, lineHeight: 1.5 }}>{description}</p>
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', background: palette.surface.sunken, borderRadius: 8, fontSize: 14 }}>
      <span>{label}</span>
      {children}
    </div>
  );
}

const segmented = {
  display: 'inline-flex',
  alignSelf: 'flex-start',
  padding: 3,
  gap: 2,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 8,
  background: palette.surface.sunken,
  flexWrap: 'wrap' as const,
};
const segment = {
  height: 30,
  padding: '0 12px',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'transparent',
  borderRadius: 6,
  background: 'none',
  color: palette.ink.muted,
  fontSize: 13,
  fontWeight: 500,
};
const segmentOn = {
  background: palette.surface.card,
  color: palette.ink.strong,
  borderColor: palette.surface.line,
  boxShadow: '0 1px 2px rgba(0,0,0,.06)',
};
