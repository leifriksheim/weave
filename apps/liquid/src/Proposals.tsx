import { useState, type ReactNode } from 'react';
import { useNode } from '@weaveprotocol/core/react';
import { Modal } from '@weave/app-shared/Modal';
import type { Assembly, ProposalView, RollView } from './model';
import {
  CHOICES,
  MAX_CITED,
  MAX_VOTERS,
  proposal as proposalCollection,
  support,
  vote,
  type Choice,
} from './schema';
import {
  RULES,
  majority,
  needed,
  ruleName,
  trail,
  type Next,
  type PartyStand,
  type Result,
  type RuleId,
  type Step,
  type Tally,
} from './tally';
import {
  CHOICE_LABEL,
  Empty,
  Meter,
  PartyChip,
  PathView,
  Problem,
  TopicChip,
  TopicPicker,
  Upvote,
  Who,
  ago,
} from './ui';
import { useAction } from '@weave/app-shared/action';
import { palette, tone } from './styles';

type Sort = 'top' | 'new' | 'decided';

export function Proposals({ a, writable }: { a: Assembly; writable: boolean }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('top');
  const [composing, setComposing] = useState(false);

  const opened = openKey ? a.proposals.find((p) => p.key === openKey) : undefined;
  if (opened) return <ProposalPage a={a} p={opened} writable={writable} onBack={() => setOpenKey(null)} />;

  const shown = a.proposals
    .filter((p) => (sort === 'decided' ? p.result !== 'open' : p.result === 'open'))
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
              ['decided', 'Decided'],
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
          <TopicPicker
            topics={a.topics}
            solid
            on={(t) => filter === t.key}
            onToggle={(t) => setFilter(filter === t.key ? null : t.key)}
          />
        </div>
      )}

      {shown.length === 0 ? (
        <Empty title={sort === 'decided' ? 'Nothing decided yet' : 'No open proposals'}>
          {sort !== 'decided' && writable && (
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
  const totals = a.countOf(p);
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
        disabled={!writable || supportIt.busy || p.result !== 'open'}
        onToggle={supportIt.toggle}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}>
          {topic && <TopicChip topic={topic} />}
          <span className="lq-faint">
            {a.name(p.createdBy)} · {ago(p.createdAt)}
          </span>
          <Verdict result={p.result} />
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
          {writable && <MyVotePill a={a} p={p} />}
        </div>
      </div>
    </article>
  );
}

function Numbers({ tally }: { tally: Tally }) {
  const voters = tally.for + tally.against + tally.abstain + tally.uncast;
  return (
    <span className="lq-num lq-muted" style={{ display: 'inline-flex', gap: 10, flexWrap: 'wrap' }}>
      <span>
        <b style={{ color: tone.for, fontWeight: 600 }}>{tally.for}</b> for
      </span>
      <span>
        <b style={{ color: tone.against, fontWeight: 600 }}>{tally.against}</b> against
      </span>
      {tally.abstain > 0 && <span>{tally.abstain} abstain</span>}
      <span className="lq-faint">
        of {voters} {voters === 1 ? 'voter' : 'voters'}
      </span>
    </span>
  );
}

const VERDICT: Readonly<
  Record<Exclude<Result, 'open'>, { label: string; color: string; bg: string; line: string }>
> = {
  passed: { label: 'Passed', color: tone.for, bg: '#effaf2', line: '#cfe9d6' },
  rejected: { label: 'Rejected', color: tone.against, bg: palette.accent.dangerSoft, line: '#f5d9d7' },
  disputed: { label: 'Disputed', color: '#9a6700', bg: '#fff8e6', line: '#f1dfa6' },
};

function Verdict({ result }: { result: Result }) {
  if (result === 'open') return null;
  const v = VERDICT[result];
  return (
    <span
      className="lq-chip"
      style={{ background: v.bg, borderColor: v.line, color: v.color, fontWeight: 600 }}
    >
      {v.label}
    </span>
  );
}

/** Where your vote stands on a proposal, in a few words */
function MyVotePill({ a, p }: { a: Assembly; p: ProposalView }) {
  const mine = p.votes.get(a.me);
  if (!p.voters.includes(a.me))
    return (
      <span className="lq-chip" style={{ color: palette.ink.muted }}>
        Not a voter
      </span>
    );
  if (!mine)
    return (
      <span className="lq-chip" style={{ color: palette.ink.muted }}>
        {p.result === 'open' ? 'You haven’t voted' : 'You didn’t vote'}
      </span>
    );
  const last = trail(a.me, p.votes)[0];
  const via = !last
    ? null
    : last.kind === 'person'
      ? a.name(last.did)
      : (a.partyOf(last.key)?.name ?? 'a party');
  return (
    <span className="lq-chip" style={{ borderColor: palette.surface.lineStrong }}>
      <span className="lq-dot" style={{ background: tone[mine.choice] }} />
      {via ? `${CHOICE_LABEL[mine.choice]} via ${via}` : `You: ${CHOICE_LABEL[mine.choice]}`}
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
  const [confirming, setConfirming] = useState<Choice | null>(null);
  const topic = a.topicOf(p.topic);

  const cast = (choice: Choice) =>
    void action.run(async () => {
      await node.records.put(a.spaceId, vote, { choice }, { links: [{ rel: 'about', to: p.key }] });
      setConfirming(null);
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
              disabled={!writable || supportIt.busy || p.result !== 'open'}
              onToggle={supportIt.toggle}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}
              >
                {topic && <TopicChip topic={topic} />}
                <Verdict result={p.result} />
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

          {p.result === 'disputed' && <Disputes a={a} p={p} />}
          {writable && <VotePanel a={a} p={p} busy={action.busy} onPick={setConfirming} />}
          <Problem>{action.error}</Problem>
          <PartyStands a={a} p={p} />
          <Breakdown a={a} p={p} />
        </div>

        <aside className="lq-aside" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Results a={a} p={p} />
        </aside>
      </div>

      {confirming && (
        <Modal
          title={`Vote ${CHOICE_LABEL[confirming].toLowerCase()}?`}
          onClose={() => setConfirming(null)}
          width={420}
        >
          <p className="lq-muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
            Votes are final. Once cast, you can’t change it or take it back, so that a result, once reached,
            stays reached on every device.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="lq-btn" data-variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button className="lq-btn" disabled={action.busy} onClick={() => cast(confirming)}>
              Vote {CHOICE_LABEL[confirming].toLowerCase()}
            </button>
          </div>
          <Problem>{action.error}</Problem>
        </Modal>
      )}
    </div>
  );
}

/** Your vote: cast it, see the one you cast, or see whom your device will follow */
function VotePanel({
  a,
  p,
  busy,
  onPick,
}: {
  a: Assembly;
  p: ProposalView;
  busy: boolean;
  onPick: (choice: Choice) => void;
}) {
  const mine = p.votes.get(a.me) ?? null;
  const voter = p.voters.includes(a.me);
  const topic = a.topicOf(p.topic);

  if (p.voters.length === 0)
    return (
      <div className="lq-note" data-tone="warn">
        This proposal was made with an older Liquid, before proposals listed their voters, so it can’t be
        decided.
      </div>
    );
  if (!voter)
    return (
      <div className="lq-note">
        You’re not one of its {p.voters.length} voters. They were picked from the members when it was
        proposed, and stay fixed.
      </div>
    );

  return (
    <section className="lq-card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p className="lq-section-title" style={{ fontSize: 15 }}>
        Your vote
      </p>
      <div className="lq-votes" role="group" aria-label="Cast your vote">
        {CHOICES.map((choice) => {
          const pressed = mine?.choice === choice;
          return (
            <button
              key={choice}
              className="lq-vote"
              data-choice={choice}
              aria-pressed={pressed}
              disabled={busy || mine !== null || p.result !== 'open'}
              onClick={() => onPick(choice)}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className="lq-dot" style={{ background: pressed ? '#fff' : tone[choice] }} />
                {CHOICE_LABEL[choice]}
              </span>
              <small>{pressed ? (mine?.via ? 'Followed' : 'Your vote') : ' '}</small>
            </button>
          );
        })}
      </div>
      {mine ? (
        <CastNote a={a} p={p} />
      ) : p.result !== 'open' ? (
        <SettledNote next={a.nextFor(p)} />
      ) : (
        <NextNote a={a} next={a.nextFor(p)} topicName={topic?.name ?? null} />
      )}
    </section>
  );
}

/** A vote's way, and a sentence about it */
function PathNote({
  a,
  path,
  warn,
  children,
}: {
  a: Assembly;
  path: ReadonlyArray<Step>;
  warn?: boolean;
  children: string;
}) {
  return (
    <div className="lq-note" data-tone={warn ? 'warn' : undefined}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <PathView path={path} a={a} from={a.me} />
        <span>{children}</span>
      </div>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="lq-muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
      {children}
    </p>
  );
}

/** The vote you cast, and the way it came */
function CastNote({ a, p }: { a: Assembly; p: ProposalView }) {
  const path = trail(a.me, p.votes);
  if (path.length === 0) return <Quiet>You voted yourself. It’s final.</Quiet>;
  return (
    <PathNote a={a} path={path}>
      Your device cast this for you, following who you trust. It’s final.
    </PathNote>
  );
}

/** Settled before you voted: your device may still follow, for the record, but nothing changes it */
function SettledNote({ next }: { next: Next }) {
  if (next.kind === 'cast')
    return (
      <Quiet>
        It was settled before your vote arrived. Your device is casting{' '}
        {CHOICE_LABEL[next.choice].toLowerCase()} for you, following who you trust, so the record shows where
        you stood. It doesn’t change the result.
      </Quiet>
    );
  return <Quiet>It was settled before you voted. Votes cast now don’t change it.</Quiet>;
}

/** What your device will do, in words */
function NextNote({ a, next, topicName }: { a: Assembly; next: Next; topicName: string | null }) {
  if (next.kind === 'cast')
    return (
      <Quiet>
        Your device is casting {CHOICE_LABEL[next.choice].toLowerCase()} for you, following who you trust.
      </Quiet>
    );
  if (next.how === 'unset')
    return (
      <Quiet>
        You don’t trust anyone {topicName ? `on ${topicName}` : 'on this'}, so nobody votes for you. Set that
        up under <b>Your vote</b>.
      </Quiet>
    );
  return (
    <PathNote a={a} path={next.path} warn={next.how !== 'waiting'}>
      {NEXT_SAYS[next.how]}
    </PathNote>
  );
}

const NEXT_SAYS = {
  waiting:
    'When they vote, your device casts the same vote for you, unless you vote first. Liquid has to be open on one of your devices for that.',
  loop: 'These delegations loop back round, so unless someone on it votes themselves, nobody does. Vote yourself, or trust someone else.',
  stopped: 'It reaches someone who doesn’t vote on this proposal, so nobody votes for you.',
  disputed: 'The party said two different things about who its members are here, so nobody follows it.',
};

/** Who said two things, and what that means */
function Disputes({ a, p }: { a: Assembly; p: ProposalView }) {
  return (
    <div className="lq-note" data-tone="warn" style={{ fontSize: 13, lineHeight: 1.55 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span>
          <b>Disputed.</b> Someone signed two different versions of something this proposal counts. Every
          device shows it as disputed, whatever the count says:
        </span>
        {p.conflicts.map((c) => (
          <span
            key={c.record}
            style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
          >
            {c.voter ? (
              <>
                <Who did={c.voter} a={a} size={18} /> voted two ways.
              </>
            ) : c.party && a.partyOf(c.party) ? (
              <>
                <PartyChip party={a.partyOf(c.party)!} /> froze two different member lists.
              </>
            ) : (
              'A vote or a party’s members, written two ways.'
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The count among the proposal's voters, and what it needs */
function Results({ a, p }: { a: Assembly; p: ProposalView }) {
  const shown = a.countOf(p);
  const coming = a.comingOf(p);
  const voters = p.voters.length;
  const need = needed(shown, p.toPass);
  const followed = [...p.votes.values()].filter((v) => v.via).length;
  const own = p.votes.size - followed;
  const comingCount = coming.for + coming.against + coming.abstain;
  return (
    <section className="lq-card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <p className="lq-section-title">{p.result === 'open' ? 'Standing now' : 'Result'}</p>
        <span className="lq-faint lq-num" style={{ fontSize: 12 }}>
          {voters} {voters === 1 ? 'voter' : 'voters'}, as of {ago(p.createdAt)}
        </span>
      </div>
      <div className="lq-muted lq-num" style={{ fontSize: 12.5 }}>
        To pass:{' '}
        <b>
          {p.toPass} of {voters}
        </b>{' '}
        for{ruleName(p.toPass, voters) && ` (${ruleName(p.toPass, voters)?.toLowerCase()})`}
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
      <p className="lq-muted lq-num" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
        {own} voted themselves, {followed} by following someone, {shown.uncast} not yet.
        {comingCount > 0 && ` ${comingCount} more will follow once their devices are online.`}
      </p>
      {p.result === 'open' && voters > 0 && (
        <p className="lq-muted lq-num" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Passes with {need.toPass} more for. Fails with {need.toFail} more against or abstaining. Until one
          of those happens it stays open: there’s no deadline.
        </p>
      )}
      {p.result === 'passed' || p.result === 'rejected' ? (
        <div className="lq-note" data-tone="good" style={{ fontSize: 12.5 }}>
          ✓ Settled, with a proof every device checks. No later vote can change it.
        </div>
      ) : null}
    </section>
  );
}

/** Where each party stands on it, and how far it is from a position, by the rule its roll froze */
function PartyStands({ a, p }: { a: Assembly; p: ProposalView }) {
  const rolls = [...p.rolls].flatMap(([key, roll]) => {
    const party = a.partyOf(key);
    return party ? [{ party, roll, stand: p.stands.get(key) ?? null }] : [];
  });
  if (rolls.length === 0) return null;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p className="lq-section-title">Parties</p>
      <div className="lq-card">
        {rolls.map(({ party, roll, stand }) => (
          <div key={party.key} className="lq-row" style={{ flexWrap: 'wrap' }}>
            <PartyChip party={party} />
            <span className="lq-faint lq-num" style={{ fontSize: 12.5 }}>
              {standText(a, roll, stand, p.votes)}
            </span>
            <span style={{ flex: 1 }} />
            {stand && stand !== 'disputed' && <ChoicePill choice={stand} />}
          </div>
        ))}
      </div>
    </section>
  );
}

function standText(a: Assembly, roll: RollView, stand: PartyStand, votes: ProposalView['votes']): string {
  if (stand === 'disputed') return 'disputed';
  const rep = roll.decides.representative;
  if (rep !== undefined) return stand ? `as ${a.name(rep)} voted` : `waiting for ${a.name(rep)} to vote`;
  const n = new Set(roll.members).size;
  if (stand) return `${roll.decides.toTake} of its ${n} members agreed`;
  const own = roll.members.flatMap((did) => {
    const v = votes.get(did);
    return v && v.via === null ? [v.choice] : [];
  });
  const most = Math.max(0, ...CHOICES.map((c) => own.filter((x) => x === c).length));
  return `${most} of the ${roll.decides.toTake} it needs agree so far, of ${n} members`;
}

/** Who voted, and through whom */
function Breakdown({ a, p }: { a: Assembly; p: ProposalView }) {
  const rows = [...p.votes]
    .filter(([did]) => p.voters.includes(did))
    .map(([did, cast]) => ({ did, cast, path: trail(did, p.votes) }))
    .sort((x, y) => x.path.length - y.path.length || a.name(x.did).localeCompare(a.name(y.did)));

  if (rows.length === 0)
    return (
      <p className="lq-faint" style={{ fontSize: 13 }}>
        Nobody has voted yet.
      </p>
    );

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p className="lq-section-title">How the votes came in</p>
      <div className="lq-card">
        {rows.map(({ did, cast, path }) => (
          <div key={did} className="lq-row" style={{ flexWrap: 'wrap' }}>
            {path.length > 0 ? <PathView path={path} a={a} from={did} /> : <Who did={did} a={a} />}
            <span style={{ flex: 1 }} />
            <ChoicePill choice={cast.choice} />
          </div>
        ))}
      </div>
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
  // People vote unless left out; bots only when added. Kept as changes, so a bot list that loads late still applies.
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [rule, setRule] = useState<RuleId | 'custom'>('majority');
  const [custom, setCustom] = useState(1);
  const action = useAction();

  const byName = (x: string, y: string) =>
    x === a.me ? -1 : y === a.me ? 1 : a.name(x).localeCompare(a.name(y));
  const people = a.members
    .map((m) => m.did)
    .filter((did) => !a.bots.has(did))
    .sort(byName);
  const bots = a.members
    .map((m) => m.did)
    .filter((did) => a.bots.has(did))
    .sort(byName);
  const picks = (did: string) => (a.bots.has(did) ? added.has(did) : !left.has(did));
  const voters = a.members
    .map((m) => m.did)
    .filter(picks)
    .sort();
  const n = voters.length;
  // An assembly made before proposals set their rule takes more than half.
  const toPass = !a.current
    ? majority(n)
    : rule === 'custom'
      ? Math.min(Math.max(1, custom), n)
      : (RULES.find((r) => r.id === rule)?.toPass(n) ?? majority(n));
  const problem =
    n === 0
      ? 'Pick at least one voter.'
      : n > MAX_VOTERS
        ? `A proposal can have at most ${MAX_VOTERS} voters for now.`
        : toPass > MAX_CITED || n - toPass + 1 > MAX_CITED
          ? `With this many voters, a rule must settle it with at most ${MAX_CITED} votes either way.`
          : null;

  const toggle = (did: string) => {
    const flip = (set: ReadonlySet<string>) => {
      const next = new Set(set);
      if (!next.delete(did)) next.add(did);
      return next;
    };
    if (a.bots.has(did)) setAdded(flip);
    else setLeft(flip);
  };

  return (
    <Modal title="New proposal" onClose={onClose} width={560}>
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim() || problem) return;
          void action.run(async () => {
            const made = await node.records.put(
              a.spaceId,
              proposalCollection,
              {
                title: title.trim(),
                ...(body.trim() ? { body: body.trim() } : {}),
                voters,
                ...(a.current ? { toPass } : {}),
              },
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
              <TopicPicker
                topics={a.topics}
                on={(t) => topicKey === t.key}
                onToggle={(t) => setTopicKey(topicKey === t.key ? null : t.key)}
              />
            </div>
            <p className="lq-faint" style={{ fontSize: 12, marginTop: 8 }}>
              People who don’t vote themselves follow whoever they trust with this topic.
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

        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <p className="lq-label">
              Who votes · {n} of {a.members.length}
            </p>
            <span style={{ display: 'inline-flex', gap: 4 }}>
              <button
                type="button"
                className="lq-btn"
                data-variant="ghost"
                data-size="sm"
                onClick={() => {
                  setLeft(new Set());
                  setAdded(new Set());
                }}
              >
                Everyone but bots
              </button>
              <button
                type="button"
                className="lq-btn"
                data-variant="ghost"
                data-size="sm"
                onClick={() => {
                  setLeft(new Set(people));
                  setAdded(new Set());
                }}
              >
                Nobody
              </button>
            </span>
          </div>
          <div className="lq-card" style={{ marginTop: 8, maxHeight: 240, overflowY: 'auto' }}>
            {people.map((did) => (
              <VoterRow key={did} a={a} did={did} on={picks(did)} onToggle={() => toggle(did)} />
            ))}
            {bots.length > 0 && (
              <p className="lq-row lq-faint" style={{ fontSize: 12, padding: '8px 16px' }}>
                Bots don’t vote unless you add them.
              </p>
            )}
            {bots.map((did) => (
              <VoterRow key={did} a={a} did={did} bot on={picks(did)} onToggle={() => toggle(did)} />
            ))}
          </div>
          <p className="lq-faint" style={{ fontSize: 12, marginTop: 8 }}>
            Fixed once proposed. People who join later vote on later proposals.
          </p>
        </div>

        <div>
          <p className="lq-label" style={{ marginBottom: 8 }}>
            What it takes to pass
          </p>
          {a.current ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="group" aria-label="Rule">
              {RULES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="lq-chip"
                  data-filter
                  aria-pressed={rule === r.id}
                  onClick={() => setRule(r.id)}
                >
                  {r.label}
                </button>
              ))}
              <button
                type="button"
                className="lq-chip"
                data-filter
                aria-pressed={rule === 'custom'}
                onClick={() => {
                  setCustom(toPass);
                  setRule('custom');
                }}
              >
                A number
              </button>
              {rule === 'custom' && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input
                    className="lq-input"
                    type="number"
                    min={1}
                    max={Math.max(1, n)}
                    value={custom}
                    onChange={(event) => setCustom(Math.round(Number(event.target.value)) || 1)}
                    style={{ width: 72, height: 30 }}
                    aria-label="Votes for it needs"
                  />
                  <span className="lq-muted">of {n}</span>
                </span>
              )}
            </div>
          ) : (
            <p className="lq-faint" style={{ fontSize: 12.5 }}>
              More than half. Update this assembly to pick another rule.
            </p>
          )}
          {n > 0 && (
            <p className="lq-muted lq-num" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>
              Passes once {toPass} of the {n} {n === 1 ? 'voter votes' : 'voters vote'} for. Fails once{' '}
              {n - toPass + 1} vote against or abstain, since it can no longer pass. Until then it stays open:
              there’s no deadline.
              {toPass * 2 <= n && ' Fewer than half can pass it.'}
            </p>
          )}
        </div>

        <Problem>{problem ?? action.error}</Problem>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="lq-btn" data-variant="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="lq-btn" disabled={!title.trim() || action.busy || problem !== null}>
            {action.busy ? 'Proposing…' : 'Propose'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** One member to pick as a voter, or leave out */
function VoterRow({
  a,
  did,
  bot,
  on,
  onToggle,
}: {
  a: Assembly;
  did: string;
  bot?: boolean;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="lq-row" style={{ cursor: 'pointer', padding: '8px 16px' }}>
      <input type="checkbox" checked={on} onChange={onToggle} />
      <Who did={did} a={a} size={22} />
      {bot && <span className="lq-chip">bot</span>}
    </label>
  );
}
