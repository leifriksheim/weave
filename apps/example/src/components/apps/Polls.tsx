import { useState } from 'react';
import { useAccount, useCan, useLive, useNode, useProfiles } from '@weaveprotocol/core/react';
import type { IncludedOf, QueryRecord } from '@weaveprotocol/core';
import { poll, vote, type Poll } from '@weaveprotocol/core/schemas';
import { nameOf, peopleFrom, respondingTo } from '../../derive/people';
import { styles, palette, ui } from '../../styles';
import type { AppProps } from './index';
import { OptionBar, OptionCard, OptionsForm } from './options';

/** `std.poll` and `std.vote`: one vote per person per poll, so voting again changes it. */
export function Polls({ space, onOpen }: AppProps) {
  const node = useNode();
  const mayAsk = useCan(space.id, 'create', poll.name);
  const [asking, setAsking] = useState(false);

  const polls = useLive(
    space.id,
    async () =>
      (
        await node.records.query(space.id, {
          collection: poll,
          sort: { '@createdAt': 'desc' },
          include: withVotes,
        })
      ).records,
    [],
  );

  return (
    <div style={{ ...ui.stack, gap: 16, maxWidth: 640 }}>
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
      {polls?.length === 0 && !asking && (
        <div style={styles.emptyState}>No polls yet.{mayAsk ? ' Ask the space something.' : ''}</div>
      )}
      {polls?.map((p) => (
        <PollView key={p.key} space={space} record={p} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** Include this with a poll to get what {@link PollView} needs: its votes */
export const withVotes = { votes: { rel: 'about', from: vote } } as const;

/** A poll, as a query with {@link withVotes} gives it */
export type PollWithVotes = QueryRecord<Poll, IncludedOf<typeof withVotes>>;

/** One poll, ready to vote on, in this app's list or shared into a chat */
export function PollView({
  space,
  record,
  onOpen,
}: {
  space: AppProps['space'];
  record: PollWithVotes;
  onOpen: AppProps['onOpen'];
}) {
  const node = useNode();
  const { did: me } = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  const { question, options, closed } = record.body;
  // Only votes for an option that exists count — a vote from a buggy app for option 7 of 2 is ignored.
  const votes = record.included.votes.filter((v) => v.body.choice < options.length);
  const mine = votes.find((v) => v.root === me);
  const open = space.writable && !closed;
  const small = { ...styles.smallButton, height: 28 };

  return (
    <OptionCard
      record={record}
      verb="asked"
      badge={!!closed && 'Closed'}
      title={question}
      open="Open this poll"
      onOpen={() => onOpen(record)}
    >
      <div role="group" aria-label="Options" style={{ ...ui.stack, gap: 6 }}>
        {options.map((option, i) => {
          const these = votes.filter((v) => v.body.choice === i);
          const share = votes.length ? these.length / votes.length : 0;
          const chosen = mine?.body.choice === i;
          return (
            <OptionBar
              key={i}
              label={option}
              count={`${these.length} · ${Math.round(share * 100)}%`}
              share={share}
              chosen={chosen}
              radio
              clickable={open}
              voters={these.map((v) => nameOf(v.root, people))}
              onClick={() =>
                void (mine && chosen
                  ? node.records.delete(space.id, mine.key)
                  : node.records.put(
                      space.id,
                      vote.name,
                      { choice: i, ...respondingTo(record.root, me) },
                      { links: [{ rel: 'about', to: record.key }] },
                    ))
              }
            />
          );
        })}
      </div>

      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          fontSize: 12,
          color: palette.ink.faint,
        }}
      >
        <span>
          {votes.length} {votes.length === 1 ? 'vote' : 'votes'}
          {open && (mine ? ' · click your choice again to take it back' : ' · pick one')}
        </span>
        {record.createdBy === me && space.writable && (
          <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <button
              onClick={() =>
                void node.records.update(space.id, record.key, { ...record.body, closed: !closed })
              }
              data-variant="quiet"
              style={small}
            >
              {closed ? 'Reopen' : 'Close poll'}
            </button>
            <button
              onClick={() => void node.records.delete(space.id, record.key)}
              data-variant="danger"
              style={{ ...small, color: palette.accent.danger }}
            >
              Delete
            </button>
          </span>
        )}
      </footer>
    </OptionCard>
  );
}

/** A question and its options — two to start, more on demand, blanks dropped */
export function Ask({
  onAsk,
  onCancel,
  initialQuestion = '',
}: {
  onAsk: (question: string, options: string[]) => Promise<void>;
  onCancel: () => void;
  initialQuestion?: string;
}) {
  return (
    <OptionsForm
      initialTitle={initialQuestion}
      placeholder="Ask a question"
      label="Question"
      submit="Ask"
      submitting="Asking…"
      onSubmit={onAsk}
      onCancel={onCancel}
    />
  );
}
