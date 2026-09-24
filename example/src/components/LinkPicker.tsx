import { useMemo, useState, type FormEvent } from 'react';
import { roleHolds } from 'weave-protocol';
import type { DefineCollection, NodeCollection, NodeRecord, SpaceSummary } from 'weave-protocol';
import { useAccess, useAccount, useLive, useNode, useProfiles } from 'weave-protocol/react';
import { collectionLabel, humanize, recordLabel } from '../derive/schema-ui';
import { nameOf, peopleFrom } from '../derive/people';
import { styles, palette } from '../styles';

/** Kinds of link most things need, each with a word on what it means. Any other word works too. */
const SUGGESTED: ReadonlyArray<{ rel: string; description: string }> = [
  { rel: 'about', description: 'What this is about' },
  { rel: 'in', description: 'Where this belongs' },
  { rel: 'partOf', description: 'The bigger thing this is part of' },
  { rel: 'relatedTo', description: 'Something related' },
  { rel: 'blocks', description: "What can't go ahead until this is done" },
  { rel: 'dependsOn', description: 'What has to happen first' },
];

/** "part of" → "partOf": link names are one lower camel case word */
export function relFrom(text: string): string {
  const words = text.trim().replace(/[^a-zA-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const joined = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
  return joined.replace(/^[^a-z]+/, '').slice(0, 64);
}

/**
 * Whether a link fits what the collection already allows, and if not, the
 * wider definition that would allow it. A collection names each kind of link
 * its records carry and what it may point at — a new word, or a new kind of
 * target, means changing that.
 */
export function linkFit(collection: NodeCollection, rel: string, target: NodeRecord): { fits: true } | { fits: false; widened: DefineCollection } {
  const declared = collection.links[rel];
  if (declared && (declared.to === '*' || declared.to.includes(target.collection))) return { fits: true };
  const description = declared?.description ?? SUGGESTED.find((s) => s.rel === rel)?.description;
  const to = declared && declared.to !== '*' ? [...declared.to, target.collection] : [target.collection];
  return {
    fits: false,
    widened: {
      name: collection.name,
      ...(collection.title !== undefined ? { title: collection.title } : {}),
      ...(collection.description !== undefined ? { description: collection.description } : {}),
      schema: collection.schema ?? { type: 'object' },
      history: collection.history,
      links: { ...collection.links, [rel]: { to, cardinality: declared?.cardinality ?? 'many', ...(description ? { description } : {}) } },
      permissions: collection.permissions,
      rules: collection.rules,
    },
  };
}

/**
 * Links this record to any other record in the space, with a word for how
 * they relate — one the collection already uses, a common one, or your own.
 * When the word or the kind of target is new here, the collection's
 * definition grows to allow it, which only its definer or someone who
 * manages the space may do; anyone else is told so up front.
 */
export function LinkPicker({
  space,
  record,
  collection,
  collections,
  onDone,
}: {
  space: SpaceSummary;
  record: NodeRecord;
  collection: NodeCollection;
  collections: ReadonlyArray<NodeCollection>;
  onDone: () => void;
}) {
  const node = useNode();
  const account = useAccount();
  const access = useAccess(space.id);
  const people = peopleFrom(useProfiles(space.id));
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<NodeRecord | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const everything = useLive(space.id, (n) => n.records.list(space.id, { newestFirst: true }), []) ?? [];
  const schemaOf = (name: string) => collections.find((c) => c.name === name)?.schema ?? null;
  const labelOf = (r: NodeRecord) => recordLabel(r, schemaOf(r.collection));
  const kindOf = (name: string) => {
    const c = collections.find((x) => x.name === name);
    return c ? collectionLabel(c) : name;
  };
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return everything
      .filter((r) => r.key !== record.key && r.body !== null)
      .filter((r) => !q || labelOf(r).toLowerCase().includes(q) || kindOf(r.collection).toLowerCase().includes(q))
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everything, search, record.key, collections]);

  // The words this collection already uses first, then the common ones.
  const words = [
    ...Object.entries(collection.links).map(([rel, d]) => ({ rel, description: d.description ?? '' })),
    ...SUGGESTED.filter((s) => !(s.rel in collection.links)),
  ];
  const rel = relFrom(label);
  const fit = target && rel ? linkFit(collection, rel, target) : null;
  const mayWiden = collection.definedBy === account.did || roleHolds(access?.role, 'manage');
  const definer = collection.definedBy ? nameOf(collection.definedBy, people) : 'whoever made it';
  const blocked = fit && !fit.fits && !mayWiden;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target || !rel || !fit || blocked) return;
    setBusy(true);
    setError(null);
    try {
      if (!fit.fits) await node.collections.define(space.id, fit.widened);
      // A kind of link there can be only one of is replaced, not added to.
      const one = (fit.fits ? collection.links[rel] : fit.widened.links?.[rel])?.cardinality === 'one';
      const kept = record.links.filter((l) => !(l.rel === rel && (one || l.to === target.key)));
      await node.records.update(space.id, record.key, record.body, { links: [...kept, { rel, to: target.key }] });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label="Link to another record" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, border: `1px solid ${palette.surface.line}`, borderRadius: 10 }}>
      <h3 style={styles.sectionTitle}>Link to…</h3>
      {target ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 14 }}>
          <span>
            <span style={{ color: palette.ink.faint }}>{kindOf(target.collection)}</span> {labelOf(target)}
          </span>
          <button type="button" onClick={() => setTarget(null)} data-variant="ghost" style={styles.linkButton}>
            Change
          </button>
        </div>
      ) : (
        <>
          <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find anything in this space" aria-label="Find a record" style={styles.input} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {candidates.map((r) => (
              <button key={r.key} type="button" onClick={() => setTarget(r)} data-row style={pickRow}>
                <span style={{ color: palette.ink.faint, fontSize: 12, width: 90, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{kindOf(r.collection)}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labelOf(r)}</span>
              </button>
            ))}
            {candidates.length === 0 && <span style={{ fontSize: 13, color: palette.ink.faint, padding: 6 }}>Nothing matches.</span>}
          </div>
        </>
      )}

      {target && (
        <>
          <label style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
            How are they related?
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. in, about, part of — or your own word" aria-label="How they relate" style={styles.input} />
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {words.map((w) => (
              <button
                key={w.rel}
                type="button"
                onClick={() => setLabel(humanize(w.rel).toLowerCase())}
                title={w.description}
                data-variant="quiet"
                style={{ ...styles.smallButton, height: 26, fontSize: 12, ...(rel === w.rel ? { borderColor: palette.ink.strong, color: palette.ink.strong } : {}) }}
              >
                {humanize(w.rel).toLowerCase()}
              </button>
            ))}
          </div>
          {rel && (
            <p style={{ fontSize: 13, color: palette.ink.muted, lineHeight: 1.5 }}>
              {labelOf(record)} <strong style={{ color: palette.ink.strong }}>{humanize(rel).toLowerCase()}</strong> {labelOf(target)}
              {fit && !fit.fits && mayWiden && (
                <>
                  <br />
                  {collectionLabel(collection)} will now allow “{humanize(rel).toLowerCase()}” links to {kindOf(target.collection)}. Everyone's apps see the change.
                </>
              )}
            </p>
          )}
          {blocked && (
            <p style={{ ...styles.errorHint, marginTop: 0 }}>
              {collectionLabel(collection)} doesn't have “{humanize(rel).toLowerCase()}” links to {kindOf(target.collection)} yet, and only {definer} or someone who manages the space can add a new kind.
              {Object.keys(collection.links).length > 0 && ` You can use: ${Object.keys(collection.links).map((r) => humanize(r).toLowerCase()).join(', ')}.`}
            </p>
          )}
        </>
      )}

      {error && <p style={styles.error}>{error}</p>}
      <div style={styles.linkRow}>
        <button type="submit" disabled={!target || !rel || !!blocked || busy} data-variant="primary" style={styles.addButton}>
          {busy ? 'Linking…' : 'Link'}
        </button>
        <button type="button" onClick={onDone} data-variant="ghost" style={styles.linkButton}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const pickRow = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', border: 'none', borderRadius: 6, background: 'none', textAlign: 'left' as const, fontSize: 14, width: '100%' };
