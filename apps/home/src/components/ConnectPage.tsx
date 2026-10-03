import { useEffect, useState, type ReactNode } from 'react';
import type { SpaceSummary } from '@weaveprotocol/core';
import {
  isProposeRequest,
  receiveConnectRequest,
  type ConnectRequest,
  type IncomingRequest,
  type ProposeRequest,
} from '@weaveprotocol/core/session';
import { WeaveAuth, useAuth, useSession, useWeave } from '@weaveprotocol/core/react';
import { Wordmark } from '@weave/app-shared/Wordmark';
import { Avatar } from '@weave/app-shared/Avatar';
import { useAction } from '@weave/app-shared/action';
import { styles, palette } from '../styles';

/**
 * An app opened this in a popup to ask for access to the account: sign in,
 * then say what the app gets. The account signs a note for the app's own key;
 * the seed never leaves this page. The app's address is what is trusted, as
 * the browser reports it, not what it calls itself.
 */
export function ConnectPage() {
  const [incoming, setIncoming] = useState<IncomingRequest | null | undefined>(undefined);
  const { state } = useWeave();

  useEffect(() => {
    void receiveConnectRequest().then(setIncoming);
  }, []);

  if (incoming === undefined)
    return (
      <Frame>
        <p style={styles.hint}>Waiting for the app…</p>
      </Frame>
    );

  if (incoming === null) {
    return (
      <Frame>
        <h1 style={styles.title}>Your account home</h1>
        <p style={styles.hint}>
          Apps open this page to ask for access to your Weave account. Nothing has asked right now.
        </p>
        <a href="/" style={{ ...styles.linkButton, paddingLeft: 0 }}>
          Your account
        </a>
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

  const { request } = incoming;
  if (isProposeRequest(request)) return <ApproveProposal incoming={incoming} request={request} />;
  return request.access === 'carry' ? (
    <ApproveCarrier incoming={incoming} request={request} />
  ) : (
    <Approve incoming={incoming} request={request} />
  );
}

/** Who is asking, by the address the browser reports — an extension has no host name worth showing */
function asker(origin: string): string {
  const url = new URL(origin);
  return url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:'
    ? 'A browser extension'
    : url.host;
}

/** A small line above sign-in, so it is clear why this window opened */
function Asking({ incoming }: { incoming: IncomingRequest }) {
  return (
    <p
      style={{
        ...styles.errorHint,
        marginTop: 0,
        marginBottom: 24,
        padding: '10px 12px',
        background: palette.surface.sunken,
        borderRadius: 8,
      }}
    >
      <strong style={{ color: palette.ink.strong }}>{asker(incoming.origin)}</strong>{' '}
      {isProposeRequest(incoming.request)
        ? 'suggests what to notify you about.'
        : 'wants to use your Weave account.'}{' '}
      Sign in to decide
      {isProposeRequest(incoming.request) ? '.' : ' what it gets.'}
    </p>
  );
}

function Approve({ incoming, request }: { incoming: IncomingRequest; request: ConnectRequest }) {
  const { origin } = incoming;
  const { auth } = useAuth();
  const session = useSession();
  const host = new URL(origin).host;
  const agent = request.agent === true;
  const previous = auth.connections().find((known) => known.origin === origin && !!known.agent === agent);

  const spaces = useSpaces(true);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(previous?.spaces.map((space) => space.id) ?? []),
  );
  const { run, busy, error } = useAction();

  const whole = request.scope === 'account';
  const choosing = !whole && request.chooseSpaces !== false;
  const writes = request.access === 'write';
  // Spaces the app can use as asked: to change one, the account must be able to.
  const offered = spaces.filter((space) => !writes || space.writable);
  const privateChosen = offered.some((space) => chosen.has(space.id) && space.visibility === 'private');
  const creating = request.create ?? [];
  // A whole-account app gets the contacts anyway; the box below is for one that asks for them alone.
  const contacts = request.contacts === true && !agent && !whole;
  const nothing = !whole && !contacts && chosen.size === 0 && creating.length === 0;

  const allow = () =>
    run(async () => incoming.approve(await auth.grant({ origin, request, spaceIds: [...chosen] })));

  return (
    <Frame>
      {agent ? (
        <>
          <h1 style={styles.title}>Connect “{request.name ?? 'an agent'}”</h1>
          <p style={styles.subtitle}>
            An AI agent on your computer — Claude Code, Claude Desktop, Cursor — wants to{' '}
            {writes ? 'read and change' : 'read'} {whole ? 'everything in' : 'spaces in'} your account,{' '}
            <strong style={{ color: palette.ink.strong }}>{session.account.name}</strong>. It asked through{' '}
            {host}.
          </p>
          <Note title="What it can do" below={12}>
            Read {whole ? 'every space, including ones you make later' : 'the spaces you pick'}, write in them
            as you, and propose new apps there. Everything it writes shows as yours, “via agent”, to everyone
            in the space. It keeps working when no app is open.
          </Note>
          <Note title="What always needs you">
            Adding an app or a collection, changing roles, inviting or removing people, joining or leaving
            spaces. Every device ignores an agent that tries. It can't sign in as you.
          </Note>
        </>
      ) : (
        <>
          <h1 style={styles.title}>Connect to {host}</h1>
          <p style={styles.subtitle}>
            {request.name ? <>It calls itself “{request.name}”. </> : null}It wants to{' '}
            {writes ? 'read and change' : 'read'} {whole ? 'everything in' : 'spaces in'} your account,{' '}
            <strong style={{ color: palette.ink.strong }}>{session.account.name}</strong>.
          </p>
        </>
      )}

      {whole && !agent && (
        <Note title="Your whole account">
          Every space, including private ones, the list of them, your contacts, and contact requests sent to
          you. It can make and join spaces for you. It cannot sign in anywhere as you, change your password or
          passkeys, or keep access past the date below unless you allow it again.
        </Note>
      )}

      {contacts && (
        <Note title="Your contacts">
          Who is on your contact list, and contact requests sent to you in the spaces it gets. It can change
          the list. Asking someone, or saying yes to a request, also needs your whole account.
        </Note>
      )}

      {choosing && (
        <section style={{ marginBottom: 20 }}>
          <p style={styles.fieldLabel}>{agent ? 'Which spaces it may work in' : 'Which spaces'}</p>
          {offered.length === 0 && <p style={styles.errorHint}>You have no spaces it could use.</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {offered.map((space) => (
              <label key={space.id} style={choice}>
                <input
                  type="checkbox"
                  checked={chosen.has(space.id)}
                  onChange={() => setChosen((was) => toggled(was, space.id))}
                  style={{ ...styles.checkbox, marginTop: 0 }}
                />
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
                  {space.visibility} ·{' '}
                  {space.roles ? space.roles.map((role) => role.title ?? role.name).join(', ') : 'just you'}
                </span>
              </div>
            ))}
          </div>
          <p style={styles.errorHint}>Made in your account, so your other devices and apps see them too.</p>
        </section>
      )}

      <p style={{ ...styles.errorHint, marginBottom: 20 }}>
        Access lasts {lasts(request.days ?? 7)}; after that it asks again.
        {(whole || privateChosen) &&
          ' It can read the private spaces it gets from now on — that cannot be taken back yet.'}
      </p>

      <Answer
        error={error}
        busy={busy}
        blocked={nothing}
        allowLabel={busy ? 'Giving access…' : 'Allow'}
        onAllow={() => void allow()}
        onDeny={() => incoming.deny()}
      />

      <p style={{ ...styles.errorHint, marginTop: 20 }}>
        {agent ? 'The agent' : 'The app'} gets a note signed by your account, for its own key. It never sees
        your password.
        {agent && ' You can disconnect it any time, in your account.'}
      </p>
    </Frame>
  );
}

/**
 * A carrier — the browser extension — asking to keep the spaces online. It
 * gets a pass for each space, never a key: it can hold and pass on what it
 * cannot read.
 */
function ApproveCarrier({ incoming, request }: { incoming: IncomingRequest; request: ConnectRequest }) {
  const { origin } = incoming;
  const { auth, state } = useAuth();
  const session = useSession();
  const { run, busy, error } = useAction();
  const pod = state.place?.kind === 'folder' ? (state.place.directory?.name ?? 'your pod') : null;
  // One extension carries one account: allowing it here moves it off another one.
  const elsewhere = auth.connectedElsewhere(origin);

  const allow = () => run(async () => incoming.approve(await auth.grantCarry({ origin, request })));

  return (
    <Frame>
      <h1 style={styles.title}>Keep your spaces online</h1>
      <p style={styles.subtitle}>
        {request.name ? <>“{request.name}”</> : asker(origin)} wants to keep your spaces online while your
        browser is open — even with no app open.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Avatar did={session.did} size={32} />
        <div style={{ flex: 1 }}>
          <p style={{ ...styles.todoText, margin: 0 }}>{session.account.name}</p>
          <p style={{ ...styles.errorHint, margin: 0 }}>The account it will keep online</p>
        </div>
        <button
          onClick={() => void auth.signOut()}
          disabled={busy}
          data-variant="ghost"
          style={{ ...styles.linkButton, fontSize: 13 }}
        >
          Use another account
        </button>
      </div>

      {elsewhere.length > 0 && (
        <div style={{ ...styles.errorBox, marginTop: 0, marginBottom: 12 }}>
          <p style={{ ...styles.todoText }}>
            It keeps {elsewhere.map((account) => `“${account.name}”`).join(' and ')} online now
          </p>
          <p style={styles.errorHint}>
            It keeps one account online at a time. Allowing it here switches it to {session.account.name}, and{' '}
            {elsewhere.length === 1 ? 'that account stops' : 'those accounts stop'} being kept online. Wanted
            the other one? Choose “Use another account” above.
          </p>
        </div>
      )}

      <Note title="What it can do" below={12}>
        Hold your spaces as they travel, with private ones still locked, and pass them on to your other
        devices and the people you share with.
        {pod ? ` Keep your pod, “${pod}”, up to date — it asks you to pick the folder next.` : ''}
      </Note>
      <Note title="What it can't do">
        Read your private spaces, change anything in them, or sign in as you. It never gets your password or a
        space's key.
      </Note>

      <p style={{ ...styles.errorHint, marginBottom: 20 }}>
        Like a relay, it can see who wrote something and when, but not what it says. You can disconnect it any
        time in your account.
      </p>

      <Answer
        error={error}
        busy={busy}
        allowLabel={busy ? 'Connecting…' : 'Allow'}
        onAllow={() => void allow()}
        onDeny={() => incoming.deny()}
      />
    </Frame>
  );
}

/**
 * An app already connected, suggesting subscriptions because the person
 * asked it to. Nothing else changes: it gets no access it didn't have, and
 * learns only which of its suggestions the person kept.
 */
function ApproveProposal({ incoming, request }: { incoming: IncomingRequest; request: ProposeRequest }) {
  const { origin } = incoming;
  const { auth } = useAuth();
  const session = useSession();
  const connection = auth
    .connections()
    .find((known) => known.origin === origin && !known.agent && known.access !== 'carry');
  const spaces = useSpaces(false);
  const [kept, setKept] = useState<ReadonlySet<number>>(
    () => new Set(request.notify.map((_, index) => index)),
  );
  const { run, busy, error } = useAction();

  const who = connection?.name ?? request.name ?? asker(origin);
  const reachesAll = connection?.scope === 'account';
  const where = (ids: ReadonlyArray<string> | undefined) => {
    if (!ids) return reachesAll ? 'every space' : 'the spaces it has';
    const names = ids.map((id) => spaces.find((space) => space.id === id)?.name ?? 'a space');
    return names.join(', ');
  };

  const allow = () =>
    run(async () => incoming.approve(await auth.propose({ origin, request, notify: [...kept] })));

  if (!connection) {
    return (
      <Frame>
        <h1 style={styles.title}>Not connected here</h1>
        <p style={styles.subtitle}>
          {asker(origin)} suggested what to notify you about, but it isn't connected to your account,{' '}
          {session.account.name}, in this home. Connect it first — or, if it keeps another account, switch to
          that one.
        </p>
        <button
          onClick={() => incoming.deny('It is not connected to this account here. Connect it first.')}
          data-variant="quiet"
          style={styles.button}
        >
          Close
        </button>
      </Frame>
    );
  }

  return (
    <Frame>
      <h1 style={styles.title}>Notify you when…</h1>
      <p style={styles.subtitle}>
        “{who}” suggests these for your account,{' '}
        <strong style={{ color: palette.ink.strong }}>{session.account.name}</strong>. Keep the ones you want.
      </p>

      <section style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {request.notify.map((proposal, index) => (
            <label key={index} style={choice}>
              <input
                type="checkbox"
                checked={kept.has(index)}
                onChange={() => setKept((was) => toggled(was, index))}
                style={{ ...styles.checkbox, marginTop: 0 }}
              />
              <span style={{ flex: 1 }}>{proposal.label}</span>
              <span style={{ color: palette.ink.faint, fontSize: 12 }}>{where(proposal.spaces)}</span>
            </label>
          ))}
        </div>
        <p style={styles.errorHint}>
          {who} lets you know itself, while it is open. You can pause or remove these any time in your
          account.
        </p>
      </section>

      <Answer
        error={error}
        busy={busy}
        blocked={kept.size === 0}
        allowLabel={busy ? 'Adding…' : kept.size === 1 ? 'Notify me' : `Notify me about ${kept.size}`}
        onAllow={() => void allow()}
        denyLabel="Not now"
        onDeny={() => incoming.deny('You chose not to.')}
      />
    </Frame>
  );
}

/** The set with `item` taken out if it was in, put in if it wasn't */
function toggled<T>(set: ReadonlySet<T>, item: T): Set<T> {
  const next = new Set(set);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}

/**
 * The account's spaces, asked again as spaces arrive: one made in an app a
 * moment ago may still be on its way here. With `hold`, a space whose role
 * isn't known yet is opened, which syncs its access history and so its role.
 */
function useSpaces(hold: boolean): ReadonlyArray<SpaceSummary> {
  const session = useSession();
  const [spaces, setSpaces] = useState<ReadonlyArray<SpaceSummary>>([]);
  useEffect(() => {
    const opened = new Set<string>();
    const load = () =>
      void session.node.spaces.list().then(
        (found) => {
          setSpaces(found);
          for (const space of found) {
            if (!hold || space.role !== null || opened.has(space.id)) continue;
            opened.add(space.id);
            void session.node.spaces.hold(space.id).catch(() => {});
          }
        },
        () => {},
      );
    load();
    return session.node.subscribe((event) => {
      if (event.type === 'spaces' || event.type === 'account' || event.type === 'records') load();
    });
  }, [session, hold]);
  return spaces;
}

/** A boxed explanation: what something may do, or may not */
function Note({ title, below = 20, children }: { title: string; below?: number; children: ReactNode }) {
  return (
    <div
      style={{ ...styles.errorBox, marginTop: 0, marginBottom: below, background: palette.surface.sunken }}
    >
      <p style={{ ...styles.todoText }}>{title}</p>
      <p style={styles.errorHint}>{children}</p>
    </div>
  );
}

/** What went wrong, if anything, then the two answers to a request */
function Answer({
  error,
  busy,
  blocked = false,
  allowLabel,
  onAllow,
  denyLabel = "Don't allow",
  onDeny,
}: {
  error: string | null;
  busy: boolean;
  /** Nothing to allow yet */
  blocked?: boolean;
  allowLabel: string;
  onAllow: () => void;
  denyLabel?: string;
  onDeny: () => void;
}) {
  return (
    <>
      {error && (
        <div style={{ ...styles.errorBox, marginBottom: 16 }}>
          <p style={styles.error}>{error}</p>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button onClick={onAllow} disabled={busy || blocked} data-variant="primary" style={styles.button}>
          {allowLabel}
        </button>
        <button
          onClick={onDeny}
          disabled={busy}
          data-variant="quiet"
          style={{
            ...styles.button,
            background: palette.surface.card,
            color: palette.ink.body,
            borderColor: palette.surface.lineStrong,
          }}
        >
          {denyLabel}
        </button>
      </div>
    </>
  );
}

/** "7 days", "1 year" */
function lasts(days: number): string {
  if (days >= 365) return days === 365 ? '1 year' : `${Math.round(days / 365)} years`;
  return days === 1 ? '1 day' : `${days} days`;
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
