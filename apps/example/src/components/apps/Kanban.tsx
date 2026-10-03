import { useState, type DragEvent } from 'react';
import { useCan, useLive, useNode } from '@weaveprotocol/core/react';
import type { NodeRecord } from '@weaveprotocol/core';
import { column, task, positionBetween, type Column, type Task } from '@weaveprotocol/core/schemas';
import { styles, palette } from '../../styles';
import type { AppProps } from './index';
import { Lane, Card } from '../Lane';

/** Where a dragged card would land: a lane, and the card it would go before (null: the end) */
interface Drop {
  readonly lane: string;
  readonly before: string | null;
}

/** The lane for tasks whose column is gone, or that never had one */
const LOOSE = '';

/** By position; records without one (made by something that knows no order) go last, oldest first */
const byPosition = <T extends { position?: string }>(a: NodeRecord<T>, b: NodeRecord<T>) => {
  const pa = a.body!.position;
  const pb = b.body!.position;
  if (pa !== pb) return pa === undefined ? 1 : pb === undefined ? -1 : pa < pb ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key);
};
const laneOf = (t: NodeRecord) => t.links.find((l) => l.rel === 'column')?.to ?? LOOSE;

/** `std.task` and `std.column` as a board; dragging a card rewrites only its column link and position */
export function Kanban({ space, onOpen }: AppProps) {
  const node = useNode();
  const mayAddTask = useCan(space.id, 'create', task.name);
  const mayAddColumn = useCan(space.id, 'create', column.name);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);

  const board = useLive(
    space.id,
    async () => {
      const [columns, tasks] = await Promise.all([
        node.records.list<Column>(space.id, { collection: column.name }),
        node.records.list<Task>(space.id, { collection: task.name }),
      ]);
      return {
        columns: columns.filter((c) => c.body !== null).sort(byPosition),
        tasks: tasks.filter((t) => t.body !== null).sort(byPosition),
      };
    },
    [],
  );
  if (!board) return null;

  const known = new Set(board.columns.map((c) => c.key));
  const tasksIn = (lane: string) =>
    board.tasks.filter((t) => (known.has(laneOf(t)) ? laneOf(t) : LOOSE) === lane);
  const lanes = [
    ...(tasksIn(LOOSE).length > 0 ? [{ key: LOOSE, name: 'No column', record: null }] : []),
    ...board.columns.map((c) => ({ key: c.key, name: c.body!.name, record: c })),
  ];

  const place = (lane: string, before: string | null, moving?: string) => {
    const list = tasksIn(lane).filter((t) => t.key !== moving);
    const at =
      before === null
        ? list.length
        : Math.max(
            0,
            list.findIndex((t) => t.key === before),
          );
    // Unpositioned tasks sit at the end, so the nearest positioned ones are the neighbours.
    const prev = list
      .slice(0, at)
      .reverse()
      .find((t) => t.body!.position)?.body!.position;
    const next = list.slice(at).find((t) => t.body!.position)?.body!.position;
    return positionBetween(prev, next);
  };
  const columnLinks = (lane: string) => (lane === LOOSE ? [] : [{ rel: 'column', to: lane }]);

  const move = (key: string, to: Drop) => {
    const t = board.tasks.find((x) => x.key === key);
    if (!t?.body) return;
    const lane = known.has(laneOf(t)) ? laneOf(t) : LOOSE;
    if (lane === to.lane && (to.before === key || nextIn(lane, key) === to.before)) return; // dropped where it was
    void node.records.update(
      space.id,
      key,
      { ...t.body, position: place(to.lane, to.before, key) },
      {
        links: [...t.links.filter((l) => l.rel !== 'column'), ...columnLinks(to.lane)],
      },
    );
  };
  const nextIn = (lane: string, key: string) => {
    const list = tasksIn(lane);
    return list[list.findIndex((t) => t.key === key) + 1]?.key ?? null;
  };

  const addTask = (lane: string, title: string) =>
    void node.records.put(
      space.id,
      task.name,
      { title, position: place(lane, null) },
      { links: columnLinks(lane) },
    );
  const addColumn = (name: string) =>
    void node.records.put(space.id, column.name, {
      name,
      position: positionBetween([...board.columns].reverse().find((c) => c.body!.position)?.body!.position),
    });

  const overCard = (e: DragEvent, lane: string, key: string) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < box.top + box.height / 2 ? key : nextIn(lane, key);
    if (drop?.lane !== lane || drop.before !== before) setDrop({ lane, before });
  };
  const endDrag = () => {
    setDragging(null);
    setDrop(null);
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        overflowX: 'auto',
        paddingBottom: 12,
        margin: '0 -4px',
        padding: '0 4px 12px',
      }}
    >
      {lanes.map((lane) => {
        const cards = tasksIn(lane.key);
        const landing = (before: string | null) =>
          dragging !== null && drop?.lane === lane.key && drop.before === before;
        return (
          <Lane
            key={lane.key}
            aria-label={lane.name}
            count={cards.length}
            name={
              lane.record ? (
                <button
                  onClick={() => onOpen(lane.record)}
                  title="Open this column"
                  style={{
                    border: 'none',
                    background: 'none',
                    padding: 0,
                    font: 'inherit',
                    color: palette.ink.strong,
                  }}
                >
                  {lane.name}
                </button>
              ) : (
                <span style={{ color: palette.ink.muted }}>{lane.name}</span>
              )
            }
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              if (drop?.lane !== lane.key || drop.before !== null) setDrop({ lane: lane.key, before: null });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging && drop) move(dragging, drop);
              endDrag();
            }}
            style={{ flex: '0 0 264px' }}
          >
            {cards.map((t) => (
              <div key={t.key}>
                {landing(t.key) && <Marker />}
                <Card
                  draggable={space.writable}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', t.body!.title);
                    setDragging(t.key);
                  }}
                  onDragEnd={endDrag}
                  onDragOver={(e) => overCard(e, lane.key, t.key)}
                  onClick={() => onOpen(t)}
                  style={{ opacity: dragging === t.key ? 0.4 : 1 }}
                >
                  <span>{t.body!.title}</span>
                  {t.body!.notes && <span style={{ fontSize: 12, color: palette.ink.faint }}>Has notes</span>}
                </Card>
              </div>
            ))}
            {landing(null) && <Marker />}

            {mayAddTask &&
              (addingTo === lane.key ? (
                <OneLine
                  placeholder="Task title"
                  onDone={() => setAddingTo(null)}
                  onSubmit={(title) => addTask(lane.key, title)}
                />
              ) : (
                <button onClick={() => setAddingTo(lane.key)} data-variant="ghost" style={addButton}>
                  + Add task
                </button>
              ))}
          </Lane>
        );
      })}

      {mayAddColumn && (
        <div style={{ flex: '0 0 264px' }}>
          {addingColumn ? (
            <OneLine placeholder="Column name" onDone={() => setAddingColumn(false)} onSubmit={addColumn} />
          ) : (
            <button
              onClick={() => setAddingColumn(true)}
              data-variant="quiet"
              style={{ ...styles.smallButton, width: '100%', height: 40 }}
            >
              + Add column
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Marker() {
  return (
    <div
      aria-hidden
      style={{ height: 2, margin: '2px 0 4px', borderRadius: 1, background: palette.ink.strong }}
    />
  );
}

/** A one-line input that adds on Enter, stays open for the next, and closes on Escape or when left empty */
function OneLine({
  placeholder,
  onSubmit,
  onDone,
}: {
  placeholder: string;
  onSubmit: (text: string) => void;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSubmit(text.trim());
        setText('');
      }}
    >
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onDone()}
        onBlur={() => !text.trim() && onDone()}
        placeholder={placeholder}
        aria-label={placeholder}
        style={{ ...styles.input, height: 38 }}
      />
    </form>
  );
}

const addButton = {
  height: 32,
  padding: '0 8px',
  border: 'none',
  borderRadius: 6,
  background: 'none',
  color: palette.ink.muted,
  fontSize: 13,
  textAlign: 'left' as const,
};
