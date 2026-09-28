import { useEffect, useMemo, useState } from 'react';
import type { NotifyView, P2PNode, SpaceSummary } from '@weaveprotocol/core/node';
import { message } from '../message';
import { styles, palette } from '../styles';

/**
 * "Notify me when…": what apps asked to let you know about, and you allowed.
 *
 * Only an app adds one, when you ask it to, and you say yes here in the home;
 * the home itself adds none. Each shows under the app that asked, which shows
 * the notifications itself. Here you pause or remove them.
 */
export function Notifications({ node }: { node: P2PNode }) {
  const [subscriptions, setSubscriptions] = useState<ReadonlyArray<NotifyView> | null>(null);
  const [spaces, setSpaces] = useState<ReadonlyArray<SpaceSummary>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void node.notifications.list().then(setSubscriptions, (reason: unknown) => setError(message(reason)));
    void node.spaces.list().then(setSpaces, () => {});
    // Linked to from an app: straight here.
    if (location.hash === '#notifications') document.getElementById('notifications')?.scrollIntoView();
  }, [node]);

  const spaceName = (id: string) => spaces.find((space) => space.id === id)?.name ?? 'a space';

  const act = async (what: string, work: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await work();
      setSubscriptions(await node.notifications.list());
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(null);
    }
  };

  // By the app that asked; ones made here before, last.
  const groups = useMemo(() => {
    const byApp = new Map<string, [NotifyView['app'], NotifyView[]]>();
    for (const sub of subscriptions ?? []) {
      const at = sub.app?.origin ?? '';
      if (!byApp.has(at)) byApp.set(at, [sub.app, []]);
      byApp.get(at)![1].push(sub);
    }
    return [...byApp.entries()]
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
      .map(([, group]) => group);
  }, [subscriptions]);

  return (
    <section id="notifications" style={styles.settingsSection}>
      <div>
        <h2 style={{ ...styles.sectionTitle, fontSize: 16, marginBottom: 4 }}>Notify me when…</h2>
        <p style={{ color: palette.ink.muted, fontSize: 14, lineHeight: 1.5 }}>
          Apps you use can ask to notify you. What you allow shows here, under the app that asked, and that
          app lets you know.
        </p>
      </div>

      {subscriptions?.length === 0 && <p style={styles.errorHint}>No app notifies you yet.</p>}

      {groups.map(([app, subs]) => (
        <div key={app?.origin ?? ''} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ ...styles.fieldLabel, margin: 0 }}>
            {app ? `From ${app.name ?? new URL(app.origin).host}` : 'Made here before'}
          </p>
          {subs.map((sub) => (
            <div key={sub.id} style={styles.settingsRow}>
              <span style={{ opacity: sub.paused ? 0.55 : 1 }}>
                {sub.label} · {sub.spaces === 'all' ? 'every space' : sub.spaces.map(spaceName).join(', ')}
                {sub.paused ? ' · paused' : ''}
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() =>
                    void act(
                      `pause:${sub.id}`,
                      async () => void (await node.notifications.update(sub.id, { paused: !sub.paused })),
                    )
                  }
                  disabled={busy !== null}
                  data-variant="quiet"
                  style={styles.smallButton}
                >
                  {sub.paused ? 'Resume' : 'Pause'}
                </button>
                <button
                  onClick={() => void act(`remove:${sub.id}`, () => node.notifications.remove(sub.id))}
                  disabled={busy !== null}
                  data-variant="quiet"
                  style={styles.smallButton}
                >
                  Remove
                </button>
              </span>
            </div>
          ))}
        </div>
      ))}

      {error && <p style={{ ...styles.errorHint, color: palette.accent.danger }}>{error}</p>}
    </section>
  );
}
