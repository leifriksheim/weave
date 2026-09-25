import { useEffect, useState } from 'react';
import type { HostingView, P2PNode } from '@weaveprotocol/core/node';
import { styles, palette } from '../styles';

/** The host this home offers by default; any other can be typed in */
const DEFAULT_HOST = import.meta.env.VITE_WEAVE_HOST ?? '';

/**
 * "Keep my spaces online": one host, paid for once, carrying every space of
 * the account — without being able to read them. Paying happens on the
 * provider's own page; coming back here, the list asks the host again and
 * hands it the spaces.
 */
export function Hosting({ node }: { node: P2PNode }) {
  const [hosts, setHosts] = useState<ReadonlyArray<HostingView> | null>(null);
  const [address, setAddress] = useState(DEFAULT_HOST);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
              {host.plans.length > 0 && (host.status?.paidUntil ?? 0) > 0 && (
                <button onClick={() => void manage(host)} disabled={busy !== null} data-variant="quiet" style={styles.smallButton}>
                  {busy === 'manage' ? 'Opening…' : 'Billing'}
                </button>
              )}
              <button onClick={() => void stop(host)} disabled={busy !== null} data-variant="quiet" style={styles.smallButton}>
                {busy === 'stop' ? 'Stopping…' : 'Stop'}
              </button>
            </span>
          </div>
          {needsPaying(host) && host.plans.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
            </div>
          )}
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
      return host.plans.length ? 'not paid for yet' : "this host isn't taking new accounts";
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
