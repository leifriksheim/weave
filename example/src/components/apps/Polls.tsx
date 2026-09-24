import { useState } from 'react';
import { useAccount, useCan, useLive, useNode, useProfiles } from 'weave-protocol/react';
import type { NodeRecord, QueryRecord } from 'weave-protocol';
import { poll, vote, type Poll, type Vote } from 'weave-protocol/schemas';
import { nameOf, peopleFrom, type People } from '../../derive/people';
import { ago } from '../../derive/time';
import { Avatar } from '../Avatar';
import { styles, palette } from '../../styles';
import type { AppProps } from './index';

const MAX_OPTIONS = 10;

/**
 * `std.poll` and `std.vote`: ask a question, and everyone picks one option.
 * A vote is one record per person per poll, so voting again just changes it
 * and clicking your choice again takes it back.
 */
export function Polls({ space, onOpen }: AppProps) {
  const node = useNode();
  const mayAsk = useCan(space.id, 'create', poll.name);
  const [asking, setAsking] = useState(false);

  const polls = useLive(
    space.id,
    async () =>
      (
        await node.records.query<Poll>(space.id, {
          collection: poll.name,
          sort: { '@createdAt': 'desc' },
          include: withVotes,
        })
      ).records.filter((p) => p.body !== null),
    [],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 640 }}>
      {mayAsk &&
        (asking ? (
          <Ask
            onCancel={() => setAsking(false)}
            onAsk={async (question, options) => {
              await node.records.put(space.id, poll.name, { question, options });
              setAsking(false);
            }}
          />
        ) : (
          <button onClick={() => setAsking(true)} data-variant="primary" style={styles.addButton}>
            New poll
          </button>
        ))}
      {polls?.length === 0 && !asking && <div style={styles.emptyState}>No polls yet.{mayAsk ? ' Ask the space something.' : ''}</div>}
      {polls?.map((p) => <PollView key={p.key} space={space} record={p} onOpen={onOpen} />)}
    </div>
  );
}

/** Include this with a poll to get what {@link PollView} needs: its votes */
export const withVotes = { votes: { rel: 'about', from: vote.name } } as const;

/**
 * One poll, ready to vote on — wherever it shows up: in this app's list, or
 * shared into a chat. The record must carry its votes (query it with
 * `include: withVotes`).
 */
export function PollView({ space, record, onOpen }: { space: AppProps['space']; record: QueryRecord<Poll>; onOpen: AppProps['onOpen'] }) {
  const node = useNode();
  const { did: me } = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  return (
    <PollCard
      record={record}
      me={me}
      people={people}
      writable={space.writable}
      onOpen={() => onOpen(record)}
      onVote={(choice) => void node.records.put(space.id, vote.name, { choice }, { links: [{ rel: 'about', to: record.key }] })}
      onUnvote={(key) => void node.records.delete(space.id, key)}
      onClose={(closed) => void node.records.update(space.id, record.key, { ...record.body!, closed })}
      onDelete={() => void node.records.delete(space.id, record.key)}
    />
  );
}

function PollCard({
  record,
  me,
  people,
  writable,
  onOpen,
  onVote,
  onUnvote,
  onClose,
  onDelete,
}: {
  record: QueryRecord<Poll>;
  me: string;
  people: People;
  writable: boolean;
  onOpen: () => void;
  onVote: (choice: number) => void;
  onUnvote: (key: string) => void;
  onClose: (closed: boolean) => void;
  onDelete: () => void;
}) {
  const { question, options, closed } = record.body!;
  const found = record.included?.votes;
  // Only votes for an option that exists count — a vote from a buggy app for option 7 of 2 is ignored.
  const votes = (Array.isArray(found) ? (found as NodeRecord<Vote>[]) : []).filter((v) => typeof v.body?.choice === 'number' && v.body.choice < options.length);
  const mine = votes.find((v) => v.root === me);
  const asker = record.createdBy === me;
  const open = writable && !closed;

  return (
    <article style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, border: `1px solid ${palette.surface.line}`, borderRadius: 10 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: palette.ink.faint }}>
          <Avatar did={record.createdBy ?? record.author} size={18} />
          <span>
            {nameOf(record.createdBy, people)} asked · {ago(record.createdAt)}
          </span>
          {closed && <span style={{ ...styles.badge, marginLeft: 'auto' }}>Closed</span>}
        </div>
        <button onClick={onOpen} title="Open this poll" style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: 16, fontWeight: 600, color: palette.ink.strong, textAlign: 'left', wordBreak: 'break-word' }}>
          {question}
        </button>
      </header>

      <div role="group" aria-label="Options" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {options.map((option, i) => {
          const these = votes.filter((v) => v.body!.choice === i);
          const share = votes.length ? these.length / votes.length : 0;
          const chosen = mine?.body?.choice === i;
          return (
            <button
              key={i}
              onClick={() => (chosen ? onUnvote(mine!.key) : onVote(i))}
              disabled={!open}
              aria-pressed={chosen}
              title={these.length ? these.map((v) => nameOf(v.root, people)).join(', ') : undefined}
              style={{
                position: 'relative',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                height: 40,
                padding: '0 12px',
                border: `1px solid ${chosen ? palette.ink.strong : palette.surface.line}`,
                borderRadius: 8,
                background: palette.surface.card,
                font: 'inherit',
                fontSize: 14,
                color: palette.ink.body,
                textAlign: 'left',
                // A closed poll is still for reading, so it should not look greyed out.
                opacity: 1,
                cursor: open ? 'pointer' : 'default',
              }}
            >
              <span aria-hidden style={{ position: 'absolute', inset: 0, width: `${share * 100}%`, background: chosen ? palette.accent.soft : palette.surface.sunken, transition: 'width .3s ease' }} />
              <span aria-hidden style={{ position: 'relative', width: 14, height: 14, flexShrink: 0, borderRadius: 999, border: `1.5px solid ${chosen ? palette.ink.strong : palette.surface.lineStrong}`, background: chosen ? palette.ink.strong : 'none', boxShadow: chosen ? `inset 0 0 0 2px ${palette.surface.card}` : 'none' }} />
              <span style={{ position: 'relative', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: chosen ? 500 : 400 }}>{option}</span>
              <span style={{ position: 'relative', fontSize: 12, color: palette.ink.muted, fontVariantNumeric: 'tabular-nums' }}>
                {these.length} · {Math.round(share * 100)}%
              </span>
            </button>
          );
        })}
      </div>

      <footer style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: palette.ink.faint }}>
        <span>
          {votes.length} {votes.length === 1 ? 'vote' : 'votes'}
          {open && (mine ? ' · click your choice again to take it back' : ' · pick one')}
        </span>
        {asker && writable && (
          <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <button onClick={() => onClose(!closed)} data-variant="quiet" style={{ ...styles.smallButton, height: 28 }}>
              {closed ? 'Reopen' : 'Close poll'}
            </button>
            <button onClick={onDelete} data-variant="danger" style={{ ...styles.smallButton, height: 28, color: palette.accent.danger }}>
              Delete
            </button>
          </span>
        )}
      </footer>
    </article>
  );
}

/** A question and its options — two to start, more on demand, blanks dropped */
export function Ask({ onAsk, onCancel, initialQuestion = '' }: { onAsk: (question: string, options: string[]) => Promise<void>; onCancel: () => void; initialQuestion?: string }) {
  const [question, setQuestion] = useState(initialQuestion);
  const [options, setOptions] = useState(['', '']);
  const [busy, setBusy] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const ready = question.trim() && filled.length >= 2 && new Set(filled).size === filled.length;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        void onAsk(question.trim(), filled).finally(() => setBusy(false));
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16, border: `1px solid ${palette.surface.line}`, borderRadius: 10 }}
    >
      <input autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a question" aria-label="Question" style={styles.input} />
      {options.map((option, i) => (
        <input
          key={i}
          value={option}
          onChange={(e) => setOptions((was) => was.map((o, j) => (j === i ? e.target.value : o)))}
          placeholder={`Option ${i + 1}`}
          aria-label={`Option ${i + 1}`}
          style={styles.input}
        />
      ))}
      {filled.length !== new Set(filled).size && <p style={{ fontSize: 13, color: palette.accent.danger }}>Two options are the same.</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {options.length < MAX_OPTIONS && (
          <button type="button" onClick={() => setOptions((was) => [...was, ''])} data-variant="quiet" style={styles.smallButton}>
            + Add option
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onCancel} data-variant="quiet" style={styles.smallButton}>
          Cancel
        </button>
        <button type="submit" disabled={!ready || busy} data-variant="primary" style={{ ...styles.addButton, height: 32 }}>
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </div>
    </form>
  );
}
