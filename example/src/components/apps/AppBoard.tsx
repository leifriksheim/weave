import { useState } from 'react';
import type { NodeCollection, NodeRecord, SpaceSummary } from 'weave-protocol';
import { useLive, useNode, useProfiles } from 'weave-protocol/react';
import { SchemaForm } from '../SchemaForm';
import { Value } from '../Value';
import { choicesFrom, choicesOf, collectionLabel, fieldsOf, metaFields, recordLabel, titleField, type Field } from '../../derive/schema-ui';
import { nameOf, peopleFrom, writerOf, type People } from '../../derive/people';
import { ago } from '../../derive/time';
import { styles, palette } from '../../styles';

/**
 * An added app, drawn from its definitions alone — no screen of its own.
 *
 * The things nothing else in the app points at are the main list: trips,
 * polls, events. What points at one of them is drawn inside it: seats in a
 * trip, votes on a poll. How each is added comes from its rules and fields:
 *
 * - a field that picks from the thing it points at (`x-choicesFrom`) becomes
 *   buttons with counts — pick one, and pick again to change it;
 * - nothing to fill in, and one per person (`onePer: ['@author', 'link:…']`)
 *   becomes "Add your seat" / "Remove your seat";
 * - anything else gets a small form.
 */
export function AppBoard({
  space,
  names,
  collections,
  onOpen,
}: {
  space: SpaceSummary;
  names: ReadonlyArray<string>;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (record: NodeRecord) => void;
}) {
  const people = peopleFrom(useProfiles(space.id));
  const held = names.map((name) => collections.find((c) => c.name === name)).filter((c): c is NodeCollection => !!c && c.version !== null);
  const records = useLive(space.id, (node) => Promise.all(held.map((c) => node.records.list(space.id, { collection: c.name }))), [space.id, held.map((c) => c.name).join('|')]);

  /** Collections of this app that point at `parent`, with the link role they use */
  const childrenOf = (parent: NodeCollection) =>
    held.flatMap((child) =>
      Object.entries(child.links)
        .filter(([, link]) => link.to !== '*' && link.to.includes(parent.name))
        .map(([rel]) => ({ child, rel })),
    );
  const pointsIntoApp = (c: NodeCollection) => Object.values(c.links).some((link) => link.to !== '*' && link.to.some((to) => names.includes(to) && to !== c.name));
  const main = held.filter((c) => !pointsIntoApp(c));

  if (!records) return <p style={styles.emptyState}>Opening…</p>;
  const byName = new Map(held.map((c, i) => [c.name, records[i] ?? []]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      {main.map((parent) => (
        <section key={parent.name} aria-label={collectionLabel(parent)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <AddForm space={space} collection={parent} label={`Add ${noun(parent)}`} />
          {(byName.get(parent.name) ?? []).length === 0 && <div style={{ ...styles.emptyState, padding: '24px 16px' }}>No {noun(parent)} yet.</div>}
          {(byName.get(parent.name) ?? []).map((record) => (
            <article key={record.key} style={card}>
              <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                <button onClick={() => onOpen(record)} data-variant="ghost" style={cardTitle}>
                  {recordLabel(record, parent.schema)}
                </button>
                <span style={{ fontSize: 12, color: palette.ink.faint, whiteSpace: 'nowrap' }}>
                  {writerOf(record, people)} · {ago(record.createdAt)}
                </span>
              </header>
              <Meta collection={parent} record={record} />
              {childrenOf(parent).map(({ child, rel }) => (
                <Children
                  key={`${child.name}:${rel}`}
                  space={space}
                  child={child}
                  rel={rel}
                  parent={record}
                  records={(byName.get(child.name) ?? []).filter((r) => r.links.some((l) => l.rel === rel && l.to === record.key))}
                  people={people}
                  onOpen={onOpen}
                />
              ))}
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}

const noun = (c: NodeCollection) => collectionLabel(c).toLowerCase();

/** What a record says in its title field, when it says anything — "Can take a bike", not a made-up label */
function said(record: NodeRecord, collection: NodeCollection): string | null {
  const title = titleField(collection.schema);
  const value = title ? (record.body as Record<string, unknown> | null)?.[title] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The short fields beside a title */
function Meta({ collection, record }: { collection: NodeCollection; record: NodeRecord }) {
  const body = (record.body ?? {}) as Record<string, unknown>;
  const fields = metaFields(collection.schema).filter((f) => body[f.name] !== undefined && body[f.name] !== '');
  if (fields.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 13, color: palette.ink.muted }}>
      {fields.map((f) => (
        <span key={f.name}>
          {f.label} <span style={{ color: palette.ink.strong }}><Value field={f} value={body[f.name]} /></span>
        </span>
      ))}
    </div>
  );
}

/** What points at one record, drawn inside it — and the way to add one */
function Children({
  space,
  child,
  rel,
  parent,
  records,
  people,
  onOpen,
}: {
  space: SpaceSummary;
  child: NodeCollection;
  rel: string;
  parent: NodeRecord;
  records: ReadonlyArray<NodeRecord>;
  people: People;
  onOpen: (record: NodeRecord) => void;
}) {
  const node = useNode();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fields = fieldsOf(child.schema);
  const mine = records.find((r) => r.createdBy === node.did);
  const links = [{ rel, to: parent.key }];
  const onePerMe = !!child.rules.onePer?.includes('@author') && !!child.rules.onePer?.includes(`link:${rel}`);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // A field that picks from the parent: buttons with counts.
  const picker: Field | undefined = fields.find((f) => choicesFrom(f.schema)?.rel === rel);
  const choices = picker ? choicesOf(picker, { [rel]: parent }) : null;
  if (picker && choices) {
    const chosen = (mine?.body as Record<string, unknown> | null)?.[picker.name];
    const pick = (value: unknown) =>
      run(() =>
        mine && !onePerMe
          ? node.records.update(space.id, mine.key, { ...(mine.body as object), [picker.name]: value })
          : node.records.put(space.id, child.name, { [picker.name]: value }, { links }),
      );
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {choices.map((choice) => {
            const count = records.filter((r) => (r.body as Record<string, unknown> | null)?.[picker.name] === choice.value).length;
            const on = chosen === choice.value;
            return (
              <button
                key={String(choice.value)}
                onClick={() => void pick(choice.value)}
                disabled={busy}
                aria-pressed={on}
                data-variant={on ? 'primary' : 'quiet'}
                style={{
                  ...styles.smallButton,
                  height: 30,
                  gap: 8,
                  ...(on ? { background: palette.ink.strong, color: '#fff', borderColor: palette.ink.strong } : {}),
                }}
              >
                {choice.label} <span style={{ opacity: 0.7 }}>{count}</span>
              </button>
            );
          })}
        </div>
        {mine && (
          <span style={{ fontSize: 12, color: palette.ink.faint }}>
            You picked — pick again to change{' '}
            <button onClick={() => void run(() => node.records.delete(space.id, mine.key))} data-variant="ghost" style={{ ...styles.linkButton, padding: 0, fontSize: 12 }}>
              or take it back
            </button>
          </span>
        )}
        {error && <p style={styles.error}>{error}</p>}
      </div>
    );
  }

  const nothingToFill = fields.every((f) => !f.required);
  const label = noun(child);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, borderTop: `1px solid ${palette.surface.line}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: palette.ink.muted }}>
          {records.length} {records.length === 1 ? label : `${label}s`}
        </span>
        {onePerMe && nothingToFill ? (
          mine ? (
            <button onClick={() => void run(() => node.records.delete(space.id, mine.key))} disabled={busy} data-variant="quiet" style={{ ...styles.smallButton, height: 28 }}>
              Remove your {label}
            </button>
          ) : (
            <button onClick={() => void run(() => node.records.put(space.id, child.name, {}, { links }))} disabled={busy} data-variant="primary" style={{ ...styles.smallButton, height: 28 }}>
              Add your {label}
            </button>
          )
        ) : (
          <AddForm space={space} collection={child} label={`Add ${label}`} links={links} compact />
        )}
      </div>
      {records.length > 0 && (
        <ul style={{ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 6, margin: 0, padding: 0 }}>
          {records.map((r) => (
            <li key={r.key}>
              <button onClick={() => onOpen(r)} data-variant="ghost" style={chip}>
                {said(r, child) ? `${nameOf(r.createdBy, people)}: ${said(r, child)}` : writerOf(r, people)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p style={styles.error}>{error}</p>}
    </div>
  );
}

/** "Add a trip…", opening a form built from the definition */
function AddForm({
  space,
  collection,
  label,
  links,
  compact = false,
}: {
  space: SpaceSummary;
  collection: NodeCollection;
  label: string;
  links?: ReadonlyArray<{ rel: string; to: string }>;
  compact?: boolean;
}) {
  const node = useNode();
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} data-variant="quiet" style={{ ...styles.smallButton, height: compact ? 28 : 32, alignSelf: compact ? 'auto' : 'flex-start' }}>
        {label}
      </button>
    );
  }
  return (
    <div style={{ ...card, gap: 8, width: compact ? '100%' : undefined }}>
      <SchemaForm
        schema={collection.schema}
        submitLabel={label}
        onSubmit={async (body) => {
          await node.records.put(space.id, collection.name, body, links ? { links } : {});
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}

const card = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 10,
  padding: 14,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 10,
  background: palette.surface.card,
};
const cardTitle = { border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: 15, fontWeight: 600, color: palette.ink.strong, textAlign: 'left' as const, cursor: 'pointer' };
const chip = { border: `1px solid ${palette.surface.line}`, borderRadius: 999, background: palette.surface.sunken, padding: '3px 10px', fontSize: 12, color: palette.ink.body, cursor: 'pointer' };
