import { useState } from 'react';
import { useNode } from 'weave-protocol/react';
import type { NodeCollection, SpaceSummary } from 'weave-protocol';
import { standardSchemas, useSchemas } from 'weave-protocol/schemas';
import { styles, palette } from '../styles';

const WHAT_IT_ADDS: Record<string, string> = {
  'std.reaction': 'Emoji reactions on anything — one of each per person.',
  'std.comment': 'A comment thread on every record.',
  'std.tag': 'Labels on records, shown as #tags.',
  'std.attachment': 'Describe a file attached to a record.',
  'std.reference': 'Note that one record refers to another.',
};

/**
 * The standard schema library, offered rather than assumed: the ones this
 * space has not added yet, each a click away. Nothing is written until
 * someone picks one — and whoever does becomes its definer here.
 */
export function Library({
  space,
  collections,
  title,
  onAdded,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  title: string;
  onAdded?: (name: string) => void;
}) {
  const node = useNode();
  const [busy, setBusy] = useState<string | null>(null);
  const defined = new Set(collections.filter((c) => c.version !== null).map((c) => c.name));
  const missing = standardSchemas.filter((s) => !defined.has(s.name));
  if (!space.writable || missing.length === 0) return null;

  return (
    <section aria-label="Standard schemas" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 24 }}>
      <div>
        <h3 style={styles.sectionTitle}>{title}</h3>
        <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>Shared shapes, so other apps understand them too.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
        {missing.map((schema) => (
          <div key={schema.name} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 14, border: `1px solid ${palette.surface.line}`, borderRadius: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: 14, fontWeight: 600, color: palette.ink.strong }}>{schema.title}</strong>
              <button
                onClick={() => {
                  setBusy(schema.name);
                  void useSchemas(node, space.id, [schema])
                    .then(() => onAdded?.(schema.name))
                    .finally(() => setBusy(null));
                }}
                disabled={busy !== null}
                aria-label={`Add ${schema.title}`}
                data-variant="quiet"
                style={{ ...styles.smallButton, height: 28 }}
              >
                {busy === schema.name ? 'Adding…' : 'Add'}
              </button>
            </div>
            <span style={{ fontSize: 13, lineHeight: 1.5, color: palette.ink.muted }}>{WHAT_IT_ADDS[schema.name] ?? schema.description}</span>
            <code style={{ fontSize: 11, color: palette.ink.faint }}>{schema.name}</code>
          </div>
        ))}
      </div>
    </section>
  );
}
