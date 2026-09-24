import { useEffect, useState, type ReactNode } from 'react';
import { useNode, useLive, useProfiles, useCan } from 'weave-protocol/react';
import type { NodeCollection, NodeRecord, QueryRecord, SpaceSummary } from 'weave-protocol';
import { reaction, comment, tag } from 'weave-protocol/schemas';
import {
  byRel,
  checkField,
  choicesFrom,
  choicesOf,
  collectionLabel,
  columnsOf,
  groupField,
  metaFields,
  quickAddBody,
  recordLabel,
  titleField,
  labelOf,
  type Field,
  type LinkedByRel,
} from '../derive/schema-ui';
import { nameOf, peopleFrom, type People } from '../derive/people';
import { ago } from '../derive/time';
import { SchemaForm } from './SchemaForm';
import { Value } from './Value';
import { Avatar } from './Avatar';
import { reactionSummary } from './std/Reactions';
import { chip, labelOf as tagLabel } from './std/Tags';
import { styles, palette } from '../styles';

type Layout = 'list' | 'table' | 'board';

/** Each collection remembers how you last looked at it — on this device only */
const layoutKey = (space: string, name: string) => `weave.layout:${space}:${name}`;
function rememberedLayout(space: string, name: string): Layout | null {
  try {
    return globalThis.localStorage.getItem(layoutKey(space, name)) as Layout | null;
  } catch {
    return null;
  }
}

interface Row {
  readonly record: QueryRecord;
  readonly linked: LinkedByRel;
}

/**
 * One kind of thing: a list you can search, add to in one line, and look at
 * as a list, a table, or — when it has a field with fixed choices — a board.
 * All worked out from the collection's schema; nothing here knows what the
 * records are.
 */
export function CollectionView({
  space,
  name,
  collection,
  onOpen,
}: {
  space: SpaceSummary;
  name: string;
  collection: NodeCollection | null;
  onOpen: (record: NodeRecord) => void;
}) {
  const node = useNode();
  const schema = collection?.schema ?? null;
  const title = titleField(schema);
  const group = groupField(schema);
  const [layout, setLayout] = useState<Layout>(() => rememberedLayout(space.id, name) ?? 'list');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState<Record<string, unknown> | null>(null);
  const people = peopleFrom(useProfiles(space.id));
  const mayCreate = useCan(space.id, 'create', name);
  const shownLayout = layout === 'board' && !group ? 'list' : layout;

  const choose = (next: Layout) => {
    setLayout(next);
    try {
      globalThis.localStorage.setItem(layoutKey(space.id, name), next);
    } catch {
      /* fine */
    }
  };

  // Choices that live in a linked record (a vote's poll) need that record to show their label.
  const needsLinked = [...columnsOf(schema), ...metaFields(schema)].some((f) => choicesFrom(f.schema));
  const rows = useLive(
    space.id,
    async (): Promise<Row[]> => {
      const { records } = await node.records.query(space.id, {
        collection: name,
        ...(search.trim() && title ? { where: { [title]: { $contains: search.trim() } } } : {}),
        sort: { '@createdAt': 'desc' },
        include: {
          reactions: { rel: 'about', from: reaction.name },
          comments: { rel: 'about', from: comment.name, count: true },
          tags: { rel: 'about', from: tag.name },
        },
      });
      return Promise.all(
        records.map(async (record) => ({
          record,
          linked: needsLinked ? byRel(record.links, await Promise.all(record.links.map((l) => node.records.get(space.id, l.to)))) : {},
        })),
      );
    },
    [name, search, needsLinked, title],
  );

  const add = async (body: unknown) => {
    await node.records.put(space.id, name, body);
    setAdding(null);
  };

  const label = collection ? collectionLabel(collection) : name;
  const visible = (rows ?? []).filter((r) => r.record.body !== null);

  return (
    <section aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ ...styles.appTitle, fontSize: 22 }}>{label}</h2>
          <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 4 }}>
            {collection?.description ?? <code style={{ fontSize: 12 }}>{name}</code>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {title && (
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              aria-label={`Search ${label}`}
              style={{ ...styles.input, height: 32, width: 180, fontSize: 13 }}
            />
          )}
          <div role="tablist" aria-label="Layout" style={segmented}>
            {(['list', 'table', ...(group ? ['board'] : [])] as Layout[]).map((l) => (
              <button key={l} role="tab" aria-selected={shownLayout === l} onClick={() => choose(l)} style={shownLayout === l ? { ...segment, ...segmentOn } : segment}>
                {l[0]!.toUpperCase() + l.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {mayCreate &&
        (adding ? (
          <div style={{ border: `1px solid ${palette.surface.line}`, borderRadius: 12, padding: 16 }}>
            <SchemaForm schema={schema} initial={adding} submitLabel="Add" onCancel={() => setAdding(null)} onSubmit={add} />
          </div>
        ) : (
          <QuickAdd label={label} schema={schema} onAdd={add} onMore={(prefill) => setAdding(prefill)} />
        ))}

      {rows && visible.length === 0 && <p style={styles.emptyState}>{search ? 'Nothing matches.' : `No ${label.toLowerCase()} yet.`}</p>}

      {visible.length > 0 && shownLayout === 'list' && <ListLayout rows={visible} schema={schema} people={people} space={space} onOpen={onOpen} />}
      {visible.length > 0 && shownLayout === 'table' && <TableLayout rows={visible} schema={schema} people={people} onOpen={onOpen} />}
      {visible.length > 0 && shownLayout === 'board' && group && <BoardLayout rows={visible} schema={schema} field={group} people={people} space={space} onOpen={onOpen} />}
    </section>
  );
}

/** One line to add a thing by its title; "More fields" when there is more to say */
function QuickAdd({ label, schema, onAdd, onMore }: { label: string; schema: NodeCollection['schema']; onAdd: (body: unknown) => Promise<void>; onMore: (prefill: Record<string, unknown>) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const title = titleField(schema);
  const noun = label.toLowerCase();

  if (!title) {
    return (
      <button onClick={() => onMore({})} data-variant="primary" style={{ ...styles.addButton }}>
        + New {noun}
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = text.trim();
        if (!value) return;
        const body = quickAddBody(schema, value);
        setError(null);
        // Something else is required that has no empty value: the full form, with the title filled in.
        if (!body) return onMore({ [title]: value });
        void onAdd(body)
          .then(() => setText(''))
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Add ${noun}…`} aria-label={`Add ${noun}`} style={{ ...styles.input, flex: 1 }} />
        <button type="button" onClick={() => onMore(text.trim() ? { [title]: text.trim() } : {})} data-variant="quiet" style={{ ...styles.smallButton, height: 40 }}>
          More fields
        </button>
      </div>
      {error && <p style={styles.error}>{error}</p>}
    </form>
  );
}

// ─── Layouts ───────────────────────────────────────────────────────

function ListLayout({ rows, schema, people, space, onOpen }: { rows: Row[]; schema: NodeCollection['schema']; people: People; space: SpaceSummary; onOpen: (r: NodeRecord) => void }) {
  const node = useNode();
  const check = checkField(schema);
  const meta = metaFields(schema);
  return (
    <div role="list" style={{ border: `1px solid ${palette.surface.line}`, borderRadius: 12, overflow: 'hidden' }}>
      {rows.map(({ record, linked }, i) => {
        const body = record.body as Record<string, unknown>;
        const done = check ? body[check.name] === true : false;
        return (
          <div key={record.key} role="listitem" data-row style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: i === 0 ? 'none' : `1px solid ${palette.surface.line}`, cursor: 'pointer' }} onClick={() => onOpen(record)}>
            {check && (
              <Check
                checked={done}
                disabled={!space.writable}
                label={`${check.label}: ${recordLabel(record, schema)}`}
                onChange={(checked) => node.records.update(space.id, record.key, { ...body, [check.name]: checked })}
              />
            )}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: done ? palette.ink.faint : palette.ink.strong, textDecoration: done ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {recordLabel(record, schema)}
              </span>
              <Meta record={record} fields={meta} linked={linked} />
            </div>
            <Signals record={record} people={people} />
          </div>
        );
      })}
    </div>
  );
}

/** A checkbox that answers at once, and settles when the new version comes back (or fails) */
function Check({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: (checked: boolean) => Promise<unknown> }) {
  const [shown, setShown] = useState(checked);
  useEffect(() => setShown(checked), [checked]);
  return (
    <input
      type="checkbox"
      checked={shown}
      disabled={disabled}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const next = e.target.checked;
        setShown(next);
        void onChange(next).catch(() => setShown(!next));
      }}
      style={{ width: 16, height: 16, accentColor: '#000', flexShrink: 0 }}
    />
  );
}

function TableLayout({ rows, schema, people, onOpen }: { rows: Row[]; schema: NodeCollection['schema']; people: People; onOpen: (r: NodeRecord) => void }) {
  const columns = columnsOf(schema);
  return (
    <div style={{ border: `1px solid ${palette.surface.line}`, borderRadius: 12, overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
        <thead>
          <tr>
            {(columns.length ? columns.map((c) => c.label) : ['Record']).map((h) => (
              <th key={h} style={th}>
                {h}
              </th>
            ))}
            <th style={th}>By</th>
            <th style={{ ...th, textAlign: 'right' }}>Added</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ record, linked }) => (
            <tr key={record.key} onClick={() => onOpen(record)} style={{ cursor: 'pointer' }} aria-label={recordLabel(record, schema)}>
              {columns.length ? (
                columns.map((c) => (
                  <td key={c.name} style={td}>
                    <Value field={c} value={(record.body as Record<string, unknown>)[c.name]} linked={linked} />
                  </td>
                ))
              ) : (
                <td style={td}>{recordLabel(record, schema)}</td>
              )}
              <td style={{ ...td, color: palette.ink.muted, whiteSpace: 'nowrap' }}>{nameOf(record.createdBy ?? record.root, people)}</td>
              <td style={{ ...td, color: palette.ink.muted, textAlign: 'right', whiteSpace: 'nowrap' }}>{ago(record.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Columns by a fixed-choice field; drag a card to another column to change it */
function BoardLayout({ rows, schema, field, people, space, onOpen }: { rows: Row[]; schema: NodeCollection['schema']; field: Field; people: People; space: SpaceSummary; onOpen: (r: NodeRecord) => void }) {
  const node = useNode();
  const [over, setOver] = useState<string | null>(null);
  const choices = choicesOf(field) ?? [];
  const columns = [...choices.map((c, i) => ({ id: String(i), label: c.label, value: c.value })), { id: 'none', label: `No ${field.label.toLowerCase()}`, value: undefined }];
  const meta = metaFields(schema).filter((f) => f.name !== field.name);
  const columnOf = (r: Row) => {
    const i = choices.findIndex((c) => c.value === (r.record.body as Record<string, unknown>)[field.name]);
    return i < 0 ? 'none' : String(i);
  };
  const move = (key: string, value: unknown) => {
    const row = rows.find((r) => r.record.key === key);
    if (!row) return;
    const body = { ...(row.record.body as Record<string, unknown>) };
    if (value === undefined) delete body[field.name];
    else body[field.name] = value;
    // Refused by the record's rules — it stays where it was.
    void node.records.update(space.id, key, body).catch(() => {});
  };

  return (
    <div style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'minmax(220px, 1fr)', gap: 12, overflowX: 'auto', paddingBottom: 4 }}>
      {columns
        .filter((c) => c.id !== 'none' || rows.some((r) => columnOf(r) === 'none'))
        .map((column) => {
          const cards = rows.filter((r) => columnOf(r) === column.id);
          return (
            <div
              key={column.id}
              aria-label={`Column ${column.label}`}
              onDragOver={(e) => {
                if (!space.writable) return;
                e.preventDefault();
                setOver(column.id);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                move(e.dataTransfer.getData('text/plain'), column.value);
              }}
              style={{ background: over === column.id ? '#f0f0f0' : palette.surface.sunken, border: `1px solid ${palette.surface.line}`, borderRadius: 12, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120 }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 500, padding: '2px 4px' }}>
                <span>{column.label}</span>
                <span style={{ color: palette.ink.faint }}>{cards.length}</span>
              </div>
              {cards.map(({ record, linked }) => (
                <div
                  key={record.key}
                  draggable={space.writable}
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', record.key)}
                  onClick={() => onOpen(record)}
                  aria-label={recordLabel(record, schema)}
                  style={{ background: palette.surface.card, border: `1px solid ${palette.surface.line}`, borderRadius: 8, padding: 12, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8, boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}
                >
                  <span style={{ fontSize: 14, fontWeight: 500, color: palette.ink.strong }}>{recordLabel(record, schema)}</span>
                  <Meta record={record} fields={meta} linked={linked} />
                  <Signals record={record} people={people} />
                </div>
              ))}
            </div>
          );
        })}
    </div>
  );
}

// ─── Row pieces ────────────────────────────────────────────────────

/** A row's short fields and tags, as small chips */
function Meta({ record, fields, linked }: { record: QueryRecord; fields: ReadonlyArray<Field>; linked: LinkedByRel }) {
  const body = record.body as Record<string, unknown>;
  const tags = Array.isArray(record.included?.tags) ? (record.included.tags as NodeRecord[]) : [];
  const parts: ReactNode[] = [];
  for (const f of fields) {
    const value = body[f.name];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    const shown = labelOf(f, value, linked) ?? (Array.isArray(value) ? value.join(', ') : String(value));
    parts.push(
      <span key={f.name} style={{ fontSize: 12, color: palette.ink.muted }}>
        <span style={{ color: palette.ink.faint }}>{f.label}</span> {shown}
      </span>,
    );
  }
  for (const t of tags) {
    parts.push(
      <span key={t.key} style={{ ...chip, height: 20, fontSize: 11 }}>
        #{tagLabel(t)}
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>{parts}</div>;
}

/** Reactions, comment count, who and when — the right-hand side of a row */
function Signals({ record, people }: { record: QueryRecord; people: People }) {
  const reactions = reactionSummary(record.included?.reactions);
  const comments = typeof record.included?.comments === 'number' ? record.included.comments : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: palette.ink.muted, flexShrink: 0 }}>
      {reactions && <span>{reactions}</span>}
      {comments > 0 && <span aria-label={`${comments} comments`}>💬 {comments}</span>}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={nameOf(record.createdBy ?? record.root, people)}>
        <Avatar did={record.createdBy ?? record.root ?? record.author} size={18} />
        {ago(record.createdAt)}
      </span>
    </div>
  );
}

const th = { textAlign: 'left' as const, padding: '10px 14px', borderBottom: `1px solid ${palette.surface.line}`, color: palette.ink.muted, fontWeight: 500, fontSize: 12, background: palette.surface.sunken };
const td = { padding: '10px 14px', borderBottom: `1px solid ${palette.surface.line}`, color: palette.ink.body };
const segmented = { display: 'inline-flex', padding: 2, gap: 2, border: `1px solid ${palette.surface.line}`, borderRadius: 8, background: palette.surface.sunken };
const segment = { height: 28, padding: '0 10px', borderWidth: 1, borderStyle: 'solid', borderColor: 'transparent', borderRadius: 6, background: 'none', color: palette.ink.muted, fontSize: 13, fontWeight: 500 };
const segmentOn = { background: palette.surface.card, color: palette.ink.strong, borderColor: palette.surface.line, boxShadow: '0 1px 2px rgba(0,0,0,.06)' };
