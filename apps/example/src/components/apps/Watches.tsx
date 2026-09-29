import { useState } from 'react';
import { useAccount, useLive, useNode, useProfiles } from '@weaveprotocol/core/react';
import type { NodeRecord } from '@weaveprotocol/core';
import { watch, type Watch } from '@weaveprotocol/core/schemas';
import { nameOf, peopleFrom } from '../../derive/people';
import { styles, palette } from '../../styles';
import type { AppProps } from './index';

/**
 * `std.watch`: what a person's agent does when some records appear or change,
 * or at set times (`weave agent` runs them). A watch runs only once its
 * current version is the person's own, so one the agent suggested waits here
 * until they turn it on, which saves it as theirs.
 */
export function Watches({ space }: AppProps) {
  const node = useNode();
  const { did: me } = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  const [adding, setAdding] = useState(false);
  const watches = useLive(
    space.id,
    async () => node.records.list<Watch>(space.id, { collection: watch.name }),
    [],
  );
  const mine = watches?.filter((w) => w.root === me) ?? [];
  const others = watches?.filter((w) => w.root !== me) ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 640 }}>
      <p style={{ fontSize: 13, color: palette.ink.muted }}>
        Your agent does these for you while <code>weave agent</code> runs. It can suggest one when you ask it
        to keep an eye on something; it starts once you turn it on here.
      </p>
      {space.writable &&
        (adding ? (
          <NewWatch
            onCancel={() => setAdding(false)}
            onSave={async (body) => {
              await node.records.put(space.id, watch.name, body);
              setAdding(false);
            }}
          />
        ) : (
          <button onClick={() => setAdding(true)} data-variant="primary" style={styles.addButton}>
            New watch
          </button>
        ))}
      {watches?.length === 0 && !adding && <div style={styles.emptyState}>No watches yet.</div>}
      {mine.map((w) => (
        <WatchCard
          key={w.key}
          record={w}
          onTurnOn={() => void node.records.update(space.id, w.key, { ...w.body, paused: false })}
          onPause={(paused) => void node.records.update(space.id, w.key, { ...w.body, paused })}
          onDelete={() => void node.records.delete(space.id, w.key)}
        />
      ))}
      {others.length > 0 && (
        <>
          <h3 style={styles.sectionTitle}>Other people’s</h3>
          {others.map((w) => (
            <WatchCard key={w.key} record={w} owner={nameOf(w.root, people)} />
          ))}
        </>
      )}
    </div>
  );
}

/** When a watch runs, in words */
function trigger(body: Watch): string {
  const parts = [
    body.query
      ? `when a ${body.query.collection}${body.query.where ? ` matching ${JSON.stringify(body.query.where)}` : ''} appears or changes`
      : null,
    body.every ? `at “${body.every}”` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', and ') : 'never: it has no query and no schedule';
}

function WatchCard({
  record,
  owner,
  onTurnOn,
  onPause,
  onDelete,
}: {
  record: NodeRecord<Watch>;
  /** Someone else's: shown, not changed */
  owner?: string;
  onTurnOn?: () => void;
  onPause?: (paused: boolean) => void;
  onDelete?: () => void;
}) {
  const body = record.body;
  if (!body) return null;
  // The agent's version is a suggestion; the person saving it makes it theirs.
  const suggested = !!record.viaAgent;
  const state = suggested ? 'Suggested by your agent' : body.paused ? 'Paused' : 'On';
  return (
    <article
      style={{
        border: `1px solid ${suggested ? palette.accent.base : palette.surface.line}`,
        borderRadius: 10,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: palette.surface.card,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <strong style={{ color: palette.ink.strong }}>{body.name}</strong>
        <span style={{ fontSize: 12, color: palette.ink.muted }}>{owner ?? state}</span>
      </div>
      <div style={{ fontSize: 13, color: palette.ink.muted }}>Runs {trigger(body)}</div>
      <p style={{ fontSize: 14, color: palette.ink.body, whiteSpace: 'pre-wrap' }}>{body.do}</p>
      {!owner && (
        <div style={{ display: 'flex', gap: 8 }}>
          {suggested ? (
            <button data-variant="primary" style={styles.smallButton} onClick={onTurnOn}>
              Turn on
            </button>
          ) : (
            <button style={styles.smallButton} onClick={() => onPause?.(!body.paused)}>
              {body.paused ? 'Resume' : 'Pause'}
            </button>
          )}
          <button data-variant="danger" style={styles.smallButton} onClick={onDelete}>
            {suggested ? 'Dismiss' : 'Delete'}
          </button>
        </div>
      )}
    </article>
  );
}

/** A new watch: a name, what sets it off, and what to do */
function NewWatch({ onSave, onCancel }: { onSave: (body: Watch) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [collection, setCollection] = useState('');
  const [where, setWhere] = useState('');
  const [every, setEvery] = useState('');
  const [what, setWhat] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    let filter: unknown;
    try {
      filter = where.trim() ? JSON.parse(where) : undefined;
    } catch {
      return setProblem('“Where” must be JSON, like {"status": "done"}');
    }
    if (filter !== undefined && (typeof filter !== 'object' || filter === null || Array.isArray(filter)))
      return setProblem('“Where” must be a JSON object');
    if (!collection.trim() && !every.trim())
      return setProblem('Give it a collection to watch, or a schedule');
    const query = collection.trim()
      ? {
          collection: collection.trim(),
          ...(filter ? { where: Object.fromEntries(Object.entries(filter)) } : {}),
        }
      : undefined;
    try {
      await onSave({
        name: name.trim(),
        do: what.trim(),
        ...(query ? { query } : {}),
        ...(every.trim() ? { every: every.trim() } : {}),
      });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const label = {
    fontSize: 12,
    color: palette.ink.muted,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  } as const;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <label style={label}>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tasks given to me"
          style={styles.input}
        />
      </label>
      <label style={label}>
        When a record in this collection appears or changes
        <input
          value={collection}
          onChange={(e) => setCollection(e.target.value)}
          placeholder="std.task"
          style={styles.input}
        />
      </label>
      <label style={label}>
        Only those where (the query format; "$me" is you)
        <input
          value={where}
          onChange={(e) => setWhere(e.target.value)}
          placeholder='{"assignees": {"$contains": "$me"}}'
          style={styles.input}
        />
      </label>
      <label style={label}>
        Or at these times (minute hour day month weekday)
        <input
          value={every}
          onChange={(e) => setEvery(e.target.value)}
          placeholder="0 8 * * 1-5"
          style={styles.input}
        />
      </label>
      <label style={label}>
        What your agent should do
        <textarea
          value={what}
          onChange={(e) => setWhat(e.target.value)}
          placeholder="Add it to my weekly plan note, and tell me if it is due this week"
          rows={3}
          style={{ ...styles.input, resize: 'vertical' }}
        />
      </label>
      {problem && <div style={styles.error}>{problem}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="submit"
          data-variant="primary"
          style={styles.addButton}
          disabled={!name.trim() || !what.trim()}
        >
          Save
        </button>
        <button type="button" style={styles.addButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
