import { useEffect, useRef, useState } from 'react';
import type { HostingView, P2PNode } from '@weaveprotocol/core/node';
import { styles, palette } from '../styles';
import { findWallets, forgetPending, pendingPayment, rememberPending, sendPayment, type Wallet } from '../wallet';

/** The host this home offers by default; any other can be typed in */
const DEFAULT_HOST = import.meta.env.VITE_WEAVE_HOST ?? '';

/** Time paid up front can be topped up this long before it runs out */
const TOP_UP_DAYS = 30;

/**
 * "Keep my spaces online": one host, paid for once, carrying every space of
 * the account — without being able to read them. A card pays on the
 * provider's own page, and coming back here the list asks the host again and
 * hands it the spaces. A crypto wallet pays right here: the host gets the
 * transaction and checks it on the network.
 */
export function Hosting({ node }: { node: P2PNode }) {
  const [hosts, setHosts] = useState<ReadonlyArray<HostingView> | null>(null);
  const [address, setAddress] = useState(DEFAULT_HOST);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Several wallets in this browser: which one to pay with */
  const [picking, setPicking] = useState<{ url: string; plan: string; wallets: ReadonlyArray<Wallet> } | null>(null);
  /** A host whose wallet payment is sent, and waiting for the network */
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = () => void node.hosting.list().then(setHosts, (reason: unknown) => setError(message(reason)));
  useEffect(load, [node]);

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

  const start = () =>
    act('start', async () => {
      await node.hosting.use(address.trim());
      setHosts(await node.hosting.list());
    });
  // Back to this very page after paying: it asks the host again, and the spaces go over.
  const pay = (host: HostingView, plan: string) =>
    act(`pay:${plan}`, async () => {
      window.location.assign(await node.hosting.checkout(host.url, plan, window.location.href));
    });
  const manage = (host: HostingView) =>
    act('manage', async () => {
      window.location.assign(await node.hosting.manage(host.url, window.location.href));
    });
  // Asks the host every few seconds until the network has confirmed the transfer.
  const claim = async (url: string, tx: string) => {
    setConfirming(url);
    try {
      for (let tries = 0; tries < 60; tries++) {
        if (await node.hosting.walletClaim(url, tx)) {
          forgetPending(url);
          setHosts(await node.hosting.list());
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      throw new Error("The network hasn't confirmed the payment yet. It counts once it has: come back to this page in a while.");
    } catch (reason) {
      // Refused for good (another amount, counted already): nothing left to ask about.
      const status = (reason as { status?: number }).status;
      if (status === 400 || status === 409) forgetPending(url);
      throw reason;
    } finally {
      setConfirming(null);
    }
  };
  const payWithWallet = (host: HostingView, plan: string, chosen?: Wallet) =>
    act(`wallet:${plan}`, async () => {
      if (!host.wallet) return;
      const wallets = chosen ? [chosen] : await findWallets();
      if (wallets.length === 0) throw new Error('There is no crypto wallet in this browser. Add one, like MetaMask or Coinbase Wallet, and try again.');
      if (wallets.length > 1) return setPicking({ url: host.url, plan, wallets });
      setPicking(null);
      const payment = await node.hosting.walletPayment(host.url, plan);
      const tx = await sendPayment(wallets[0]!, host.wallet, payment);
      rememberPending(host.url, tx);
      await claim(host.url, tx);
    });
  // A payment sent before a reload is claimed when the page comes back.
  const resumed = useRef(false);
  useEffect(() => {
    if (!hosts || resumed.current) return;
    resumed.current = true;
    for (const host of hosts) {
      const tx = pendingPayment(host.url);
      if (tx) void act('resume', () => claim(host.url, tx));
    }
  }, [hosts]);
  const stop = (host: HostingView) =>
    act('stop', async () => {
      await node.hosting.stop(host.url);
      setHosts(await node.hosting.list());
    });

  return (
    <section style={section}>
      <div>
        <h2 style={{ ...styles.sectionTitle, fontSize: 16, marginBottom: 4 }}>Keep my spaces online</h2>
        <p style={{ color: palette.ink.muted, fontSize: 14, lineHeight: 1.5 }}>
          Your spaces stay reachable and backed up when your devices are off, and a new device can get everything back from your
          recovery code alone. The host stores them encrypted and can't read them. It does see which spaces exist, how big they are
          and when they change.
        </p>
      </div>

      {hosts === null && !error && <p style={styles.errorHint}>Asking your host…</p>}

      {hosts?.length === 0 && (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="https://your-host.example"
            aria-label="Host address"
            style={{ ...styles.input, flex: 1 }}
          />
          <button onClick={() => void start()} disabled={busy !== null || !address.trim()} style={styles.addButton}>
            {busy === 'start' ? 'Asking…' : 'Keep online'}
          </button>
        </div>
      )}

      {hosts?.map((host) => (
        <div key={host.url} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={row}>
            <span>
              {new URL(host.url).host} · {describe(host)}
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              {host.status?.renews && (
                <button onClick={() => void manage(host)} disabled={busy !== null} data-variant="quiet" style={styles.smallButton}>
                  {busy === 'manage' ? 'Opening…' : 'Billing'}
                </button>
              )}
              <button onClick={() => void stop(host)} disabled={busy !== null} data-variant="quiet" style={styles.smallButton}>
                {busy === 'stop' ? 'Stopping…' : 'Stop'}
              </button>
            </span>
          </div>
          {(needsPaying(host) || runsOutSoon(host)) && host.plans.length > 0 && (
            <PayGroup label="Card, Apple Pay or Google Pay">
              {[...host.plans]
                // A year up front first: cheaper for you, and nearly all of it reaches the host.
                .sort((a, b) => (a.id === 'yearly' ? -1 : b.id === 'yearly' ? 1 : 0))
                .map((plan, index) => (
                  <button
                    key={plan.id}
                    onClick={() => void pay(host, plan.id)}
                    disabled={busy !== null}
                    style={index === 0 ? styles.addButton : styles.smallButton}
                  >
                    {busy === `pay:${plan.id}` ? 'Opening…' : `Pay ${plan.label.toLowerCase()}`}
                  </button>
                ))}
            </PayGroup>
          )}
          {(needsPaying(host) || runsOutSoon(host)) && host.wallet && (
            <PayGroup label={`Crypto wallet · ${host.wallet.symbol} on ${host.wallet.chainName}, straight to the host`}>
              {host.wallet.plans.map((plan) => (
                <button
                  key={plan.id}
                  onClick={() => void payWithWallet(host, plan.id)}
                  disabled={busy !== null}
                  style={host.plans.length === 0 && plan.id === host.wallet?.plans[0]?.id ? styles.addButton : styles.smallButton}
                >
                  {busy === `wallet:${plan.id}` && confirming !== host.url
                    ? 'Waiting for the wallet…'
                    : `${plan.label} · ${plan.price} ${host.wallet!.symbol}`}
                </button>
              ))}
            </PayGroup>
          )}
          {picking?.url === host.url && (
            <PayGroup label="Pay with">
              {picking.wallets.map((wallet) => (
                <button key={wallet.name} onClick={() => void payWithWallet(host, picking.plan, wallet)} disabled={busy !== null} style={styles.smallButton}>
                  {wallet.icon && <img src={wallet.icon} alt="" width={16} height={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />}
                  {wallet.name}
                </button>
              ))}
            </PayGroup>
          )}
          {confirming === host.url && <p style={styles.errorHint}>Payment sent. Waiting for the network to confirm it, which takes a few seconds…</p>}
          {host.status?.state === 'grace' && (
            <p style={styles.errorHint}>
              The last payment ran out. Your spaces stay online for a while longer; pay again before then, or the host deletes its copy.
              Your devices keep theirs either way.
            </p>
          )}
        </div>
      ))}

      {error && <p style={{ ...styles.errorHint, color: palette.accent.danger }}>{error}</p>}
    </section>
  );
}

function needsPaying(host: HostingView): boolean {
  return !host.status || host.status.state === 'none' || host.status.state === 'lapsed' || host.status.state === 'grace';
}

/** Time paid up front, running out within a month: offer to add more */
function runsOutSoon(host: HostingView): boolean {
  const status = host.status;
  if (!status || status.state !== 'active' || status.renews || status.paidUntil === 0) return false;
  return status.paidUntil - Date.now() / 1000 < TOP_UP_DAYS * 24 * 3600;
}

function PayGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ color: palette.ink.muted, fontSize: 13 }}>{label}</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function describe(host: HostingView): string {
  const status = host.status;
  if (!status) return `can't be reached right now${host.error ? ` (${host.error})` : ''}`;
  const until = new Date(status.paidUntil * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const spaces = `${status.spaces} space${status.spaces === 1 ? '' : 's'} online`;
  switch (status.state) {
    case 'active':
      return status.paidUntil > 0 ? `paid until ${until} · ${spaces}` : spaces;
    case 'grace':
      return `payment ran out on ${until} · ${spaces} for now`;
    default:
      return host.plans.length || host.wallet ? 'not paid for yet' : "this host isn't taking new accounts";
  }
}

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

const section = {
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 12,
  padding: 20,
  marginBottom: 16,
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 12,
};
const row = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '10px 12px',
  background: palette.surface.sunken,
  borderRadius: 8,
  fontSize: 14,
};
