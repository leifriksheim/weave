import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAccess, useAccount, useCan, useLive, useNode, useProfiles } from '@weaveprotocol/core/react';
import { DEFINE, roleHolds } from '@weaveprotocol/core';
import type { DirectMessage, NodeRecord, ResultOf } from '@weaveprotocol/core';
import { channel, message, poll, positionBetween, reaction, vote } from '@weaveprotocol/core/schemas';
import type { Channel } from '@weaveprotocol/core/schemas';
import { nameOf, peopleFrom, writerOf, type People } from '../../derive/people';
import { Icon } from '../Icon';
import { ago } from '../../derive/time';
import { Avatar } from '@weave/app-shared/Avatar';
import { createPortal } from 'react-dom';
import { Modal } from '@weave/app-shared/Modal';
import { Reactions } from '../std/Reactions';
import { styles, palette } from '../../styles';
import type { AppProps } from './index';
import { Ask, PollView, withVotes } from './Polls';

/** A message that mentions you, or replies to you: a warm tint, and an edge down its left */
const FOR_ME = '#fff8e6';
const FOR_ME_EDGE = '#f0b429';

/** Messages from one person this close together share one name line */
const RUN_MS = 5 * 60 * 1000;

/** Typing this sends a poll instead of a message, when the space has polls */
const POLL_COMMAND = /^\/poll(?:\s+(.*))?$/s;

type ChannelRecord = NodeRecord<Channel>;

/** Where the chat is open: the space's own room, one of its channels, or a conversation of direct messages */
type Place =
  | { readonly kind: 'room'; readonly channel: string | null }
  | { readonly kind: 'direct'; readonly with: ReadonlyArray<string> };

/** One conversation of direct messages: everyone in it but you, and what was said */
interface Conversation {
  readonly with: ReadonlyArray<string>;
  readonly messages: ReadonlyArray<DirectMessage>;
}

/**
 * A chat the way a team uses one: the space's own room, the channels it adds
 * (`std.channel`), and direct messages between members (`std.direct`) that
 * only the people in them can read. A space with none of those is one room,
 * with no list beside it.
 */
export function Chat(props: AppProps) {
  const { space, collections } = props;
  const node = useNode();
  const { did: me } = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  const access = useAccess(space.id);
  const hasChannels = collections.some((c) => c.name === channel.name && c.version !== null);
  const mayDefine = space.writable && roleHolds(access?.role, DEFINE);
  const mayCreateChannel = useCan(space.id, 'create', channel.name);
  const mayAddChannel = hasChannels ? mayCreateChannel : mayDefine;
  // Direct messages are sealed to member keys, which members publish only in private spaces.
  const directs = space.visibility === 'private';

  const channels = useLive(
    space.id,
    async () =>
      hasChannels
        ? [...(await node.records.list<Channel>(space.id, { collection: channel.name }))].sort(
            (a, b) =>
              (a.body?.position ?? '').localeCompare(b.body?.position ?? '') ||
              (a.body?.name ?? '').localeCompare(b.body?.name ?? ''),
          )
        : [],
    [hasChannels],
  );
  const reachable = useLive(space.id, async () => (directs ? node.direct.reachable(space.id) : []), [
    directs,
  ]);
  const conversations = useLive(
    space.id,
    async () => (directs ? conversationsOf(await node.direct.list(space.id), me) : []),
    [directs, me],
  );

  const [place, setPlace] = useState<Place>({ kind: 'room', channel: null });
  const open = place.kind === 'room' ? (channels?.find((c) => c.key === place.channel) ?? null) : null;
  // Nothing to choose between: the space is the room, as it always was.
  const listed = directs || mayAddChannel || (channels?.length ?? 0) > 0;

  const addChannel = async (name: string) => {
    if (!hasChannels) await node.collections.define(space.id, channel);
    const last = channels?.at(-1)?.body?.position ?? null;
    const made = await node.records.put(space.id, channel.name, { name, position: positionBetween(last) });
    setPlace({ kind: 'room', channel: made.key });
  };

  return (
    <div
      className={listed ? 'chat-shell' : undefined}
      style={{
        display: listed ? undefined : 'flex',
        flex: 1,
        minHeight: 0,
        border: `1px solid ${palette.surface.line}`,
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      {listed && (
        <Places
          space={space}
          people={people}
          channels={channels ?? []}
          conversations={conversations ?? []}
          reachable={directs ? (reachable ?? []) : null}
          place={place}
          onPlace={setPlace}
          onAddChannel={mayAddChannel ? addChannel : undefined}
        />
      )}
      {place.kind === 'room' ? (
        <Room key={place.channel ?? ''} {...props} channel={open} titled={listed} />
      ) : (
        <DirectRoom
          key={place.with.join(',')}
          space={space}
          people={people}
          with={place.with}
          messages={conversations?.find((c) => sameGroup(c.with, place.with))?.messages ?? []}
        />
      )}
    </div>
  );
}

/** Everyone in a conversation but you, as one key: sorted, once each */
const groupOf = (m: DirectMessage, me: string) =>
  [...new Set([m.from, ...m.to])].filter((did) => did !== me).sort();
const sameGroup = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.join(',') === b.join(',');

/** Direct messages as conversations, the one spoken in most recently first */
function conversationsOf(messages: ReadonlyArray<DirectMessage>, me: string): ReadonlyArray<Conversation> {
  const byGroup = new Map<string, { with: string[]; messages: DirectMessage[] }>();
  for (const m of messages) {
    const group = groupOf(m, me);
    const key = group.join(',');
    const found = byGroup.get(key) ?? { with: group, messages: [] };
    found.messages.push(m);
    byGroup.set(key, found);
  }
  const last = (c: Conversation) => c.messages.at(-1)?.createdAt ?? '';
  return [...byGroup.values()].sort((a, b) => last(b).localeCompare(last(a)));
}

/**
 * `std.message` as a chat room: the space's own, or one channel's; oldest at
 * the top, a box at the bottom. Reactions appear when the space has
 * `std.reaction`.
 *
 * A message can share a record. When the space also has polls, `/poll` asks
 * the room one: the poll is an ordinary `std.poll`, and the message shares it,
 * so it can be voted on right here, in the Polls app, or anywhere else.
 */
function Room({
  space,
  collections,
  onOpen,
  since,
  channel: inChannel,
  titled,
}: AppProps & {
  /** The channel it is, or null for the space's own room */
  readonly channel: ChannelRecord | null;
  /** Shows which room it is above the messages, when there are others to be in */
  readonly titled: boolean;
}) {
  const node = useNode();
  const { did: me } = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  const mayWrite = useCan(space.id, 'create', message.name);
  const defined = (name: string) => collections.find((c) => c.name === name && c.version !== null);
  const reacts = !!defined(reaction.name);
  // A space that defined messages before they could share records has no such link to write.
  const shares = !!defined(message.name)?.links?.shares;
  const polls = shares && !!defined(poll.name) && !!defined(vote.name);
  // Messages defined before mentions were topics still carry them, but only an open app can tell
  // people; someone who may define collections can bring the space up to date so any device can.
  const access = useAccess(space.id);
  const [updating, setUpdating] = useState(false);
  const outdated =
    space.writable &&
    roleHolds(access?.role, DEFINE) &&
    !!defined(message.name) &&
    !defined(message.name)?.topics.includes('mentions');
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const stuck = useRef(true);

  const where = { channel: inChannel ? inChannel.key : { $exists: false } };
  const messages = useLive(
    space.id,
    async () => (await node.records.query(space.id, { ...CHAT, where })).records,
    [inChannel?.key],
  );
  const roomName = inChannel?.body?.name ?? GENERAL;
  const inRoom = inChannel ? { channel: inChannel.key } : {};
  // Where what arrived since you last looked begins: a line above it, the way chat apps mark it.
  // Fixed when the chat opens, so reading it doesn't move the line away.
  const [after] = useState(() => (since ? Date.parse(since) : Infinity));
  const firstNew = messages?.findIndex((m) => m.root !== me && Date.parse(m.createdAt) > after) ?? -1;

  // Follow new messages down — unless you have scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [messages?.length]);

  // Who the draft mentions, by the name it shows: whoever was picked after "@", and whoever's
  // full name was typed after one. Names are shown unique (`nameOf`), so neither is a guess.
  const picked = useRef(new Map<string, string>());
  const [caret, setCaret] = useState(0);
  const [choice, setChoice] = useState(0);
  const [replying, setReplying] = useState<ChatMessage | null>(null);
  // A space that defined messages before replies could link to what they answer has no such link to write.
  const linksReplies = !!defined(message.name)?.links?.replyTo;
  const typed = /(?:^|\s)@([^\s@]*)$/.exec(draft.slice(0, caret));
  const query = typed ? (typed[1] ?? '').toLowerCase() : null;
  const suggestions =
    query === null
      ? []
      : [...people.values()]
          .filter((person) => person.did !== me && person.name.toLowerCase().includes(query))
          .slice(0, 6);
  const pick = (did: string) => {
    const label = nameOf(did, people);
    const before = draft.slice(0, caret).replace(/@[^\s@]*$/, `@${label} `);
    picked.current.set(label, did);
    setDraft(before + draft.slice(caret));
    setChoice(0);
    setCaret(before.length);
    placeCaret.current = before.length;
  };
  // Straight after the new text is in the box, before the next key lands: later, and it lands in the wrong place.
  const placeCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = placeCaret.current;
    if (at === null) return;
    placeCaret.current = null;
    input.current?.focus();
    input.current?.setSelectionRange(at, at);
  }, [draft]);
  const reply = (m: ChatMessage) => {
    setReplying(m);
    input.current?.focus();
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    const command = polls ? POLL_COMMAND.exec(text) : null;
    if (command) return setAsking(command[1]?.trim() ?? '');
    stuck.current = true;
    const named = (label: string) =>
      new RegExp(`(?:^|\\s)@${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s.,!?:;)])`, 'i').test(
        text,
      );
    const typed = [...people.keys()]
      .filter((did) => did !== me)
      .map((did) => [nameOf(did, people), did] as const);
    const mentions = [
      ...new Set([...picked.current, ...typed].filter(([label]) => named(label)).map(([, did]) => did)),
    ];
    const to = replying;
    picked.current.clear();
    setReplying(null);
    const body = {
      text,
      ...inRoom,
      ...(mentions.length ? { mentions } : {}),
      ...(to?.root && to.root !== me ? { replyingTo: to.root } : {}),
    };
    void (to && linksReplies
      ? node.records.put(space.id, message.name, body, { links: [{ rel: 'replyTo', to: to.key }] })
      : node.records.put(space.id, message.name, body));
  };

  const sendPoll = async (question: string, options: string[]) => {
    const asked = await node.records.put(space.id, poll.name, { question, options });
    stuck.current = true;
    await node.records.put(
      space.id,
      message.name,
      { text: `Poll: ${question}`, ...inRoom },
      { links: [{ rel: 'shares', to: asked.key }] },
    );
    setAsking(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      {titled && (
        <RoomTitle
          name={`# ${roomName}`}
          detail={inChannel?.body?.topic ?? (inChannel ? undefined : 'Everyone in the space')}
        />
      )}
      {outdated && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            padding: '8px 12px',
            borderBottom: `1px solid ${palette.surface.line}`,
            background: palette.surface.sunken,
            fontSize: 13,
            color: palette.ink.muted,
          }}
        >
          <span style={{ flex: '1 1 240px' }}>
            Update this space's messages so mentions and replies notify people even when the app is closed.
          </span>
          <button
            onClick={() => {
              setUpdating(true);
              void node.collections.define(space.id, message).finally(() => setUpdating(false));
            }}
            disabled={updating}
            data-variant="quiet"
            style={{ ...styles.smallButton, height: 28 }}
          >
            {updating ? 'Updating…' : 'Update'}
          </button>
        </div>
      )}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        style={{
          // As tall as the window lets it be (`.space-content[data-fill]`).
          flex: '1 1 0',
          minHeight: 240,
          overflowY: 'auto',
          padding: '16px 16px 8px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {messages?.length === 0 && (
          <p style={{ margin: 'auto', fontSize: 13, color: palette.ink.faint }}>
            No messages yet. Say hello.
          </p>
        )}
        {messages?.map((m, i) => {
          const prev = messages[i - 1];
          const answers = m.links.find((link) => link.rel === 'replyTo')?.to;
          const answered = answers ? messages.find((other) => other.key === answers) : undefined;
          const startsRun =
            !!answers ||
            !prev ||
            prev.root !== m.root ||
            Date.parse(m.createdAt) - Date.parse(prev.createdAt) > RUN_MS;
          return (
            <Fragment key={m.key}>
              {i === firstNew && <NewSince />}
              <Line
                record={m}
                startsRun={startsRun}
                name={writerOf(m, people)}
                mine={m.root === me}
                forMe={m.root !== me && (!!m.body.mentions?.includes(me) || m.body.replyingTo === me)}
                answers={
                  answers
                    ? {
                        name: answered ? writerOf(answered, people) : nameOf(m.body.replyingTo, people),
                        text: answered?.body.text ?? null,
                      }
                    : undefined
                }
                onReply={mayWrite ? () => reply(m) : undefined}
                showReactions={reacts && (hover === m.key || reactionsOf(m).length > 0)}
                onHover={(on) => setHover(on ? m.key : (h) => (h === m.key ? null : h))}
                onDelete={() => void node.records.delete(space.id, m.key)}
                onOpen={onOpen}
                space={space}
              />
            </Fragment>
          );
        })}
      </div>
      {asking !== null && (
        <div style={{ padding: 12, borderTop: `1px solid ${palette.surface.line}` }}>
          <Ask initialQuestion={asking} onAsk={sendPoll} onCancel={() => setAsking(null)} />
        </div>
      )}
      {mayWrite &&
        polls &&
        asking === null &&
        draft.startsWith('/') &&
        !POLL_COMMAND.test(draft.trim()) &&
        '/poll'.startsWith(draft.trim()) && (
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
            data-menu-item
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'baseline',
              padding: '8px 12px',
              border: 'none',
              borderTop: `1px solid ${palette.surface.line}`,
              background: palette.surface.card,
              font: 'inherit',
              fontSize: 13,
              textAlign: 'left',
            }}
          >
            <code style={{ color: palette.ink.strong }}>/poll</code>
            <span style={{ color: palette.ink.muted }}>Ask the room a question</span>
          </button>
        )}
      {mayWrite && suggestions.length > 0 && (
        <div
          role="listbox"
          aria-label="Mention someone"
          style={{ borderTop: `1px solid ${palette.surface.line}` }}
        >
          {suggestions.map((person, i) => (
            <button
              key={person.did}
              type="button"
              role="option"
              aria-selected={i === choice}
              // Keep the cursor in the box.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(person.did)}
              data-menu-item
              style={{
                width: '100%',
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                padding: '8px 12px',
                border: 'none',
                background: i === choice ? palette.surface.sunken : palette.surface.card,
                font: 'inherit',
                fontSize: 13,
                textAlign: 'left',
              }}
            >
              <Avatar did={person.did} size={20} />
              <span style={{ color: palette.ink.strong }}>{nameOf(person.did, people)}</span>
            </button>
          ))}
        </div>
      )}
      {mayWrite && replying && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderTop: `1px solid ${palette.surface.line}`,
            fontSize: 13,
            color: palette.ink.muted,
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            Replying to <strong style={{ color: palette.ink.strong }}>{writerOf(replying, people)}</strong> ·{' '}
            {replying.body.text}
          </span>
          <button
            type="button"
            onClick={() => setReplying(null)}
            aria-label="Don't reply"
            data-variant="ghost"
            style={{
              border: 'none',
              background: 'none',
              color: palette.ink.faint,
              fontSize: 14,
              padding: '0 4px',
            }}
          >
            ✕
          </button>
        </div>
      )}
      {mayWrite ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          style={{
            display: 'flex',
            gap: 8,
            padding: 12,
            borderTop: `1px solid ${palette.surface.line}`,
            background: palette.surface.sunken,
          }}
        >
          <input
            ref={input}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setChoice(0);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? draft.length)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && replying && !suggestions.length) return setReplying(null);
              if (!suggestions.length) return;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setChoice((i) => (i + step + suggestions.length) % suggestions.length);
              } else if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const person = suggestions[choice] ?? suggestions[0];
                if (person) pick(person.did);
              } else if (e.key === 'Escape') {
                setCaret(0);
              }
            }}
            placeholder={
              replying
                ? 'Write a reply'
                : `Message ${titled ? `#${roomName}` : space.name} · @ to mention someone`
            }
            aria-label="Write a message"
            style={{ ...styles.input, flex: 1 }}
          />
          <button type="submit" disabled={!draft.trim()} data-variant="primary" style={styles.addButton}>
            Send
          </button>
        </form>
      ) : (
        <p
          style={{
            padding: 12,
            fontSize: 13,
            color: palette.ink.muted,
            borderTop: `1px solid ${palette.surface.line}`,
          }}
        >
          Your role here doesn't let you send messages.
        </p>
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
  forMe,
  answers,
  onReply,
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
  /** It mentions you, or replies to you: marked the way chat apps mark what is yours to answer */
  forMe: boolean;
  /** The message it replies to: who wrote it, and its text when this device has it */
  answers: { name: string; text: string | null } | undefined;
  onReply: (() => void) | undefined;
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
      style={{
        display: 'flex',
        gap: 10,
        padding: '2px 8px',
        margin: `${startsRun ? 10 : 0}px -8px 0`,
        borderRadius: 6,
        ...(forMe ? { background: FOR_ME, boxShadow: `inset 3px 0 0 ${FOR_ME_EDGE}` } : {}),
      }}
    >
      <div style={{ width: 28, flexShrink: 0 }}>
        {startsRun && <Avatar did={record.root ?? record.author} size={28} />}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        {answers && (
          <div
            style={{
              fontSize: 12,
              color: palette.ink.muted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            ↳ Replying to <strong style={{ fontWeight: 600 }}>{answers.name}</strong>
            {answers.text ? ` · ${answers.text}` : ''}
          </div>
        )}
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
              <PollView space={space} record={shared} onOpen={onOpen} />
            </div>
          ) : (
            <div style={{ flex: 1, minWidth: 0 }}>
              <p
                style={{
                  fontSize: 14,
                  lineHeight: 1.5,
                  color: palette.ink.body,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {record.body.text}
              </p>
              {shared && (
                <button
                  onClick={() => onOpen(shared)}
                  data-variant="quiet"
                  style={{ ...styles.smallButton, height: 28, marginTop: 4 }}
                >
                  Open shared record
                </button>
              )}
            </div>
          )}
          {onReply && (
            <button
              onClick={onReply}
              data-row-action
              data-variant="ghost"
              aria-label={`Reply to ${name}`}
              style={{
                border: 'none',
                background: 'none',
                fontSize: 12,
                color: palette.ink.faint,
                padding: '2px 4px',
              }}
            >
              Reply
            </button>
          )}
          {/* A shared poll has its own Delete; two would be confusing. */}
          {mine && space.writable && !sharesPoll && (
            <button
              onClick={onDelete}
              data-row-action
              data-variant="ghost"
              aria-label="Delete message"
              style={{
                border: 'none',
                background: 'none',
                fontSize: 12,
                color: palette.ink.faint,
                padding: '2px 4px',
              }}
            >
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

/** The line above the first message that arrived since you last looked */
function NewSince() {
  return (
    <div
      role="separator"
      aria-label="New messages"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '10px 0',
        color: palette.accent.danger,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '.05em',
      }}
    >
      <span style={{ flex: 1, height: 1, background: palette.accent.danger, opacity: 0.5 }} />
      New
    </div>
  );
}

/** What the space's own room is called beside its channels */
const GENERAL = 'general';

function RoomTitle({ name, detail }: { name: string; detail?: string | undefined }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        minWidth: 0,
        padding: '10px 16px',
        borderBottom: `1px solid ${palette.surface.line}`,
      }}
    >
      <strong style={{ fontSize: 14, fontWeight: 600, color: palette.ink.strong, whiteSpace: 'nowrap' }}>
        {name}
      </strong>
      {detail && (
        <span
          style={{
            fontSize: 12,
            color: palette.ink.muted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {detail}
        </span>
      )}
    </div>
  );
}

/**
 * The list beside the chat: the space's own room and its channels, then
 * conversations of direct messages. On a phone it is a row above the chat.
 */
function Places({
  space,
  people,
  channels,
  conversations,
  reachable,
  place,
  onPlace,
  onAddChannel,
}: {
  space: AppProps['space'];
  people: People;
  channels: ReadonlyArray<ChannelRecord>;
  conversations: ReadonlyArray<Conversation>;
  /** Who can be written to directly; null where there are no direct messages */
  reachable: ReadonlyArray<string> | null;
  place: Place;
  onPlace: (place: Place) => void;
  onAddChannel: ((name: string) => Promise<void>) | undefined;
}) {
  const [adding, setAdding] = useState<'channel' | 'direct' | null>(null);
  // The same function every render: the dialog takes a new one as a reason to move focus again.
  const stopAdding = useCallback(() => setAdding(null), []);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const inRoom = (key: string | null) => place.kind === 'room' && place.channel === key;
  const inDirect = (group: ReadonlyArray<string>) => place.kind === 'direct' && sameGroup(place.with, group);
  // A conversation just started, before anything is sent in it: listed while it's open, gone if left empty.
  const drafting =
    place.kind === 'direct' && !conversations.some((c) => sameGroup(c.with, place.with)) ? place.with : null;
  const shown = drafting ? [{ with: drafting }, ...conversations] : conversations;

  const submitChannel = async () => {
    const trimmed = name.trim();
    if (!trimmed || !onAddChannel) return;
    setBusy(true);
    try {
      await onAddChannel(trimmed);
      setName('');
      setAdding(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <nav className="chat-places" aria-label={`Conversations in ${space.name}`}>
      <Heading
        label="Channels"
        onAdd={onAddChannel ? () => setAdding(adding === 'channel' ? null : 'channel') : undefined}
      />
      <PlaceButton current={inRoom(null)} onClick={() => onPlace({ kind: 'room', channel: null })}>
        <span style={{ color: palette.ink.faint }}>#</span> {GENERAL}
      </PlaceButton>
      {channels.map((c) => (
        <PlaceButton
          key={c.key}
          current={inRoom(c.key)}
          onClick={() => onPlace({ kind: 'room', channel: c.key })}
        >
          <span style={{ color: palette.ink.faint }}>#</span> {c.body?.name ?? 'Unreadable channel'}
        </PlaceButton>
      ))}
      {adding === 'channel' && (
        <form
          className="chat-places-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitChannel();
          }}
          style={{ display: 'flex', gap: 6, padding: '4px 0' }}
        >
          <input
            autoFocus
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(null)}
            placeholder="Channel name"
            aria-label="New channel's name"
            style={{ ...styles.input, height: 30, fontSize: 13, flex: 1, minWidth: 0 }}
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            data-variant="primary"
            style={{ ...styles.smallButton, height: 30 }}
          >
            Add
          </button>
        </form>
      )}

      {reachable && (
        <>
          <Heading
            label="Direct messages"
            onAdd={reachable.length > 0 ? () => setAdding(adding === 'direct' ? null : 'direct') : undefined}
          />
          {shown.map((c) => (
            <PlaceButton
              key={c.with.join(',')}
              current={inDirect(c.with)}
              onClick={() => onPlace({ kind: 'direct', with: c.with })}
            >
              <Avatar did={c.with[0] ?? ''} size={16} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.with.map((did) => nameOf(did, people)).join(', ')}
              </span>
            </PlaceButton>
          ))}
          {adding === 'direct' && (
            <NewConversation
              people={people}
              reachable={reachable}
              onStart={(group) => {
                setAdding(null);
                onPlace({ kind: 'direct', with: group });
              }}
              onClose={stopAdding}
            />
          )}
          {shown.length === 0 && (
            <p
              className="chat-places-note"
              style={{ fontSize: 12, color: palette.ink.faint, padding: '2px 8px' }}
            >
              {reachable.length > 0
                ? 'Write to someone only they can read.'
                : 'People show up here once they open the space in an up-to-date app.'}
            </p>
          )}
        </>
      )}
    </nav>
  );
}

/**
 * Who to write to: everyone who can be written to, ticked one or more at a
 * time. Picking opens the conversation; it stays in the list once something
 * is sent in it.
 */
function NewConversation({
  people,
  reachable,
  onStart,
  onClose,
}: {
  people: People;
  reachable: ReadonlyArray<string>;
  onStart: (group: ReadonlyArray<string>) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const [find, setFind] = useState('');
  const found = reachable
    .map((did) => ({ did, name: nameOf(did, people) }))
    .filter((p) => p.name.toLowerCase().includes(find.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const toggle = (did: string) =>
    setPicked((was) => (was.includes(did) ? was.filter((d) => d !== did) : [...was, did]));
  const names = picked.map((did) => nameOf(did, people));
  // Out of the list it's opened from, which on a phone is a scrolling row.
  return createPortal(
    <Modal title="New message" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (picked.length) onStart([...picked].sort());
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {reachable.length > 6 && (
          <input
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Find someone"
            aria-label="Find someone"
            style={styles.input}
          />
        )}
        <div
          role="group"
          aria-label="People"
          style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 320, overflowY: 'auto' }}
        >
          {found.map((p) => (
            <label
              key={p.did}
              data-nav
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 8px',
                borderRadius: 6,
                fontSize: 14,
                color: palette.ink.strong,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={picked.includes(p.did)}
                onChange={() => toggle(p.did)}
                style={styles.checkbox}
              />
              <Avatar did={p.did} size={24} />
              {p.name}
            </label>
          ))}
          {found.length === 0 && (
            <p style={{ fontSize: 13, color: palette.ink.faint, padding: '6px 8px' }}>Nobody by that name.</p>
          )}
        </div>
        <p style={{ fontSize: 12.5, color: palette.ink.muted }}>
          Only the people you pick can read it. Others in the space see that you wrote, not what.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} data-variant="quiet" style={styles.smallButton}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={picked.length === 0}
            data-variant="primary"
            style={{ ...styles.addButton, height: 32 }}
          >
            {picked.length === 0
              ? 'Message'
              : picked.length === 1
                ? `Message ${names[0]}`
                : `Message ${picked.length} people`}
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}

function Heading({ label, onAdd }: { label: string; onAdd: (() => void) | undefined }) {
  return (
    <div
      className="chat-places-heading"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 8px 4px',
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '.05em',
          color: palette.ink.muted,
        }}
      >
        {label}
      </span>
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          aria-label={label === 'Channels' ? 'Add a channel' : 'New message'}
          title={label === 'Channels' ? 'Add a channel' : 'New message'}
          data-variant="ghost"
          style={{
            border: 'none',
            background: 'none',
            padding: 2,
            color: palette.ink.muted,
            display: 'flex',
          }}
        >
          <Icon name="plus" size={14} />
        </button>
      )}
    </div>
  );
}

function PlaceButton({
  current,
  onClick,
  children,
}: {
  current: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current || undefined}
      data-nav
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        minWidth: 0,
        height: 30,
        padding: '0 8px',
        border: 'none',
        borderRadius: 6,
        // The list itself is sunken: the open one stands up out of it, the way the space's sidebar marks its own.
        background: current ? palette.surface.card : 'none',
        boxShadow: current ? `0 0 0 1px ${palette.surface.line}` : 'none',
        color: current ? palette.ink.strong : palette.ink.body,
        fontWeight: current ? 600 : 400,
        font: 'inherit',
        fontSize: 13,
        textAlign: 'left',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

/**
 * A conversation of direct messages. What is written here is sealed for the
 * people in it (`node.direct`): the rest of the space sees that you wrote to
 * them, and when, but not what.
 */
function DirectRoom({
  space,
  people,
  with: others,
  messages,
}: {
  space: AppProps['space'];
  people: People;
  with: ReadonlyArray<string>;
  messages: ReadonlyArray<DirectMessage>;
}) {
  const node = useNode();
  const { did: me } = useAccount();
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const names = others.map((did) => nameOf(did, people)).join(', ');

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setProblem(null);
    node.direct.send(space.id, others, text).catch((error: unknown) => {
      setDraft(text);
      setProblem(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      <RoomTitle
        name={names}
        detail={
          others.length === 1 ? 'Only the two of you can read this' : 'Only the people here can read this'
        }
      />
      <div
        ref={scroller}
        style={{
          flex: '1 1 0',
          minHeight: 240,
          overflowY: 'auto',
          padding: '16px 16px 8px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {messages.length === 0 && (
          <p
            style={{
              margin: 'auto',
              maxWidth: 320,
              textAlign: 'center',
              fontSize: 13,
              color: palette.ink.faint,
            }}
          >
            Messages here are sealed for {names} and you. Others in {space.name} see that you wrote, not what.
          </p>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const startsRun =
            !prev || prev.from !== m.from || Date.parse(m.createdAt) - Date.parse(prev.createdAt) > RUN_MS;
          return (
            <div
              key={m.key}
              data-row
              style={{
                display: 'flex',
                gap: 10,
                padding: '2px 8px',
                margin: `${startsRun ? 10 : 0}px -8px 0`,
                borderRadius: 6,
              }}
            >
              <div style={{ width: 28, flexShrink: 0 }}>{startsRun && <Avatar did={m.from} size={28} />}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                {startsRun && (
                  <div style={{ fontSize: 13 }}>
                    <strong style={{ fontWeight: 600, color: palette.ink.strong }}>
                      {nameOf(m.from, people)}
                    </strong>
                    <span style={{ color: palette.ink.faint }}>
                      {' '}
                      · {ago(m.createdAt)}
                      {m.viaAgent ? ' · via agent' : ''}
                    </span>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <p
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 14,
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      color: m.text === null ? palette.ink.faint : palette.ink.body,
                      fontStyle: m.text === null ? 'italic' : undefined,
                    }}
                  >
                    {m.text ?? "This device can't open this message."}
                  </p>
                  {m.from === me && space.writable && (
                    <button
                      onClick={() => void node.records.delete(space.id, m.key)}
                      data-row-action
                      data-variant="ghost"
                      aria-label="Delete message"
                      style={{
                        border: 'none',
                        background: 'none',
                        fontSize: 12,
                        color: palette.ink.faint,
                        padding: '2px 4px',
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {problem && (
        <p
          style={{
            padding: '8px 12px',
            fontSize: 13,
            color: palette.accent.danger,
            borderTop: `1px solid ${palette.surface.line}`,
          }}
        >
          {problem}
        </p>
      )}
      {space.writable ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          style={{
            display: 'flex',
            gap: 8,
            padding: 12,
            borderTop: `1px solid ${palette.surface.line}`,
            background: palette.surface.sunken,
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Message ${names}`}
            aria-label="Write a direct message"
            style={{ ...styles.input, flex: 1 }}
          />
          <button type="submit" disabled={!draft.trim()} data-variant="primary" style={styles.addButton}>
            Send
          </button>
        </form>
      ) : (
        <p
          style={{
            padding: 12,
            fontSize: 13,
            color: palette.ink.muted,
            borderTop: `1px solid ${palette.surface.line}`,
          }}
        >
          Your role here doesn't let you send messages.
        </p>
      )}
    </div>
  );
}
