import { useEffect, useState, type ReactNode } from 'react';
import type { NodeCollection, NodeRecord, SpaceSummary } from 'weave-protocol';
import { reaction, comment, tag, standardSchemas } from 'weave-protocol/schemas';
import { requireSession } from '../protocol';
import { useLive } from '../hooks/useLive';
import {
  attachable,
  byRel,
  choicesFrom,
  collectionLabel,
  fieldsOf,
  humanize,
  labelOf,
  recordLabel,
  tally,
  titleField,
  type Field,
  type LinkedByRel,
} from '../derive/schema-ui';
import { nameOf, peopleFrom } from '../derive/people';
import { ago } from '../derive/time';
import { SchemaForm, FieldInput } from './SchemaForm';
import { Value } from './Value';
import { Avatar } from './Avatar';
import { Reactions } from './std/Reactions';
import { Tags } from './std/Tags';
import { Comments } from './std/Comments';
import { styles, palette } from '../styles';

/**
 * The standard schemas: registered in every space this app opens. Reactions,
 * comments and tags get a place of their own on every record; none of them is
 * listed as a kind of thing, or offered as "+ Add …".
 */
export const ANNOTATIONS = new Set<string>(standardSchemas.map((s) => s.name));

/**
 * One record, in a panel beside the list it came from: its title, its fields
 * as properties you edit in place, reactions and tags, what it points at and
 * what points at it, and its comments. Works for any collection — the fields
 * come from the schema, the rest from links.
 */
export function RecordPanel({
  space,
  recordKey,
  collections,
  onOpen,
  onClose,
}: {
  space: SpaceSummary;
  recordKey: string;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (record: NodeRecord) => void;
  onClose: () => void;
}) {
  const { node } = requireSession();
  const [adding, setAdding] = useState<{ collection: NodeCollection; rel: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => setAdding(null), [recordKey]);

  const people = peopleFrom(useLive(space.id, () => node.spaces.profiles(space.id), []));
  const data = useLive(
    space.id,
    async () => {
      const record = await node.records.get(space.id, recordKey);
      const linked = await node.records.linked(space.id, recordKey);
      const targets = record ? await Promise.all(record.links.map(async (link) => ({ link, target: await node.records.get(space.id, link.to) }))) : [];
      return { record, linked, targets };
    },
    [recordKey],
  );

  const record = data?.record ?? null;
  const schemaOf = (name: string) => collections.find((c) => c.name === name)?.schema ?? null;
  const collection = record ? collections.find((c) => c.name === record.collection) : undefined;
  const schema = collection?.schema ?? null;
  const body = (record?.body ?? {}) as Record<string, unknown>;
  const title = titleField(schema);
  const fields = fieldsOf(schema).filter((f) => f.name !== title);
  const extra = Object.keys(body).filter((k) => k !== title && !fieldsOf(schema).some((f) => f.name === k));
  const linkedHere: LinkedByRel = record && data ? byRel(record.links, data.targets.map((t) => t.target)) : {};
  const editable = space.writable && record !== null && record.body !== null;

  /** Writes one field: the next version of the record, everything else unchanged */
  const save = async (name: string, value: unknown) => {
    if (!record) return;
    setError(null);
    const next = { ...body };
    if (value === undefined || value === '') delete next[name];
    else next[name] = value;
    try {
      await node.records.update(space.id, record.key, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const linked = data?.linked ?? [];
  const pointing = groupBy(linked.filter((r) => !ANNOTATIONS.has(r.collection)), (r) => r.collection);

  return (
    <>
      <div onClick={onClose} style={scrim} aria-hidden />
      <aside role="dialog" aria-label={record ? recordLabel(record, schema) : 'Record'} style={panel}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: `1px solid ${palette.surface.line}` }}>
          <span style={{ fontSize: 13, color: palette.ink.muted }}>{collection ? collectionLabel(collection) : record?.collection}</span>
          <button onClick={onClose} aria-label="Close" style={iconButton}>
            ✕
          </button>
        </header>

        {!data ? (
          <p style={{ ...styles.emptyState, margin: 20 }}>Opening…</p>
        ) : !record ? (
          <p style={{ ...styles.emptyState, margin: 20 }}>This record is gone — deleted, or not here yet.</p>
        ) : (
          <div style={{ padding: '20px 20px 40px', display: 'flex', flexDirection: 'column', gap: 22, overflowY: 'auto' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {title && editable ? (
                <InlineText value={String(body[title] ?? '')} onSave={(v) => save(title, v)} ariaLabel="Title" big />
              ) : (
                <h2 style={bigTitle}>{recordLabel(record, schema)}</h2>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: palette.ink.muted }}>
                <Avatar did={record.createdBy ?? record.root ?? record.author} size={20} />
                <span>{nameOf(record.createdBy ?? record.root, people)}</span>
                <span>· {ago(record.createdAt)}</span>
                {record.seq > 0 && <span>· edited {ago(record.updatedAt)}</span>}
              </div>
            </div>

            <Reactions space={space} target={record.key} reactions={linked.filter((r) => r.collection === reaction.name)} />

            <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {fields.map((f) => (
                <Property key={f.name} label={f.label}>
                  <FieldEditor field={f} value={body[f.name]} linked={linkedHere} editable={editable} onSave={(v) => save(f.name, v)} />
                </Property>
              ))}
              {extra.map((name) => (
                <Property key={name} label={humanize(name)}>
                  <Value value={body[name]} />
                </Property>
              ))}
              {data.targets.map(({ link, target }) => (
                <Property key={`${link.rel}-${link.to}`} label={humanize(link.rel)}>
                  {target ? (
                    <button onClick={() => onOpen(target)} style={linkish}>
                      {recordLabel(target, schemaOf(target.collection))} →
                    </button>
                  ) : (
                    <span style={{ color: palette.ink.faint }}>not here yet</span>
                  )}
                </Property>
              ))}
              <Property label="Tags">
                <Tags space={space} target={record.key} tags={linked.filter((r) => r.collection === tag.name)} />
              </Property>
            </dl>

            {record.conforms === false && (
              <p style={{ ...styles.errorHint, color: palette.accent.danger }}>
                Doesn't fit its definition: {record.issues?.map((i) => i.message).join('; ')}
              </p>
            )}
            {error && <p style={styles.error}>{error}</p>}

            {[...pointing].map(([name, records]) => {
              const c = collections.find((x) => x.name === name);
              const counted = c ? tally(c, records, record) : null;
              const labelFor = (r: NodeRecord) =>
                (counted
                  ? labelOf(counted.field, (r.body as Record<string, unknown> | null)?.[counted.field.name], { [choicesFrom(counted.field.schema)!.rel]: record })
                  : null) ?? recordLabel(r, schemaOf(r.collection));
              return (
                <section key={name} aria-label={`${c ? collectionLabel(c) : name} pointing here`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <h3 style={styles.sectionTitle}>
                    {c ? collectionLabel(c) : name} <span style={{ color: palette.ink.faint, fontWeight: 400 }}>{records.length}</span>
                  </h3>
                  {counted && (
                    <div aria-label="Tally" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {counted.counts.map(({ label, count }) => (
                        <div key={label} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 24px', alignItems: 'center', gap: 10, fontSize: 13 }}>
                          <span>{label}</span>
                          <span style={{ height: 6, borderRadius: 3, background: palette.surface.sunken, overflow: 'hidden' }}>
                            <span style={{ display: 'block', height: '100%', width: `${(count / Math.max(1, records.length)) * 100}%`, background: '#000' }} />
                          </span>
                          <span style={{ color: palette.ink.muted, textAlign: 'right' }}>{count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {records.map((r) => (
                      <button key={r.key} data-row onClick={() => onOpen(r)} style={miniRow}>
                        <Avatar did={r.root ?? r.author} size={18} />
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labelFor(r)}</span>
                        <span style={{ color: palette.ink.faint, fontSize: 12 }}>
                          {nameOf(r.root, people)} · {ago(r.createdAt)}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}

            {space.writable &&
              (adding ? (
                <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <h3 style={styles.sectionTitle}>New {collectionLabel(adding.collection).toLowerCase()}</h3>
                  <SchemaForm
                    schema={adding.collection.schema}
                    linked={{ [adding.rel]: record }}
                    submitLabel="Add"
                    onCancel={() => setAdding(null)}
                    onSubmit={async (next) => {
                      await node.records.put(space.id, adding.collection.name, next, { links: [{ rel: adding.rel, to: record.key }] });
                      setAdding(null);
                    }}
                  />
                </section>
              ) : (
                attachable(collections, record.collection, ANNOTATIONS).length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {attachable(collections, record.collection, ANNOTATIONS).map((a) => (
                      <button key={`${a.collection.name}-${a.rel}`} onClick={() => setAdding(a)} data-variant="quiet" style={styles.smallButton}>
                        + Add {collectionLabel(a.collection).toLowerCase()}
                      </button>
                    ))}
                  </div>
                )
              ))}

            <div style={{ height: 1, background: palette.surface.line }} />
            <Comments space={space} target={record.key} comments={linked.filter((r) => r.collection === comment.name)} people={people} />

            <footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 8, fontSize: 12, color: palette.ink.faint }}>
              <span>
                {record.verified ? 'Signature verified' : 'Not verified'}
                {record.encrypted && ' · encrypted'}
                {record.seq > 0 && ` · version ${record.seq + 1}`}
              </span>
              {editable && (
                <button
                  onClick={() => {
                    if (!globalThis.confirm('Delete this for everyone in the space?')) return;
                    void node.records.delete(space.id, record.key).then(onClose);
                  }}
                  data-variant="quiet"
                  style={{ ...styles.smallButton, color: palette.accent.danger }}
                >
                  Delete
                </button>
              )}
            </footer>
          </div>
        )}
      </aside>
    </>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, alignItems: 'start', minHeight: 32, padding: '4px 0' }}>
      <dt style={{ fontSize: 13, color: palette.ink.muted, paddingTop: 6 }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: 14, minWidth: 0 }}>{children}</dd>
    </div>
  );
}

/**
 * A field shown as its value, edited where it stands: yes/no and choices
 * save as soon as they change; text and numbers when you press Enter or click
 * away. Lists, objects and JSON get the form's editor and a Save.
 */
function FieldEditor({ field, value, linked, editable, onSave }: { field: Field; value: unknown; linked: LinkedByRel; editable: boolean; onSave: (value: unknown) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<unknown>(value);
  useEffect(() => setDraft(value), [value]);
  // In place, the property row already says what the field is.
  const bare: Field = { ...field, label: '', required: false, schema: { ...field.schema, description: undefined } };

  if (!editable) return <div style={{ paddingTop: 6 }}><Value field={field} value={value} linked={linked} /></div>;

  if (field.kind === 'boolean') {
    return (
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, paddingTop: 6, cursor: 'pointer' }}>
        <input type="checkbox" checked={value === true} onChange={(e) => void onSave(e.target.checked)} aria-label={field.label} />
        <span style={{ color: palette.ink.muted, fontSize: 13 }}>{value === true ? 'Yes' : 'No'}</span>
      </label>
    );
  }
  if (field.kind === 'text' || field.kind === 'longText') {
    return <InlineText value={typeof value === 'string' ? value : ''} onSave={(v) => onSave(v)} ariaLabel={field.label} multiline={field.kind === 'longText'} />;
  }
  if (field.kind === 'choice' || field.kind === 'number' || field.kind === 'integer') {
    // The form's own input, saving on change (choices) or on Enter/blur (numbers).
    const immediate = field.kind === 'choice';
    return (
      <div
        className="inline-field"
        onBlur={() => !immediate && draft !== value && void onSave(draft)}
        onKeyDown={(e) => e.key === 'Enter' && !immediate && void onSave(draft)}
      >
        <FieldInput
          field={bare}
          value={draft}
          linked={linked}
          onChange={(v) => {
            setDraft(v);
            if (immediate) void onSave(v);
          }}
        />
      </div>
    );
  }
  return editing ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <FieldInput field={bare} value={draft} linked={linked} onChange={setDraft} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => void onSave(draft).then(() => setEditing(false))} data-variant="primary" style={{ ...styles.smallButton, background: '#000', color: '#fff', borderColor: '#000' }}>
          Save
        </button>
        <button onClick={() => setEditing(false)} data-variant="quiet" style={styles.smallButton}>
          Cancel
        </button>
      </div>
    </div>
  ) : (
    <button data-editable onClick={() => setEditing(true)} style={{ ...editable_, textAlign: 'left' }} aria-label={`Edit ${field.label}`}>
      <Value field={field} value={value} linked={linked} />
    </button>
  );
}

/** Text that looks like text until you click it; Enter or clicking away saves, Escape cancels */
function InlineText({ value, onSave, ariaLabel, big, multiline }: { value: string; onSave: (value: string) => Promise<void> | void; ariaLabel: string; big?: boolean; multiline?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value.trim()) void onSave(draft.trim());
  };
  const common = {
    value: draft,
    'aria-label': ariaLabel,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
    placeholder: 'Empty',
    'data-editable': true,
    style: { ...editable_, ...(big ? bigTitle : {}), width: '100%', resize: 'vertical' as const, fontFamily: 'inherit' },
  };
  return multiline ? (
    <textarea {...common} rows={3} onKeyDown={(e) => e.key === 'Escape' && setDraft(value)} />
  ) : (
    <input
      {...common}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

function groupBy<T>(items: ReadonlyArray<T>, key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

const scrim = { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,.18)', zIndex: 30, animation: 'weave-fade .12s ease' };
const panel = {
  position: 'fixed' as const,
  top: 0,
  right: 0,
  bottom: 0,
  width: 'min(560px, 100vw)',
  background: palette.surface.card,
  borderLeft: `1px solid ${palette.surface.line}`,
  boxShadow: '-24px 0 48px -32px rgba(0,0,0,.35)',
  zIndex: 31,
  display: 'flex',
  flexDirection: 'column' as const,
  animation: 'weave-slide .16s ease',
};
const bigTitle = { fontSize: 22, fontWeight: 600, letterSpacing: '-0.03em', color: palette.ink.strong, lineHeight: 1.3 };
const iconButton = { border: 'none', background: 'none', color: palette.ink.muted, fontSize: 14, padding: 6, borderRadius: 6 };
const linkish = { border: 'none', background: 'none', padding: '6px 0 0', color: palette.ink.strong, textDecoration: 'underline', textUnderlineOffset: 3, fontSize: 14 };
const miniRow = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', border: 'none', borderRadius: 6, background: 'none', textAlign: 'left' as const, fontSize: 14, width: '100%' };
const editable_ = {
  border: '1px solid transparent',
  borderRadius: 6,
  background: 'none',
  padding: '5px 8px',
  margin: '0 -8px',
  fontSize: 14,
  color: palette.ink.body,
  outline: 'none',
  width: 'calc(100% + 16px)',
};
