import { useEffect, useState } from 'react';
import { describeHost, type HostDescription } from '@weaveprotocol/core';
import type { HostingView, P2PNode } from '@weaveprotocol/core/node';
import { DEFAULT_HOST } from '@weave/app-shared/relay';
import { message } from '../message';
import { styles, palette } from '../styles';

/** Time paid up front can be topped up this long before it runs out */
const TOP_UP_DAYS = 30;

/**
 * "Keep my spaces online": one host, paid for once, carrying every space of
 * the account — without being able to read them.
 *
 * This home knows nothing about how a host is paid (spec/06-nodes-and-sessions.md, Hosts). **Payment**
 * opens the host's own page in a new tab, with a link signed for this
 * subscription; that page takes cards, wallets, whatever the host chose. The
 * home stays in its own tab, and never follows a link the host hands it, so
 * no host can send the person to a lookalike. Coming back to this tab, the
 * list asks the host again — and what the host signs is kept in the registry.
 *
 * With a host this build offers (`VITE_WEAVE_HOST`), starting is one button:
 * its name and price, and the pay page opening straight after when it wants
 * paying. Any other host is folded away under "Use another host".
 */
export function Hosting({ node }: { node: P2PNode }) {
  const offered = DEFAULT_HOST;
  const [hosts, setHosts] = useState<ReadonlyArray<HostingView> | null>(null);
  const [offer, setOffer] = useState<HostDescription | null>(null);
  const [other, setOther] = useState(!DEFAULT_HOST);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!DEFAULT_HOST) return;
    // A default host that doesn't answer is offered as a field to type another into.
    void describeHost(DEFAULT_HOST).then(setOffer, () => setOther(true));
  }, []);

  useEffect(() => {
    const load = () =>
      void node.hosting.list().then(setHosts, (reason: unknown) => setError(message(reason)));
    load();
    // Back from the host's pay page in the other tab: ask again.
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

  /**
   * Starts with a host, and opens its pay page at once when it wants paying.
   * The tab is opened inside the click, so no popup blocker stops it; the
   * link follows, or the tab closes when there's nothing to pay.
   */
  const start = (url: string, pays: boolean) => {
    const tab = pays ? window.open('about:blank', '_blank') : null;
    void act('start', async () => {
      try {
        const view = await node.hosting.use(url);
        setHosts(await node.hosting.list());
        if (!pays || !view.pays || !needsPaying(view)) return void tab?.close();
        await openPayPage(view, tab);
      } catch (reason) {
        tab?.close();
        throw reason;
      }
    });
  };
  const openPayPage = async (host: HostingView, tab: Window | null) => {
    const link = await node.hosting.payPage(host.url);
    if (!tab) return void window.open(link, '_blank', 'noopener');
    // Cut the tab loose first: the host's page can't reach back into this one.
    tab.opener = null;
    tab.location.href = link;
  };
  const pay = (host: HostingView) => {
    const tab = window.open('about:blank', '_blank');
    void act('pay', async () => {
      try {
        await openPayPage(host, tab);
      } catch (reason) {
        tab?.close();
        throw reason;
      }
    });
  };
  const stop = (host: HostingView) =>
    act('stop', async () => {
      await node.hosting.stop(host.url);
      setHosts(await node.hosting.list());
    });

  return (
    <section style={styles.settingsSection}>
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
            <button
              onClick={() => start(offered, !offer.free && offer.pay !== undefined)}
              disabled={busy !== null}
              style={styles.addButton}
            >
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
            onClick={() => start(address.trim(), false)}
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
              {host.pays && (
                <button
                  onClick={() => pay(host)}
                  disabled={busy !== null}
                  data-variant={needsPaying(host) ? undefined : 'quiet'}
                  style={needsPaying(host) ? styles.addButton : styles.smallButton}
                >
                  {busy === 'pay' ? 'Opening…' : 'Payment'}
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
          {host.pays && needsPaying(host) && host.price && (
            <p style={styles.errorHint}>{host.price}, paid on the host's own page.</p>
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
  switch (status.state) {
    case 'active':
      if (status.paidUntil === 0) return `free${spaces}${offline}`;
      return `${status.renews ? 'renews' : 'paid until'} ${until}${spaces}${offline}`;
    case 'grace':
      return `payment ran out on ${until}${spaces}${offline}`;
    default:
      return host.pays ? `not paid for yet${offline}` : `this host isn't taking new accounts${offline}`;
  }
}
