import { useEffect, useRef, useState } from 'react';
import { useAccount, useCan, useLive, useNode, useProfiles } from 'weave-protocol/react';
import type { NodeRecord, QueryRecord } from 'weave-protocol';
import { message, reaction, type Message } from 'weave-protocol/schemas';
import { nameOf, peopleFrom } from '../../derive/people';
import { ago } from '../../derive/time';
import { Avatar } from '../Avatar';
import { Reactions } from '../std/Reactions';
import { styles, palette } from '../../styles';
import type { AppProps } from './index';

/** Messages from one person this close together share one name line */
const RUN_MS = 5 * 60 * 1000;

/**
 * `std.message` as a chat: the whole space is one room, oldest at the top,
 * a box at the bottom. Reactions appear when the space has `std.reaction`.
 */
export function Chat({ space, collections }: AppProps) {
  const node = useNode();
  const { did: me } = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  const mayWrite = useCan(space.id, 'create', message.name);
  const reacts = collections.some((c) => c.name === reaction.name && c.version !== null);
  const [draft, setDraft] = useState('');
  const [hover, setHover] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  const messages = useLive(
    space.id,
    async () =>
      (
        await node.records.query<Message>(space.id, {
          collection: message.name,
          sort: { '@createdAt': 'asc' },
          ...(reacts ? { include: { reactions: { rel: 'about', from: reaction.name } } } : {}),
        })
      ).records.filter((m) => m.body !== null),
    [reacts],
  );

  // Follow new messages down — unless you have scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [messages?.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    stuck.current = true;
    void node.records.put(space.id, message.name, { text });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${palette.surface.line}`, borderRadius: 10, overflow: 'hidden' }}>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        style={{ height: 'min(60vh, 560px)', minHeight: 280, overflowY: 'auto', padding: '16px 16px 8px', display: 'flex', flexDirection: 'column' }}
      >
        {messages?.length === 0 && <p style={{ margin: 'auto', fontSize: 13, color: palette.ink.faint }}>No messages yet. Say hello.</p>}
        {messages?.map((m, i) => {
          const prev = messages[i - 1];
          const startsRun = !prev || prev.root !== m.root || Date.parse(m.createdAt) - Date.parse(prev.createdAt) > RUN_MS;
          return (
            <Line
              key={m.key}
              record={m}
              startsRun={startsRun}
              name={nameOf(m.root, people)}
              mine={m.root === me}
              showReactions={reacts && (hover === m.key || reactionsOf(m).length > 0)}
              onHover={(on) => setHover(on ? m.key : (h) => (h === m.key ? null : h))}
              onDelete={() => void node.records.delete(space.id, m.key)}
              space={space}
            />
          );
        })}
      </div>
      {mayWrite ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          style={{ display: 'flex', gap: 8, padding: 12, borderTop: `1px solid ${palette.surface.line}`, background: palette.surface.sunken }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Message ${space.name}`} aria-label="Write a message" style={{ ...styles.input, flex: 1 }} />
          <button type="submit" disabled={!draft.trim()} data-variant="primary" style={styles.addButton}>
            Send
          </button>
        </form>
      ) : (
        <p style={{ padding: 12, fontSize: 13, color: palette.ink.muted, borderTop: `1px solid ${palette.surface.line}` }}>Your role here doesn't let you send messages.</p>
      )}
    </div>
  );
}

const reactionsOf = (m: QueryRecord): ReadonlyArray<NodeRecord> => {
  const found = m.included?.reactions;
  return Array.isArray(found) ? found : [];
};

function Line({
  record,
  startsRun,
  name,
  mine,
  showReactions,
  onHover,
  onDelete,
  space,
}: {
  record: QueryRecord<Message>;
  startsRun: boolean;
  name: string;
  mine: boolean;
  showReactions: boolean;
  onHover: (on: boolean) => void;
  onDelete: () => void;
  space: AppProps['space'];
}) {
  return (
    <div
      data-row
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onClick={() => onHover(true)}
      style={{ display: 'flex', gap: 10, padding: '2px 8px', margin: `${startsRun ? 10 : 0}px -8px 0`, borderRadius: 6 }}
    >
      <div style={{ width: 28, flexShrink: 0 }}>{startsRun && <Avatar did={record.root ?? record.author} size={28} />}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        {startsRun && (
          <div style={{ fontSize: 13 }}>
            <strong style={{ fontWeight: 600, color: palette.ink.strong }}>{name}</strong>
            <span style={{ color: palette.ink.faint }}> · {ago(record.createdAt)}</span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <p style={{ flex: 1, fontSize: 14, lineHeight: 1.5, color: palette.ink.body, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{record.body?.text}</p>
          {mine && space.writable && (
            <button onClick={onDelete} data-row-action data-variant="ghost" aria-label="Delete message" style={{ border: 'none', background: 'none', fontSize: 12, color: palette.ink.faint, padding: '2px 4px' }}>
              Delete
            </button>
          )}
        </div>
        {showReactions && (
          <div style={{ margin: '4px 0 6px' }}>
            <Reactions space={space} target={record.key} reactions={reactionsOf(record)} />
          </div>
        )}
      </div>
    </div>
  );
}
