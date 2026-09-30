import { useEffect, useState } from 'react';
import { useSession } from '@weaveprotocol/core/react';
import { describeHost, type HostDescription } from '@weaveprotocol/core';
import type { HostingView, P2PNode } from '@weaveprotocol/core/node';
import { DEFAULT_HOST } from '@weave/app-shared/relay';
import { Payment, RemindMe } from '@weave/app-shared/Payment';
import { message } from '../message';
import { styles, palette } from '../styles';

/** Time paid up front can be topped up this long before it runs out */
const TOP_UP_DAYS = 30;

/**
 * "Keep my spaces online": one host, paid for once, carrying every space of
 * the account — without being able to read them.
 *
 * The whole flow is here, not on the host's site (spec/06-nodes-and-sessions.md, Hosts): the host's
 * plans as buttons, and what it answers, shown by `Payment` — a checkout page
 * at the payment provider in a new tab, or a payment request for a wallet.
 * The home never touches a card or a wallet's keys. Coming back to this tab,
 * the list asks the host again, and what the host signs is kept in the
 * registry.
 *
 * With a host this build offers (`VITE_WEAVE_HOST`), starting is one button,
 * with its name and price. Any other host is folded away under "Use another
 * host".
 */
export function Hosting({ node }: { node: P2PNode }) {
  const offered = DEFAULT_HOST;
  const [hosts, setHosts] = useState<ReadonlyArray<HostingView> | null>(null);
  const [offer, setOffer] = useState<HostDescription | null>(null);
  const [other, setOther] = useState(!DEFAULT_HOST);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Whether the plans show for a host that is paid already: adding time, or changing plan */
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    if (!DEFAULT_HOST) return;
    // A default host that doesn't answer is offered as a field to type another into.
    void describeHost(DEFAULT_HOST).then(setOffer, () => setOther(true));
  }, []);

  useEffect(() => {
    const load = () =>
      void node.hosting.list().then(setHosts, (reason: unknown) => setError(message(reason)));
    load();
    // Back from a checkout page in the other tab: ask again.
    const back = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [node]);

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

  const start = (url: string) =>
    act('start', async () => {
      await node.hosting.use(url);
      setHosts(await node.hosting.list());
    });
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
  /** Whether a host's date moved past what it said before: the payment arrived */
  const paidSince = (host: HostingView) => async () => {
    const now = await node.hosting.list();
    const moved =
      (now.find((known) => known.url === host.url)?.status?.paidUntil ?? 0) > (host.status?.paidUntil ?? 0);
    if (moved) {
      setHosts(now);
      setAdding(null);
    }
    return moved;
  };
  const stop = (host: HostingView) =>
    act('stop', async () => {
      await node.hosting.stop(host.url);
      setHosts(await node.hosting.list());
    });

  return (
    <section id="hosting" style={styles.settingsSection}>
      <div>
        <h2 style={{ ...styles.sectionTitle, fontSize: 16, marginBottom: 4 }}>Keep my spaces online</h2>
        <p style={{ color: palette.ink.muted, fontSize: 14, lineHeight: 1.5 }}>
          Your spaces stay reachable and backed up when your devices are off, and a new device can get
          everything back from your recovery code alone. The host stores them encrypted and can't read them.
          It does see which spaces exist, how big they are and when they change.
        </p>
      </div>

      {hosts === null && !error && <p style={styles.errorHint}>Asking your host…</p>}

      {hosts?.length === 0 && offer && offered && !other && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <div style={{ ...styles.settingsRow, alignSelf: 'stretch' }}>
            <span>
              {offer.name}
              {offer.free ? ' · free' : offer.price ? ` · ${offer.price}` : ''}
            </span>
            <button onClick={() => void start(offered)} disabled={busy !== null} style={styles.addButton}>
              {busy === 'start' ? 'Starting…' : 'Keep online'}
            </button>
          </div>
          <button onClick={() => setOther(true)} data-variant="quiet" style={styles.smallButton}>
            Use another host
          </button>
        </div>
      )}

      {hosts?.length === 0 && other && (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="https://your-host.example"
            aria-label="Host address"
            style={{ ...styles.input, flex: 1 }}
          />
          <button
            onClick={() => void start(address.trim())}
            disabled={busy !== null || !address.trim()}
            style={styles.addButton}
          >
            {busy === 'start' ? 'Asking…' : 'Keep online'}
          </button>
        </div>
      )}

      {hosts?.map((host) => (
        <div key={host.url} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={styles.settingsRow}>
            <span>
              {host.name} · {describe(host)}
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              {host.status?.renews && (
                <button
                  onClick={() => manage(host)}
                  disabled={busy !== null}
                  data-variant="quiet"
                  style={styles.smallButton}
                >
                  {busy === 'manage' ? 'Opening…' : 'Change card or cancel'}
                </button>
              )}
              {plansFor(host).length > 0 && !needsPaying(host) && (
                <button
                  onClick={() => setAdding(adding === host.url ? null : host.url)}
                  data-variant="quiet"
                  style={styles.smallButton}
                >
                  {adding === host.url ? 'Close' : 'Add time'}
                </button>
              )}
              <button
                onClick={() => void stop(host)}
                disabled={busy !== null}
                data-variant="quiet"
                style={styles.smallButton}
              >
                {busy === 'stop' ? 'Stopping…' : 'Stop'}
              </button>
            </span>
          </div>
          {plansFor(host).length > 0 && (needsPaying(host) || adding === host.url) && (
            <Payment
              plans={plansFor(host)}
              start={(plan) => node.hosting.pay(host.url, plan)}
              paid={paidSince(host)}
            />
          )}
          {host.reminds && host.status && !host.status.renews && host.status.paidUntil > 0 && (
            <RemindMe remind={(email) => node.hosting.remind(host.url, email)} />
          )}
          {host.status?.quota !== undefined && (host.status.bytes ?? 0) >= host.status.quota && (
            <p style={styles.errorHint}>
              Your spaces take all the room this host gives you. What it keeps stays online; a new space waits
              until there is room.
            </p>
          )}
          {host.status?.state === 'grace' && (
            <p style={styles.errorHint}>
              The last payment ran out. Your spaces stay online for a while longer; pay again before then, or
              the host deletes its copy. Your devices keep theirs either way.
            </p>
          )}
        </div>
      ))}

      {error && <p style={{ ...styles.errorHint, color: palette.accent.danger }}>{error}</p>}
    </section>
  );
}

/** Days before time paid up front runs out that the home says so at the top */
const DUE_DAYS = 14;

/**
 * The reminder every device can give without email: each holds the host's
 * signed `paidUntil`, so the home says when time paid up front runs out soon,
 * or has run out, above everything else.
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
            return status.state === 'grace' || status.paidUntil - Date.now() / 1000 < DUE_DAYS * 24 * 3600;
          }),
        ),
      () => {},
    );
  }, [session]);
  return due.map((host) => {
    const until = new Date((host.status?.paidUntil ?? 0) * 1000).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'long',
    });
    return (
      <div key={host.url} style={{ ...styles.errorBox, marginTop: 0, marginBottom: 16 }}>
        <p style={styles.error}>
          {host.status?.state === 'grace'
            ? `The time paid at ${host.name} ran out on ${until}`
            : `The time paid at ${host.name} runs out on ${until}`}
        </p>
        <p style={styles.errorHint}>
          Your spaces stay on your devices either way; the host keeps its copy online while it is paid.{' '}
          <a href="#hosting">Add time</a>
        </p>
      </div>
    );
  });
}

/** The plans a person may choose now: not a card that renews while one already does */
function plansFor(host: HostingView) {
  return host.plans.filter((plan) => !(plan.renews && host.status?.renews));
}

/** Not paid, running out, or time paid up front that ends within a month */
function needsPaying(host: HostingView): boolean {
  const status = host.status;
  if (!status || status.state !== 'active') return true;
  if (status.renews || status.paidUntil === 0) return false;
  return status.paidUntil - Date.now() / 1000 < TOP_UP_DAYS * 24 * 3600;
}

function describe(host: HostingView): string {
  const status = host.status;
  const unreachable = `can't be reached right now${host.error ? ` (${host.error})` : ''}`;
  if (!status) return unreachable;
  // Not live: the last the host signed, from the registry.
  const offline = host.live ? '' : ` · ${unreachable}`;
  const until = new Date(status.paidUntil * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  // No count: the host also carries the account's hidden spaces (its registry, its contacts), so any number would look wrong.
  const spaces = host.live && status.carrying ? ' · your spaces are online' : '';
  const room =
    status.bytes === undefined
      ? ''
      : ` · ${size(status.bytes)}${status.quota === undefined ? '' : ` of ${size(status.quota)}`}`;
  switch (status.state) {
    case 'active':
      if (status.paidUntil === 0) return `free${spaces}${room}${offline}`;
      return `${status.renews ? 'renews' : 'paid until'} ${until}${spaces}${room}${offline}`;
    case 'grace':
      return `payment ran out on ${until}${spaces}${offline}`;
    default:
      return host.plans.length
        ? `not paid for yet${offline}`
        : `this host isn't taking new accounts${offline}`;
  }
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
