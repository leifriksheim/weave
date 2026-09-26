import { useEffect, useMemo, useState } from 'react';
import type { CarrierSummary, NodeCollection, NotifyView, P2PNode, SpaceSummary } from '@weaveprotocol/core/node';
import { styles, palette } from '../styles';

/**
 * "Notify me when…": what the account's extension should let you know about.
 *
 * The extension can't read your spaces, so it never learns what you asked
 * for: it gets each subscription with the value you picked replaced by a tag
 * it can only compare. It shows your label, the space and the time; the
 * message itself you read when you open it.
 */
export function Notifications({ node, carriers }: { node: P2PNode; carriers: ReadonlyArray<CarrierSummary> | null }) {
  const [subscriptions, setSubscriptions] = useState<ReadonlyArray<NotifyView> | null>(null);
  const [spaces, setSpaces] = useState<ReadonlyArray<SpaceSummary>>([]);
  const [collections, setCollections] = useState<ReadonlyArray<NodeCollection>>([]);
  const [where, setWhere] = useState<string>('all');
  const [collection, setCollection] = useState('');
  const [field, setField] = useState('');
  const [value, setValue] = useState('');
  const [others, setOthers] = useState(true);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void node.notifications.list().then(setSubscriptions, (reason: unknown) => setError(message(reason)));
    void node.spaces.list().then(setSpaces, () => {});
    // Opened from the extension: straight here.
    if (location.hash === '#notifications') document.getElementById('notifications')?.scrollIntoView();
  }, [node]);

  // What the chosen spaces hold: every defined collection, once, with its topic fields.
  useEffect(() => {
    const looked = where === 'all' ? spaces.map((space) => space.id) : [where];
    void Promise.all(looked.map((id) => node.collections.list(id).catch(() => [] as NodeCollection[]))).then((lists) => {
      const byName = new Map<string, NodeCollection>();
      for (const found of lists.flat()) if (found.version !== null && !byName.has(found.name)) byName.set(found.name, found);
      setCollections([...byName.values()].sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name)));
    });
  }, [node, where, spaces]);

  const chosen = collections.find((c) => c.name === collection) ?? null;
  const spaceName = (id: string) => spaces.find((space) => space.id === id)?.name ?? 'a space';
  const suggested = useMemo(() => {
    if (!chosen) return '';
    const what = field && value ? `${value === node.did ? 'Mentions me' : `${field} is ${value}`}` : `New ${chosen.title ?? chosen.name}`;
    return `${what}${where === 'all' ? '' : ` in ${spaceName(where)}`}`;
  }, [chosen, field, value, where, spaces]);

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

  const add = () =>
    act('add', async () => {
      await node.notifications.add({
        label: (label.trim() || suggested).slice(0, 120),
        collection,
        spaces: where === 'all' ? 'all' : [where],
        ...(field && value ? { topic: { field, value } } : {}),
        others,
      });
      setField('');
      setValue('');
      setLabel('');
    });

  const noCarrier = carriers !== null && carriers.length === 0;

  return (
    <section id="notifications" style={section}>
      <div>
        <h2 style={{ ...styles.sectionTitle, fontSize: 16, marginBottom: 4 }}>Notify me when…</h2>
        <p style={{ color: palette.ink.muted, fontSize: 14, lineHeight: 1.5 }}>
          Your Weave extension lets you know, even with every app closed. It can't read your spaces, so it never learns what you
          picked here: it matches a code standing in for it. The notification shows your label, the space and the time; you read the
          message when you open it.
        </p>
      </div>

      {noCarrier && <p style={styles.errorHint}>Nothing will notify you until the Weave extension is connected to this account.</p>}

      {subscriptions?.map((sub) => (
        <div key={sub.id} style={row}>
          <span style={{ opacity: sub.paused ? 0.55 : 1 }}>
            {sub.label} · {sub.spaces === 'all' ? 'every space' : sub.spaces.map(spaceName).join(', ')}
            {sub.paused ? ' · paused' : ''}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => void act(`pause:${sub.id}`, async () => void (await node.notifications.update(sub.id, { paused: !sub.paused })))}
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

      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <select value={where} onChange={(event) => setWhere(event.target.value)} aria-label="Where" style={styles.input}>
          <option value="all">Every space</option>
          {spaces.map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
        </select>
        <select
          value={collection}
          onChange={(event) => {
            setCollection(event.target.value);
            setField('');
            setValue('');
          }}
          aria-label="What"
          style={styles.input}
        >
          <option value="">Choose what…</option>
          {collections.map((c) => (
            <option key={c.name} value={c.name}>
              New {c.title ?? c.name}
            </option>
          ))}
        </select>
        {chosen && chosen.topics.length > 0 && (
          <select value={field} onChange={(event) => setField(event.target.value)} aria-label="Only when" style={styles.input}>
            <option value="">Any of them</option>
            {chosen.topics.map((topic) => (
              <option key={topic} value={topic}>
                Only when {topic} is…
              </option>
            ))}
          </select>
        )}
        {field && (
          <span style={{ display: 'flex', gap: 6 }}>
            <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="a value" aria-label="Value" style={{ ...styles.input, flex: 1 }} />
            <button onClick={() => setValue(node.did)} data-variant="quiet" style={styles.smallButton}>
              Me
            </button>
          </span>
        )}
      </div>

      {chosen && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={suggested}
            aria-label="What the notification says"
            style={{ ...styles.input, flex: 1, minWidth: 200 }}
          />
          <label style={{ fontSize: 13, color: palette.ink.muted, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={others} onChange={(event) => setOthers(event.target.checked)} /> Only other people's
          </label>
          <button onClick={() => void add()} disabled={busy !== null || !collection || (field !== '' && !value)} style={styles.addButton}>
            {busy === 'add' ? 'Adding…' : 'Notify me'}
          </button>
        </div>
      )}

      {error && <p style={{ ...styles.errorHint, color: palette.accent.danger }}>{error}</p>}
    </section>
  );
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
