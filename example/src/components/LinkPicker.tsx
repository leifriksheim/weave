import { useMemo, useState } from 'react';
import type { NodeCollection, NodeRecord, SpaceSummary } from '@weaveprotocol/core';
import { useLive, useNode } from '@weaveprotocol/core/react';
import { collectionLabel, humanize, recordLabel } from '../derive/schema-ui';
import { styles, palette } from '../styles';

/**
 * Links this record to another, in one of the ways its collection allows —
 * and only to the collections each way may point at. What those ways are
 * is part of the collection's definition, changed there, not here.
 */
export function LinkPicker({
  space,
  record,
  collection,
  collections,
  initialRel,
  onDone,
}: {
  space: SpaceSummary;
  record: NodeRecord;
  collection: NodeCollection;
  collections: ReadonlyArray<NodeCollection>;
  /** The kind of link to start on */
  initialRel?: string;
  onDone: () => void;
}) {
  const node = useNode();
  const kinds = Object.entries(collection.links);
  const [rel, setRel] = useState<string | null>(initialRel ?? (kinds.length === 1 ? kinds[0]![0] : null));
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const everything = useLive(space.id, (n) => n.records.list(space.id, { newestFirst: true }), []) ?? [];
  const schemaOf = (name: string) => collections.find((c) => c.name === name)?.schema ?? null;
  const labelOf = (r: NodeRecord) => recordLabel(r, schemaOf(r.collection));
  const kindOf = (name: string) => {
    const c = collections.find((x) => x.name === name);
    return c ? collectionLabel(c) : name;
  };

  const declared = rel ? collection.links[rel] : undefined;
  const one = declared?.cardinality === 'one';
  const current = rel ? record.links.filter((l) => l.rel === rel) : [];
  const candidates = useMemo(() => {
    if (!declared) return [];
    const q = search.trim().toLowerCase();
    return everything
      .filter((r) => r.key !== record.key && r.body !== null && !current.some((l) => l.to === r.key))
      .filter((r) => declared.to === '*' || declared.to.includes(r.collection))
      .filter((r) => !q || labelOf(r).toLowerCase().includes(q) || kindOf(r.collection).toLowerCase().includes(q))
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everything, search, record, declared, collections]);

  const link = async (target: NodeRecord) => {
    if (!rel) return;
    setBusy(true);
    setError(null);
    try {
      // A kind of link there can be only one of is replaced, not added to.
      const kept = one ? record.links.filter((l) => l.rel !== rel) : record.links;
      await node.records.update(space.id, record.key, record.body, { links: [...kept, { rel, to: target.key }] });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const allowed = declared ? (declared.to === '*' ? 'anything' : declared.to.map(kindOf).join(' or ')) : '';

  return (
    <section aria-label="Link to another record" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, border: `1px solid ${palette.surface.line}`, borderRadius: 10 }}>
      <h3 style={styles.sectionTitle}>{rel ? `${humanize(rel)}…` : 'Link to…'}</h3>
      {!initialRel && kinds.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {kinds.map(([r, d]) => (
            <button
              key={r}
              type="button"
              onClick={() => setRel(r)}
              title={d.description}
              aria-pressed={rel === r}
              data-variant="quiet"
              style={{ ...styles.smallButton, height: 28, ...(rel === r ? { borderColor: palette.ink.strong, color: palette.ink.strong } : {}) }}
            >
              {humanize(r).toLowerCase()}
            </button>
          ))}
        </div>
      )}
      {declared && (
        <>
          <p style={{ fontSize: 13, color: palette.ink.muted, lineHeight: 1.5 }}>
            <strong style={{ color: palette.ink.strong }}>{humanize(rel!).toLowerCase()}</strong>
            {declared.description && ` — ${declared.description}`}. Can point at {allowed}
            {one && current.length > 0 ? '; picking one replaces the one it has.' : '.'}
          </p>
          <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Find ${allowed === 'anything' ? 'anything' : allowed}`} aria-label="Find a record" style={styles.input} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {candidates.map((r) => (
              <button key={r.key} type="button" disabled={busy} onClick={() => void link(r)} data-row style={pickRow}>
                <span style={{ color: palette.ink.faint, fontSize: 12, width: 90, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{kindOf(r.collection)}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labelOf(r)}</span>
              </button>
            ))}
            {candidates.length === 0 && <span style={{ fontSize: 13, color: palette.ink.faint, padding: 6 }}>Nothing to link to.</span>}
          </div>
        </>
      )}
      {error && <p style={styles.error}>{error}</p>}
      <button type="button" onClick={onDone} data-variant="ghost" style={{ ...styles.linkButton, alignSelf: 'flex-start' }}>
        Cancel
      </button>
    </section>
  );
}

const pickRow = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', border: 'none', borderRadius: 6, background: 'none', textAlign: 'left' as const, fontSize: 14, width: '100%' };
