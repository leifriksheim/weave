import { useState } from 'react';
import type { NodeCollection, NodeRecord, SpaceSummary } from 'weave-protocol';
import { requireSession } from '../protocol';
import { useLive } from '../hooks/useLive';
import { attachable, byRel, choicesFrom, collectionLabel, fieldsOf, humanize, labelOf, recordLabel, tally } from '../derive/schema-ui';
import { SchemaForm } from './SchemaForm';
import { Value } from './Value';
import type { Place } from './SpaceView';
import { styles } from '../styles';
import { reaction, comment, useSchemas } from 'weave-protocol/schemas';
import { nameOf, peopleFrom, type People } from '../derive/people';

const LIKE = '👍';
/**
 * Annotations every record gets a place for, whatever it is. This app's
 * choice, not the protocol's: it uses the reaction and comment shapes from the
 * standard schema library, and defines them in a space the first time it
 * writes one there.
 */
export const ANNOTATIONS = new Set<string>([reaction.name, comment.name]);

/**
 * One record: its fields, who wrote it, what it points at and what points at
 * it — with buttons to add the things its space says may point at it.
 */
export function RecordView({ space, recordKey, collections, go }: { space: SpaceSummary; recordKey: string; collections: ReadonlyArray<NodeCollection>; go: (p: Place) => void }) {
  const { node, rootDid } = requireSession();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState<{ collection: NodeCollection; rel: string } | null>(null);

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
  if (!data) return <p style={styles.emptyState}>Opening…</p>;
  const { record, linked, targets } = data;
  if (!record) return <p style={styles.emptyState}>This record is gone — deleted, or not here yet.</p>;

  const schemaOf = (name: string) => collections.find((c) => c.name === name)?.schema ?? null;
  const collection = collections.find((c) => c.name === record.collection);
  const schema = collection?.schema ?? null;
  const body = (record.body ?? {}) as Record<string, unknown>;
  const described = fieldsOf(schema);
  const extra = Object.keys(body).filter((k) => !described.some((f) => f.name === k));

  const reactions = linked.filter((r) => r.collection === reaction.name);
  const comments = linked.filter((r) => r.collection === comment.name);
  const pointing = groupBy(linked.filter((r) => !ANNOTATIONS.has(r.collection)), (r) => r.collection);
  const mine = reactions.find((r) => r.root === rootDid && (r.body as { emoji?: string } | null)?.emoji === LIKE);
  const open = (r: NodeRecord) => go({ collection: r.collection, key: r.key });
  const linkedHere = byRel(record.links, targets.map((t) => t.target));

  return (
    <article aria-label={recordLabel(record, schema)} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={styles.panelSection}>
        <h2 style={{ ...styles.appTitle, fontSize: 18 }}>{recordLabel(record, schema)}</h2>
        <p style={styles.todoMeta}>
          {collection ? collectionLabel(collection) : record.collection} · by {nameOf(record.root, people)} · {new Date(record.createdAt).toLocaleString()}
          {record.seq > 0 && ` · edited ${record.seq}×`}
          {record.verified && ' · verified'}
          {record.encrypted && ' · encrypted'}
        </p>
        {record.conforms === false && (
          <p style={styles.error}>Does not fit its definition: {record.issues?.map((i) => i.message).join('; ')}</p>
        )}

        {editing ? (
          <SchemaForm
            schema={schema}
            initial={record.body}
            linked={linkedHere}
            submitLabel="Save"
            onCancel={() => setEditing(false)}
            onSubmit={async (next) => {
              await node.records.update(space.id, record.key, next);
              setEditing(false);
            }}
          />
        ) : (
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', margin: 0, fontSize: 14 }}>
            {described.map((f) => (
              <Row key={f.name} label={f.label}>
                <Value field={f} value={body[f.name]} linked={linkedHere} />
              </Row>
            ))}
            {extra.map((name) => (
              <Row key={name} label={humanize(name)}>
                <Value value={body[name]} />
              </Row>
            ))}
            {targets.map(({ link, target }) => (
              <Row key={`${link.rel}-${link.to}`} label={humanize(link.rel)}>
                {target ? (
                  <button onClick={() => open(target)} data-variant="ghost" style={styles.linkButton}>
                    → {recordLabel(target, schemaOf(target.collection))}
                  </button>
                ) : (
                  <span style={{ opacity: 0.5 }}>→ not here yet</span>
                )}
              </Row>
            ))}
          </dl>
        )}

        <div style={{ ...styles.linkRow, gap: 8 }}>
          <button
            onClick={() =>
              void (mine
                ? node.records.delete(space.id, mine.key)
                : useSchemas(node, space.id, [reaction]).then(() =>
                    node.records.put(space.id, reaction.name, { emoji: LIKE }, { links: [{ rel: 'about', to: record.key }] }),
                  ))
            }
            disabled={!space.writable}
            data-variant={mine ? 'primary' : 'quiet'}
            style={mine ? { ...styles.smallButton, backgroundColor: '#000', color: '#fff', borderColor: '#000' } : styles.smallButton}
            aria-label={mine ? 'Take back your 👍' : 'Add 👍'}
          >
            {summarizeReactions(reactions) || LIKE}
          </button>
          {space.writable && !editing && (
            <>
              <button onClick={() => setEditing(true)} data-variant="quiet" style={styles.smallButton}>
                Edit
              </button>
              <button
                onClick={() => {
                  if (!globalThis.confirm('Delete this for everyone in the space?')) return;
                  void node.records.delete(space.id, record.key).then(() => go({ collection: record.collection, key: null }));
                }}
                data-variant="quiet"
                style={{ ...styles.smallButton, color: '#e5484d' }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </section>

      {[...pointing].map(([name, records]) => {
        const c = collections.find((x) => x.name === name);
        const counted = c ? tally(c, records, record) : null;
        // A vote has no title of its own; name it by what it picked.
        const labelFor = (r: NodeRecord) => {
          const picked = counted ? labelOf(counted.field, (r.body as Record<string, unknown> | null)?.[counted.field.name], { [choicesFrom(counted.field.schema)!.rel]: record }) : null;
          return picked ?? recordLabel(r, schemaOf(r.collection));
        };
        return (
          <section key={name} style={styles.panelSection} aria-label={`${c ? collectionLabel(c) : name} pointing here`}>
            <h3 style={styles.sectionTitle}>
              {c ? collectionLabel(c) : name} ({records.length})
            </h3>
            {counted && (
              <div aria-label="Tally" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {counted.counts.map(({ label, count }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                    <span style={{ minWidth: 90 }}>{label}</span>
                    <span style={{ height: 8, borderRadius: 4, background: '#000', width: `${(count / Math.max(1, records.length)) * 160}px` }} />
                    <span style={styles.todoMeta}>{count}</span>
                  </div>
                ))}
              </div>
            )}
            {records.map((r) => (
              <button key={r.key} onClick={() => open(r)} data-variant="ghost" style={{ ...styles.linkButton, textAlign: 'left' }}>
                {labelFor(r)}
                <span style={styles.todoMeta}> · by {nameOf(r.root, people)}</span>
              </button>
            ))}
          </section>
        );
      })}

      {space.writable && (
        <section style={styles.panelSection}>
          {adding ? (
            <>
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
            </>
          ) : (
            <div style={{ ...styles.linkRow, gap: 8, marginTop: 0 }}>
              {attachable(collections, record.collection, ANNOTATIONS).map((a) => (
                <button key={`${a.collection.name}-${a.rel}`} onClick={() => setAdding(a)} data-variant="quiet" style={styles.smallButton}>
                  + Add {collectionLabel(a.collection).toLowerCase()}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      <Comments space={space} target={record.key} comments={comments} people={people} />
    </article>
  );
}

function Comments({ space, target, comments, people }: { space: SpaceSummary; target: string; comments: ReadonlyArray<NodeRecord>; people: People }) {
  const { node } = requireSession();
  const [draft, setDraft] = useState('');
  return (
    <section style={styles.panelSection} aria-label="Comments">
      <h3 style={styles.sectionTitle}>Comments ({comments.length})</h3>
      {comments.map((c) => (
        <p key={c.key} style={styles.todoText}>
          <span style={styles.todoMeta}>{nameOf(c.root, people)}: </span>
          {(c.body as { text?: string } | null)?.text}
        </p>
      ))}
      {space.writable && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            const text = draft.trim();
            void useSchemas(node, space.id, [comment]).then(() =>
              node.records.put(space.id, comment.name, { text }, { links: [{ rel: 'about', to: target }] }),
            );
            setDraft('');
          }}
          style={styles.addForm}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a comment" style={styles.todoInput} />
          <button type="submit" disabled={!draft.trim()} data-variant="primary" style={styles.addButton}>
            Comment
          </button>
        </form>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: '#6b7280' }}>{label}</dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </>
  );
}

function summarizeReactions(reactions: ReadonlyArray<NodeRecord>): string {
  const counts = new Map<string, number>();
  for (const r of reactions) {
    const emoji = (r.body as { emoji?: string } | null)?.emoji;
    if (emoji) counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  }
  return [...counts].map(([emoji, n]) => `${emoji} ${n}`).join('  ');
}

function groupBy<T>(items: ReadonlyArray<T>, key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
