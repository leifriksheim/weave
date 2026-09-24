import { useState, type ReactNode } from 'react';
import { STAY_SIGNED_IN_CHOICES, type AuthState, type StaySignedIn } from 'weave-protocol/session';
import { auth, type Session } from '../protocol';
import { styles, palette } from '../styles';
import { connectDesktopAgents, desktopAgentsEnabled } from '../webmcp';

/**
 * How this device gets into the account: whether it stays signed in, and
 * whether a passkey unlocks it. Everything here is about this device only —
 * the account itself, and its password, are the same everywhere.
 */
export function SecuritySettings({ state, session, onBack }: { state: AuthState; session: Session; onBack: () => void }) {
  const [stay, setStay] = useState<StaySignedIn>(auth.staySignedIn.choice);
  const [until, setUntil] = useState<Date | null>(auth.staySignedIn.until);
  const hasPasskey = (state.entry?.shortcuts.length ?? 0) > 0;
  const [agents, setAgents] = useState(desktopAgentsEnabled);

  const choose = async (choice: StaySignedIn) => {
    setStay(choice);
    await auth.staySignedIn.setChoice(choice);
    setUntil(auth.staySignedIn.until());
  };

  return (
    <>
      <nav style={{ marginBottom: 16 }}>
        <button onClick={onBack} data-variant="ghost" style={{ ...styles.linkButton, paddingLeft: 0 }}>
          ← Spaces
        </button>
      </nav>
      <h1 style={{ ...styles.appTitle, marginBottom: 6 }}>Security</h1>
      <p style={{ ...styles.hint, marginBottom: 28 }}>How this device gets into your account. Your other devices and apps have their own settings.</p>

      <Section
        title="Stay signed in"
        description="Skip unlocking when you come back to this app. After this long without using it, you'll be asked again."
      >
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
            ? 'This device asks to unlock every time you open the app.'
            : until
              ? `Signed in on this device until ${until.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}, or longer if you keep using it.`
              : 'Applies from your next unlock.'}{' '}
          Anyone who can use this browser can open your account while you're signed in.
        </p>
      </Section>

      <Section
        title="Passkey"
        description="Unlock with Touch ID, Windows Hello or your password manager instead of typing your account password. Only for this app, on this device."
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

      <Section
        title="Desktop agents"
        description="Let AI apps on this computer — Claude Desktop and others — use your spaces through a local relay. Any program on this computer that listens where the relay does gets the same access, so leave it off unless you use it."
      >
        <Row label={agents ? 'Agents on this computer can use your spaces.' : 'Off.'}>
          <button
            onClick={() => {
              connectDesktopAgents(!agents);
              setAgents(!agents);
            }}
            data-variant="quiet"
            style={styles.smallButton}
          >
            {agents ? 'Turn off' : 'Turn on'}
          </button>
        </Row>
      </Section>

      <Section title="Sign out of this device" description="Forgets that this device is signed in. Your account and your data stay where they are.">
        <div>
          <button onClick={() => void auth.signOut()} data-variant="quiet" style={styles.smallButton}>
            Sign out
          </button>
        </div>
      </Section>
    </>
  );
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
