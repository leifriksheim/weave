import { useEffect, useState } from 'react';
import { fieldValue, type QueryRecord, type QueryResult, type SpaceSummary, type View } from '@p2p-web/protocol';
import { requireSession } from '../protocol';
import { COLLECTION } from '../todos';
import { styles, palette } from '../styles';

/**
 * Views saved in this space — by this app, another app, or an agent — drawn
 * by one generic renderer. A view is data (`sys.view`: a query and a layout);
 * nothing here knows what a todo is.
 */
export function ViewsPanel({ space }: { space: SpaceSummary }) {
  const { node } = requireSession();
  const [views, setViews] = useState<ReadonlyArray<QueryRecord<View>>>([]);

  useEffect(
    () => node.records.watch<View>(space.id, { collection: 'sys.view', sort: { '@createdAt': 'asc' } }, (r) => setViews(r.records)),
    [node, space.id],
  );

  // A starting point: the kind of thing an agent would write when asked for
  // "a table of what's left, with the likes".
  const addExample = () =>
    node.records.put<View>(space.id, 'sys.view', {
      title: 'Still to do',
      description: 'Open todos, oldest first, with their 👍 count',
      query: {
        collection: COLLECTION,
        where: { completed: false },
        sort: { order: 'asc' },
        include: { likes: { rel: 'about', from: 'sys.reaction', count: true } },
      },
      layout: 'table',
      fields: [{ field: 'text', label: 'What' }, { field: '@createdAt', label: 'Added' }],
    });

  return (
    <details style={styles.panel}>
      <summary data-variant="ghost" style={styles.panelSummary}>
        🪟 Views {views.length > 0 && `(${views.length})`}
      </summary>
      <div style={styles.panelBody}>
        <p style={styles.errorHint}>
          A view is a saved query and a layout, stored in the list as data. An agent can write one, and any app
          that draws views shows it — without knowing what the records are.
        </p>
        {views.map((view) =>
          view.body ? (
            <ViewBlock
              key={view.key}
              space={space}
              view={view.body}
              {...(space.writable ? { onRemove: () => void node.records.delete(space.id, view.key) } : {})}
            />
          ) : null,
        )}
        {space.writable && (
          <button onClick={() => void addExample()} data-variant="ghost" style={{ ...styles.addButton, alignSelf: 'flex-start' }}>
            Add an example view
          </button>
        )}
      </div>
    </details>
  );
}

function ViewBlock({ space, view, onRemove }: { space: SpaceSummary; view: View; onRemove?: () => void }) {
  const { node } = requireSession();
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      node.records.watch(
        space.id,
        view.query,
        (r) => {
          setResult(r);
          setError(null);
        },
        (e) => setError(e.message),
      ),
    [node, space.id, view.query],
  );

  const records = (result?.records ?? []).filter((r) => r.body !== null);
  const fields = view.fields ?? [];
  const includes = Object.keys(view.query.include ?? {});

  return (
    <section aria-label={`View: ${view.title}`} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
      <div style={styles.chainRow}>
        <strong style={styles.sectionTitle}>{view.title}</strong>
        <span style={styles.badge}>{view.layout}</span>
        {onRemove && (
          <button onClick={onRemove} data-variant="ghost" style={styles.linkButton} aria-label={`Remove view ${view.title}`}>
            remove
          </button>
        )}
      </div>
      {view.description && <span style={styles.factLabel}>{view.description}</span>}
      {error && <span style={styles.error}>{error}</span>}
      {result && records.length === 0 && <span style={styles.factLabel}>Nothing matches.</span>}
      {records.length > 0 && <Layout view={view} records={records} fields={fields} includes={includes} />}
    </section>
  );
}

type Field = { field: string; label?: string };

function Layout({ view, records, fields, includes }: { view: View; records: ReadonlyArray<QueryRecord>; fields: ReadonlyArray<Field>; includes: string[] }) {
  // Without fields, show the body's own top-level fields.
  const shown: ReadonlyArray<Field> = fields.length > 0 ? fields : Object.keys((records[0]?.body as object) ?? {}).map((field) => ({ field }));
  const columns = [...shown.map((f) => ({ label: f.label ?? f.field, get: (r: QueryRecord) => display(fieldValue(r, f.field)) })),
    ...includes.map((name) => ({ label: name, get: (r: QueryRecord) => display(r.included?.[name]) }))];

  switch (view.layout) {
    case 'table':
      return (
        <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
          <thead>
            <tr>{columns.map((c) => <th key={c.label} style={cell(true)}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.key}>{columns.map((c) => <td key={c.label} style={cell(false)}>{c.get(r)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      );
    case 'board': {
      const groups = new Map<string, QueryRecord[]>();
      for (const r of records) {
        const group = display(fieldValue(r, view.groupBy ?? ''));
        groups.set(group, [...(groups.get(group) ?? []), r]);
      }
      return (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto' }}>
          {[...groups].map(([group, items]) => (
            <div key={group} style={{ flex: '1 0 140px', background: palette.surface.sunken, borderRadius: 8, padding: 8 }}>
              <div style={styles.factLabel}>{view.groupBy}: {group}</div>
              {items.map((r) => <Card key={r.key} record={r} columns={columns} />)}
            </div>
          ))}
        </div>
      );
    }
    case 'cards':
      return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
          {records.map((r) => <Card key={r.key} record={r} columns={columns} />)}
        </div>
      );
    default: // 'list', and any layout this app does not know
      return (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
          {records.map((r) => (
            <li key={r.key}>{columns.map((c) => c.get(r)).filter(Boolean).join(' · ')}</li>
          ))}
        </ul>
      );
  }
}

function Card({ record, columns }: { record: QueryRecord; columns: ReadonlyArray<{ label: string; get: (r: QueryRecord) => string }> }) {
  return (
    <div style={{ background: palette.surface.card, border: `1px solid ${palette.surface.line}`, borderRadius: 8, padding: 8, marginTop: 6, fontSize: 13 }}>
      {columns.map((c, i) => (
        <div key={c.label} style={i === 0 ? { color: palette.ink.strong, fontWeight: 500 } : styles.factLabel}>
          {i === 0 ? c.get(record) : `${c.label}: ${c.get(record)}`}
        </div>
      ))}
    </div>
  );
}

const cell = (head: boolean) => ({
  textAlign: 'left' as const,
  padding: '4px 6px',
  borderBottom: `1px solid ${head ? palette.surface.lineStrong : palette.surface.line}`,
  color: head ? palette.ink.muted : palette.ink.body,
  fontWeight: head ? 500 : 400,
});

/** A field's value as text. Timestamps read as dates; included lists as their length. */
function display(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return String(value.length);
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) return new Date(value).toLocaleString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
