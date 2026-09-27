import { useState } from 'react';
import { useCan, useNode } from '@weaveprotocol/core/react';
import type { NodeRecord, SpaceSummary } from '@weaveprotocol/core';
import { tag } from '@weaveprotocol/core/schemas';
import { palette } from '../../styles';

/** A tag's label, if the record is one */
export const labelOf = (r: NodeRecord) => (r.body as { label?: string } | null)?.label ?? '';

/**
 * `std.tag` on a record: each tag is a small record of its own, pointing at
 * the thing it labels — so removing one is deleting it, and anyone's app that
 * uses `std.tag` sees the same labels.
 */
export function Tags({ space, target, tags }: { space: SpaceSummary; target: string; tags: ReadonlyArray<NodeRecord> }) {
  const node = useNode();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const labels = new Set(tags.map(labelOf));

  const add = () => {
    const label = draft.trim().toLowerCase();
    setDraft('');
    setAdding(false);
    if (!label || labels.has(label)) return;
    void node.records.put(space.id, tag.name, { label }, { links: [{ rel: 'about', to: target }] });
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }} aria-label="Tags">
      {tags.map((t) => (
        <TagChip key={t.key} space={space} tag={t} />
      ))}
      {space.writable &&
        (adding ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={add}
              placeholder="tag"
              aria-label="New tag"
              style={{ height: 26, width: 110, padding: '0 8px', border: `1px solid ${palette.surface.lineStrong}`, borderRadius: 999, fontSize: 12 }}
            />
          </form>
        ) : (
          <button onClick={() => setAdding(true)} style={{ ...chip, color: palette.ink.muted, background: 'none', borderStyle: 'dashed' }}>
            + Tag
          </button>
        ))}
    </div>
  );
}

export const chip = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 24,
  padding: '0 9px',
  borderRadius: 999,
  border: `1px solid ${palette.surface.line}`,
  background: palette.surface.sunken,
  color: palette.ink.body,
  fontSize: 12,
};

/** One tag. Yours to remove — or anyone's, if your role here may moderate tags: the rules say, not this. */
function TagChip({ space, tag: t }: { space: SpaceSummary; tag: NodeRecord }) {
  const node = useNode();
  const mayRemove = useCan(space.id, 'delete', t.key);
  return (
    <span style={chip}>
      #{labelOf(t)}
      {mayRemove && (
        <button onClick={() => void node.records.delete(space.id, t.key)} aria-label={`Remove tag ${labelOf(t)}`} style={{ border: 'none', background: 'none', padding: 0, color: palette.ink.faint, fontSize: 12 }}>
          ✕
        </button>
      )}
    </span>
  );
}
