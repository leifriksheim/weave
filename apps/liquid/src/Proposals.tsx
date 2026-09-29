import { useState } from 'react';
import { useNode } from '@weaveprotocol/core/react';
import { Modal } from '@weave/app-shared/Modal';
import type { Assembly, ProposalView } from './model';
import { CHOICES, proposal as proposalCollection, support, vote, type Choice, type Tally } from './schema';
import { accepted, turnout, type Count, type Outcome } from './tally';
import {
  CHOICE_LABEL,
  Empty,
  Meter,
  PartyChip,
  PathView,
  Problem,
  TopicChip,
  Upvote,
  Who,
  ago,
  useAction,
} from './ui';
import { palette, tone, hue } from './styles';

type Sort = 'top' | 'new' | 'closed';

export function Proposals({ a, writable }: { a: Assembly; writable: boolean }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('top');
  const [composing, setComposing] = useState(false);

  const opened = openKey ? a.proposals.find((p) => p.key === openKey) : undefined;
  if (opened) return <ProposalPage a={a} p={opened} writable={writable} onBack={() => setOpenKey(null)} />;

  const shown = a.proposals
    .filter((p) => (sort === 'closed' ? p.closed : !p.closed))
    .filter((p) => filter === null || p.topic === filter)
    .sort((x, y) =>
      sort === 'top'
        ? y.supporters.size - x.supporters.size || y.createdAt.localeCompare(x.createdAt)
        : y.createdAt.localeCompare(x.createdAt),
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="lq-toolbar" style={{ justifyContent: 'space-between' }}>
        <div role="group" aria-label="Sort" style={{ display: 'flex', gap: 4 }}>
          {(
            [
              ['top', 'Top'],
              ['new', 'New'],
              ['closed', 'Closed'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className="lq-chip"
              data-filter
              aria-pressed={sort === id}
              onClick={() => setSort(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {writable && (
          <button className="lq-btn" onClick={() => setComposing(true)}>
            New proposal
          </button>
        )}
      </div>

      {a.topics.length > 0 && (
        <div className="lq-scroll-x" role="group" aria-label="Topic">
          <button
            className="lq-chip"
            data-filter
            aria-pressed={filter === null}
            onClick={() => setFilter(null)}
          >
            All topics
          </button>
          {a.topics.map((t) => {
            const c = hue(t.hue);
            const on = filter === t.key;
            return (
              <button
                key={t.key}
                className="lq-chip"
                data-filter
                aria-pressed={on}
                onClick={() => setFilter(on ? null : t.key)}
                style={on ? { background: c.strong, borderColor: c.strong } : undefined}
              >
                <span className="lq-dot" style={{ background: on ? '#fff' : c.strong }} />
                {t.name}
              </button>
            );
          })}
        </div>
      )}

      {shown.length === 0 ? (
        <Empty title={sort === 'closed' ? 'Nothing closed yet' : 'No open proposals'}>
          {sort !== 'closed' && writable && (
            <>
              <p style={{ fontSize: 13.5 }}>
                Put something to the assembly. Anyone can support it, so the important ones rise.
              </p>
              <button className="lq-btn" data-variant="quiet" onClick={() => setComposing(true)}>
                Write a proposal
              </button>
            </>
          )}
        </Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.map((p, i) => (
            <ProposalCard
              key={p.key}
              a={a}
              p={p}
              writable={writable}
              index={i}
              onOpen={() => setOpenKey(p.key)}
            />
          ))}
        </div>
      )}

      {composing && (
        <Compose
          a={a}
          initialTopic={filter}
          onClose={() => setComposing(false)}
          onDone={(key) => {
            setComposing(false);
            setOpenKey(key);
          }}
        />
      )}
    </div>
  );
}

/** Supporting a proposal, or taking it back */
function useSupport(a: Assembly, p: ProposalView) {
  const node = useNode();
  const action = useAction();
  return {
    toggle: () =>
      void action.run(() =>
        p.mySupportKey
          ? node.records.delete(a.spaceId, p.mySupportKey)
          : node.records.put(a.spaceId, support, {}, { links: [{ rel: 'about', to: p.key }] }),
      ),
    busy: action.busy,
  };
}

function ProposalCard({
  a,
  p,
  writable,
  index,
  onOpen,
}: {
  a: Assembly;
  p: ProposalView;
  writable: boolean;
  index: number;
  onOpen: () => void;
}) {
  const supportIt = useSupport(a, p);
  const counted = a.countOf(p);
  const totals = p.closed && p.result ? p.result : counted.totals;
  const mine = counted.outcomes.get(a.me);
  const topic = a.topicOf(p.topic);

  return (
    <article
      className="lq-card lq-proposal lq-rise"
      data-interactive
      style={{ animationDelay: `${Math.min(index, 8) * 25}ms` }}
      onClick={onOpen}
      onKeyDown={(event) => event.key === 'Enter' && onOpen()}
      tabIndex={0}
      aria-label={p.title}
    >
      <Upvote
        count={p.supporters.size}
        pressed={p.mySupportKey !== null}
        disabled={!writable || supportIt.busy || p.closed}
        onToggle={supportIt.toggle}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}>
          {topic && <TopicChip topic={topic} />}
          <span className="lq-faint">
            {a.name(p.createdBy)} · {ago(p.createdAt)}
          </span>
          {p.closed && <Verdict tally={totals} />}
        </div>
        <h3
          style={{
            fontSize: 16,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: palette.ink.strong,
            lineHeight: 1.35,
            wordBreak: 'break-word',
          }}
        >
          {p.title}
        </h3>
        <Meter tally={totals} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12.5 }}>
          <Numbers tally={totals} />
          <span style={{ flex: 1 }} />
          {mine && writable && <MyVotePill outcome={mine} a={a} />}
        </div>
      </div>
    </article>
  );
}

function Numbers({ tally }: { tally: Tally }) {
  return (
    <span className="lq-num lq-muted" style={{ display: 'inline-flex', gap: 10, flexWrap: 'wrap' }}>
      <span>
        <b style={{ color: tone.for, fontWeight: 600 }}>{tally.for}</b> for
      </span>
      <span>
        <b style={{ color: tone.against, fontWeight: 600 }}>{tally.against}</b> against
      </span>
      {tally.abstain > 0 && <span>{tally.abstain} abstain</span>}
      <span className="lq-faint">{Math.round(turnout(tally) * 100)}% turnout</span>
    </span>
  );
}

function Verdict({ tally }: { tally: Tally }) {
  const yes = accepted(tally);
  return (
    <span
      className="lq-chip"
      style={{
        background: yes ? '#effaf2' : palette.accent.dangerSoft,
        borderColor: yes ? '#cfe9d6' : '#f5d9d7',
        color: yes ? tone.for : tone.against,
        fontWeight: 600,
      }}
    >
      {yes ? 'Accepted' : 'Rejected'}
    </span>
  );
}

/** Where your vote stands on a proposal, in a few words */
function MyVotePill({ outcome, a }: { outcome: Outcome; a: Assembly }) {
  const last = outcome.path.at(-1);
  const via = !last
    ? null
    : last.kind === 'person'
      ? a.name(last.did)
      : (a.partyOf(last.key)?.name ?? 'a party');
  if (!outcome.choice)
    return (
      <span className="lq-chip" style={{ color: palette.ink.muted }}>
        {outcome.how === 'unset' ? 'You haven’t voted' : 'Your vote isn’t counted'}
      </span>
    );
  return (
    <span className="lq-chip" style={{ borderColor: palette.surface.lineStrong }}>
      <span className="lq-dot" style={{ background: tone[outcome.choice] }} />
      {outcome.how === 'own'
        ? `You: ${CHOICE_LABEL[outcome.choice]}`
        : `${CHOICE_LABEL[outcome.choice]} via ${via}`}
    </span>
  );
}

function ProposalPage({
  a,
  p,
  writable,
  onBack,
}: {
  a: Assembly;
  p: ProposalView;
  writable: boolean;
  onBack: () => void;
}) {
  const node = useNode();
  const supportIt = useSupport(a, p);
  const action = useAction();
  const [closing, setClosing] = useState(false);
  const counted = a.countOf(p);
  const topic = a.topicOf(p.topic);
  const mayClose = writable && (p.createdBy === a.me || a.mayModerate);

  const cast = (choice: Choice) =>
    void action.run(() =>
      node.records.put(a.spaceId, vote, { choice }, { links: [{ rel: 'about', to: p.key }] }),
    );
  const takeBack = () =>
    void action.run(async () => p.myVoteKey && node.records.delete(a.spaceId, p.myVoteKey));
  const close = (result: Tally | null) =>
    void action.run(async () => {
      await node.records.update(a.spaceId, p.key, {
        title: p.title,
        ...(p.body ? { body: p.body } : {}),
        ...(result ? { closed: true, result } : {}),
      });
      setClosing(false);
    });

  return (
    <div className="lq-fade" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <button
        className="lq-btn"
        data-variant="ghost"
        onClick={onBack}
        style={{ alignSelf: 'flex-start', marginLeft: -8 }}
      >
        ← All proposals
      </button>
      <div className="lq-two">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 14 }}>
            <Upvote
              count={p.supporters.size}
              pressed={p.mySupportKey !== null}
              disabled={!writable || supportIt.busy || p.closed}
              onToggle={supportIt.toggle}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}
              >
                {topic && <TopicChip topic={topic} />}
                {p.closed && p.result && <Verdict tally={p.result} />}
              </div>
              <h1
                style={{
                  fontSize: 26,
                  fontWeight: 600,
                  letterSpacing: '-0.04em',
                  lineHeight: 1.2,
                  color: palette.ink.strong,
                  wordBreak: 'break-word',
                }}
              >
                {p.title}
              </h1>
              {p.createdBy && (
                <span
                  className="lq-faint"
                  style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <Who did={p.createdBy} a={a} size={18} /> · {ago(p.createdAt)}
                </span>
              )}
            </div>
          </div>
          {p.body && (
            <p
              style={{
                fontSize: 15,
                lineHeight: 1.65,
                color: palette.ink.body,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {p.body}
            </p>
          )}

          {!p.closed && writable && (
            <VotePanel a={a} p={p} counted={counted} busy={action.busy} onCast={cast} onTakeBack={takeBack} />
          )}
          <Problem>{action.error}</Problem>
          <Breakdown a={a} p={p} counted={counted} />
        </div>

        <aside className="lq-aside" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Results p={p} counted={counted} />
          {mayClose &&
            (p.closed ? (
              <button
                className="lq-btn"
                data-variant="quiet"
                disabled={action.busy}
                onClick={() => close(null)}
              >
                Reopen for voting
              </button>
            ) : (
              <button className="lq-btn" data-variant="quiet" onClick={() => setClosing(true)}>
                Close and record the result
              </button>
            ))}
        </aside>
      </div>

      {closing && (
        <Modal title="Close this proposal?" onClose={() => setClosing(false)} width={420}>
          <p className="lq-muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
            Voting stops, and the result is saved as your device counts it now:
          </p>
          <div className="lq-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Meter tally={counted.totals} size="lg" />
            <Numbers tally={counted.totals} />
            <p
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: accepted(counted.totals) ? tone.for : tone.against,
              }}
            >
              {accepted(counted.totals) ? 'Accepted' : 'Rejected'}
            </p>
          </div>
          <p className="lq-faint" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Everyone else’s device checks this against its own count, and shows it if they differ.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="lq-btn" data-variant="ghost" onClick={() => setClosing(false)}>
              Cancel
            </button>
            <button className="lq-btn" disabled={action.busy} onClick={() => close(counted.totals)}>
              Close proposal
            </button>
          </div>
          <Problem>{action.error}</Problem>
        </Modal>
      )}
    </div>
  );
}

/** Your vote: cast it, change it, or hand it back to whoever you trust */
function VotePanel({
  a,
  p,
  counted,
  busy,
  onCast,
  onTakeBack,
}: {
  a: Assembly;
  p: ProposalView;
  counted: Count;
  busy: boolean;
  onCast: (choice: Choice) => void;
  onTakeBack: () => void;
}) {
  const mine = counted.outcomes.get(a.me);
  const own = p.votes.get(a.me) ?? null;
  const topic = a.topicOf(p.topic);
  const trusted = a.mine.find((d) => d.topic === p.topic) ?? a.mine.find((d) => d.topic === '*');

  return (
    <section className="lq-card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <p className="lq-section-title" style={{ fontSize: 15 }}>
          Your vote
        </p>
        {own && (
          <button className="lq-link lq-muted" style={{ fontSize: 13 }} onClick={onTakeBack} disabled={busy}>
            {trusted ? 'Let my delegate decide' : 'Take back my vote'}
          </button>
        )}
      </div>
      <div className="lq-votes" role="group" aria-label="Cast your vote">
        {CHOICES.map((choice) => {
          const pressed = mine?.choice === choice && mine.how === 'own';
          const following = mine?.choice === choice && mine.how === 'followed';
          return (
            <button
              key={choice}
              className="lq-vote"
              data-choice={choice}
              aria-pressed={pressed}
              disabled={busy}
              onClick={() => onCast(choice)}
              style={following ? { borderColor: tone[choice], borderStyle: 'dashed' } : undefined}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className="lq-dot" style={{ background: pressed ? '#fff' : tone[choice] }} />
                {CHOICE_LABEL[choice]}
              </span>
              <small>{pressed ? 'Your vote' : following ? 'Via your delegate' : ' '}</small>
            </button>
          );
        })}
      </div>
      {mine && <OutcomeNote outcome={mine} a={a} topicName={topic?.name ?? null} />}
    </section>
  );
}

/** What happened to your vote, in words */
function OutcomeNote({ outcome, a, topicName }: { outcome: Outcome; a: Assembly; topicName: string | null }) {
  const on = topicName ? `on ${topicName}` : 'on this';
  switch (outcome.how) {
    case 'own':
      return (
        <p className="lq-muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
          Your own vote counts here, whoever you trust. You can change it until the proposal closes.
        </p>
      );
    case 'followed':
      return (
        <div className="lq-note">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <PathView outcome={outcome} a={a} from={a.me} />
            <span>
              Your vote goes {outcome.choice ? <b>{CHOICE_LABEL[outcome.choice].toLowerCase()}</b> : null}{' '}
              through who you trust. Vote yourself to override it for this proposal only.
            </span>
          </div>
        </div>
      );
    case 'unset':
      return (
        <p className="lq-muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
          You haven’t voted, and you don’t trust anyone {on}, so your vote isn’t counted yet. Set that up
          under <b>Your vote</b>.
        </p>
      );
    case 'loop':
      return (
        <div className="lq-note" data-tone="warn">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <PathView outcome={outcome} a={a} from={a.me} />
            <span>
              These delegations loop back round, so nobody on it votes. Vote yourself, or trust someone else.
            </span>
          </div>
        </div>
      );
    case 'stopped':
      return (
        <div className="lq-note" data-tone="warn">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <PathView outcome={outcome} a={a} from={a.me} />
            <span>
              Your vote stops with someone who hasn’t voted or trusted anyone {on}, or who has left. It isn’t
              counted yet.
            </span>
          </div>
        </div>
      );
    case 'undecided':
      return (
        <div className="lq-note" data-tone="warn">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <PathView outcome={outcome} a={a} from={a.me} />
            <span>The party hasn’t decided: its members are tied, or none has voted yet.</span>
          </div>
        </div>
      );
  }
}

/** The count, and for a closed proposal whether this device agrees with the one saved */
function Results({ p, counted }: { p: ProposalView; counted: Count }) {
  const shown = p.closed && p.result ? p.result : counted.totals;
  const same =
    p.result !== null &&
    (['for', 'against', 'abstain', 'uncast'] as const).every((k) => p.result?.[k] === counted.totals[k]);
  const direct = [...counted.outcomes.values()].filter((o) => o.how === 'own').length;
  const delegated = [...counted.outcomes.values()].filter((o) => o.how === 'followed').length;
  return (
    <section className="lq-card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <p className="lq-section-title">{p.closed ? 'Result' : 'Standing now'}</p>
        <span className="lq-faint lq-num" style={{ fontSize: 12 }}>
          {Math.round(turnout(shown) * 100)}% turnout
        </span>
      </div>
      <Meter tally={shown} size="lg" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {CHOICES.map((c) => (
          <div key={c}>
            <p
              className="lq-num"
              style={{
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: '-0.03em',
                color: c === 'abstain' ? palette.ink.body : tone[c],
              }}
            >
              {shown[c]}
            </p>
            <p className="lq-faint" style={{ fontSize: 12 }}>
              {CHOICE_LABEL[c]}
            </p>
          </div>
        ))}
      </div>
      {!p.closed && (
        <p className="lq-muted lq-num" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          {direct} voted themselves, {delegated} through someone they trust, {shown.uncast} not counted.
          {accepted(shown) ? ' It would pass now.' : ' It wouldn’t pass now.'}
        </p>
      )}
      {p.closed && p.result && (
        <div className="lq-note" data-tone={same ? 'good' : 'warn'} style={{ fontSize: 12.5 }}>
          {same
            ? '✓ Your device counts the same.'
            : `Your device counts ${counted.totals.for} for and ${counted.totals.against} against now. Votes changed after it closed, or hadn’t reached the closer.`}
        </div>
      )}
    </section>
  );
}

/** Who cast the votes: the people and parties that voted, and how many each carried */
function Breakdown({ a, p, counted }: { a: Assembly; p: ProposalView; counted: Count }) {
  const people = [...p.votes]
    .filter(([did]) => counted.outcomes.has(did))
    .map(([did, choice]) => ({ did, choice, carried: counted.carried.get(did) ?? 1 }))
    .sort((x, y) => y.carried - x.carried);
  const parties = a.parties
    .map((party) => ({
      party,
      choice: counted.parties.get(party.key) ?? null,
      carried: counted.carried.get(party.key) ?? 0,
    }))
    .filter((x) => x.carried > 0);
  const missing = [...counted.outcomes.values()].filter((o) => !o.choice);
  const loops = missing.filter((o) => o.how === 'loop').length;

  if (people.length === 0 && parties.length === 0)
    return (
      <p className="lq-faint" style={{ fontSize: 13 }}>
        Nobody has voted yet.
      </p>
    );

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p className="lq-section-title">How the votes came in</p>
      <div className="lq-card">
        {parties.map(({ party, choice, carried }) => (
          <div key={party.key} className="lq-row">
            <PartyChip party={party} />
            <span className="lq-faint" style={{ fontSize: 12.5 }}>
              for {carried} {carried === 1 ? 'person' : 'people'} who trust it
            </span>
            <span style={{ flex: 1 }} />
            {choice && <ChoicePill choice={choice} />}
          </div>
        ))}
        {people.map(({ did, choice, carried }) => (
          <div key={did} className="lq-row">
            <Who did={did} a={a} />
            {carried > 1 && (
              <span className="lq-chip" title={`${carried - 1} people’s votes follow theirs`}>
                +{carried - 1}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <ChoicePill choice={choice} />
          </div>
        ))}
      </div>
      {missing.length > 0 && (
        <p className="lq-faint" style={{ fontSize: 12.5 }}>
          {missing.length} not counted{loops ? `, ${loops} of them in a loop of delegations` : ''}.
        </p>
      )}
    </section>
  );
}

function ChoicePill({ choice }: { choice: Choice }) {
  return (
    <span
      className="lq-chip"
      style={{ fontWeight: 600, color: choice === 'abstain' ? palette.ink.muted : tone[choice] }}
    >
      <span className="lq-dot" style={{ background: tone[choice] }} />
      {CHOICE_LABEL[choice]}
    </span>
  );
}

function Compose({
  a,
  initialTopic,
  onClose,
  onDone,
}: {
  a: Assembly;
  initialTopic: string | null;
  onClose: () => void;
  onDone: (key: string) => void;
}) {
  const node = useNode();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [topicKey, setTopicKey] = useState<string | null>(initialTopic ?? a.topics[0]?.key ?? null);
  const action = useAction();
  return (
    <Modal title="New proposal" onClose={onClose} width={560}>
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          void action.run(async () => {
            const made = await node.records.put(
              a.spaceId,
              proposalCollection,
              { title: title.trim(), ...(body.trim() ? { body: body.trim() } : {}) },
              topicKey ? { links: [{ rel: 'topic', to: topicKey }] } : {},
            );
            onDone(made.key);
          });
        }}
      >
        <label className="lq-label">
          What should the assembly decide?
          <input
            className="lq-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Install bike racks by the entrance"
            maxLength={200}
            autoFocus
          />
        </label>
        {a.topics.length > 0 && (
          <div>
            <p className="lq-label" style={{ marginBottom: 8 }}>
              Topic
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {a.topics.map((t) => {
                const c = hue(t.hue);
                const on = topicKey === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    className="lq-chip"
                    data-filter
                    aria-pressed={on}
                    onClick={() => setTopicKey(on ? null : t.key)}
                    style={on ? { background: c.soft, borderColor: c.strong, color: c.strong } : undefined}
                  >
                    <span className="lq-dot" style={{ background: c.strong }} />
                    {t.name}
                  </button>
                );
              })}
            </div>
            <p className="lq-faint" style={{ fontSize: 12, marginTop: 8 }}>
              Votes of people who don’t vote themselves go to whoever they trust with this topic.
            </p>
          </div>
        )}
        <label className="lq-label">
          Details
          <textarea
            className="lq-textarea"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Why it matters, what it costs, what happens if it passes."
            maxLength={20000}
          />
        </label>
        <Problem>{action.error}</Problem>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="lq-btn" data-variant="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="lq-btn" disabled={!title.trim() || action.busy}>
            {action.busy ? 'Proposing…' : 'Propose'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
