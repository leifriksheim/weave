import type { CSSProperties } from 'react';
import type { NodeCollection } from '@weaveprotocol/core';
import { collectionLabel, fieldsOf } from '../derive/schema-ui';
import { namespaceOf } from '../derive/filters';
import { styles, palette } from '../styles';

/** How a namespace reads in a list: its name, or a word for having none */
export const namespaceLabel = (namespace: string) => namespace || 'No namespace';

/**
 * Every collection in the space at once — or in one namespace — with how
 * many records each holds and what shape they have. Opening one shows its
 * records.
 */
export function CollectionsOverview({
  collections,
  namespace,
  onOpen,
}: {
  collections: ReadonlyArray<NodeCollection>;
  namespace: string | null;
  onOpen: (name: string) => void;
}) {
  const total = collections.reduce((sum, c) => sum + c.records, 0);
  return (
    <section
      aria-label="All collections"
      style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}
    >
      <header>
        <h2 style={{ ...styles.appTitle, fontSize: 22 }}>
          {namespace === null ? 'All collections' : namespaceLabel(namespace)}
        </h2>
        <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 4 }}>
          {collections.length} collection{collections.length === 1 ? '' : 's'}, {total} record
          {total === 1 ? '' : 's'}
        </p>
      </header>
      {collections.length === 0 ? (
        <p style={styles.emptyState}>No collections here.</p>
      ) : (
        <div style={{ border: `1px solid ${palette.surface.line}`, borderRadius: 12, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
            <thead>
              <tr>
                <th style={th}>Collection</th>
                <th style={th}>Namespace</th>
                <th style={th}>Fields</th>
                <th style={{ ...th, textAlign: 'right' }}>Records</th>
              </tr>
            </thead>
            <tbody>
              {collections.map((c) => (
                <tr
                  key={c.name}
                  tabIndex={0}
                  onClick={() => onOpen(c.name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onOpen(c.name);
                  }}
                  aria-label={`Open ${collectionLabel(c)}`}
                  style={{ cursor: 'pointer' }}
                >
                  <td style={td}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontWeight: 500, color: palette.ink.strong }}>{collectionLabel(c)}</span>
                      <code style={{ fontSize: 12, color: palette.ink.faint }}>{c.name}</code>
                      {c.description && (
                        <span style={{ fontSize: 12, color: palette.ink.muted, whiteSpace: 'normal' }}>
                          {c.description}
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ ...td, color: palette.ink.muted }}>{namespaceLabel(namespaceOf(c.name))}</td>
                  <td style={{ ...td, color: palette.ink.muted }}>
                    {c.schema ? fieldsOf(c.schema).length : 'Not defined'}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>{c.records}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const th: CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  borderBottom: `1px solid ${palette.surface.line}`,
  color: palette.ink.muted,
  fontWeight: 500,
  fontSize: 12,
  background: palette.surface.sunken,
};
const td: CSSProperties = {
  padding: '10px 14px',
  borderBottom: `1px solid ${palette.surface.line}`,
  color: palette.ink.body,
  verticalAlign: 'top',
  whiteSpace: 'nowrap',
};
