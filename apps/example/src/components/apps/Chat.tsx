import { useEffect, useRef, useState } from 'react';
import { useAccount, useCan, useLive, useNode, useProfiles } from '@weaveprotocol/core/react';
import type { ResultOf } from '@weaveprotocol/core';
import { message, poll, reaction, vote, type Message, type Poll } from '@weaveprotocol/core/schemas';
import { nameOf, peopleFrom, writerOf } from '../../derive/people';
import { ago } from '../../derive/time';
import { Avatar } from '../Avatar';
import { Reactions } from '../std/Reactions';
import { styles, palette } from '../../styles';
import type { AppProps } from './index';
import { Ask, PollView, withVotes, type PollWithVotes } from './Polls';

/** Messages from one person this close together share one name line */
const RUN_MS = 5 * 60 * 1000;

/** Typing this sends a poll instead of a message, when the space has polls */
const POLL_COMMAND = /^\/poll(?:\s+(.*))?$/s;

/**
 * `std.message` as a chat: the whole space is one room, oldest at the top,
 * a box at the bottom. Reactions appear when the space has `std.reaction`.
 *
 * A message can share a record. When the space also has polls, `/poll` asks
 * the room one: the poll is an ordinary `std.poll`, and the message shares it,
 * so it can be voted on right here, in the Polls app, or anywhere else.
 */
export function Chat({ space, collections, onOpen }: AppProps) {
  const node = useNode();
  const { did: me } = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  const mayWrite = useCan(space.id, 'create', message.name);
  const defined = (name: string) => collections.find((c) => c.name === name && c.version !== null);
  const reacts = !!defined(reaction.name);
  // A space that defined messages before they could share records has no such link to write.
  const shares = !!defined(message.name)?.links?.shares;
  const polls = shares && !!defined(poll.name) && !!defined(vote.name);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const stuck = useRef(true);

  const messages = useLive(
    space.id,
    async () =>
      (
        await node.records.query(space.id, CHAT)
      ).records,
    [],
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
    const command = polls ? POLL_COMMAND.exec(text) : null;
    if (command) return setAsking(command[1]?.trim() ?? '');
    stuck.current = true;
    void node.records.put(space.id, message.name, { text });
  };

  const sendPoll = async (question: string, options: string[]) => {
    const asked = await node.records.put(space.id, poll.name, { question, options });
    stuck.current = true;
    await node.records.put(space.id, message.name, { text: `Poll: ${question}` }, { links: [{ rel: 'shares', to: asked.key }] });
    setAsking(null);
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
              name={writerOf(m, people)}
              mine={m.root === me}
              showReactions={reacts && (hover === m.key || reactionsOf(m).length > 0)}
              onHover={(on) => setHover(on ? m.key : (h) => (h === m.key ? null : h))}
              onDelete={() => void node.records.delete(space.id, m.key)}
              onOpen={onOpen}
              space={space}
            />
          );
        })}
      </div>
      {asking !== null && (
        <div style={{ padding: 12, borderTop: `1px solid ${palette.surface.line}` }}>
          <Ask initialQuestion={asking} onAsk={sendPoll} onCancel={() => setAsking(null)} />
        </div>
      )}
      {mayWrite && polls && asking === null && draft.startsWith('/') && !POLL_COMMAND.test(draft.trim()) && '/poll'.startsWith(draft.trim()) && (
        <button
          type="button"
          // Keep the cursor in the box, at the end, ready for the question.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setDraft('/poll ');
            requestAnimationFrame(() => {
              const el = input.current;
              el?.focus();
              el?.setSelectionRange(el.value.length, el.value.length);
            });
          }}
          data-menu-item style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 12px', border: 'none', borderTop: `1px solid ${palette.surface.line}`, background: palette.surface.card, font: 'inherit', fontSize: 13, textAlign: 'left' }}>
          <code style={{ color: palette.ink.strong }}>/poll</code>
          <span style={{ color: palette.ink.muted }}>Ask the room a question</span>
        </button>
      )}
      {mayWrite ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          style={{ display: 'flex', gap: 8, padding: 12, borderTop: `1px solid ${palette.surface.line}`, background: palette.surface.sunken }}
        >
          <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Message ${space.name}`} aria-label="Write a message" style={{ ...styles.input, flex: 1 }} />
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

/**
 * Every message, oldest first, with its reactions and whatever it shares —
 * with a shared poll's votes. Asking for what a space has not defined yet
 * simply finds nothing.
 */
const CHAT = {
  collection: message,
  sort: { '@createdAt': 'asc' },
  include: {
    reactions: { rel: 'about', from: reaction },
    shared: { rel: 'shares', direction: 'out', include: withVotes },
  },
} as const;
type ChatMessage = ResultOf<typeof CHAT>['records'][number];

const reactionsOf = (m: ChatMessage) => m.included.reactions;
/** The record a message shares, when it has one and this device holds it */
const sharedOf = (m: ChatMessage) => m.included.shared[0] ?? null;

function Line({
  record,
  startsRun,
  name,
  mine,
  showReactions,
  onHover,
  onDelete,
  onOpen,
  space,
}: {
  record: ChatMessage;
  startsRun: boolean;
  name: string;
  mine: boolean;
  showReactions: boolean;
  onHover: (on: boolean) => void;
  onDelete: () => void;
  onOpen: AppProps['onOpen'];
  space: AppProps['space'];
}) {
  const shared = sharedOf(record);
  // It can share anything; a poll is the one this chat knows how to show.
  const sharesPoll = shared?.collection === poll.name;
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
          {sharesPoll ? (
            // The poll says it better than the message's fallback text.
            <div style={{ flex: 1, minWidth: 0, maxWidth: 480, margin: '4px 0' }}>
              <PollView space={space} record={shared as PollWithVotes} onOpen={onOpen} />
            </div>
          ) : (
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 14, lineHeight: 1.5, color: palette.ink.body, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{record.body.text}</p>
              {shared && (
                <button onClick={() => onOpen(shared)} data-variant="quiet" style={{ ...styles.smallButton, height: 28, marginTop: 4 }}>
                  Open shared record
                </button>
              )}
            </div>
          )}
          {/* A shared poll has its own Delete; two would be confusing. */}
          {mine && space.writable && !sharesPoll && (
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
