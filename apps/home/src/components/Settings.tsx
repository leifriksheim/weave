import { useEffect, useState, type ReactNode } from 'react';
import type { CarrierSummary } from '@weaveprotocol/core/node';
import {
  MIN_PASSWORD_LENGTH,
  STAY_SIGNED_IN_CHOICES,
  accountCredentialName,
  offerToSave,
  recoveryKit,
  type Connection,
  type StaySignedIn,
} from '@weaveprotocol/core/session';
import { useAuth, useSession } from '@weaveprotocol/core/react';
import { Avatar } from '@weave/app-shared/Avatar';
import { PairPhone } from './PairPhone';
import { Hosting } from './Hosting';
import { Notifications } from './Notifications';
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
  const [stay, setStay] = useState<StaySignedIn>(() => auth.staySignedIn.choice());
  const [until, setUntil] = useState<Date | null>(() => auth.staySignedIn.until());
  const hasPasskey = (state.entry?.shortcuts.length ?? 0) > 0;
  const hasPassword = state.entry?.hasPassword ?? false;
  // Without either, every visit here asks for the recovery code.
  const onlyWayIn = Number(hasPasskey) + Number(hasPassword) === 1;
  const [changingPassword, setChangingPassword] = useState(false);
  const place = state.place;
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const disconnect = async (app: Connection) => {
    setDisconnecting(connectionId(app));
    try {
      // An agent is its own key; an app takes the agents that connected through it along.
      await auth.disconnect(app.origin, app.agent ? { audience: app.audience } : {});
    } finally {
      setDisconnecting(null);
    }
  };

  // Carriers are in the account registry, so every device lists them — not
  // only the home that connected one, which is all `connections()` knows.
  const [carriers, setCarriers] = useState<ReadonlyArray<CarrierSummary> | null>(null);
  // A host is a carrier too, but it has its own section.
  const [hostKeys, setHostKeys] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    void session.node.hosting.list().then(
      (hosts) => setHostKeys(new Set(hosts.map((host) => host.host))),
      () => {},
    );
  }, [session]);
  // Which carriers are online now: each is a peer in its own carry space. One
  // that never is may be keeping another account online instead.
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let current: ReadonlyArray<CarrierSummary> = [];
    const look = async () => {
      const seen = new Set<string>();
      for (const carrier of current) {
        const status = await session.node.spaces.status(carrier.space).catch(() => null);
        if (status?.peers.includes(carrier.did)) seen.add(carrier.space);
      }
      setOnline(seen);
    };
    const load = () =>
      void session.node.carriers.list().then(
        (found) => {
          current = found;
          setCarriers(found);
          void look();
        },
        () => {},
      );
    load();
    return session.node.subscribe((event) => {
      if (event.type === 'records' || event.type === 'account') load();
      else if (event.type === 'status' && current.some((carrier) => carrier.space === event.space))
        void look();
    });
  }, [session]);
  const presence = (space: string | undefined) =>
    space && online.has(space) ? 'online now' : 'not online right now';
  const anyAway = (carriers ?? []).some((carrier) => !online.has(carrier.space));
  // A carrier disconnected on another device is gone here too.
  const connections = auth
    .connections()
    .filter(
      (app) =>
        app.access !== 'carry' ||
        carriers === null ||
        carriers.some((carrier) => carrier.space === app.carrySpace),
    );
  const known = new Set(connections.map((app) => app.carrySpace).filter(Boolean));
  const elsewhere = (carriers ?? []).filter(
    (carrier) => !known.has(carrier.space) && !hostKeys.has(carrier.did),
  );
  const removeCarrier = async (space: string) => {
    setDisconnecting(space);
    try {
      await session.node.carriers.remove(space);
      setCarriers(await session.node.carriers.list());
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
        {connections.length === 0 && elsewhere.length === 0 && <Row label="No apps yet.">{null}</Row>}
        {connections.map((app) => (
          <Row
            key={connectionId(app)}
            label={
              app.access === 'carry'
                ? `${describeConnection(app)} · ${presence(app.carrySpace)}`
                : describeConnection(app)
            }
          >
            <button
              onClick={() => void disconnect(app)}
              disabled={disconnecting !== null}
              data-variant="quiet"
              style={styles.smallButton}
            >
              {disconnecting === connectionId(app) ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </Row>
        ))}
        {elsewhere.map((carrier) => (
          <Row
            key={carrier.space}
            label={`${carrier.name} · keeps your spaces online · connected on another device · ${presence(carrier.space)}`}
          >
            <button
              onClick={() => void removeCarrier(carrier.space)}
              disabled={disconnecting !== null}
              data-variant="quiet"
              style={styles.smallButton}
            >
              {disconnecting === carrier.space ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </Row>
        ))}
        {anyAway && (
          <p style={styles.errorHint}>
            An extension that is not online either has Chrome closed, or is keeping a different account online
            now — open it to see which.
          </p>
        )}
        {connections.length > 0 && (
          <p style={styles.errorHint}>
            Disconnecting stops the app for good the next time it comes online: it signs itself out, and
            nothing it changes after that counts. What it already wrote stays, and it keeps what it could
            already read.
          </p>
        )}
      </Section>

      <Hosting node={session.node} />

      <Notifications node={session.node} carriers={carriers} />

      <Section
        title="Signing in"
        description="How you open your account here every day. A passkey works in this browser; a password works wherever your account is kept, including your pod in other apps."
      >
        {hasPasskey ? (
          <Row label="A passkey signs you in on this device.">
            <button
              onClick={() => void auth.removeShortcut('passkey')}
              disabled={state.busy || onlyWayIn}
              title={
                onlyWayIn
                  ? 'Set a password first — otherwise you would need your recovery code to get back in.'
                  : undefined
              }
              data-variant="quiet"
              style={{ ...styles.smallButton, color: palette.accent.danger }}
            >
              Remove
            </button>
          </Row>
        ) : (
          <Row label="No passkey on this device.">
            <button
              onClick={() => void auth.addPasskey()}
              disabled={state.busy}
              data-variant="primary"
              style={{ ...styles.smallButton, background: '#000', color: '#fff', borderColor: '#000' }}
            >
              {state.busy ? 'Waiting…' : 'Set up a passkey'}
            </button>
          </Row>
        )}
        {changingPassword ? (
          <PasswordForm
            account={session.account.name}
            busy={state.busy}
            onSave={async (password) => {
              const ok = await auth.setPassword(password);
              if (ok) {
                const filedAs = accountCredentialName(session.account.name);
                await offerToSave(filedAs, password, filedAs);
                setChangingPassword(false);
              }
              return ok;
            }}
            onCancel={() => setChangingPassword(false)}
          />
        ) : (
          <Row label={hasPassword ? 'A password is set.' : 'No password.'}>
            <span style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => setChangingPassword(true)}
                disabled={state.busy}
                data-variant="quiet"
                style={styles.smallButton}
              >
                {hasPassword ? 'Change' : 'Set a password'}
              </button>
              {hasPassword && (
                <button
                  onClick={() => void auth.removeShortcut('passphrase')}
                  disabled={state.busy || onlyWayIn}
                  title={
                    onlyWayIn
                      ? 'Set up a passkey first — otherwise you would need your recovery code to get back in.'
                      : undefined
                  }
                  data-variant="quiet"
                  style={{ ...styles.smallButton, color: palette.accent.danger }}
                >
                  Remove
                </button>
              )}
            </span>
          </Row>
        )}
        {changingPassword && state.error && <p style={styles.error}>{state.error.message}</p>}
      </Section>

      <RecoveryCode reveal={() => auth.recoveryCode()} name={session.account.name} did={session.did} />

      <Section
        title="Stay signed in"
        description="Skip unlocking when you come back. After this long without using it, you'll be asked again."
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
          <Row
            label={place?.kind === 'folder' ? `Pod: ${place.directory?.name ?? 'folder'}` : 'In this browser'}
          >
            <button
              onClick={() => void auth.choosePod()}
              disabled={state.busy}
              data-variant="quiet"
              style={styles.smallButton}
            >
              {place?.kind === 'folder' ? 'Change pod' : 'Move to a pod'}
            </button>
          </Row>
        </Section>
      )}

      <div style={{ marginBottom: 16 }}>
        <PairPhone />
      </div>

      <Section
        title="Sign out of this device"
        description="Signs this account home out on this device. Apps you connected stay connected — disconnect them under Connected apps. Your account and your data stay where they are."
      >
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
function AccountHeader({
  name,
  did,
  onRename,
}: {
  name: string;
  did: string;
  onRename: (name: string) => Promise<boolean>;
}) {
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
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoFocus
              aria-label="Account name"
              style={{ ...styles.input, height: 34 }}
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              data-variant="primary"
              style={{
                ...styles.smallButton,
                height: 34,
                background: '#000',
                color: '#fff',
                borderColor: '#000',
              }}
            >
              Save
            </button>
          </form>
        ) : (
          <h1 style={{ ...styles.appTitle, display: 'flex', alignItems: 'baseline', gap: 10 }}>
            {name}
            <button
              onClick={() => {
                setDraft(name);
                setEditing(true);
              }}
              data-variant="ghost"
              style={{ ...styles.linkButton, fontSize: 13 }}
            >
              Rename
            </button>
          </h1>
        )}
        <CopyDid did={did} />
      </div>
    </header>
  );
}

/** A new password, twice; a manager fills both and offers to save it under the account's name */
function PasswordForm({
  account,
  busy,
  onSave,
  onCancel,
}: {
  account: string;
  busy: boolean;
  onSave: (password: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [mismatch, setMismatch] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setMismatch(password !== again);
        if (password === again) void onSave(password);
      }}
      style={styles.form}
    >
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={accountCredentialName(account)}
        readOnly
        aria-label="Account"
        style={styles.input}
      />
      <input
        type="password"
        name="password"
        autoComplete="new-password"
        placeholder="New password"
        minLength={MIN_PASSWORD_LENGTH}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoFocus
        aria-label="New password"
        style={styles.input}
      />
      <input
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        placeholder="The same again"
        value={again}
        onChange={(event) => setAgain(event.target.value)}
        aria-label="Confirm password"
        style={styles.input}
      />
      {mismatch && <p style={styles.error}>Those two do not match.</p>}
      <p style={styles.errorHint}>
        At least {MIN_PASSWORD_LENGTH} characters. Let your password manager make one.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="submit"
          disabled={busy || !password}
          data-variant="primary"
          style={{ ...styles.smallButton, background: '#000', color: '#fff', borderColor: '#000' }}
        >
          {busy ? 'Saving…' : 'Save password'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          data-variant="quiet"
          style={styles.smallButton}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The recovery code, hidden until asked for. It is the account itself, so it
 * is shown only on purpose, and never offered to a password manager as a login.
 */
function RecoveryCode({ reveal, name, did }: { reveal: () => string | null; name: string; did: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const download = () => {
    if (!code) return;
    const kit = recoveryKit({ code, name, did });
    const url = URL.createObjectURL(new Blob([kit.text], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = kit.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Section
      title="Recovery code"
      description="Your account, written out. It restores the account on any device, even one that has never seen it. Keep it somewhere safe — nobody can reissue it."
    >
      {code ? (
        <>
          <code
            style={{
              display: 'block',
              padding: 12,
              borderRadius: 8,
              background: palette.surface.sunken,
              border: `1px solid ${palette.surface.line}`,
              fontSize: 15,
              letterSpacing: '0.04em',
              textAlign: 'center',
              wordBreak: 'break-all',
              userSelect: 'all',
            }}
          >
            {code}
          </code>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => void navigator.clipboard.writeText(code).then(() => setCopied(true))}
              data-variant="quiet"
              style={styles.smallButton}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={download} data-variant="quiet" style={styles.smallButton}>
              Download
            </button>
            <button
              onClick={() => {
                setCode(null);
                setCopied(false);
              }}
              data-variant="quiet"
              style={styles.smallButton}
            >
              Hide
            </button>
          </div>
          <p style={styles.errorHint}>Anyone who sees this can open your account.</p>
        </>
      ) : (
        <div>
          <button onClick={() => setCode(reveal())} data-variant="quiet" style={styles.smallButton}>
            Show recovery code
          </button>
        </div>
      )}
    </Section>
  );
}

/** Agents connect through an app's origin, several to one, so each is named by its key */
const connectionId = (app: Connection) => (app.agent ? app.audience : app.origin);

/** "Todo (todo.example) · read and change Groceries · until 3 October" */

/** The account's DID, short, with a way to copy it whole — what a host's `--allow` takes */
function CopyDid({ did }: { did: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(did);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <code title={did} style={{ fontSize: 12, color: palette.ink.faint }}>
        {did.slice(0, 16)}…{did.slice(-6)}
      </code>
      <button
        onClick={() => void copy()}
        data-variant="quiet"
        style={{ ...styles.smallButton, height: 24, fontSize: 12 }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

function describeConnection(app: Connection): string {
  const url = new URL(app.origin);
  const extension = url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:';
  if (app.access === 'carry')
    return `${app.name ?? 'Browser extension'} · keeps your spaces online · can't read them`;
  const host = extension ? 'browser extension' : url.host;
  const who = app.agent
    ? `${app.name ?? 'An agent'} (agent, via ${host})`
    : app.name
      ? `${app.name} (${host})`
      : host;
  const what =
    app.scope === 'account'
      ? 'your whole account'
      : app.spaces.length
        ? app.spaces.map((space) => space.name).join(', ')
        : 'no spaces';
  const until = new Date(app.expiresAt * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
  });
  const expired = app.expiresAt * 1000 < Date.now();
  return `${who} · ${app.access === 'write' ? 'read and change' : 'read'} ${what} · ${expired ? 'ran out' : `until ${until}`}`;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        border: `1px solid ${palette.surface.line}`,
        borderRadius: 12,
        padding: 20,
        marginBottom: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
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
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 12px',
        background: palette.surface.sunken,
        borderRadius: 8,
        fontSize: 14,
      }}
    >
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
