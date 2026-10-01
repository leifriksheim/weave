import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@weaveprotocol/core/react';
import { describeHost, type HostDescription } from '@weaveprotocol/core';
import type { HostingView, P2PNode } from '@weaveprotocol/core/node';
import { DEFAULT_HOST } from '@weave/app-shared/relay';
import { Modal } from '@weave/app-shared/Modal';
import { HostAddressForm, useWanted, type Wanted } from '@weave/app-shared/HostAddress';
import { PayFlow, RemindMe } from '@weave/app-shared/Payment';
import { Benefit, FeatureIcon, StatusPill, shortDate, timeLeft, type Tone } from '@weave/app-shared/Feature';
import { message } from '../message';
import { styles, palette } from '../styles';

const DAY = 86_400;
/** Time paid up front can be topped up this long before it runs out */
const TOP_UP_DAYS = 30;
/** Days before time paid up front runs out that the home says so at the top */
const DUE_DAYS = 14;

/**
 * "Keep my spaces online": one host, paid for once, carrying every space of
 * the account, without being able to read them.
 *
 * Off, it is a product card: what it gives in three lines, the price, and
 * Turn on. On, it is a status line: the host, a pill for how it stands, when
 * it renews or runs out, and how much room is used, with quiet actions: pay
 * or add time, ask again a host that didn't answer, and stop using it, which
 * asks first.
 * Choosing and paying happen in a dialog, and the whole flow is here, not on
 * the host's site (spec/06-nodes-and-sessions.md, Hosts): a checkout page at
 * the payment provider in a new tab, or a payment request for a wallet. The
 * home never touches a card or a wallet's keys, and nothing is set up with a
 * host until a plan is chosen.
 */
export function Hosting({ node }: { node: P2PNode }) {
  const [hosts, setHosts] = useState<ReadonlyArray<HostingView> | null>(null);
  const [offer, setOffer] = useState<HostDescription | null>(null);
  const [dialog, setDialog] = useState<{ url: string | null } | null>(null);
  const [stopping, setStopping] = useState<HostingView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () => node.hosting.list().then(setHosts, (reason: unknown) => setError(message(reason))),
    [node],
  );
  useEffect(() => {
    void load();
    if (DEFAULT_HOST) void describeHost(DEFAULT_HOST).then(setOffer, () => {});
    // Back from a checkout page in the other tab: ask again.
    const back = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [load]);

  const act = async (what: string, work: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(null);
    }
  };
  /** The payment provider's page for a card that renews: opened inside the click, the link following */
  const manage = (host: HostingView) => {
    const tab = window.open('about:blank', '_blank');
    void act('manage', async () => {
      try {
        const answer = await node.hosting.manage(host.url);
        if (!('checkout' in answer)) throw new Error("The host's answer isn't a page to open");
        if (!tab) return void window.open(answer.checkout, '_blank', 'noopener');
        tab.opener = null;
        tab.location.href = answer.checkout;
      } catch (reason) {
        tab?.close();
        throw reason;
      }
    });
  };
  const again = () => act('again', load);

  return (
    <section id="hosting" style={{ ...styles.settingsSection, gap: 16 }}>
      {hosts === null && !error ? (
        <p style={{ fontSize: 13, color: palette.ink.muted }}>Asking your host…</p>
      ) : hosts?.length ? (
        <>
          <h2 style={{ ...styles.sectionTitle, fontSize: 16 }}>Always online</h2>
          {hosts.map((host) => (
            <HostRow
              key={host.url}
              host={host}
              busy={busy}
              onAddTime={() => setDialog({ url: host.url })}
              onManage={() => manage(host)}
              onAgain={() => void again()}
              onStop={() => setStopping(host)}
              remind={(email) => node.hosting.remind(host.url, email)}
            />
          ))}
        </>
      ) : (
        <Offer offer={offer} onTurnOn={() => setDialog({ url: null })} />
      )}

      {error && <p style={{ fontSize: 13, color: palette.accent.danger }}>{error}</p>}

      {dialog && (
        <HostingDialog
          node={node}
          url={dialog.url}
          offer={offer}
          onClose={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {stopping && (
        <StopDialog
          node={node}
          host={stopping}
          onManage={() => manage(stopping)}
          onClose={() => {
            setStopping(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

/** Off: what it gives, the price, and one button */
function Offer({ offer, onTurnOn }: { offer: HostDescription | null; onTurnOn: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <FeatureIcon kind="online" glyph="cloud" size={44} />
        <div style={{ flex: 1 }}>
          <h2 style={{ ...styles.sectionTitle, fontSize: 16 }}>Keep your spaces online</h2>
          <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>
            {offer
              ? `${offer.name} · ${offer.free ? 'free' : (offer.price ?? '')}`
              : 'With a host you choose'}
          </p>
        </div>
      </div>
      <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Benefit glyph="clock">Reachable when all your devices are off</Benefit>
        <Benefit glyph="restore">Everything back on a new device, from your recovery code alone</Benefit>
        <Benefit glyph="shield">Encrypted end to end: the host keeps it and can't read it</Benefit>
      </ul>
      <button onClick={onTurnOn} data-variant="primary" style={styles.addButton}>
        Turn on
      </button>
    </div>
  );
}

/** On: the host, how it stands, and what can be done */
function HostRow({
  host,
  busy,
  onAddTime,
  onManage,
  onAgain,
  onStop,
  remind,
}: {
  host: HostingView;
  busy: string | null;
  onAddTime: () => void;
  onManage: () => void;
  /** Asks a host that didn't answer once more */
  onAgain: () => void;
  onStop: () => void;
  remind: (email: string) => Promise<void>;
}) {
  const state = standing(host);
  const status = host.status;
  const room =
    status?.bytes !== undefined && status.quota !== undefined
      ? Math.min(1, status.bytes / status.quota)
      : null;
  const plans = plansFor(host);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <FeatureIcon kind="online" glyph="cloud" size={40} />
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14, color: palette.ink.strong }}>{host.name}</strong>
            <StatusPill tone={state.tone}>{state.pill}</StatusPill>
          </div>
          <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>{state.line}</p>
        </div>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!host.live && (
            <button
              onClick={onAgain}
              disabled={busy !== null}
              data-variant="quiet"
              style={styles.smallButton}
            >
              {busy === 'again' ? 'Asking…' : 'Try again'}
            </button>
          )}
          {status?.renews ? (
            <button
              onClick={onManage}
              disabled={busy !== null}
              data-variant="quiet"
              style={styles.smallButton}
            >
              {busy === 'manage' ? 'Opening…' : 'Change card'}
            </button>
          ) : (
            plans.length > 0 && (
              <button
                onClick={onAddTime}
                data-variant={needsPaying(host) ? 'primary' : 'quiet'}
                style={needsPaying(host) ? darkSmall : styles.smallButton}
              >
                {status?.paidUntil ? 'Add time' : 'Pay'}
              </button>
            )
          )}
          <button onClick={onStop} disabled={busy !== null} data-variant="danger" style={styles.smallButton}>
            Stop
          </button>
        </span>
      </div>
      {room !== null && status?.bytes !== undefined && status.quota !== undefined && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ height: 4, borderRadius: 2, background: palette.surface.sunken, overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.max(room * 100, 1)}%`,
                height: '100%',
                background: room >= 1 ? palette.accent.danger : palette.ink.strong,
              }}
            />
          </div>
          <p style={{ fontSize: 12, color: palette.ink.faint }}>
            {size(status.bytes)} of {size(status.quota)} used
            {room >= 1 ? ' · a new space waits until there is room' : ''}
          </p>
        </div>
      )}
      {host.reminds && status && !status.renews && status.paidUntil > 0 && <RemindMe remind={remind} />}
    </div>
  );
}

const darkSmall = {
  ...styles.smallButton,
  background: palette.ink.strong,
  color: '#fff',
  border: `1px solid ${palette.ink.strong}`,
};

/**
 * Turning it on, or adding time. For a new host: its name and price, then
 * Continue, which starts using it and shows its plans; on a free host that
 * is all. Another host by its address, for those who have one.
 */
function HostingDialog({
  node,
  url,
  offer,
  onClose,
}: {
  node: P2PNode;
  url: string | null;
  offer: HostDescription | null;
  onClose: () => void;
}) {
  const [host, setHost] = useState<HostingView | null>(null);
  const [other, setOther] = useState(!offer);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const wanted = useWanted();

  useEffect(() => {
    if (!url) return;
    void node.hosting.list().then((hosts) => setHost(hosts.find((known) => known.url === url) ?? null));
  }, [node, url]);

  /**
   * Starts using the host at an address, once it answered as one and is still
   * wanted: closing the dialog or Cancel while it is asked sets nothing up.
   */
  const start = async (where: string, stillWanted: Wanted) => {
    await describeHost(where);
    if (!stillWanted()) return;
    const view = await node.hosting.use(where);
    if (!stillWanted()) return;
    if (!plansFor(view).length || !needsPaying(view)) return onClose();
    setHost(view);
  };
  const startOffered = async (where: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await start(where, wanted);
    } catch (reason) {
      if (wanted()) setProblem(message(reason));
    } finally {
      if (wanted()) setBusy(false);
    }
  };
  const paidUntil = host?.status?.paidUntil ?? 0;

  return (
    <Modal title="Keep your spaces online" onClose={onClose} width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <FeatureIcon kind="online" glyph="cloud" size={44} />
          <div>
            <p style={{ fontSize: 16, fontWeight: 600, color: palette.ink.strong }}>
              {host ? host.name : 'Always online'}
            </p>
            <p style={{ fontSize: 13, color: palette.ink.muted }}>
              {host ? 'Choose how to pay' : 'Your spaces, reachable around the clock'}
            </p>
          </div>
        </div>

        {host ? (
          <PayFlow
            plans={plansFor(host)}
            start={(plan) => node.hosting.pay(host.url, plan)}
            paid={async () =>
              ((await node.hosting.list()).find((known) => known.url === host.url)?.status?.paidUntil ?? 0) >
              paidUntil
            }
            onDone={onClose}
          />
        ) : url ? (
          <p style={{ fontSize: 13, color: palette.ink.muted }}>One moment…</p>
        ) : other || !offer ? (
          <>
            <HostAddressForm onAddress={start} label="Continue" />
            {offer && (
              <button onClick={() => setOther(false)} style={{ ...styles.linkButton, alignSelf: 'center' }}>
                Use {offer.name} instead
              </button>
            )}
          </>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 12,
                padding: '12px 14px',
                borderRadius: 10,
                background: palette.surface.sunken,
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 500, color: palette.ink.strong }}>{offer.name}</span>
              <span style={{ fontSize: 13, color: palette.ink.muted }}>
                {offer.free ? 'Free' : (offer.price ?? '')}
              </span>
            </div>
            <button
              onClick={() => void startOffered(DEFAULT_HOST ?? '')}
              disabled={busy}
              data-variant="primary"
              style={styles.button}
            >
              {busy ? 'One moment…' : 'Continue'}
            </button>
            <button onClick={() => setOther(true)} style={{ ...styles.linkButton, alignSelf: 'center' }}>
              Use another host
            </button>
          </>
        )}
        {problem && (
          <p role="alert" style={{ fontSize: 13, color: palette.accent.danger }}>
            {problem}
          </p>
        )}
        <p style={{ fontSize: 12, color: palette.ink.faint, lineHeight: 1.5, textAlign: 'center' }}>
          The host sees which spaces exist, how big they are and when they change, never what's in them.
        </p>
      </div>
    </Modal>
  );
}

/**
 * Stopping a host, said before it happens: it forgets the account's spaces,
 * which stay on the account's devices, and the subscription is let go, with
 * whatever time was paid for. A card that renews is cancelled at the payment
 * provider, which `stop` doesn't do, so that comes first.
 */
function StopDialog({
  node,
  host,
  onManage,
  onClose,
}: {
  node: P2PNode;
  host: HostingView;
  onManage: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const status = host.status;
  const stop = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await node.hosting.stop(host.url);
      onClose();
    } catch (reason) {
      setProblem(message(reason));
      setBusy(false);
    }
  };
  const said = { fontSize: 14, color: palette.ink.body, lineHeight: 1.5 };
  return (
    <Modal title={`Stop using ${host.name}?`} onClose={onClose} width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={said}>
          {host.name} forgets your spaces. They stay on your devices, and are reachable only while one of them
          is online.
        </p>
        {status?.renews && (
          <p style={said}>
            Your card keeps renewing until you cancel it at the payment provider.{' '}
            <button
              onClick={onManage}
              style={{ ...styles.linkButton, padding: 0, color: palette.ink.strong }}
            >
              Cancel the card first
            </button>
          </p>
        )}
        {status && paidAhead(host) && (
          <p style={said}>The time paid for, until {shortDate(status.paidUntil)}, isn't paid back.</p>
        )}
        {!host.live && (
          <p style={said}>
            {host.name} isn't answering right now, so it may be a while before it drops what it has.
          </p>
        )}
        {problem && (
          <p role="alert" style={{ fontSize: 13, color: palette.accent.danger }}>
            {problem}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 4 }}>
          <button onClick={onClose} disabled={busy} data-variant="quiet" style={styles.smallButton}>
            Keep it
          </button>
          <button
            onClick={() => void stop()}
            disabled={busy}
            data-variant="danger"
            style={{ ...styles.smallButton, color: palette.accent.danger }}
          >
            {busy ? 'Stopping…' : `Stop using ${host.name}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The reminder every device can give without email: each holds the host's
 * signed `paidUntil`, so the home says when time paid up front runs out soon,
 * or has run out, above everything else. One quiet line per host.
 */
export function HostingDue() {
  const session = useSession();
  const [due, setDue] = useState<ReadonlyArray<HostingView>>([]);
  useEffect(() => {
    void session.node.hosting.list().then(
      (hosts) =>
        setDue(
          hosts.filter((host) => {
            const status = host.status;
            if (!status || status.renews || status.paidUntil === 0) return false;
            return status.state === 'grace' || status.paidUntil - Date.now() / 1000 < DUE_DAYS * DAY;
          }),
        ),
      () => {},
    );
  }, [session]);
  return due.map((host) => {
    const state = standing(host);
    return (
      <div
        key={host.url}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
          padding: '10px 12px 10px 14px',
          borderRadius: 10,
          border: `1px solid ${palette.surface.line}`,
        }}
      >
        <StatusPill tone={state.tone}>{state.pill}</StatusPill>
        <span style={{ flex: 1, fontSize: 13, color: palette.ink.muted }}>
          Your spaces at {host.name}. They stay on your devices either way.
        </span>
        <a
          href="#hosting"
          style={{
            ...styles.smallButton,
            display: 'inline-flex',
            alignItems: 'center',
            textDecoration: 'none',
          }}
        >
          Add time
        </a>
      </div>
    );
  });
}

/** How the account stands at a host, as a pill and one line */
function standing(host: HostingView): { tone: Tone; pill: string; line: string } {
  const status = host.status;
  const offline = host.live ? '' : ` · can't reach it right now`;
  if (!status) return { tone: 'bad', pill: "Can't reach host", line: host.error ?? 'Try again in a while' };
  const room =
    status.bytes !== undefined && status.quota !== undefined && status.bytes >= status.quota ? ' · full' : '';
  if (status.state === 'active' && status.paidUntil === 0)
    return { tone: 'good', pill: 'Online', line: `Free${offline}` };
  if (status.state === 'active') {
    const soon = !status.renews && status.paidUntil - Date.now() / 1000 < DUE_DAYS * DAY;
    return {
      tone: soon ? 'warn' : 'good',
      pill: soon ? `Runs out ${timeLeft(status.paidUntil)}` : 'Online',
      line: `${status.renews ? 'Renews' : 'Paid until'} ${shortDate(status.paidUntil)}${room}${offline}`,
    };
  }
  if (status.state === 'grace')
    return {
      tone: 'bad',
      pill: 'Needs payment',
      line: `Ran out ${shortDate(status.paidUntil)}. Your spaces stay online a little longer${offline}`,
    };
  return {
    tone: 'neutral',
    pill: host.plans.length ? 'Not paid yet' : 'Off',
    line: host.plans.length
      ? `Choose a plan to turn it on${offline}`
      : `This host isn't taking new accounts${offline}`,
  };
}

/** The plans a person may choose now: not a card that renews while one already does */
function plansFor(host: HostingView) {
  return host.plans.filter((plan) => !(plan.renews && host.status?.renews));
}

/** Whether time paid up front is still running: what stopping gives up */
function paidAhead(host: HostingView): boolean {
  const status = host.status;
  return status !== null && !status.renews && status.paidUntil > Date.now() / 1000;
}

/** Not paid, running out, or time paid up front that ends within a month */
function needsPaying(host: HostingView): boolean {
  const status = host.status;
  if (!status || status.state !== 'active') return true;
  if (status.renews || status.paidUntil === 0) return false;
  return status.paidUntil - Date.now() / 1000 < TOP_UP_DAYS * DAY;
}

/** Bytes as people read them: 12 KB, 3.4 MB, 10 GB */
function size(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
