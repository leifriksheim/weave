import { useState } from 'react';
import type { NodeCollection, SpaceSummary } from '@p2p-web/protocol';
import { requireSession } from '../protocol';
import { useLive } from '../hooks/useLive';
import { collectionLabel, columnsOf, recordLabel } from '../derive/schema-ui';
import { SchemaForm } from './SchemaForm';
import { Value } from './Value';
import type { Place } from './SpaceView';
import { styles, palette } from '../styles';

/** One kind of thing: its records as a table of their short fields, and a form for a new one. */
export function CollectionView({ space, name, collection, go }: { space: SpaceSummary; name: string; collection: NodeCollection | null; go: (p: Place) => void }) {
  const { node } = requireSession();
  const [adding, setAdding] = useState(false);
  const schema = collection?.schema ?? null;
  const columns = columnsOf(schema);
  const result = useLive(space.id, () => node.records.query(space.id, { collection: name, sort: { '@createdAt': 'desc' } }), [name]);
  const records = result?.records ?? [];

  return (
    <section style={styles.panelSection} aria-label={collection ? collectionLabel(collection) : name}>
      <h2 style={styles.sectionTitle}>
        {collection ? collectionLabel(collection) : name} <code style={{ fontWeight: 400 }}>{name}</code>
      </h2>
      {collection?.description && <p style={styles.hint}>{collection.description}</p>}

      {space.writable &&
        (adding ? (
          <SchemaForm
            schema={schema}
            submitLabel="Add"
            onCancel={() => setAdding(false)}
            onSubmit={async (body) => {
              await node.records.put(space.id, name, body);
              setAdding(false);
            }}
          />
        ) : (
          <button onClick={() => setAdding(true)} data-variant="primary" style={{ ...styles.addButton, alignSelf: 'flex-start' }}>
            + New {collection ? collectionLabel(collection).toLowerCase() : 'record'}
          </button>
        ))}

      {result && records.length === 0 && <p style={styles.emptyState}>None yet.</p>}
      {records.length > 0 && (
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
          {columns.length > 0 && (
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.name} style={cell(true)}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {records.map((r) => (
              <tr key={r.key} onClick={() => go({ collection: name, key: r.key })} style={{ cursor: 'pointer' }} aria-label={recordLabel(r, schema)}>
                {columns.length > 0 ? (
                  columns.map((c) => (
                    <td key={c.name} style={cell(false)}>
                      <Value field={c} value={(r.body as Record<string, unknown> | null)?.[c.name]} />
                    </td>
                  ))
                ) : (
                  <td style={cell(false)}>{recordLabel(r, schema)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const cell = (head: boolean) => ({
  textAlign: 'left' as const,
  padding: '6px 8px',
  borderBottom: `1px solid ${head ? palette.surface.lineStrong : palette.surface.line}`,
  color: head ? palette.ink.muted : palette.ink.body,
  fontWeight: head ? 500 : 400,
});
