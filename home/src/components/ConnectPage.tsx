import { useEffect, useState, type ReactNode } from 'react';
import type { SpaceSummary } from 'weave-protocol';
import { receiveConnectRequest, type IncomingRequest } from 'weave-protocol/session';
import { WeaveAuth, useAuth, useSession, useWeave } from 'weave-protocol/react';
import { Wordmark } from './Wordmark';
import { styles, palette } from '../styles';

/**
 * An app opened this in a popup to ask for access to the account.
 *
 * Sign in first, with `<weave-auth>` as anywhere else. Then say what the app
 * gets: which spaces, read or change, for how long. The account signs a note
 * for the app's own key; the seed never leaves this page.
 *
 * What the app calls itself is shown, but its address is what is trusted —
 * the browser reports it, the app cannot make it up.
 */
export function ConnectPage() {
  const [incoming, setIncoming] = useState<IncomingRequest | null | undefined>(undefined);
  const { state } = useWeave();

  useEffect(() => {
    void receiveConnectRequest().then(setIncoming);
  }, []);

  if (incoming === undefined) return <Frame><p style={styles.hint}>Waiting for the app…</p></Frame>;

  if (incoming === null) {
    return (
      <Frame>
        <h1 style={styles.title}>Your account home</h1>
        <p style={styles.hint}>
          Apps open this page to ask for access to your Weave account. Nothing has asked right now.
        </p>
        <a href="/" style={{ ...styles.linkButton, paddingLeft: 0 }}>Your account</a>
      </Frame>
    );
  }

  if (state?.stage !== 'ready') {
    return (
      <Frame mark={false}>
        <Asking incoming={incoming} />
        <WeaveAuth />
      </Frame>
    );
  }

  return incoming.request.access === 'carry' ? <ApproveCarrier incoming={incoming} /> : <Approve incoming={incoming} />;
}

/** Who is asking, by the address the browser reports — an extension has no host name worth showing */
function asker(origin: string): string {
  const url = new URL(origin);
  return url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:' ? 'A browser extension' : url.host;
}

/** A small line above sign-in, so it is clear why this window opened */
function Asking({ incoming }: { incoming: IncomingRequest }) {
  return (
    <p style={{ ...styles.errorHint, marginTop: 0, marginBottom: 24, padding: '10px 12px', background: palette.surface.sunken, borderRadius: 8 }}>
      <strong style={{ color: palette.ink.strong }}>{asker(incoming.origin)}</strong> wants to use your Weave account. Sign in to
      decide what it gets.
    </p>
  );
}

function Approve({ incoming }: { incoming: IncomingRequest }) {
  const { request, origin } = incoming;
  const { auth } = useAuth();
  const session = useSession();
  const host = new URL(origin).host;
  const previous = auth.connections().find((known) => known.origin === origin);

  const [spaces, setSpaces] = useState<ReadonlyArray<SpaceSummary>>([]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(previous?.spaces.map((space) => space.id) ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void session.node.spaces.list().then(setSpaces);
  }, [session]);

  const whole = request.scope === 'account';
  const choosing = !whole && request.chooseSpaces !== false;
  const writes = request.access === 'write';
  // Spaces the app can use as asked: to change one, the account must be able to.
  const offered = spaces.filter((space) => !writes || space.writable);
  const privateChosen = offered.some((space) => chosen.has(space.id) && space.visibility === 'private');
  const creating = request.create ?? [];
  const nothing = !whole && chosen.size === 0 && creating.length === 0;

  const toggle = (id: string) =>
    setChosen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allow = async () => {
    setBusy(true);
    setError(null);
    try {
      const grant = await auth.grant({ origin, request, spaceIds: [...chosen] });
      incoming.approve(grant);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not give access');
      setBusy(false);
    }
  };

  return (
    <Frame>
      <h1 style={styles.title}>Connect to {host}</h1>
      <p style={styles.subtitle}>
        {request.name ? <>It calls itself “{request.name}”. </> : null}It wants to {writes ? 'read and change' : 'read'}{' '}
        {whole ? 'everything in' : 'spaces in'} your account, <strong style={{ color: palette.ink.strong }}>{session.account.name}</strong>.
      </p>

      {whole && (
        <div style={{ ...styles.errorBox, marginTop: 0, marginBottom: 20, background: palette.surface.sunken }}>
          <p style={{ ...styles.todoText }}>Your whole account</p>
          <p style={styles.errorHint}>
            Every space, including private ones, and the list of them. It can make and join spaces for you. It cannot sign in
            anywhere as you, change your password or passkeys, or keep access past the date below unless you allow it again.
          </p>
        </div>
      )}

      {choosing && (
        <section style={{ marginBottom: 20 }}>
          <p style={styles.fieldLabel}>Which spaces</p>
          {offered.length === 0 && <p style={styles.errorHint}>You have no spaces it could use.</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {offered.map((space) => (
              <label key={space.id} style={choice}>
                <input type="checkbox" checked={chosen.has(space.id)} onChange={() => toggle(space.id)} style={{ ...styles.checkbox, marginTop: 0 }} />
                <span style={{ flex: 1 }}>{space.name}</span>
                <span style={{ color: palette.ink.faint, fontSize: 12 }}>
                  {space.visibility} · {space.role ?? 'following'}
                </span>
              </label>
            ))}
          </div>
        </section>
      )}

      {creating.length > 0 && (
        <section style={{ marginBottom: 20 }}>
          <p style={styles.fieldLabel}>New spaces for it</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {creating.map((space, index) => (
              <div key={index} style={choice}>
                <span style={{ flex: 1 }}>{space.name}</span>
                <span style={{ color: palette.ink.faint, fontSize: 12 }}>
                  {space.visibility} · {space.roles ? space.roles.map((role) => role.title ?? role.name).join(', ') : 'just you'}
                </span>
              </div>
            ))}
          </div>
          <p style={styles.errorHint}>Made in your account, so your other devices and apps see them too.</p>
        </section>
      )}

      <p style={{ ...styles.errorHint, marginBottom: 20 }}>
        Access lasts 7 days; after that it asks again.
        {(whole || privateChosen) && ' It can read the private spaces it gets from now on — that cannot be taken back yet.'}
      </p>

      {error && (
        <div style={{ ...styles.errorBox, marginBottom: 16 }}>
          <p style={styles.error}>{error}</p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button onClick={() => void allow()} disabled={busy || nothing} data-variant="primary" style={styles.button}>
          {busy ? 'Giving access…' : 'Allow'}
        </button>
        <button onClick={() => incoming.deny()} disabled={busy} data-variant="quiet" style={{ ...styles.button, background: palette.surface.card, color: palette.ink.body, borderColor: palette.surface.lineStrong }}>
          Don't allow
        </button>
      </div>

      <p style={{ ...styles.errorHint, marginTop: 20 }}>
        The app gets a note signed by your account, for its own key. It never sees your password.
      </p>
    </Frame>
  );
}

/**
 * A carrier — the browser extension — asking to keep the spaces online. It
 * gets a pass for each space, never a key: it can hold and pass on what it
 * cannot read.
 */
function ApproveCarrier({ incoming }: { incoming: IncomingRequest }) {
  const { request, origin } = incoming;
  const { auth, state } = useAuth();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pod = state.place?.kind === 'folder' ? (state.place.directory?.name ?? 'your pod') : null;

  const allow = async () => {
    setBusy(true);
    setError(null);
    try {
      incoming.approve(await auth.grantCarry({ origin, request }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect it');
      setBusy(false);
    }
  };

  return (
    <Frame>
      <h1 style={styles.title}>Keep your spaces online</h1>
      <p style={styles.subtitle}>
        {request.name ? <>“{request.name}”</> : asker(origin)} wants to keep the spaces in{' '}
        <strong style={{ color: palette.ink.strong }}>{session.account.name}</strong> online while your browser is open — even with no app
        open.
      </p>

      <div style={{ ...styles.errorBox, marginTop: 0, marginBottom: 12, background: palette.surface.sunken }}>
        <p style={{ ...styles.todoText }}>What it can do</p>
        <p style={styles.errorHint}>
          Hold your spaces as they travel, with private ones still locked, and pass them on to your other devices and the people you
          share with.{pod ? ` Keep your pod, “${pod}”, up to date — it asks you to pick the folder next.` : ''}
        </p>
      </div>
      <div style={{ ...styles.errorBox, marginTop: 0, marginBottom: 20, background: palette.surface.sunken }}>
        <p style={{ ...styles.todoText }}>What it can't do</p>
        <p style={styles.errorHint}>
          Read your private spaces, change anything in them, or sign in as you. It never gets your password or a space's key.
        </p>
      </div>

      <p style={{ ...styles.errorHint, marginBottom: 20 }}>
        Like a relay, it can see who wrote something and when, but not what it says. You can disconnect it any time in your account.
      </p>

      {error && (
        <div style={{ ...styles.errorBox, marginBottom: 16 }}>
          <p style={styles.error}>{error}</p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button onClick={() => void allow()} disabled={busy} data-variant="primary" style={styles.button}>
          {busy ? 'Connecting…' : 'Allow'}
        </button>
        <button onClick={() => incoming.deny()} disabled={busy} data-variant="quiet" style={{ ...styles.button, background: palette.surface.card, color: palette.ink.body, borderColor: palette.surface.lineStrong }}>
          Don't allow
        </button>
      </div>
    </Frame>
  );
}

/** The page around it; `mark` off when the sign-in element draws its own */
function Frame({ children, mark = true }: { children: ReactNode; mark?: boolean }) {
  return (
    <div style={{ ...styles.container, paddingTop: 32 }}>
      <div style={{ ...styles.card, paddingTop: 0 }}>
        {mark && (
          <div style={{ marginBottom: 32 }}>
            <Wordmark compact />
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

const choice = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 8,
  fontSize: 14,
  cursor: 'pointer',
} as const;
